import { formatUpdateNudge, maybeRefreshBrainRules, maybeRefreshInBackground, readUpdateCache } from './upkeep.js';
/**
 * @param repo    the project dir
 * @param current the running graft's version
 * @param opts.background  false in hook contexts: read the update cache, never
 *   spawn a fetch. Hooks run under a hard timeout and must stay off the network.
 */
export function runUpkeep(repo, current, opts = {}) {
    const lines = [];
    // Repository markers are not consent to rewrite user-level host settings.
    // Wiring is refreshed only by an explicit init/hooks invocation.
    try {
        // Opt-in local mining runs in a child and never delays this session.
        if (opts.background !== false)
            maybeRefreshBrainRules(repo);
    }
    catch { /* same */ }
    try {
        if (opts.background !== false)
            maybeRefreshInBackground(opts.home);
        const nudge = formatUpdateNudge(current, readUpdateCache(opts.home)?.latest);
        if (nudge)
            lines.push(nudge);
    }
    catch { /* same */ }
    return { lines };
}
