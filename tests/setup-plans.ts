// Caps come from the provider plans. Every suite reads the shipped example, never the user's real
// ~/.config/agent-rules/provider-plans.json (nor a shell-exported ORCHESTRA_PLANS); a test that needs
// other plans overrides this with vi.stubEnv.
// @ts-expect-error - dispatcher/ is plain ESM JavaScript tooling, not part of a typed build.
import { EXAMPLE_PLANS } from '../dispatcher/plans.mjs';

process.env.ORCHESTRA_PLANS = EXAMPLE_PLANS;
