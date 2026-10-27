import { defineConfig } from 'vitest/config';

// Tests run headless in Node. This file exists so vitest doesn't load
// vite.config.ts, which starts the dev-only stand-in and render plugins.
// `npm run check:fast` runs tests/unit; `npm run verify` runs tests/M*.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/golden/**', 'node_modules/**'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
