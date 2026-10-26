/** Host-owned argument rewrite. Only a single literal external command is eligible. */
import { fileURLToPath } from 'node:url';
import { classifyCommand } from './runner.js';

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

export function routeInput(host, tool, args, { shell = process.platform === 'win32' ? 'powershell' : 'bash', node = process.execPath } = {}) {
    if (!ROUTE_HOSTS.has(host) || !args || typeof args !== 'object'
        || args.tty || args.pty || args.background || args.interactive
        || process.env.GRAFLY_NO_TOOL_ROUTE === '1') return null;
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
    // These names are PowerShell aliases, not the external programs they resemble.
    if (ps && ['cat', 'ls', 'where', 'find'].includes(name)) return null;
    // .cmd/.bat require another shell on Windows; do not change their quoting.
    if (process.platform === 'win32' && /^(npm|pnpm|yarn)(\.(cmd|bat))?$/.test(name)) return null;
    const q = ps ? value => "'" + value.replaceAll("'", "''") + "'"
        : value => "'" + value.replaceAll("'", "'\\''") + "'";
    const paths = !ps && process.platform === 'win32' ? [node, entry].map(p => p.replaceAll('\\', '/')) : [node, entry];
    const routed = (ps ? '& ' : '') + [...paths, 'run', '--', ...argv].map(q).join(' ')
        + (ps ? '; exit $LASTEXITCODE' : '');
    return { ...args, [key]: routed };
}

export function routeHook(host, input) {
    // Codex requires an allow decision to rewrite. Only do that in an already
    // non-asking mode: enabling this hook must never grant new approval rights.
    if (host === 'codex' && !['dontAsk', 'bypassPermissions'].includes(input.permission_mode)) return {};
    const args = input.tool_input ?? input.toolInput ?? input.args;
    const updated = routeInput(host, input.tool_name ?? input.toolName, args,
        { shell: input.shell || (host === 'codex' && process.platform === 'win32' ? 'powershell' : 'bash') });
    if (!updated) return {};
    if (host === 'hermes') return { action: 'modify', args: updated };
    return { hookSpecificOutput: { hookEventName: 'PreToolUse',
        ...(host === 'codex' ? { permissionDecision: 'allow' } : {}), updatedInput: updated } };
}
