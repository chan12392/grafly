/** Host-owned argument rewrite. Only a single literal external command is eligible. */
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { classifyCommand } from './runner.js';
import { gateNativeRead } from './conditional.js';
import { canServeReadCommand } from './output.js';

export const ROUTE_HOSTS = new Set(['codex', 'devin', 'hermes']);
const entry = fileURLToPath(new URL('./cli.js', import.meta.url));

// This is deliberately a literal-command recognizer, not a shell parser. Shell
// expressions, pipelines, substitutions, redirects and persistent shell state
// must remain with the host. Never hide a command in base64 from approval hooks.
export function literalArgv(command, shell = 'powershell') {
    if (typeof command !== 'string' || command.length > 32768 || /[\r\n\0]/.test(command)) return null;
    let text = command.trim();
    const ps = /powershell|pwsh/i.test(shell);
    if (ps && text.startsWith('& ')) text = text.slice(2).trimStart();
    const words = []; let word = '', quote = '', started = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote) {
                if (ps && quote === "'" && text[i + 1] === "'") { word += "'"; i++; }
                else quote = '';
            } else {
                if (quote === '"' && /[$`]/.test(c)) return null;
                if (!ps && quote === '"' && c === '\\') return null;
                if (/[\r\n\0]/.test(c)) return null;
                word += c;
            }
            continue;
        }
        if (/\s/.test(c)) { if (started) { words.push(word); word = ''; started = false; } continue; }
        if (c === "'" || c === '"') { quote = c; started = true; continue; }
        if (/[;&|<>$`(){}\[\]*?!#@,~%\r\n\0]/.test(c) || (!ps && c === '\\')) return null;
        word += c; started = true;
    }
    if (quote) return null;
    if (started) words.push(word);
    return words.length ? words : null;
}

export function routeInput(host, tool, args, { shell = process.platform === 'win32' ? 'powershell' : 'bash', node = process.execPath, sessionId } = {}) {
    if (!ROUTE_HOSTS.has(host) || !args || typeof args !== 'object'
        || args.tty || args.pty || args.background || args.interactive
        || process.env.GRAFLY_NO_TOOL_ROUTE === '1' || process.env.GRAFLY_TOOL_OUTPUT === '0') return null;
    const names = { codex: ['bash', 'exec_command', 'shell', 'shell_command'], devin: ['exec', 'shell'], hermes: ['terminal'] };
    if (!names[host].includes(String(tool).toLowerCase())) return null;
    const key = typeof args.command === 'string' ? 'command' : typeof args.cmd === 'string' ? 'cmd' : null;
    if (!key) return null;
    const effectiveShell = args.shell || shell;
    if (!/(?:^|[\\/])(?:powershell|pwsh|bash|sh|zsh)(?:\.exe)?$/i.test(effectiveShell)) return null;
    const argv = literalArgv(args[key], effectiveShell);
    if (!argv || !classifyCommand(argv[0], argv.slice(1))) return null;
    const ps = /powershell|pwsh/i.test(effectiveShell);
    const name = argv[0].replaceAll('\\', '/').split('/').at(-1).toLowerCase();
    // Shell builtins can't be spawned, and PowerShell aliases aren't the
    // programs they resemble — only route them when readPath can serve the
    // exact invocation form, otherwise the host runs them raw as before.
    if (!ps && ['type', 'get-content', 'gc'].includes(name)) return null;
    if (ps && ['ls', 'where', 'find'].includes(name)) return null;
    if (ps && ['cat', 'type', 'get-content', 'gc', 'more'].includes(name)) {
        if (!canServeReadCommand(argv[0], argv.slice(1))) return null;
    }
    // .cmd/.bat require another shell on Windows; do not change their quoting.
    if (process.platform === 'win32' && /^(npm|pnpm|yarn)(\.(cmd|bat))?$/.test(name)) return null;
    const q = ps ? value => "'" + value.replaceAll("'", "''") + "'"
        : value => "'" + value.replaceAll("'", "'\\''") + "'";
    const paths = !ps && process.platform === 'win32' ? [node, entry].map(p => p.replaceAll('\\', '/')) : [node, entry];
    const sessionArgs = sessionId === null ? ['--session-id='] : sessionId ? ['--session-id', sessionId] : [];
    const routed = (ps ? '& ' : '') + [...paths, 'run', ...sessionArgs, '--', ...argv].map(q).join(' ')
        + (ps ? '; exit $LASTEXITCODE' : '');
    return { ...args, [key]: routed };
}

/** Deny a repeat native read when the session already holds the file — the
 *  reason carries the freshness answer and the `grafly read` escape hatch. */
function routeReadGate(host, tool, args, cwd, sessionId) {
    if (host !== 'devin' || tool !== 'read' || !args) return null;
    const raw = args.file_path;
    if (typeof raw !== 'string' || !raw.length) return null;
    const full = isAbsolute(raw) ? raw : resolve(cwd ?? process.cwd(), raw);
    const whole = !['offset', 'limit']
        .some(k => args[k] !== undefined);
    const verdict = gateNativeRead(full, { whole, sessionId });
    if (!verdict.deny) return null;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse',
        permissionDecision: 'deny', permissionDecisionReason: verdict.reason } };
}

export function routeHook(host, input) {
    if (process.env.GRAFLY_NO_TOOL_ROUTE === '1' || process.env.GRAFLY_TOOL_OUTPUT === '0') return {};
    const rawSession = input.session_id ?? input.sessionId ?? input.thread_id;
    const sessionId = typeof rawSession === 'string' && rawSession.trim() ? `${host}:${rawSession.trim()}` : null;
    const args = input.tool_input ?? input.toolInput ?? input.args;
    const tool = input.tool_name ?? input.toolName;
    // Codex requires an allow decision to rewrite. Only do that in an already
    // non-asking mode: enabling this hook must never grant new approval rights.
    // (The read gate below is a deny — it restricts, so no mode gate applies.)
    const mayRewrite = host !== 'codex' || ['dontAsk', 'bypassPermissions'].includes(input.permission_mode);
    if (mayRewrite) {
        const updated = routeInput(host, tool, args,
            { shell: input.shell || (host === 'codex' && process.platform === 'win32' ? 'powershell' : 'bash'), sessionId });
        if (updated) {
            if (host === 'hermes') return { action: 'modify', args: updated };
            return { hookSpecificOutput: { hookEventName: 'PreToolUse',
                ...(host === 'codex' ? { permissionDecision: 'allow' } : {}), updatedInput: updated } };
        }
    }
    const gated = routeReadGate(host, tool, args, input.cwd ?? input.workdir, sessionId);
    return gated ?? {};
}
