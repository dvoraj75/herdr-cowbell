// Icon presets and config handling. Pure: no I/O, so it can be unit-tested
// without a herdr server and reused by the daemon and the control CLI.

/**
 * Deep-freeze a plain object/array tree so shared constants cannot be
 * mutated by accident.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Agent states a tab can show an icon for.
 * @type {readonly string[]}
 */
export const STATES = deepFreeze(["working", "blocked", "done", "idle", "unknown"]);

/**
 * Preset names in cycle order (the order `cycle-preset` walks through).
 * @type {readonly string[]}
 */
export const PRESET_NAMES = deepFreeze(["ask", "symbols", "emoji", "nerd", "custom"]);

// Nerd Font glyphs are private-use code points that vanish in many editors
// and fonts, so they are written as escapes: \uF110 nf-fa-spinner,
// \uF059 nf-fa-question_circle, \uF00C nf-fa-check.
/**
 * Icon per state for each preset. `""` means "no icon". `custom` is empty
 * because its icons come entirely from `config.icons`.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const PRESETS = deepFreeze({
  ask: { working: "◐", blocked: "?", done: "✓", idle: "", unknown: "" },
  symbols: { working: "◐", blocked: "×", done: "✓", idle: "", unknown: "" },
  emoji: { working: "⏳", blocked: "❓", done: "✅", idle: "", unknown: "" },
  nerd: { working: "\uF110", blocked: "\uF059", done: "\uF00C", idle: "", unknown: "" },
  custom: { working: "", blocked: "", done: "", idle: "", unknown: "" },
});

/**
 * Config used when no config file exists. This is the only place the
 * `include_auto_named` default is defined.
 */
export const DEFAULT_CONFIG = deepFreeze({
  preset: "ask",
  icons: {},
  separator: " ",
  include_auto_named: true,
  spinner: { enabled: false, frames: ["◐", "◓", "◑", "◒"], interval_ms: 1000 },
});

/**
 * Build a fresh, mutable copy of the defaults. Hand-copied because
 * `structuredClone` is not available on Node 18.0.
 * @returns {{preset: string, icons: Record<string, string>, separator: string,
 *   include_auto_named: boolean,
 *   spinner: {enabled: boolean, frames: string[], interval_ms: number}}}
 */
export function defaultConfig() {
  return {
    preset: DEFAULT_CONFIG.preset,
    icons: { ...DEFAULT_CONFIG.icons },
    separator: DEFAULT_CONFIG.separator,
    include_auto_named: DEFAULT_CONFIG.include_auto_named,
    spinner: {
      enabled: DEFAULT_CONFIG.spinner.enabled,
      frames: DEFAULT_CONFIG.spinner.frames.slice(),
      interval_ms: DEFAULT_CONFIG.spinner.interval_ms,
    },
  };
}

/**
 * Resolve the icon of every state: the preset, with `config.icons`
 * overriding single states. An override of `""` removes that state's icon.
 * @param {{preset: string, icons?: Record<string, string>}} config
 * @returns {Record<string, string>}
 */
export function resolveIcons(config) {
  const base = PRESETS[config.preset] || PRESETS.custom;
  const overrides = config.icons || {};
  const resolved = {};
  for (const state of STATES) {
    resolved[state] = Object.prototype.hasOwnProperty.call(overrides, state)
      ? overrides[state]
      : base[state];
  }
  return resolved;
}

/**
 * Icon for an agent status under the given config.
 * @param {string} status
 * @param {{preset: string, icons?: Record<string, string>}} config
 * @returns {string} `""` for a status that is not in STATES.
 */
export function iconFor(status, config) {
  if (!STATES.includes(status)) return "";
  return resolveIcons(config)[status];
}

/**
 * Every icon we might have written to a label, under any preset or config,
 * so stale icons can be stripped even after the user switched presets.
 * @param {{icons?: Record<string, string>, spinner?: {frames?: string[]}}} config
 * @returns {string[]} Unique, non-empty, longest first (so a longer icon is
 *   never shadowed by one of its prefixes).
 */
