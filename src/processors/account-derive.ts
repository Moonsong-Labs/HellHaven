import {
  cacheAccountIndex,
  requireAccountIndexRange,
  selectAccountIndex,
} from "../helpers/accountIndex.js";
import { deriveAccountFromMnemonic } from "../helpers/accounts.js";
import {
  ensureVars,
  requireVarString,
  persistVars,
  type ArtilleryContext,
  type ArtilleryEvents,
  type Done,
} from "../helpers/artillery.js";
import { toError } from "../helpers/errors.js";
import { readNumberEnv } from "../helpers/validation.js";
import { getLogger } from "../log.js";
import { createEmitter } from "../helpers/metrics.js";

/**
 * Fetch the next unique account index from the local index allocator service.
 *
 * - `scripts/run-with-logs.ts` starts a tiny HTTP server per test run.
 * - It exposes `GET /next` which returns `{ index: 0 }`, `{ index: 1 }`, ...
 * - This is how we guarantee global uniqueness/sequentiality across Artillery VUs,
 *   even when Artillery runs VUs in multiple isolated JS sandboxes (where in-process
 *   counters or payload sequencing can duplicate).
 *
 * Timeout behavior:
 * - Controlled by `INDEX_ALLOCATOR_TIMEOUT_MS` (default 2000ms)
 * - Implemented via `AbortController` to avoid hanging a VU indefinitely.
 */
async function fetchNextIndex(): Promise<number> {
  const baseUrl = process.env.INDEX_ALLOCATOR_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      "Missing INDEX_ALLOCATOR_URL (index allocator not running)"
    );
  }

  const ms = readNumberEnv("INDEX_ALLOCATOR_TIMEOUT_MS", 2000);

  const res = await fetch(`${baseUrl}/next`, {
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) {
    throw new Error(`allocator /next failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (!body || typeof body !== "object") {
    throw new Error("allocator response is not an object");
  }
  const idx = (body as { index?: unknown }).index;
  if (!Number.isInteger(idx) || (idx as number) < 0) {
    throw new Error(`allocator returned invalid index: ${String(idx)}`);
  }
  return idx as number;
}

/**
 * Processor step:
 * - pick an index (allocator if enabled, else ACCOUNT_MODE vars)
 * - derive account from TEST_MNEMONIC
 * - store derived privateKey + derivation info into context.vars
 */
export async function deriveAccount(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  try {
    const m = createEmitter(context, events);
    const logger = getLogger();
    const vars = ensureVars(context);

    // Idempotency: keep VU identity stable.
    //
    // Even though many scenarios call `deriveAccount` only once per VU, Artillery can execute
    // the same VU flow multiple times (loops/repeats/long-lived VUs). This guard prevents
    // accidentally deriving a *new* account for the same VU on subsequent iterations.
    const existingPk = vars.privateKey;
    const existingAddr = vars.__accountAddress;
    const existingIndex = vars.__accountIndex;
    if (
      typeof existingPk === "string" &&
      typeof existingAddr === "string" &&
      typeof existingIndex === "number" &&
      Number.isInteger(existingIndex) &&
      existingIndex >= 0
    ) {
      logger.debug(
        { address: existingAddr, hasIndex: typeof vars.__accountIndex === "number" },
        "deriveAccount: already derived for this VU (skipping)"
      );
      m.counter("init.derive.ok", 1);
      m.histogram("init.derive.ms", Date.now() - start);
      done?.();
      return;
    }

    const mnemonic =
      process.env.TEST_MNEMONIC?.trim() ??
      requireVarString(vars, "TEST_MNEMONIC");

    // Cache: keep index stable for the duration of the VU.
    let selection = selectAccountIndex(vars);
    if (process.env.INDEX_ALLOCATOR_URL?.trim()) {
      // When allocator is enabled, override the selection once per VU
      // (this avoids duplicates caused by Artillery sandboxing).
      if (!Number.isInteger(vars.__accountIndex)) {
        const allocatorIdx = await fetchNextIndex();

        // Apply modulo to respect ACCOUNT_INDEX_COUNT (cycle through account range)
        const { start, count } = requireAccountIndexRange(vars);
        const idx = start + (allocatorIdx % count);

        selection = {
          mode: "byIndex",
          index: idx,
          source: `allocator:/next(raw=${allocatorIdx})`,
        };
        persistVars(context, { __allocatorRawIndex: allocatorIdx });
      }
    }
    cacheAccountIndex(vars, selection);

    const derived = deriveAccountFromMnemonic(mnemonic, selection.index);
    if (!derived.privateKey) {
      throw new Error("Derived account has no privateKey available");
    }

    persistVars(context, {
      privateKey: derived.privateKey,
      __accountAddress: derived.account.address,
      __derivationPath: derived.derivation.path,
    });

    logger.info(
      {
        index: selection.index,
        path: derived.derivation.path,
        address: derived.account.address,
        source: selection.source,
      },
      "Derived account"
    );

    m.counter("init.derive.ok", 1);
    m.histogram("init.derive.ms", Date.now() - start);
    done?.();
  } catch (err) {
    try {
      const logger = getLogger();
      logger.error({ err }, "deriveAccount failed");
    } catch {
      // ignore logger failures
    }
    const m = createEmitter(context, events);
    m.counter("init.derive.err", 1);
    done?.(toError(err));
  }
}
