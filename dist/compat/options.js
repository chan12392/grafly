/** Shared argument normalization for CLI/workspace parity. */
export function normalizeTraceDepth(value) {
  if (value === "all" || value === "full" || value === "max") return Number.POSITIVE_INFINITY;
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.floor(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return 1;
}
export function splitWorkspaceScope(value, children) {
  if (typeof value !== "string" || value.trim() === "") return { onlyChild: undefined, childIn: undefined };
  const prefix = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const [name, ...rest] = prefix.split("/");
  const known = [...children].sort();
  if (!known.includes(name)) throw new Error(`no workspace repo "${name}" - repos: ${known.join(", ")}`);
  return { onlyChild: name, childIn: rest.length ? rest.join("/") : undefined };
}
