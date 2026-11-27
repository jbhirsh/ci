// The few things a script does to talk to GitHub Actions: step outputs, the
// job summary, and reading input piped in. Outside Actions (a local run, a
// test) the outputs and summary print to stdout instead.

import { appendFileSync } from 'node:fs';

/**
 * Sets a step output, multi-line safe.
 *
 * @param {string} name
 * @param {string} value
 */
export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const delimiter = `EOF_${Math.random().toString(36).slice(2)}`;
  const line = `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  if (file) appendFileSync(file, line);
  else process.stdout.write(`${name}=${value}\n`);
}

/**
 * Appends Markdown to the job summary.
 *
 * @param {string} markdown
 */
export function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
  else process.stdout.write(`${markdown}\n`);
}

/**
 * Reads all of a stream, stdin by default. Streamed, never readFileSync(0):
 * on a runner, stdin piped from `gh` or `git` can be a non-blocking pipe, and
 * a synchronous read that finds it empty throws EAGAIN instead of waiting.
 *
 * @param {import('node:stream').Readable} [stream]
 * @returns {Promise<string>}
 */
export async function readAll(stream = process.stdin) {
  let input = '';
  for await (const chunk of stream) input += chunk.toString();
  return input;
}
