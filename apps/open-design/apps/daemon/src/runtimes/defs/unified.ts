import type { RuntimeAgentDef } from '../types.js';

// Platform-native agent. Unlike every other entry in the runtime registry,
// the UnifiedAI agent is NOT a local CLI: there is no binary to spawn. The
// daemon runs the agent loop itself against unified-api (see
// ../../unified-agent.ts), authenticated through the loopback broker
// (../../unified-auth.ts).
//
// The `bin` / `versionArgs` / `buildArgs` fields exist only to satisfy the
// `RuntimeAgentDef` contract so `getAgentDef('unified')` resolves and the
// generic guards in startChatRun pass. They are never used: detection
// short-circuits this id (it is only surfaced when the broker is configured)
// and startChatRun branches on `streamFormat === 'unified-http'` before any
// spawn machinery runs.
export const unifiedAgentDef = {
  id: 'unified',
  name: 'UnifiedAI',
  bin: 'unified',
  versionArgs: [],
  // `auto` lets the gateway pick the best model when the user hasn't chosen
  // one; the live list comes from the unified-api catalog at detection time.
  fallbackModels: [{ id: 'auto', label: 'Auto' }],
  buildArgs: () => [],
  streamFormat: 'unified-http',
  supportsImagePaths: true,
} satisfies RuntimeAgentDef;
