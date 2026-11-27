// measures.ts at 1000 px: the same steps, where the card's lanes lay their
// numbers out in one row and the waterfall widens. measures.test.ts plays
// it with its pauses made instant.

import measures from './measures.ts';
import type { Scenario } from '../../../gif/cli.ts';

export default {
  ...measures,
  viewport: { width: 1000, height: 800 },
} satisfies Scenario;
