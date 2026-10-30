// Tests run against a fake NDJSON server on a temp unix socket. They never
// read HERDR_SOCKET_PATH: every client gets the fake path explicitly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  socketPathFromEnv,
  HerdrError,
  createClient,
  normaliseEventType,
} from "../lib/socket.js";

/**
 * Start a fake herdr server. `onLine(line, socket, record)` runs for every
 * request line a client sends; `record.received` keeps every byte.
 * @param {(request: any, socket: net.Socket, record: {received: string}) => void} onLine
 */
async function startServer(onLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
  const socketPath = path.join(dir, "s.sock");
  const sockets = new Set();
  const records = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const record = { received: "", closed: false };
    records.push(record);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      record.received += chunk;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        onLine(JSON.parse(line), socket, record);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      record.closed = true;
      sockets.delete(socket);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    path: socketPath,
    records,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until `predicate()` is true or fail after `ms`.
 * @param {() => boolean} predicate
 * @param {number} [ms]
 */
async function waitFor(predicate, ms = 2000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await delay(5);
  }
}

/** @param {object} value */
const line = (value) => `${JSON.stringify(value)}\n`;

test("socketPathFromEnv reads HERDR_SOCKET_PATH from the given env", () => {
  assert.equal(socketPathFromEnv({ HERDR_SOCKET_PATH: "/x/herdr.sock" }), "/x/herdr.sock");
  assert.equal(socketPathFromEnv({}), null);
  assert.equal(socketPathFromEnv({ HERDR_SOCKET_PATH: "" }), null);
});

test("normaliseEventType turns the first underscore of undotted names into a dot", () => {
  assert.equal(normaliseEventType("tab_focused"), "tab.focused");
  assert.equal(normaliseEventType("pane_agent_status_changed"), "pane.agent_status_changed");
  assert.equal(normaliseEventType("workspace_focused"), "workspace.focused");
  assert.equal(normaliseEventType("pane.agent_status_changed"), "pane.agent_status_changed");
});

test("HerdrError carries code and method", () => {
  const err = new HerdrError("tab_not_found", "no such tab", "tab.rename");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "HerdrError");
  assert.equal(err.code, "tab_not_found");
  assert.equal(err.method, "tab.rename");
  assert.equal(err.message, "no such tab");
});

test("request resolves with the result, one connection per request", async () => {
  const seen = [];
  const server = await startServer((request, socket) => {
    seen.push(request);
    socket.end(line({ id: request.id, result: { type: "tab_list", tabs: [request.params] } }));
  });
  const client = createClient({ path: server.path });
  try {
    const first = await client.request("tab.list", { n: 1 });
    const second = await client.request("tab.list");
    assert.deepEqual(first, { type: "tab_list", tabs: [{ n: 1 }] });
    assert.deepEqual(second, { type: "tab_list", tabs: [{}] });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].method, "tab.list");
    assert.notEqual(seen[0].id, seen[1].id);
    assert.equal(server.records.length, 2);
  } finally {
    client.close();
    await server.stop();
  }
});

test("request rejects an error reply with a HerdrError", async () => {
  const server = await startServer((request, socket) => {
    socket.end(line({ id: request.id, error: { code: "tab_not_found", message: "tab w1:t9 not found" } }));
  });
  const client = createClient({ path: server.path });
  try {
    await assert.rejects(client.request("tab.rename", { tab_id: "w1:t9", label: "x" }), (err) => {
      assert.ok(err instanceof HerdrError);
      assert.equal(err.code, "tab_not_found");
      assert.equal(err.method, "tab.rename");
      assert.equal(err.message, "tab w1:t9 not found");
      return true;
    });
  } finally {
    client.close();
    await server.stop();
  }
});

test("request times out with ETIMEDOUT and drops the connection", async () => {
  const server = await startServer(() => {});
  const client = createClient({ path: server.path, timeoutMs: 50 });
  try {
    await assert.rejects(client.request("tab.list"), { code: "ETIMEDOUT" });
    await waitFor(() => server.records.length === 1 && server.records[0].closed);
  } finally {
    client.close();
    await server.stop();
  }
});

