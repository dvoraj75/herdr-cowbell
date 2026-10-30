// Pure label logic: no fs, net, process, timers or console. The daemon owns all I/O.
import { knownIcons, iconFor } from "./icons.js";

/**
 * @typedef {object} TabInfo A `tab.list` entry; only these fields are read.
 * @property {string} label Current tab label.
 * @property {string} agent_status Agent state, e.g. "working".
 */

/**
 * @typedef {object} ListedTab A `tab.list` entry as `positions` reads it.
 * @property {string} tab_id
 * @property {string} workspace_id
 */

/**
 * @typedef {object} TabEntry Per-tab state we persist.
 * @property {string} base The tab's real name, without any icon.
 * @property {string} lastWritten The label we last asked herdr to show.
 * @property {boolean} autoNamed True while the base is just the tab's position.
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
 * 1-based position of every tab within its workspace. herdr's automatic label
 * is this position, not the tab's `number`: `number` is a stable id that is
 * never recomputed when tabs move or close. `tab.list` returns each
 * workspace's tabs in position order, so counting per workspace works whether
 * or not the workspaces are interleaved.
 * @param {ListedTab[]} tabs Entries in `tab.list` order.
 * @returns {Map<string, number>} Position by tab id.
 */
export function positions(tabs) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {Map<string, number>} */
  const result = new Map();
  for (const tab of tabs || []) {
    const position = (counts.get(tab.workspace_id) || 0) + 1;
    counts.set(tab.workspace_id, position);
    result.set(tab.tab_id, position);
  }
  return result;
}

/**
 * True when the label, ignoring our icons, is just the tab's position.
 * @param {string} label
 * @param {number} position 1-based position in its workspace (see `positions`).
 * @param {string[]} icons
 * @param {string} [separator]
 * @returns {boolean}
 */
export function isAutoNamed(label, position, icons, separator = " ") {
  return strip(label, icons, separator) === String(position);
}

/**
 * Decide what to do with one tab. Does not mutate its inputs.
 * An auto-named tab with include_auto_named off is skipped, or renamed to its
 * bare position if it still shows our icon. A tab we ever wrote to stays
 * tracked (entry set), because herdr treats it as custom-named and only our
 * echo path can follow it when tabs move or close. A never-tracked tab gets
 * entry null. A tab whose custom entry already has this label as its base
 * stays custom, even when the label is just its position (see the comment in
 * the body).
 * @param {TabInfo} tab
 * @param {TabEntry | null | undefined} prev State from the previous pass, if any.
 * @param {object} config Parsed config (see icons.js); uses separator, include_auto_named, preset, icons, spinner.
 * @param {{position: number}} where The tab's 1-based position in its workspace (see `positions`).
 * @returns {Decision}
 */
export function decide(tab, prev, config, { position }) {
  const icons = knownIcons(config);
  const separator = config.separator;
  const automatic = String(position);

  let autoNamed;
  let base;
  if (prev && tab.label === prev.lastWritten) {
    // Our own echo, or nothing changed. herdr stops updating a tab once we
    // renamed it, so an auto-named tab follows moves and closes only here:
    // its base is always the current position.
    autoNamed = prev.autoNamed;
    base = autoNamed ? automatic : prev.base;
  } else {
    // First sight, or somebody else renamed the tab: take their name as base.
    // A label equal to the position means herdr named it, unless the entry
    // shows a deliberate custom name: `renamed()` keeps the old `lastWritten`,
    // so a user rename to the position number lands here too, with the entry
    // already custom and its base equal to this label. Calling that auto would
    // overwrite their name with the new position after the next move. An entry
    // that is custom with a different base is stale (a tab id reused after a
    // server restart or a close, or a rename we have not seen yet), so it
    // proves nothing about this label.
    const stripped = strip(tab.label, icons, separator);
    autoNamed =
      stripped === automatic && !(prev && prev.autoNamed === false && prev.base === stripped);
    base = stripped;
  }

  if (autoNamed && !config.include_auto_named) {
    // A label that still carries an icon of ours (include_auto_named was just
    // turned off) is reset to the bare position, else the stale icon stays
    // forever. The rename makes the name custom in herdr, so keep tracking it:
    // the echo path then keeps the position in sync after moves and closes. A
    // tab we never touched stays untracked, herdr still names it itself.
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
 * State entry after a foreign `tab.renamed` (the user or another plugin, not
 * one of our echoes): the new label, without our icons, becomes the custom
 * base. `lastWritten` stays as it was on purpose: when one of our in-flight
 * renames lands after theirs, the tab shows our old label again, so the next
 * resync takes the echo path and re-applies the icon on the new base.
 * @param {TabEntry | null | undefined} prev
 * @param {string} label The label from the event.
 * @param {object} config Parsed config (see icons.js); uses separator, icons, spinner.
 * @returns {TabEntry | null} null for a tab we do not track; the next resync
 *   sees it for the first time and reads its label from `tab.list`.
 */
export function renamed(prev, label, config) {
  if (!prev) return null;
  return {
    base: strip(label, knownIcons(config), config.separator),
    lastWritten: prev.lastWritten,
    autoNamed: false,
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
