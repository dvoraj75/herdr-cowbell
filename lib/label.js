// Pure label logic: no fs, net, process, timers or console. The daemon owns all I/O.
import { knownIcons, iconFor } from "./icons.js";

/**
 * @typedef {object} TabInfo A `tab.list` entry; only these fields are read.
 * @property {string} label Current tab label.
 * @property {number} number Herdr's automatic tab number.
 * @property {string} agent_status Agent state, e.g. "working".
 */

/**
 * @typedef {object} TabEntry Per-tab state we persist.
 * @property {string} base The tab's real name, without any icon.
 * @property {string} lastWritten The label we last asked herdr to show.
 * @property {boolean} autoNamed True while the base is just the tab number.
 */

/**
 * @typedef {object} Decision
 * @property {"skip" | "keep" | "rename"} action
 * @property {string} label Label the tab should have (the current one for skip).
 * @property {TabEntry | null} entry New state entry, or null only for an untracked auto-named tab that is skipped.
 */

const VARIATION_SELECTORS = ["\uFE0E", "\uFE0F"];

/**
 * Remove trailing variation selectors. Only trailing ones: an icon such as a
 * ZWJ sequence may contain selectors in the middle that must stay intact.
 * @param {string} text
 * @returns {string}
 */
function withoutTrailingSelectors(text) {
  let end = text.length;
  while (end > 0 && VARIATION_SELECTORS.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

/**
 * @param {string} text
 * @returns {string}
 */
function withoutLeadingSelectors(text) {
  let start = 0;
  while (start < text.length && VARIATION_SELECTORS.includes(text[start])) start += 1;
  return text.slice(start);
}

/**
 * Remove every leading `icon [VS]* (separator | end)` group from a label.
 * Icons are matched by string prefix, never by index, so multi-code-point
 * emoji and astral-plane characters work the same as single BMP glyphs.
 * End of string counts as a separator because herdr may trim trailing spaces
 * and `compose("", icon)` has no separator at all.
 * @param {unknown} label
 * @param {string[]} icons Icons to remove, normally `knownIcons(config)`.
 * @param {string} [separator]
 * @returns {string} The label without leading icons; "" for a non-string label.
 */
export function strip(label, icons, separator = " ") {
  if (typeof label !== "string") return "";
  // Normalise on a copy (never mutate the caller's array). Longest first so a
  // short icon that is a prefix of a longer one cannot win.
  const candidates = [...new Set((icons || []).map((icon) => withoutTrailingSelectors(String(icon))))]
    .filter((icon) => icon !== "")
    .sort((a, b) => b.length - a.length);

  let rest = label;
  for (;;) {
    let next = null;
    for (const icon of candidates) {
      if (!rest.startsWith(icon)) continue;
      // A separator may itself start with a variation selector, so test it
      // before the selectors are skipped.
      const direct = rest.slice(icon.length);
      if (separator !== "" && direct.startsWith(separator)) {
        next = direct.slice(separator.length);
        break;
      }
      // The label may carry a different selector than the icon we know.
      const after = withoutLeadingSelectors(rest.slice(icon.length));
      if (after === "" || separator === "") {
        next = after;
      } else if (after.startsWith(separator)) {
        next = after.slice(separator.length);
      }
      if (next !== null) break;
    }
    if (next === null) return rest;
    rest = next;
  }
}

/**
 * Build a label from a base name and an icon.
 * @param {string} base
 * @param {string} icon Empty string for no icon.
 * @param {string} [separator]
 * @returns {string}
 */
export function compose(base, icon, separator = " ") {
  return icon ? (base ? icon + separator + base : icon) : base;
}

/**
 * True when the tab's name, ignoring our icons, is just its automatic number.
 * @param {TabInfo} tab
 * @param {string[]} icons
 * @param {string} [separator]
 * @returns {boolean}
 */
export function isAutoNamed(tab, icons, separator = " ") {
  return strip(tab.label, icons, separator) === String(tab.number);
}

/**
 * Decide what to do with one tab. Does not mutate its inputs.
 * An auto-named tab with include_auto_named off is skipped, or renamed to its
 * bare number if it still shows our icon. A tab we ever wrote to stays tracked
 * (entry set), because herdr treats it as custom-named and only our echo path
 * can follow its renumbering. A never-tracked tab gets entry null.
 * @param {TabInfo} tab
 * @param {TabEntry | null | undefined} prev State from the previous pass, if any.
 * @param {object} config Parsed config (see icons.js); uses separator, include_auto_named, preset, icons, spinner.
 * @returns {Decision}
 */
export function decide(tab, prev, config) {
  const icons = knownIcons(config);
  const separator = config.separator;
  const number = String(tab.number);

  let autoNamed;
  let base;
  if (prev && tab.label === prev.lastWritten) {
    // Our own echo, or nothing changed. An auto-named tab follows herdr's
    // renumbering, so its base is always the current number.
    autoNamed = prev.autoNamed;
    base = autoNamed ? number : prev.base;
  } else {
    // First sight, or somebody else renamed the tab: take their name as base.
    const stripped = strip(tab.label, icons, separator);
    autoNamed = stripped === number;
    base = autoNamed ? number : stripped;
  }

  if (autoNamed && !config.include_auto_named) {
    // A label that still carries an icon of ours (include_auto_named was just
    // turned off) is reset to the bare number, else the stale icon stays forever.
    // The rename makes the name custom in herdr, so keep tracking it: the echo
    // path then keeps the number in sync after renumbering. A tab we never
    // touched stays untracked, herdr still names and renumbers it itself.
    if (tab.label !== base) {
      return { action: "rename", label: base, entry: { base, lastWritten: base, autoNamed: true } };
    }
    return {
      action: "skip",
      label: tab.label,
      entry: prev ? { base, lastWritten: tab.label, autoNamed: true } : null,
    };
  }

  const want = compose(base, iconFor(tab.agent_status, config), separator);
  return {
    action: want === tab.label ? "keep" : "rename",
    label: want,
    entry: { base, lastWritten: want, autoNamed },
  };
}

/**
 * Drop state entries of tabs that no longer exist.
 * @param {Record<string, TabEntry>} state Entries keyed by tab id.
 * @param {Set<string | number> | Array<string | number>} liveIds
 * @returns {Record<string, TabEntry>} A new object.
 */
export function pruneState(state, liveIds) {
  const live = new Set([...liveIds].map(String));
  /** @type {Record<string, TabEntry>} */
  const pruned = {};
  for (const [id, entry] of Object.entries(state || {})) {
    if (live.has(id)) pruned[id] = entry;
  }
  return pruned;
}
