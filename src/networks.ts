export type NetworkName = "testnet" | "stagenet" | "local";

export type NetworkConfig = Readonly<{
  name: NetworkName;
  chain: Readonly<{
    id: number;
    name: string;
    nativeCurrency: Readonly<{
      name: string;
      symbol: string;
      decimals: number;
    }>;
    evmRpcUrl: string;
    substrateWsUrl: `${"ws" | "wss"}://${string}`;
    filesystemPrecompileAddress: `0x${string}`;
  }>;
  msp: Readonly<{
    baseUrl: string;
    timeoutMs?: number;
    siweDomain: string;
    siweUri: string;
  }>;
}>;

// IMPORTANT:
// - These are intentionally hardcoded so the harness is deterministic in CI.
// - Fill in the real URLs/IDs for your environments.
export const NETWORKS: Readonly<Record<NetworkName, NetworkConfig>> = {
  testnet: {
    name: "testnet",
    chain: {
      id: 55931,
      name: "DataHaven Testnet",
      nativeCurrency: { name: "DH Testnet", symbol: "MOCK", decimals: 18 },
      evmRpcUrl: "https://services.datahaven-testnet.network/testnet",
      substrateWsUrl: "wss://services.datahaven-testnet.network/testnet",
      filesystemPrecompileAddress: "0x0000000000000000000000000000000000000404",
    },
    msp: {
      baseUrl: "https://deo-dh-backend.testnet.datahaven-infra.network",
      timeoutMs: 30_000,
      siweDomain: "deo-dh-backend.testnet.datahaven-infra.network",
      siweUri: "https://deo-dh-backend.testnet.datahaven-infra.network",
    },
  },
  stagenet: {
    name: "stagenet",
    chain: {
      id: 55932,
      name: "DataHaven Stagenet",
      nativeCurrency: { name: "DH Stagenet", symbol: "STAGE", decimals: 18 },
      evmRpcUrl: "https://services.datahaven-dev.network/stagenet",
      substrateWsUrl: "wss://services.datahaven-dev.network/stagenet",
      filesystemPrecompileAddress: "0x0000000000000000000000000000000000000404",
    },
    msp: {
      baseUrl: "https://deo-dh-backend.stagenet.datahaven-infra.network",
      timeoutMs: 60_000,
      siweDomain: "deo-dh-backend.stagenet.datahaven-infra.network",
      siweUri: "https://deo-dh-backend.stagenet.datahaven-infra.network",
    },
  },
  local: {
    name: "local",
    chain: {
      id: 181222,
      name: "StorageHub Solochain EVM",
      nativeCurrency: { name: "StorageHub", symbol: "SH", decimals: 18 },
      evmRpcUrl: "http://127.0.0.1:9888",
      substrateWsUrl: "ws://127.0.0.1:9888",
      filesystemPrecompileAddress: "0x0000000000000000000000000000000000000064",
    },
    msp: {
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 60_000,
      siweDomain: "localhost:3001",
      siweUri: "http://localhost:3001",
    },
  },
} as const;

export function parseNetworkName(raw: string): NetworkName {
  if (raw === "testnet" || raw === "stagenet" || raw === "local") {
    return raw;
  }
  throw new Error(
    `Invalid NETWORK: ${raw} (expected 'testnet', 'stagenet' or 'local')`
  );
}