export function knownIcons(config) {
  const all = new Set();
  const add = (icon) => {
    if (typeof icon === "string" && icon !== "") all.add(icon);
  };
  for (const preset of Object.values(PRESETS)) Object.values(preset).forEach(add);
  Object.values(config.icons || {}).forEach(add);
  DEFAULT_CONFIG.spinner.frames.forEach(add);
  ((config.spinner && config.spinner.frames) || []).forEach(add);
  return Array.from(all).sort((a, b) => b.length - a.length);
}

/**
 * @param {unknown} value
 * @returns {boolean} True for a non-null, non-array object.
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed config and merge it over the defaults.
 * @param {unknown} data
 * @returns {{config: object|null, error: string|null}}
 */
function validate(data) {
  if (!isPlainObject(data)) return { config: null, error: "config: must be a JSON object" };
  const config = defaultConfig();

  if (data.preset !== undefined) {
    if (typeof data.preset !== "string" || !PRESET_NAMES.includes(data.preset)) {
      return { config: null, error: `preset: unknown preset ${JSON.stringify(data.preset)}` };
    }
    config.preset = data.preset;
  }

  if (data.icons !== undefined) {
    if (!isPlainObject(data.icons)) return { config: null, error: "icons: must be an object" };
    for (const [state, icon] of Object.entries(data.icons)) {
      if (!STATES.includes(state)) {
        return { config: null, error: `icons: unknown state ${JSON.stringify(state)}` };
      }
      if (typeof icon !== "string") {
        return { config: null, error: `icons.${state}: must be a string` };
      }
      config.icons[state] = icon;
    }
  }

  if (data.separator !== undefined) {
    if (typeof data.separator !== "string") {
      return { config: null, error: "separator: must be a string" };
    }
    config.separator = data.separator;
  }

  if (data.include_auto_named !== undefined) {
    if (typeof data.include_auto_named !== "boolean") {
      return { config: null, error: "include_auto_named: must be a boolean" };
    }
    config.include_auto_named = data.include_auto_named;
  }

  if (data.spinner !== undefined) {
    const spinner = data.spinner;
    if (!isPlainObject(spinner)) return { config: null, error: "spinner: must be an object" };
    if (spinner.enabled !== undefined) {
      if (typeof spinner.enabled !== "boolean") {
        return { config: null, error: "spinner.enabled: must be a boolean" };
      }
      config.spinner.enabled = spinner.enabled;
    }
    if (spinner.frames !== undefined) {
      const frames = spinner.frames;
      if (
        !Array.isArray(frames) ||
        frames.length === 0 ||
        !frames.every((frame) => typeof frame === "string" && frame !== "")
      ) {
        return {
          config: null,
          error: "spinner.frames: must be a non-empty array of non-empty strings",
        };
      }
      config.spinner.frames = frames.slice();
    }
    if (spinner.interval_ms !== undefined) {
      // Floor of 1000 ms: faster renames would flood herdr with tab updates.
      if (
        typeof spinner.interval_ms !== "number" ||
        !Number.isFinite(spinner.interval_ms) ||
        spinner.interval_ms < 1000
      ) {
        return { config: null, error: "spinner.interval_ms: must be a number >= 1000" };
      }
      config.spinner.interval_ms = spinner.interval_ms;
    }
  }

  return { config, error: null };
}

/**
 * Parse and validate a config. Never throws: a bad config yields the last
 * good one (or the defaults) plus a one-line error, so a typo in the file
 * cannot take the daemon down.
 * @param {unknown} input JSON text or an already-parsed value; `undefined`
 *   means "no file" and yields the defaults.
 * @param {object|null|undefined} lastGood Config to fall back to on error,
 *   returned as-is.
 * @returns {{config: object, error: string|null}}
 */
export function parseConfig(input, lastGood) {
  const fallback = () => (lastGood == null ? defaultConfig() : lastGood);
  if (input === undefined) return { config: defaultConfig(), error: null };

  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch (err) {
      const reason = String(err && err.message).split("\n")[0];
      return { config: fallback(), error: `config: invalid JSON (${reason})` };
    }
  }

  let result;
  try {
    result = validate(data);
  } catch (err) {
    // Already-parsed input can be hostile (BigInt, throwing getters, proxies).
    const reason = String(err && err.message).split("\n")[0];
    return { config: fallback(), error: `config: ${reason}` };
  }
  if (result.error) return { config: fallback(), error: result.error };
  return result;
}
