import type { Hex, PublicClient } from "viem";

/**
 * Minimal interface for Polkadot ApiPromise - only what we need for bucket operations.
 * This avoids importing the full @polkadot/api types which have complex generics.
 */
export interface PolkadotApi {
  query: {
    providers: {
      buckets: (bucketId: `0x${string}`) => Promise<{
        isSome: boolean;
      }>;
    };
    fileSystem: {
      storageRequests: (fileKey: `0x${string}`) => Promise<{
        isSome: boolean;
      }>;
    };
  };
}

/**
 * Parameters for bucket creation operations.
 */
export type BucketParams = Readonly<{
  accountAddress: `0x${string}`;
  bucketName: string;
  mspId: `0x${string}`;
  valuePropId: `0x${string}`;
  isPrivate: boolean;
}>;

/**
 * Result of a successful bucket creation.
 */
export type CreateBucketResult = Readonly<{
  bucketName: string;
  bucketId: `0x${string}`;
  txHash: Hex;
  receipt: unknown;
  mspId: unknown;
  valuePropId: unknown;
}>;

/**
 * Parameters for waiting for bucket creation confirmation.
 */
export type WaitForBucketCreationParams = Readonly<{
  publicClient: PublicClient;
  txHash: Hex;
  bucketId: `0x${string}`;
  filesystemContractAddress: `0x${string}`;
  expectedWho: `0x${string}`;
  expectedMspId: `0x${string}`;
  /**
   * Optional: if provided, also poll Substrate storage until bucket exists.
   * If omitted, only EVM receipt + event check is performed.
   */
  userApi?: PolkadotApi | undefined;
  /**
   * Optional: wait until the tx is observed in the pool before waiting for receipt.
   * (Useful in deterministic test rigs that expose a txpool wait primitive.)
   */
  waitForTxInPool?: () => Promise<void>;
  /**
   * Number of retries for the Substrate storage check (total checks = retries + 1).
   * Only used if userApi is provided. Default: 3.
   */
  retries?: number;
  /**
   * Delay between Substrate storage check retries. Default: 6000ms (block time).
   * Only used if userApi is provided.
   */
  delayMs?: number;
}>;

/**
 * Result of waiting for bucket creation confirmation.
 */
export type WaitForBucketCreationResult = Readonly<{
  receipt: unknown;
}>;

/**
 * Resource metadata entry for files under `resources/`.
 *
 */
export type ResourceEntry = Readonly<{
  /** Repo-root relative path to the file (POSIX-style, e.g. `resources/images/adolphus.jpg`) */
  path: string;
  /** Basename of the file */
  fileName: string;
  /** Size in bytes */
  sizeBytes: number;
  /** Merkle fingerprint (root) */
  fingerprint: `0x${string}`;
}>;
