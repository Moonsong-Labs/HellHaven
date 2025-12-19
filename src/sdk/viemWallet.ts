import {
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type WalletClient,
} from "viem";
import type { Account } from "viem/accounts";
import type { NetworkConfig } from "../networks.js";

export type ViemChainAndTransport = Readonly<{
  chain: Chain;
  transportUrl: string;
}>;

export function toViemChain(network: NetworkConfig): ViemChainAndTransport {
  const chain = defineChain({
    id: network.chain.id,
    name: network.chain.name,
    network: network.name,
    nativeCurrency: network.chain.nativeCurrency,
    rpcUrls: { default: { http: [network.chain.evmRpcUrl] } },
  });

  return { chain, transportUrl: network.chain.evmRpcUrl };
}

export function createViemWallet(
  network: NetworkConfig,
  account: Account
): WalletClient {
  const { chain, transportUrl } = toViemChain(network);
  return createWalletClient({
    chain,
    account,
    transport: http(transportUrl),
  });
}
