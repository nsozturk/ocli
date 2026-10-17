import { defineConfig } from 'vitest/config';

// plugin/hooks/*.test.ts import 'claude-code/testing' and run under `claude plugin test`, never vitest.
// setupFiles pins ORCHESTRA_PLANS to the shipped example plans for every suite.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup-plans.ts'] } });
