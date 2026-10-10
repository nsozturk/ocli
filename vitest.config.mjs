import { defineConfig } from 'vitest/config';

// plugin/hooks/*.test.ts import 'claude-code/testing' and run under `claude plugin test`, never vitest.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
