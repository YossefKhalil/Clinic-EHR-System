// import-core — pure, deterministic modules shared by the browser (Vite alias
// `@import-core`) and the Supabase Edge Functions (relative imports).
//
// Hard rules (spec §14.2):
//   - No DOM, Node or Deno APIs, no network, no clock beyond arguments.
//   - Every normalizer is a pure function and idempotent.
//   - One implementation, two runtimes.
//
// M0 ships the registry and limits; M1 adds the rules engine. Later milestones
// add `yaml-contract.js` (M4) and the commit helpers (M6) in this folder.

export * from './field-registry.js';
export * from './limits.js';
export * from './canonicalize.js';
export * from './enums.js';
export * from './issues.js';
export * from './normalizers.js';
export * from './validate.js';
export * from './verify.js';
export * from './dedupe.js';
export * from './status.js';
export * from './pipeline.js';
