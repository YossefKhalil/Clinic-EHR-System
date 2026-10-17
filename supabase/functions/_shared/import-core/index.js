// import-core — pure, deterministic modules shared by the browser (Vite alias
// `@import-core`) and the Supabase Edge Functions (relative imports).
//
// Hard rules (spec §14.2):
//   - No DOM, Node or Deno APIs, no network, no clock beyond arguments.
//   - Every normalizer is a pure function and idempotent.
//   - One implementation, two runtimes.
//
// M0 ships the registry and limits. Later milestones add, in this folder:
//   canonicalize.js  normalizers.js  enums.js  verify.js  validate.js
//   dedupe.js  yaml-contract.js  status.js

export * from './field-registry.js';
export * from './limits.js';
