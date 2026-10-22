/** Acquire a local process lock; null means busy or uncertain ownership. */
export declare function acquireProcessLock(path: string): (() => void) | null;
