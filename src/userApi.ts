import { ApiPromise, WsProvider } from "@polkadot/api";
import type { NetworkConfig } from "./networks.js";
import { sleep } from "./helpers/utils.js";
import { readNumberEnv } from "./helpers/validation.js";

function readAutoConnectEnv(
  key: string,
  fallback: number | false
): number | false {
  const raw = process.env[key];
  if (!raw) return fallback;
  const s = raw.trim().toLowerCase();
  if (s === "false" || s === "0" || s === "off") return false;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normHex(x: unknown): string {
  return String(x).toLowerCase().replace(/^0x/, "");
}

type StorageRequestOpt = Readonly<{ isSome: boolean }>;

type ApiWithStorageRequests = ApiPromise & {
  query: {
    fileSystem: {
      storageRequests: (fileKey: `0x${string}`) => Promise<StorageRequestOpt>;
    };
  };
};

type EventRecordLite = Readonly<{
  event: Readonly<{
    section: string;
    method: string;
    data: readonly unknown[];
  }>;
}>;

type ApiWithFinalizedEvents = ApiPromise & {
  rpc: {
    chain: {
      subscribeFinalizedHeads: (
        cb: (header: Readonly<{ number: unknown }>) => void | Promise<void>
      ) => Promise<() => void>;
      getBlockHash: (n: unknown) => Promise<unknown>;
    };
  };
  query: {
    system: {
      events: {
        at: (hash: unknown) => Promise<readonly EventRecordLite[]>;
      };
    };
  };
};

/**
 * Create a Polkadot ApiPromise connected to the network's Substrate WS endpoint.
 *
 * Usage:
 *   const api = await createUserApi(network);
 *   const bucketOpt = await api.query.providers.buckets(bucketId);
 *   assert(bucketOpt.isSome, "Bucket should exist");
 *   await api.disconnect();
 *
 * Requirements:
 * - `network.chain.substrateWsUrl` must be reachable
 * - You must have `@polkadot/api` installed
 */
export async function createUserApi(
  network: NetworkConfig
): Promise<ApiPromise> {
  type CreateOpts = NonNullable<Parameters<typeof ApiPromise.create>[0]>;
  type Provider = NonNullable<CreateOpts["provider"]>;
  // Defaults match our observed failure mode (60s timeouts) but with a safer baseline for load tests:
  // - request timeout: increase beyond 60s to avoid spurious "No response received in 60s"
  // - autoConnectMs: retry delay between reconnect attempts (acts as backoff)
  const timeoutMs = readNumberEnv("SUBSTRATE_WS_TIMEOUT_MS", 180_000);
  const autoConnectMs = readAutoConnectEnv("SUBSTRATE_WS_RECONNECT_MS", 2_000);

  const provider = new WsProvider(
    network.chain.substrateWsUrl,
    autoConnectMs,
    undefined,
    timeoutMs,
    undefined,
    null
  ) as unknown as Provider;
  return await ApiPromise.create({ provider, noInitWarn: true });
}

// ---- Singleton (per process, per WS URL) ----
//
// Artillery runs many VUs in the same Node worker process; connecting/disconnecting an
// ApiPromise per step creates a lot of WS churn and amplifies RPC timeouts.
// This singleton keeps one ApiPromise per network WS URL for the lifetime of the process.
const USER_API_SINGLETONS = new Map<string, Promise<ApiPromise>>();

export async function getUserApiSingleton(
  network: NetworkConfig
): Promise<ApiPromise> {
  const key = network.chain.substrateWsUrl;
  const existing = USER_API_SINGLETONS.get(key);
  if (existing) return existing;

  const p = createUserApi(network).catch((err) => {
    // If creation failed, allow later retries.
    USER_API_SINGLETONS.delete(key);
    throw err;
  });
  USER_API_SINGLETONS.set(key, p);
  return p;
}

export async function disconnectUserApiSingleton(
  network: NetworkConfig
): Promise<void> {
  const key = network.chain.substrateWsUrl;
  const p = USER_API_SINGLETONS.get(key);
  if (!p) return;
  USER_API_SINGLETONS.delete(key);
  const api = await p;
  await api.disconnect();
}

export type PollParams = Readonly<{
  timeoutMs?: number;
  intervalMs?: number;
}>;

function toBigIntBlockNumber(x: unknown): bigint {
  // `header.number` is typically a BN-like Codec with `toString()`
  const s = String((x as { toString?: () => string })?.toString?.() ?? x);
  // Substrate block numbers are integers; guard against "0x.." etc by forcing base-10 parse.
  // BigInt("123") works; BigInt("0x..") also works, but we don't expect hex here.
  return BigInt(s);
}

/**
 * Wait until the chain's *finalized* head reaches at least `minBlockNumber`.
 *
 * This is useful when downstream systems (like MSP backends) only react to finalized blocks.
 */
export async function waitForFinalizedAtLeast(
  api: ApiPromise,
  minBlockNumber: bigint,
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const a = api as unknown as ApiWithFinalizedEvents;

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for finalized head >= ${minBlockNumber.toString()}`
        )
      );
    }, timeoutMs);

    let unsub: (() => void) | undefined;

    const stop = (err?: unknown) => {
      try {
        clearTimeout(t);
      } finally {
        try {
          unsub?.();
        } catch {
          // ignore
        }
      }
      if (err) reject(err);
      else resolve();
    };

    (async () => {
      unsub = await a.rpc.chain.subscribeFinalizedHeads((header) => {
        try {
          if (Date.now() > deadline) {
            stop(
              new Error(
                `Timed out waiting for finalized head >= ${minBlockNumber.toString()}`
              )
            );
            return;
          }
          const n = toBigIntBlockNumber(header.number);
          if (n >= minBlockNumber) stop();
        } catch (err) {
          stop(err);
        }
      });
    })().catch(stop);
  });
}

/**
 * Poll Substrate storage until `fileSystem.storageRequests(fileKey)` is Some.
 */
export async function waitForStorageRequestExistsOnChain(
  api: ApiPromise,
  fileKey: `0x${string}`,
  params: PollParams = {}
): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const intervalMs = params.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  const a = api as unknown as ApiWithStorageRequests;
  while (Date.now() < deadline) {
    const opt = await a.query.fileSystem.storageRequests(fileKey);
    if (opt.isSome) return;
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for on-chain storage request (fileKey=${fileKey})`
  );
}