test("request rejects with ECLOSED when the server hangs up without a reply", async () => {
  const server = await startServer((request, socket) => socket.end());
  const client = createClient({ path: server.path });
  try {
    await assert.rejects(client.request("tab.list"), { code: "ECLOSED" });
  } finally {
    client.close();
    await server.stop();
  }
});

test("request rejects with the transport error for a missing socket", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
  const client = createClient({ path: path.join(dir, "none.sock") });
  try {
    await assert.rejects(client.request("tab.list"), { code: "ENOENT" });
  } finally {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("request with no socket path rejects instead of throwing", async () => {
  const client = createClient({ path: null });
  const promise = client.request("tab.list");
  await assert.rejects(promise, { code: "ENOENT" });
});

test("client.close rejects in-flight requests with ECLOSED and closes their connections", async () => {
  const server = await startServer(() => {});
  const client = createClient({ path: server.path, timeoutMs: 10000 });
  try {
    const first = client.request("tab.list");
    const second = client.request("pane.list");
    await waitFor(() => server.records.length === 2 && server.records.every((r) => r.received !== ""));
    client.close();
    await assert.rejects(first, { code: "ECLOSED" });
    await assert.rejects(second, { code: "ECLOSED" });
    await waitFor(() => server.records.every((r) => r.closed));
    await assert.rejects(client.request("tab.list"), { code: "ECLOSED" });
  } finally {
    await server.stop();
  }
});

/**
 * Subscribe with callbacks that record every call in order.
 * @param {ReturnType<typeof createClient>} client
 * @param {object} [overrides]
 */
function recordingSubscribe(client, overrides = {}) {
  const calls = [];
  const events = [];
  const errors = [];
  const handle = client.subscribe([{ type: "tab.focused" }], {
    onStarted: () => calls.push("started"),
    onEvent: (event) => {
      calls.push("event");
      events.push(event);
    },
    onError: (err) => {
      calls.push("error");
      errors.push(err);
    },
    onClose: () => calls.push("close"),
    ...overrides,
  });
  return { handle, calls, events, errors };
}

test("subscribe: started, both envelope shapes, split chunks, malformed lines, one write only", async () => {
  const lifecycle = { event: "tab_focused", data: { type: "tab_focused", tab_id: "w1:t2", workspace_id: "w1" } };
  const renamed = {
    event: "tab_renamed",
    data: { label: "◐ api", tab_id: "w1:t3", type: "tab_renamed", workspace_id: "w1" },
  };
  const status = {
    event: "pane.agent_status_changed",
    data: { pane_id: "w1:p2", workspace_id: "w1", agent_status: "idle", agent: "test" },
  };
  const undotted = { event: "pane_agent_status_changed", data: { pane_id: "w1:p3", agent_status: "working" } };
  let subscribeRequest = null;
  const server = await startServer(async (request, socket) => {
    subscribeRequest = request;
    socket.write(line({ id: request.id, result: { type: "subscription_started" } }));
    socket.write(line(lifecycle));
    // A line split across chunks, with the split inside a multi-byte character.
    const bytes = Buffer.from(line(renamed), "utf8");
    const cut = bytes.indexOf(Buffer.from("◐", "utf8")) + 1;
    socket.write(bytes.subarray(0, cut));
    await delay(20);
    socket.write(bytes.subarray(cut));
    socket.write("not json\n[1,2]\n\n");
    socket.write(line(status) + line(undotted).slice(0, 10));
    await delay(20);
    socket.write(line(undotted).slice(10));
  });
  const client = createClient({ path: server.path });
  try {
    const { handle, calls, events, errors } = recordingSubscribe(client);
    await waitFor(() => events.length === 4);
    assert.deepEqual(subscribeRequest.method, "events.subscribe");
    assert.deepEqual(subscribeRequest.params, { subscriptions: [{ type: "tab.focused" }] });
    assert.deepEqual(events, [
      { type: "tab.focused", data: lifecycle.data },
      { type: "tab.renamed", data: renamed.data },
      { type: "pane.agent_status_changed", data: status.data },
      { type: "pane.agent_status_changed", data: undotted.data },
    ]);
    assert.deepEqual(errors, []);
    assert.equal(calls[0], "started");

    handle.close();
    await waitFor(() => calls.includes("close"));
    await delay(20);
    assert.equal(calls.filter((call) => call === "close").length, 1);
    await waitFor(() => server.records[0].closed);
    const received = server.records[0].received;
    assert.equal(received.split("\n").length, 2, "exactly one line written");
    assert.ok(received.endsWith("\n"));
  } finally {
    client.close();
    await server.stop();
  }
});

test("subscribe: events_lost reports a HerdrError, then onClose once", async () => {
  const server = await startServer((request, socket) => {
    socket.write(line({ id: request.id, result: { type: "subscription_started" } }));
    socket.end(line({ id: request.id, error: { code: "events_lost", message: "subscriber fell behind" } }));
  });
  const client = createClient({ path: server.path });
  try {
    const { calls, errors } = recordingSubscribe(client);
    await waitFor(() => calls.includes("close"));
    await delay(20);
    assert.deepEqual(calls, ["started", "error", "close"]);
    assert.ok(errors[0] instanceof HerdrError);
    assert.equal(errors[0].code, "events_lost");
    assert.equal(errors[0].method, "events.subscribe");
  } finally {
    client.close();
    await server.stop();
  }
});

test("subscribe: a throwing callback goes to onError and parsing continues", async () => {
  const server = await startServer((request, socket) => {
    socket.write(line({ id: request.id, result: { type: "subscription_started" } }));
    socket.write(line({ event: "tab_focused", data: { tab_id: "w1:t1" } }));
    socket.write(line({ event: "tab_focused", data: { tab_id: "w1:t2" } }));
  });
  const client = createClient({ path: server.path });
  try {
    const seen = [];
    const { handle, errors, calls } = recordingSubscribe(client, {
      onStarted: () => {
        throw new Error("boom in onStarted");
      },
      onEvent: (event) => {
        seen.push(event.data.tab_id);
        if (seen.length === 1) throw new Error("boom in onEvent");
      },
    });
    await waitFor(() => seen.length === 2);
    assert.deepEqual(seen, ["w1:t1", "w1:t2"]);
    assert.deepEqual(
      errors.map((err) => err.message),
      ["boom in onStarted", "boom in onEvent"],
    );
    handle.close();
    await waitFor(() => calls.includes("close"));
  } finally {
    client.close();
    await server.stop();
  }
});

test("subscribe: missing callbacks are fine", async () => {
  const server = await startServer((request, socket) => {
    socket.write(line({ id: request.id, result: { type: "subscription_started" } }));
    socket.write(line({ event: "tab_focused", data: {} }));
    socket.end(line({ id: request.id, error: { code: "events_lost", message: "x" } }));
  });
  const client = createClient({ path: server.path });
  try {
    client.subscribe([{ type: "tab.focused" }]);
    await waitFor(() => server.records.length === 1 && server.records[0].closed);
    await delay(20);
  } finally {
    client.close();
    await server.stop();
  }
});

test("subscribe: missing socket reports the transport error, then onClose once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
  const client = createClient({ path: path.join(dir, "none.sock") });
  try {
    const { calls, errors } = recordingSubscribe(client);
    await waitFor(() => calls.includes("close"));
    await delay(20);
    assert.deepEqual(calls, ["error", "close"]);
    assert.equal(errors[0].code, "ENOENT");
  } finally {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("client.close closes open subscriptions, onClose fires once", async () => {
  const server = await startServer((request, socket) => {
    socket.write(line({ id: request.id, result: { type: "subscription_started" } }));
  });
  const client = createClient({ path: server.path });
  try {
    const first = recordingSubscribe(client);
    const second = recordingSubscribe(client);
    await waitFor(() => first.calls.includes("started") && second.calls.includes("started"));
    client.close();
    await waitFor(() => first.calls.includes("close") && second.calls.includes("close"));
    first.handle.close();
    await delay(20);
    assert.deepEqual(first.calls, ["started", "close"]);
    assert.deepEqual(second.calls, ["started", "close"]);
    await waitFor(() => server.records.every((record) => record.closed));
  } finally {
    await server.stop();
  }
});
