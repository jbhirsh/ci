// Fills a prompt template: each `{{name}}` in it becomes the value of that
// name. Both tools' prompts are Markdown files beside their action.yml, so
// they read as the prompt they are; the values (the PR's number, the app's
// guide, the files left unread) come from the action at run time. A value
// is inserted as it is, never scanned for placeholders itself, so text from
// the app or the PR can't inject one. A name with no value, or a `{{` left
// over that isn't a placeholder, throws: a prompt goes out whole or not at
// all.

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function fill(template, values) {
  const missing = new Set();
  const out = template.replace(PLACEHOLDER, (_, /** @type {string} */ name) => {
    if (!Object.hasOwn(values, name)) {
      missing.add(name);
      return '';
    }
    return values[name];
  });
  if (missing.size > 0) throw new Error(`No value for ${[...missing].join(', ')}`);
  const rest = template.replace(PLACEHOLDER, '');
  const stray = rest.indexOf('{{');
  if (stray !== -1)
    throw new Error(`A stray "{{" in the template near: ${rest.slice(stray, stray + 40)}`);
  return out;
}

/**
 * The names a template asks for, in order of first use.
 *
 * @param {string} template
 * @returns {string[]}
 */
export function placeholders(template) {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

/**
 * A Markdown bullet list, one item per line.
 *
 * @param {string[]} items
 * @param {string} [indent]
 * @returns {string}
 */
export function bullets(items, indent = '') {
  return items.map((item) => `${indent}- ${item}`).join('\n');
}
