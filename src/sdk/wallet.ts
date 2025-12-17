import {
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { NetworkConfig } from "../networks.js";

export type WalletInitResult = Readonly<{
  chain: Chain;
  walletClient: WalletClient;
  address: `0x${string}`;
}>;

export function to0xPrivateKey(raw: string): `0x${string}` {
  return raw.startsWith("0x")
    ? (raw as `0x${string}`)
    : (`0x${raw}` as `0x${string}`);
}

export function initWalletFromPrivateKey(
  network: NetworkConfig,
  privateKey: `0x${string}`
): WalletInitResult {
  const chain = defineChain({
    id: network.chain.id,
    name: network.chain.name,
    network: network.name,
    nativeCurrency: { name: "Token", symbol: "TOKEN", decimals: 18 },
    rpcUrls: { default: { http: [network.chain.evmRpcUrl] } },
  });

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    chain,
    account,
    transport: http(network.chain.evmRpcUrl),
  });

  return { chain, walletClient, address: account.address };
}
