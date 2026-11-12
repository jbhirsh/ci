// What counts as a reason written beside a setting: a pin's, a type-coverage
// ignore's (pins), an unmeasured file's (unmeasured). Shared so every list of
// "<name>: <reason>" notes is held to one bar.

/** How many words a reason needs, a version label not counting. */
const REASON_WORDS = 3;

/**
 * Whether a comment gives a reason: a few words, not just a version label.
 *
 * @param {string} text
 */
export function isReason(text) {
  const words = text
    .replace(/\b[0-9a-f]{40}\b/gi, ' ')
    .replace(/\bv?\d+(?:\.[\w-]+)*/g, ' ')
    .split(/[^A-Za-z]+/)
    .filter((word) => word.length > 1);
  return words.length >= REASON_WORDS;
}

/**
 * The notes under a key: a string or a list of strings.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function notes(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  return [];
}
