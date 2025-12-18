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

export type ContextVars = Record<string, unknown> | undefined;

let sequentialCounter = 0;

function asInt(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isInteger(n) ? n : undefined;
  }
  return undefined;
}

function readInt(vars: ContextVars, key: string): number | undefined {
  return asInt(vars?.[key]);
}

function readString(vars: ContextVars, key: string): string | undefined {
  const raw = vars?.[key];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return undefined;
}

function requireInt(vars: ContextVars, key: string): number {
  const n = readInt(vars, key);
  if (typeof n !== "number") {
    throw new Error(`Missing or invalid integer var: ${key}`);
  }
  return n;
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
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG constants
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export function selectAccountIndex(vars: ContextVars): AccountIndexSelection {
  // Cache: keep index stable for the duration of the VU.
  const cached = readInt(vars, "__accountIndex");
  if (typeof cached === "number" && cached >= 0) {
    const cachedModeRaw = readString(vars, "__accountMode") ?? "byIndex";
    const cachedMode = ((): AccountMode => {
      try {
        return normalizeMode(cachedModeRaw);
      } catch {
        return "byIndex";
      }
    })();
    const cachedSource = readString(vars, "__accountIndexSource") ?? "cached";
    return { mode: cachedMode, index: cached, source: `cached (${cachedSource})` };
  }

  const mode = normalizeMode(readString(vars, "ACCOUNT_MODE"));

  if (mode === "byIndex") {
    // Payload override is allowed:
    const fromPayload = readInt(vars, "accountIndex");
    if (typeof fromPayload === "number") {
      if (fromPayload < 0) throw new Error("accountIndex must be >= 0");
      return { mode, index: fromPayload, source: "payload:accountIndex" };
    }

    const fromYaml = requireInt(vars, "ACCOUNT_INDEX");
    if (fromYaml < 0) throw new Error("ACCOUNT_INDEX must be >= 0");
    return { mode, index: fromYaml, source: "variables:ACCOUNT_INDEX" };
  }

  const start = requireInt(vars, "ACCOUNT_INDEX_START");
  const count = requireInt(vars, "ACCOUNT_INDEX_COUNT");
  if (start < 0) throw new Error("ACCOUNT_INDEX_START must be >= 0");
  if (count <= 0) throw new Error("ACCOUNT_INDEX_COUNT must be > 0");

  const workerOffset = parseWorkerIndex(process.env.ARTILLERY_WORKER_INDEX);

  if (mode === "sequential") {
    const local = sequentialCounter++;
    const idx = start + ((local + workerOffset) % count);
    if (idx < 0) throw new Error("Derived index must be >= 0");
    return {
      mode,
      index: idx,
      source: `sequential(local=${local}, workerOffset=${workerOffset})`,
    };
  }

  // random
  const seed = readInt(vars, "ACCOUNT_RANDOM_SEED");
  const rnd = typeof seed === "number" ? lcg(seed + workerOffset) : Math.random;
  const pick = Math.floor(rnd() * count);
  const idx = start + pick;
  if (idx < 0) throw new Error("Derived index must be >= 0");
  return {
    mode,
    index: idx,
    source:
      typeof seed === "number"
        ? `random(seed=${seed}, workerOffset=${workerOffset})`
        : `random(unseeded, workerOffset=${workerOffset})`,
  };
}

export function cacheAccountIndex(vars: Record<string, unknown>, selection: AccountIndexSelection): void {
  vars.__accountIndex = selection.index;
  vars.__accountMode = selection.mode;
  vars.__accountIndexSource = selection.source;
}


