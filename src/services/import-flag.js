// The import agent is deliberately unavailable while the CPU-only runtime is
// rebuilt. This module is the single client-side gate: it never asks the
// server, so no stale setting, cached response or deployment can turn the
// entry back on. The rebuild will replace this file with the new engine's
// availability check.

const DISABLED_STATE = Object.freeze({
    enabled: false,
    engine: 'off',
    localEnabled: false,
    localProfile: null,
    localConfig: null,
});

/** Kept for callers that used to clear the session cache. */
export function clearImportFlagCache() {}

/** Always false: the feature is disabled by construction, not by config. */
export async function loadImportEnabled() {
    return false;
}

/** Always the disabled state. */
export async function loadImportState() {
    return DISABLED_STATE;
}