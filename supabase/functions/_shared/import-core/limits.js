// Limits and tunables — defined once, used by the browser and the functions.
//
// The browser checks these for fast feedback; Edge Functions re-check them as
// the real gate (spec §5.1). Deployment-specific overrides come from the
// `import_settings` row (M2) via `resolveLimits()`; nothing in the system may
// hard-code a second copy of any value below.

export const LIMITS = {
    // ---- Intake (spec §5.1, Appendix B) ----
    MAX_FILES: 10,
    MAX_FILE_BYTES: 8 * 1024 * 1024,
    MAX_PDF_PAGES: 20,
    MAX_TEXT_CHARS: 200_000,
    MAX_ROWS: 500,
    MAX_TILES: 30,
    MAX_CHUNKS: 120,
    MAX_HINT_CHARS: 2_000,
    MAX_ZIP_RATIO: 50, // uncompressed/compressed guard (spec §5.2)
    MAX_ZIP_UNCOMPRESSED_BYTES: 100 * 1024 * 1024,

    // ---- Chunking (spec §6.2) ----
    SHEET_CHUNK_ROWS: 15,
    TEXT_CHUNK_TARGET: 3_500,
    TEXT_CHUNK_MAX: 5_000,
    TEXT_CHUNK_OVERLAP_LINES: 2, // when no record boundary exists

    // ---- Image pipeline (spec §5.4) ----
    IMAGE_LONG_SIDE: 2_000,
    JPEG_QUALITY: 0.85,
    TILE_ASPECT_THRESHOLD: 2.2,
    TILE_HEIGHT_RATIO: 1.5, // tile height = ratio × width
    TILE_OVERLAP: 0.12,

    // ---- Pump / leases (spec §9.5) ----
    PUMP_PARALLEL: 3,
    LEASE_SECONDS: 90,
    MAX_ATTEMPTS: 3,

    // ---- Extraction (spec §7) ----
    YAML_MAX_BYTES: 200 * 1024,
    APPROX_TOKENS_PER_RECORD: 300,
    MAX_TOKENS_FLOOR: 1_000,
    MAX_TOKENS_CEILING: 16_000,
    PROVIDER_TIMEOUT_MS: 120_000,
    PROVIDER_MAX_ATTEMPTS: 3, // total attempts per call (spec §7.1: max 3)

    // ---- Verification and normalization (spec §8, Appendix B) ----
    SNAP_DISTANCE_ID: 2,
    SNAP_DISTANCE_MOBILE: 1,
    FUZZY_DISTANCE_SHORT: 1, // 4–7 characters
    FUZZY_DISTANCE_LONG: 2, // 8+ characters
    GROUNDING_TEXT_THRESHOLD: 0.8, // share of tokens that must be found
    PRICE_WARN_ABOVE: 10_000,
    VISIT_DATE_MAX_FUTURE_DAYS: 1,
    VISIT_DATE_MAX_AGE_YEARS: 5,
    DOB_MAX_AGE_YEARS: 120,
    AGE_MAX: 120,
    CHILDREN_MAX: 30,
    CHILDREN_WARN_ABOVE: 15,
    NOTES_MAX_ENTRIES: 20,
    NOTES_MAX_CHARS: 1_000,
    TEXT_MAX_CHARS: 5_000,

    // ---- Persistence, commit, undo (spec §9.7, §11.3, §12) ----
    COMMIT_BATCH_SIZE: 50,
    UNDO_WINDOW_DAYS: 7,
    UNDO_EDIT_TOLERANCE_SECONDS: 300, // updated_at must be within this of committed_at
    STAGING_TTL_DAYS: 7,
    STAGING_TTL_HOURS_AFTER_DONE: 24,
    ROW_RETENTION_DAYS: 30,
    BATCH_PAYLOAD_RETENTION_DAYS: 90,
    EXISTENCE_RPC_MAX_IDS: 500,
    EDIT_HISTORY_DEPTH: 100,

    // ---- Rate limits (spec §13.5) ----
    MAX_CONCURRENT_JOBS: 2,
    JOBS_PER_USER_DAY: 20,
    // JOB_TOKEN_CAP is the fallback when the model context lookup is unavailable.
    // A new job replaces it with the selected model's context window, clamped
    // by these two bounds, so the stop follows the model rather than one number.
    JOB_TOKEN_CAP: 500_000, // stops extraction, keeps what it has (spec §5.1)
    JOB_TOKEN_CAP_MIN: 16_000,
    JOB_TOKEN_CAP_MAX: 2_000_000,
    USER_DAILY_TOKEN_CAP: 2_000_000,

    // ---- Storage formats (decisions D19, §8.3) ----
    PHONE_STORAGE_FORMAT: 'local', // 'local' = 01xxxxxxxxx
};

/**
 * Free OpenRouter models commonly enforce a one-request-at-a-time limit.
 * Pumping three chunks in parallel burns two requests on 429s before the
 * retry policy can help, so free models run sequentially.
 */
export function pumpParallelFor(provider, model, limits = LIMITS) {
    if (provider === 'openrouter' && /:free$/i.test(String(model ?? ''))) return 1;
    return limits.PUMP_PARALLEL;
}

/** Keys a deployment may override through the `import_settings` row. */
export const OVERRIDABLE_KEYS = Object.freeze(Object.keys(LIMITS));

/**
 * Merge deployment overrides over the defaults. Unknown keys are rejected
 * loudly so a typo in settings cannot silently do nothing.
 *
 * @param {Record<string, unknown>} [overrides]
 * @returns {typeof LIMITS}
 */
export function resolveLimits(overrides = {}) {
    const merged = { ...LIMITS };
    for (const [key, value] of Object.entries(overrides)) {
        if (!(key in LIMITS)) {
            throw new Error(`Unknown import limit override: ${key}`);
        }
        if (value === null || value === undefined || value === '') continue;
        merged[key] = value;
    }
    return merged;
}
