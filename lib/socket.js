// NDJSON client for the herdr socket. The only module that talks to herdr.
//
// herdr 0.9.3 answers one request per connection and then hangs up, so every
// request opens its own connection. A subscription also gets its own
// connection and stays write-silent after its `events.subscribe` line: herdr
// treats client bytes on a streaming connection as a disconnect.
//
// No reconnect logic lives here; the daemon decides when to retry.
import net from "node:net";

/**
 * @typedef {object} SubscribeCallbacks
 * @property {() => void} [onStarted] After herdr acknowledged the subscription.
 * @property {(event: {type: string, data: object}) => void} [onEvent] Every
 *   event, with `type` in dotted form (`tab.focused`).
 * @property {(err: Error) => void} [onError] An error reply (HerdrError), a
 *   socket error, or an exception thrown by onStarted/onEvent.
 * @property {() => void} [onClose] Exactly once, when the connection ends for
 *   any reason, including `close()`.
 */

/**
 * @typedef {object} Subscription
 * @property {() => void} close Destroy the connection; onClose follows.
 */

/**
 * @typedef {object} Client
 * @property {(method: string, params?: object) => Promise<any>} request
 * @property {(subscriptions: object[], callbacks?: SubscribeCallbacks) => Subscription} subscribe
 * @property {() => void} close Destroy every open connection and reject
 *   in-flight requests with code `ECLOSED`.
 */

/**
 * The herdr socket path from the environment.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null} null when HERDR_SOCKET_PATH is unset or empty.
 */
export function socketPathFromEnv(env = process.env) {
  const value = env && env.HERDR_SOCKET_PATH;
  return typeof value === "string" && value !== "" ? value : null;
}

/** An `{"error": {code, message}}` reply from herdr. */
export class HerdrError extends Error {
  /**
   * @param {string} code herdr's error code, e.g. `tab_not_found`.
   * @param {string} message
   * @param {string} [method] The request method the reply belongs to.
   */
  constructor(code, message, method) {
    super(message || code);
    this.name = "HerdrError";
    /** @type {string} */
    this.code = code;
    /** @type {string | undefined} */
    this.method = method;
  }
}

/**
 * An Error carrying a Node-style `code`.
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function codedError(code, message) {
  const err = /** @type {Error & {code: string}} */ (new Error(message));
  err.code = code;
  return err;
}

/**
 * Event names arrive as `tab_focused` (lifecycle) or
 * `pane.agent_status_changed` (parameterised). Undotted names get their first
 * underscore turned into a dot.
 * @param {string} name
 * @returns {string}
 */
export function normaliseEventType(name) {
  return name.includes(".") ? name : name.replace("_", ".");
}

/**
 * Split buffered text into complete lines; returns the unfinished rest.
 * @param {string} buffer
 * @param {(line: string) => void} onLine
 * @returns {string}
 */
function drainLines(buffer, onLine) {
  let rest = buffer;
  let newline;
  while ((newline = rest.indexOf("\n")) >= 0) {
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (line !== "") onLine(line);
  }
  return rest;
}

/**
 * @param {string} line
 * @returns {any} The parsed object, or null for malformed JSON or a non-object.
 */
function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Open a connection without ever throwing synchronously.
 * @param {unknown} path
 * @returns {{socket: net.Socket | null, error: Error | null}}
 */
function connect(path) {
  if (typeof path !== "string" || path === "") {
    return { socket: null, error: codedError("ENOENT", "herdr socket path is not set") };
  }
  try {
    return { socket: net.connect({ path }), error: null };
  } catch (err) {
    return { socket: null, error: /** @type {Error} */ (err) };
  }
}

/**
 * Create a herdr socket client.
 * @param {{path?: string | null, timeoutMs?: number}} [options]
 * @returns {Client}
 */
