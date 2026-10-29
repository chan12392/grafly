/** Shared argument normalization for CLI/workspace parity. */
export function splitWorkspaceScope(value, children) {
  if (typeof value !== "string" || value.trim() === "") return { onlyChild: undefined, childIn: undefined };
  const prefix = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const [name, ...rest] = prefix.split("/");
  const known = [...children].sort();
  if (!known.includes(name)) throw new Error(`no workspace repo "${name}" - repos: ${known.join(", ")}`);
  return { onlyChild: name, childIn: rest.length ? rest.join("/") : undefined };
}
