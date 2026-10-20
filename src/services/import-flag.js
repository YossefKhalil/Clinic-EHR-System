// The import agent's feature flag lives in `ai_settings.enabled` (the
// `import_agent_enabled` switch), a service-role-only table. The browser can
// only ask the `import-job` function for it: a tiny `enabled` action returns
// `{ enabled }` without touching a job. Failures keep the caller's default
// (shown), mirroring the v1 behaviour: a flaky network must never hide a
// working feature.

import { supabase, getCurrentUser } from './supabase.js';

let cached = null;

/** Forget the session cache after an admin changes the enable switch. */
export function clearImportFlagCache() {
    cached = null;
}

/**
 * True/false when the server answered; null when the check could not run.
 * The answer is cached for the session, so page navigation stays cheap.
 */
export async function loadImportEnabled({ force = false } = {}) {
    if (cached !== null && !force) return cached;
    try {
        const client = supabase();
        if (!client || !getCurrentUser()) return null;
        const { data, error } = await client.functions.invoke('import-job', {
            body: { action: 'enabled' },
        });
        if (error) return null;
        if (typeof data?.enabled === 'boolean') cached = data.enabled;
        return cached;
    } catch {
        return null;
    }
}
