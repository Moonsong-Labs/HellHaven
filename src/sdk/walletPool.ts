import type { NetworkConfig } from "../networks.js";
import { loadPrivateKeys } from "../privateKeys.js";
import {
  initWalletFromPrivateKey,
  to0xPrivateKey,
  type WalletInitResult,
} from "./wallet.js";

export type WalletPool = Readonly<{
  sourcePath: string;
  wallets: ReadonlyArray<WalletInitResult>;
  size: number;
}>;

function readPoolSizeLimit(): number | undefined {
  const raw = process.env.WALLET_POOL_SIZE;
  if (!raw) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid WALLET_POOL_SIZE: ${raw} (expected positive integer)`
    );
  }
  return n;
}

function buildPoolKey(network: NetworkConfig, sourcePath: string): string {
  return `${network.name}::${sourcePath}`;
}

const pools = new Map<string, { pool: WalletPool; nextIdx: number }>();

export function getWalletPool(network: NetworkConfig): WalletPool {
  const { keys, sourcePath } = loadPrivateKeys();
  const key = buildPoolKey(network, sourcePath);
  const existing = pools.get(key);
  if (existing) {
    return existing.pool;
  }

  const limit = readPoolSizeLimit();
  const selected = limit ? keys.slice(0, Math.min(limit, keys.length)) : keys;
  const wallets = selected.map((k) =>
    initWalletFromPrivateKey(network, to0xPrivateKey(k))
  );

  const pool: WalletPool = {
    sourcePath,
    wallets,
    size: wallets.length,
  };

  pools.set(key, { pool, nextIdx: 0 });
  return pool;
}

export function nextWalletFromPool(network: NetworkConfig): WalletInitResult {
  const pool = getWalletPool(network);
  const key = buildPoolKey(network, pool.sourcePath);
  const entry = pools.get(key);
  if (!entry) {
    // Should never happen because getWalletPool creates it
    throw new Error("Wallet pool not initialized");
  }

  const idx = entry.nextIdx % pool.wallets.length;
  const wallet = pool.wallets[idx];
  if (!wallet) {
    throw new Error(`Wallet pool is empty (source: ${pool.sourcePath})`);
  }
  entry.nextIdx += 1;
  return wallet;
}
