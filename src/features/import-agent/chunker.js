// Pooling and chunking (spec §6) — implementation lives in import-core so the
// Edge Function can reuse it (pasted-text chunking, truncation splits); this
// re-export keeps the browser import path from the repository layout (§14.1).

export * from '@import-core/chunker.js';
