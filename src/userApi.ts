import "@storagehub/api-augment"; // must be first import (side-effect type augmentation)

import { ApiPromise, WsProvider } from "@polkadot/api";
import { types as storagehubTypesBundle } from "@storagehub/types-bundle";
import type { NetworkConfig } from "./networks.js";
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
  const api = await ApiPromise.create({
    provider,
    noInitWarn: true,
    typesBundle: storagehubTypesBundle,
  });

  // Fail fast if we connect to an endpoint without the expected pallet metadata.
  // (The TS augmentation only affects compile-time types; runtime is metadata-driven.)
  await api.isReady;
  const q = (
    api as unknown as {
      query?: { fileSystem?: { storageRequests?: unknown } };
    }
  ).query;
  if (typeof q?.fileSystem?.storageRequests !== "function") {
    throw new Error(
      `Connected node metadata is missing fileSystem.storageRequests (endpoint=${network.chain.substrateWsUrl}). Ensure you're connecting to a StorageHub chain/spec that includes the fileSystem pallet.`
    );
  }

  return api;
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
