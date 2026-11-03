export declare const TELEMETRY_DOC_URL = "https://github.com/chan12392/grafly/blob/master/TELEMETRY.md";
export declare const NOTICE: string;
/**
 * The notice text the first time it is due, then null forever after. Marks it as
 * shown before returning, so two concurrent commands print it at most twice
 * rather than every time.
 */
export declare function firstRunNotice(home?: string, env?: NodeJS.ProcessEnv): string | null;
/** `graft telemetry status`. `env` is a test seam, as elsewhere in this module —
 *  a real run must be gated on the real `DO_NOT_TRACK` and CI variables. */
export declare function formatStatus(home?: string, env?: NodeJS.ProcessEnv): string;
/**
 * `graft telemetry debug` — Next.js's `NEXT_TELEMETRY_DEBUG` and Astro's
 * `DEBUG=astro:telemetry` in command form. Prints the pending queue and the
 * literal JSON body a flush would POST, and sends nothing. The point is that a
 * user never has to take our word for the contract.
 */
export declare function formatDebug(home?: string): string;
