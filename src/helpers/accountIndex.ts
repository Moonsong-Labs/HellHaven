import {
  requireDict,
  requireInteger,
} from "./validation.js";

export type AccountIndexSelection = Readonly<{
  index: number;
  /**
   * Human-readable explanation of how the index was chosen (for logs/debug).
   * Do not include secrets.
   */
  source: string;
}>;

let sequentialCounter = 0;

/**
 * Strict parsing/validation entry point for account-index selection.
 *
 * We only support **sequential** account selection:
 * - Primary path: `scripts/run-scenario.ts` starts a local index allocator and
 *   `deriveAccount` uses it to guarantee uniqueness across VUs.
 * - Fallback path: if running Artillery directly (without the wrapper), we use
 *   local sequential selection based on `ACCOUNT_INDEX_START/COUNT`.
 */

export function parseAccountIndexConfig(
  rawVars: unknown
): Readonly<{ start: number; count: number }> {
  const vars = requireDict(rawVars, "context.vars");

  const start = requireInteger(vars.ACCOUNT_INDEX_START, "ACCOUNT_INDEX_START");
  const count = requireInteger(vars.ACCOUNT_INDEX_COUNT, "ACCOUNT_INDEX_COUNT");
  if (start < 0) throw new Error("ACCOUNT_INDEX_START must be >= 0");
  if (count <= 0) throw new Error("ACCOUNT_INDEX_COUNT must be > 0");

  return { start, count };
}

function parseWorkerIndex(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 1-based in our parallel runner; convert to 0-based offset.
  return n - 1;
}

export function selectAccountIndex(rawVars: unknown): AccountIndexSelection {
  // Entry point: `context.vars` must be an object; fail fast on misconfigured scenarios/callers.
  const vars = requireDict(rawVars, "context.vars");

  // Cache: keep index stable for the duration of the VU.
  if (vars.__accountIndex !== undefined) {
    const cached = requireInteger(vars.__accountIndex, "__accountIndex");
    if (cached < 0) throw new Error("__accountIndex must be >= 0");

    const cachedSourceRaw = vars.__accountIndexSource;
    const cachedSource =
      typeof cachedSourceRaw === "string" && cachedSourceRaw.trim().length > 0
        ? cachedSourceRaw.trim()
        : "cached";

    return {
      index: cached,
      source: `cached (${cachedSource})`,
    };
  }

  // Strict entry point: validate once, then operate on typed config.
  const cfg = parseAccountIndexConfig(vars);
  const workerOffset = parseWorkerIndex(process.env.ARTILLERY_WORKER_INDEX);

  const local = sequentialCounter++;
  const idx = cfg.start + ((local + workerOffset) % cfg.count);
  if (idx < 0) throw new Error("Derived index must be >= 0");
  return {
    index: idx,
    source: `sequential(local=${local}, workerOffset=${workerOffset})`,
  };
}

export function cacheAccountIndex(
  vars: Record<string, unknown>,
  selection: AccountIndexSelection
): void {
  vars.__accountIndex = selection.index;
  vars.__accountIndexSource = selection.source;
}
