// Caps come from the provider plans. Every suite reads the shipped full-roster plans, never the
// user's real ~/.config/agent-rules/provider-plans.json (nor a shell-exported ORCHESTRA_PLANS); a
// test that needs other plans overrides this with vi.stubEnv. The starter example has its own test.
import { fileURLToPath } from 'node:url';

process.env.ORCHESTRA_PLANS = fileURLToPath(new URL('../dispatcher/provider-plans.full-roster.json', import.meta.url));
