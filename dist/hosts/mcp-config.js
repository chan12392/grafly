/**
 * Register the Grafly MCP server in each host's config.
 * JSON hosts get a keyed merge (other servers preserved; unparseable files
 * are never rewritten). The TOML host gets an append-if-absent section.
 *
 * `mcpTargets()` is the pure "which files would this touch" half, so `graft
 * init --dry-run` and the picker can report paths without writing;
 * `registerMcpConfigs()` walks that same list to do the writing.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readJsonObject } from './config-write.js';
/** Canonical MCP launch. Never fall back to the upstream Graft package. */
const BIN_LAUNCH = { command: 'grafly', args: ['mcp'] };
export function serverEntry(opts = {}) {
    void opts;
    return BIN_LAUNCH;
}
function opencodeEntry() {
    const { command, args } = serverEntry();
    return { type: 'local', command: [command, ...args], enabled: true };
}
function dirExists(p) {
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
export function mergeJsonKey(id, path, topKey, entry) {
    const loaded = readJsonObject(path);
    if (loaded === 'unparseable')
        return { id, path, action: 'skipped-unparseable' };
    const { root, existed } = loaded;
    const bucket = (root[topKey] ??= {});
    if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) {
        return { id, path, action: 'skipped-unparseable' };
    }
    if (JSON.stringify(bucket.grafly) === JSON.stringify(entry) && !('graft' in bucket))
        return { id, path, action: 'unchanged' };
    const action = existed ? 'updated' : 'created';
    bucket.grafly = entry;
    if ('graft' in bucket)
        delete bucket.graft;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
    return { id, path, action };
}
/** Canonical and legacy MCP table headers. */
const TOML_HEADER = '[mcp_servers.grafly]';
const LEGACY_TOML_HEADER = '[mcp_servers.graft]';
/**
 * Remove either Grafly's canonical table or the legacy Graft table.
 *
 * Line-based on purpose: a real parse-and-reserialize would reformat the user's
 * whole file. The table runs from its header to the next `[`-header or EOF, which
 * is exactly the shape {@link upsertCodexToml} appends. Exported so the writer and
 * `retract.ts` can never disagree about what "graft's section" means.
 */
export function stripTomlSection(text) {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => {
        const t = l.trim();
        return t === TOML_HEADER || t === LEGACY_TOML_HEADER;
    });
    if (start === -1)
        return { rest: text, found: false };
    let end = start + 1;
    while (end < lines.length && !lines[end].trimStart().startsWith('['))
        end++;
    const rest = [...lines.slice(0, start), ...lines.slice(end)]
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '');
    return { rest, found: true };
}
/**
 * Register Grafly in a TOML config, replacing any section a previous version left.
 *
 * The old behaviour was to skip entirely once the header existed, which froze the
 * launch command at whatever the first init wrote: a repo wired when graft wasn't
 * on PATH kept the slow `npx` form forever, and no upgrade could correct it. Strip
 * and re-append instead, so this converges like every other writer — foreign
 * tables are untouched either way.
 */
function upsertCodexToml(id, path) {
    const existed = existsSync(path);
    const text = existed ? readFileSync(path, 'utf8') : '';
    const { command, args } = serverEntry();
    const argList = args.map((a) => JSON.stringify(a)).join(", ");
    const section = `${TOML_HEADER}\ncommand = \"${command}\"\nargs = [${argList}]\n`;
    const { rest, found } = stripTomlSection(text);
    // Byte-identical already: don't rewrite the file just to reorder it.
    if (found && text === appendSection(rest, section))
        return { id, path, action: 'unchanged' };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, appendSection(rest, section));
    return { id, path, action: existed ? 'updated' : 'created' };
}
/** Append a section after exactly one blank line, or at the top of an empty file. */
function appendSection(text, section) {
    if (text.trim() === '')
        return section;
    const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return `${text}${sep}${section}`;
}
function jsonTarget(hostId, id, path, topKey, entry, scope = 'repo') {
    return { hostId, id, path, scope, kind: 'mcp', what: `${topKey}.grafly`, format: 'json', topKey, entry };
}
/**
 * The MCP config files selecting these hosts would touch — pure, no writes.
 * Codex's target is the user-level `~/.codex/config.toml`, so it is scoped
 * 'global': registering there affects every project on the machine.
 */
export function mcpTargets(repo, ids, opts = {}) {
    const home = opts.home ?? homedir();
    const entry = serverEntry();
    const out = [];
    for (const id of ids) {
        switch (id) {
            case 'cursor':
                out.push(jsonTarget(id, id, join(repo, '.cursor', 'mcp.json'), 'mcpServers', entry));
                break;
            case 'gemini':
                out.push(jsonTarget(id, id, join(repo, '.gemini', 'settings.json'), 'mcpServers', entry));
                break;
            case 'antigravity':
                // Antigravity reads MCP from its OWN registry, separate from Gemini CLI's
                // `.gemini/settings.json` — a global `~/.gemini/config/mcp_config.json` (the
                // gap #62 reported). Standard `{command,args}` under `mcpServers`. Global
                // scope: it applies to every workspace opened in Antigravity.
                out.push(jsonTarget(id, 'antigravity', join(home, '.gemini', 'config', 'mcp_config.json'), 'mcpServers', entry, 'global'));
                break;
            case 'kiro':
                out.push(jsonTarget(id, id, join(repo, '.kiro', 'settings', 'mcp.json'), 'mcpServers', entry));
                break;
            case 'grok':
                // Grok reads MCP from repo-level `.grok/config.toml` (`[mcp_servers.<name>]`),
                // the same TOML shape Codex uses at ~/.codex/config.toml.
                out.push({
                    hostId: id, id: 'grok', path: join(repo, '.grok', 'config.toml'),
                    scope: 'repo', kind: 'mcp', what: '[mcp_servers.grafly]', format: 'toml',
                });
                break;
            case 'agents':
                // Guarded on the CLI actually being installed, so a plan only ever
                // lists files a real run would touch.
                if (dirExists(join(home, '.codex'))) {
                    out.push({
                        hostId: id, id: 'codex', path: join(home, '.codex', 'config.toml'),
                        scope: 'global', kind: 'mcp', what: '[mcp_servers.grafly]', format: 'toml',
                    });
                }
                if (dirExists(join(home, '.config', 'opencode'))) {
                    out.push(jsonTarget(id, 'opencode', join(repo, 'opencode.json'), 'mcp', opencodeEntry()));
                }
                break;
            default:
                break; // copilot / windsurf / adal: no MCP target in this phase
        }
    }
    return out;
}
export function registerMcpConfigs(repo, ids, opts = {}) {
    return mcpTargets(repo, ids, opts)
        .filter((t) => opts.global !== false || t.scope !== 'global')
        .map((t) => t.format === 'toml'
        ? upsertCodexToml(t.id, t.path)
        : mergeJsonKey(t.id, t.path, t.topKey, t.entry));
}
