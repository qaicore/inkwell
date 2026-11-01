import { defineConfig } from 'vitest/config';

// Tests run headless in Node. This file exists so vitest doesn't load
// vite.config.ts, which starts the dev-only stand-in and render plugins.
// `npm run check:fast` runs tests/unit; `npm run verify` runs tests/M*.
//
// The timed files hold the impact renderers to design §10's time budgets
// with performance.now. While every other file runs on all cores at once,
// those timings rise 2-3x and fail on load alone, so these files run one at
// a time in a second group, after the rest is done: two projects ordered by
// sequence.groupOrder. Their thresholds are as their packages wrote them.
const TIMED = [
  'tests/unit/limb-render.test.ts',
  'tests/unit/arcs3d.test.ts',
  'tests/unit/impact-frames.test.ts',
  'tests/unit/aftermath-mass.test.ts',
  'tests/unit/aftermath-energy.test.ts',
  'tests/unit/impact-scene-budget.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 60_000,
    projects: [
      {
        test: {
          name: 'tests',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/golden/**', 'node_modules/**', ...TIMED],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: 'timed',
          include: TIMED,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
