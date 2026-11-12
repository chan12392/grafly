// Hook hosts use different shells; refuse expansion characters before emitting commands.
export function quoteHookPath(path) {
    if (/["\x60$%!\r\n]/.test(path)) throw new Error("Hook paths cannot contain shell expansion characters");
    return '"' + path.replaceAll("\\", "/") + '"';
}
