import {
  requireDict,
  requireInteger,
  requireNonEmptyString,
  type Dict,
} from "./validation.js";

export type AccountMode = "byIndex" | "sequential" | "random";

export type AccountIndexSelection = Readonly<{
  mode: AccountMode;
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
 * Why:
 * `context.vars` is an untyped runtime boundary (Artillery), so we validate once up-front
 * and then operate on a typed structure.
 */

export type ParsedAccountIndexConfig =
  | Readonly<{ mode: "byIndex"; accountIndex: number; source: string }>
  | Readonly<{ mode: "sequential"; start: number; count: number }>
  | Readonly<{ mode: "random"; start: number; count: number; seed?: number }>;

export function parseAccountIndexConfig(
  rawVars: unknown
): ParsedAccountIndexConfig {
  const vars = requireDict(rawVars, "context.vars");

  const modeRaw = requireNonEmptyString(vars.ACCOUNT_MODE, "ACCOUNT_MODE");
  if (
    modeRaw !== "byIndex" &&
    modeRaw !== "sequential" &&
    modeRaw !== "random"
  ) {
    throw new Error(
      `Missing or invalid ACCOUNT_MODE: ${modeRaw} (expected 'byIndex', 'sequential', or 'random')`
    );
  }

  if (modeRaw === "byIndex") {
    // Payload override is allowed (if present):
    if (vars.accountIndex !== undefined) {
      const idx = requireInteger(vars.accountIndex, "accountIndex");
      if (idx < 0) throw new Error("accountIndex must be >= 0");
      return {
        mode: "byIndex",
        accountIndex: idx,
        source: "payload:accountIndex",
      };
    }

    const idx = requireInteger(vars.ACCOUNT_INDEX, "ACCOUNT_INDEX");
    if (idx < 0) throw new Error("ACCOUNT_INDEX must be >= 0");
    return {
      mode: "byIndex",
      accountIndex: idx,
      source: "variables:ACCOUNT_INDEX",
    };
  }

  const start = requireInteger(vars.ACCOUNT_INDEX_START, "ACCOUNT_INDEX_START");
  const count = requireInteger(vars.ACCOUNT_INDEX_COUNT, "ACCOUNT_INDEX_COUNT");
  if (start < 0) throw new Error("ACCOUNT_INDEX_START must be >= 0");
  if (count <= 0) throw new Error("ACCOUNT_INDEX_COUNT must be > 0");

  if (modeRaw === "sequential") {
    return { mode: "sequential", start, count };
  }

  // random
  if (vars.ACCOUNT_RANDOM_SEED !== undefined) {
    const seed = requireInteger(
      vars.ACCOUNT_RANDOM_SEED,
      "ACCOUNT_RANDOM_SEED"
    );
    return { mode: "random", start, count, seed };
  }
  return { mode: "random", start, count };
}

function normalizeMode(raw: unknown): AccountMode {
  if (raw === "byIndex" || raw === "sequential" || raw === "random") return raw;
  throw new Error(
    `Missing or invalid ACCOUNT_MODE: ${String(
      raw
    )} (expected 'byIndex', 'sequential', or 'random')`
  );
}

function parseWorkerIndex(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 1-based in our parallel runner; convert to 0-based offset.
  return n - 1;
}

/**
 * Simple seeded PRNG (Linear Congruential Generator).
 *
 * - Deterministic: same seed => same sequence
 * - Not cryptographically secure (fine for load-test user selection)
 * - Returns values in [0, 1)
 *
 * Used only when `ACCOUNT_MODE=random` and `ACCOUNT_RANDOM_SEED` is set, so test runs
 * are reproducible.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG constants
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export function selectAccountIndex(rawVars: unknown): AccountIndexSelection {
  // Entry point: `context.vars` must be an object; fail fast on misconfigured scenarios/callers.
  const vars = requireDict(rawVars, "context.vars");

  // Cache: keep index stable for the duration of the VU.
  if (vars.__accountIndex !== undefined) {
    const cached = requireInteger(vars.__accountIndex, "__accountIndex");
    if (cached < 0) throw new Error("__accountIndex must be >= 0");

    const cachedModeRaw = requireNonEmptyString(
      vars.__accountMode ?? "byIndex",
      "__accountMode"
    );
    const cachedMode = normalizeMode(cachedModeRaw);

    const cachedSource = requireNonEmptyString(
      vars.__accountIndexSource ?? "cached",
      "__accountIndexSource"
    );

    return {
      mode: cachedMode,
      index: cached,
      source: `cached (${cachedSource})`,
    };
  }

  // Strict entry point: validate once, then operate on typed config.
  const cfg = parseAccountIndexConfig(vars);

  const workerOffset = parseWorkerIndex(process.env.ARTILLERY_WORKER_INDEX);

  if (cfg.mode === "byIndex") {
    return {
      mode: "byIndex",
      index: cfg.accountIndex,
      source: cfg.source,
    };
  }

  if (cfg.mode === "sequential") {
    const local = sequentialCounter++;
    const idx = cfg.start + ((local + workerOffset) % cfg.count);
    if (idx < 0) throw new Error("Derived index must be >= 0");
    return {
      mode: "sequential",
      index: idx,
      source: `sequential(local=${local}, workerOffset=${workerOffset})`,
    };
  }

  // random
  const rnd =
    typeof cfg.seed === "number" ? lcg(cfg.seed + workerOffset) : Math.random;
  const pick = Math.floor(rnd() * cfg.count);
  const idx = cfg.start + pick;
  if (idx < 0) throw new Error("Derived index must be >= 0");
  return {
    mode: "random",
    index: idx,
    source:
      typeof cfg.seed === "number"
        ? `random(seed=${cfg.seed}, workerOffset=${workerOffset})`
        : `random(unseeded, workerOffset=${workerOffset})`,
  };
}

export function cacheAccountIndex(
  vars: Record<string, unknown>,
  selection: AccountIndexSelection
): void {
  vars.__accountIndex = selection.index;
  vars.__accountMode = selection.mode;
  vars.__accountIndexSource = selection.source;
}
