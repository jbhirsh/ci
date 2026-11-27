// The probe's cold/warm table for the job summary, from a results file
// (results.ts): one row per request and phase, in `Server-Timing` order,
// cold beside the median of the warm repeats, in job-summary's duration()
// format ("812ms", "3.4s") so the summary, the PR comment and the report
// read alike. Then the run's notes as bullets. Pure.
//
//   - "none" in Warm for a phase seen only cold (BoardGames' `loaded`),
//     and in Cold for a request that ran warm while another carried cold;
//   - "not seen this run" in every Cold cell when no response carried the
//     cold flag, rather than a guess.

import { cell, duration } from '../job-summary/render.ts';
import { aggregate } from './results.ts';
import type { Results } from './results.ts';

/** A time in ms as the summary writes it. */
export const ms = (ms: number): string => duration(ms / 1000);

/**
 * The summary's Markdown for a run's results. `repeats` is the setting
 * (how many warm loads the median is of), named in the Warm heading.
 */
export function table(
  results: Results,
  { repeats, title = 'Performance probe' }: { repeats?: number; title?: string } = {},
): string {
  const rows = aggregate(results.measurements);
  const lines = [`### ${title}`, ''];
  const where = [results.target, results.environment].filter(Boolean).map(cell).join(', ');
  if (where) lines.push(where, '');
  if (rows.length === 0) {
    lines.push('No measurements this run.');
  } else {
    const anyCold = rows.some((row) => row.cold !== null);
    const warm = repeats === undefined ? 'Warm (median)' : `Warm (median of ${repeats})`;
    lines.push(
      `| Request | Phase | Cold | ${warm} |`,
      '|---|---|---:|---:|',
      ...rows.map((row) => {
        const phase = row.label ? `${cell(row.phase)} (${cell(row.label)})` : cell(row.phase);
        const cold = !anyCold ? 'not seen this run' : row.cold === null ? 'none' : ms(row.cold);
        const warm = row.warm === null ? 'none' : ms(row.warm);
        return `| ${cell(row.name)} | ${phase} | ${cold} | ${warm} |`;
      }),
    );
  }
  if (results.notes.length > 0) lines.push('', ...results.notes.map((note) => `- ${cell(note)}`));
  return `${lines.join('\n')}\n`;
}