export function createClient({ path = socketPathFromEnv(), timeoutMs = 5000 } = {}) {
  let nextId = 1;
  let closed = false;
  /** @type {Map<string, {socket: net.Socket | null, reject: (err: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
  const pending = new Map();
  /** @type {Set<Subscription>} */
  const subscriptions = new Set();

  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(codedError("ECLOSED", `${method}: client closed`));
        return;
      }
      const id = `cowbell-${nextId++}`;
      const { socket, error } = connect(path);
      if (!socket) {
        reject(error);
        return;
      }

      let settled = false;
      /**
       * @param {Error | null} err
       * @param {any} [value]
       */
      const settle = (err, value) => {
        if (settled) return;
        settled = true;
        const entry = pending.get(id);
        if (entry) clearTimeout(entry.timer);
        pending.delete(id);
        socket.destroy();
        if (err) reject(err);
        else resolve(value);
      };

      const timer = setTimeout(
        () => settle(codedError("ETIMEDOUT", `${method}: no reply within ${timeoutMs} ms`)),
        timeoutMs,
      );
      pending.set(id, { socket, reject: (err) => settle(err), timer });

      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer = drainLines(buffer + chunk, (line) => {
          if (settled) return;
          const reply = parseLine(line);
          if (reply && reply.error && typeof reply.error === "object") {
            settle(new HerdrError(String(reply.error.code), String(reply.error.message || ""), method));
          } else if (reply && Object.prototype.hasOwnProperty.call(reply, "result")) {
            settle(null, reply.result);
          } else {
            settle(codedError("EPROTO", `${method}: malformed reply`));
          }
        });
      });
      socket.on("error", (err) => settle(err));
      socket.on("close", () => settle(codedError("ECLOSED", `${method}: connection closed without a reply`)));
    });
  }

  /**
   * @param {object[]} subscriptionList
   * @param {SubscribeCallbacks} [callbacks]
   * @returns {Subscription}
   */
  function subscribe(subscriptionList, callbacks = {}) {
    const { onStarted, onEvent, onError, onClose } = callbacks;
    let started = false;
    let ended = false;

    /** @param {Error} err */
    const reportError = (err) => {
      if (typeof onError !== "function") return;
      try {
        onError(err);
      } catch {
        // onError is the reporting channel; an exception from it has nowhere left to go.
      }
    };

    // An exception from onStarted/onEvent goes to onError, so a bug in the
    // caller is visible without breaking the parser or escaping uncaught.
    /**
     * @param {Function | undefined} callback
     * @param {...any} args
     */
    const invoke = (callback, ...args) => {
      if (typeof callback !== "function") return;
      try {
        callback(...args);
      } catch (err) {
        reportError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const finish = () => {
      if (ended) return;
      ended = true;
      subscriptions.delete(handle);
      if (typeof onClose !== "function") return;
      try {
        onClose();
      } catch {
        // Nothing runs after onClose that could report it.
      }
    };

    /** @type {Subscription} */
    const handle = {
      close() {
        if (socket) socket.destroy();
        else finish();
      },
    };

    const { socket, error } = closed
      ? { socket: null, error: codedError("ECLOSED", "events.subscribe: client closed") }
      : connect(path);
    if (!socket) {
      // Deferred so the caller has the handle before any callback runs.
      process.nextTick(() => {
        if (ended) return;
        reportError(/** @type {Error} */ (error));
        finish();
      });
      return handle;
    }
    subscriptions.add(handle);

    const id = `cowbell-${nextId++}`;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      // The only write on this connection, ever.
      socket.write(
        `${JSON.stringify({
          id,
          method: "events.subscribe",
          params: { subscriptions: subscriptionList },
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer = drainLines(buffer + chunk, (line) => {
        const message = parseLine(line);
        if (!message) return;
        if (typeof message.event === "string") {
          const data = message.data && typeof message.data === "object" ? message.data : {};
          invoke(onEvent, { type: normaliseEventType(message.event), data });
        } else if (message.error && typeof message.error === "object") {
          reportError(
            new HerdrError(String(message.error.code), String(message.error.message || ""), "events.subscribe"),
          );
        } else if (!started && message.result && message.result.type === "subscription_started") {
          started = true;
          invoke(onStarted);
        }
      });
    });
    socket.on("error", (err) => reportError(err));
    socket.on("close", finish);
    return handle;
  }

  function close() {
    closed = true;
    for (const entry of Array.from(pending.values())) {
      entry.reject(codedError("ECLOSED", "client closed"));
    }
    for (const subscription of Array.from(subscriptions)) subscription.close();
  }

  return { request, subscribe, close };
}
