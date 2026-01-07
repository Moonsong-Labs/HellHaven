import { ApiPromise, WsProvider } from "@polkadot/api";
import type { NetworkConfig } from "./networks.js";

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
  const provider = new WsProvider(network.chain.substrateWsUrl);
  return await ApiPromise.create({ provider });
}