/**
 * Wait for a finalized `fileSystem.StorageRequestFulfilled(fileKey)` event.
 *
 * This is the strongest chain-level confirmation that the storage request was fulfilled.
 */
export async function waitForStorageRequestFulfilledFinalized(
  api: ApiPromise,
  fileKey: `0x${string}`,
  timeoutMs = 660_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const a = api as unknown as ApiWithFinalizedEvents;

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for finalized StorageRequestFulfilled (fileKey=${fileKey})`
        )
      );
    }, timeoutMs);

    let unsub: (() => void) | undefined;

    const stop = (err?: unknown) => {
      try {
        clearTimeout(t);
      } finally {
        try {
          unsub?.();
        } catch {
          // ignore
        }
      }
      if (err) reject(err);
      else resolve();
    };

    (async () => {
      unsub = await a.rpc.chain.subscribeFinalizedHeads(
        async (header: Readonly<{ number: unknown }>) => {
          try {
            if (Date.now() > deadline) {
              stop(
                new Error(
                  `Timed out waiting for finalized StorageRequestFulfilled (fileKey=${fileKey})`
                )
              );
              return;
            }

            const hash = await a.rpc.chain.getBlockHash(header.number);
            const records = await a.query.system.events.at(hash);

            for (const r of records) {
              const ev = r.event;
              if (String(ev.section) !== "fileSystem") continue;
              if (String(ev.method) !== "StorageRequestFulfilled") continue;

              const data0 = ev.data[0];
              if (normHex(data0) === normHex(fileKey)) {
                stop();
                return;
              }
            }
          } catch (err) {
            stop(err);
          }
        }
      );
    })().catch(stop);
  });
}
