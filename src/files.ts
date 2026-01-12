import {
  type StorageHubClient,
  filesystemAbi,
  FileMetadata,
  FileTrie,
  type FileInfo,
  hexToBytes,
  initWasm,
  ReplicationLevel,
  type EvmWriteOptions,
} from "@storagehub-sdk/core";
import type {
  MspClient,
  StorageFileInfo,
  UploadReceipt,
  UploadOptions,
} from "@storagehub-sdk/msp-client";
import { randomFillSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { parseEventLogs } from "viem";
import type { Hex, Log, PublicClient, RpcLog } from "viem";
import { getLogger } from "./log.js";
import type { PolkadotApi } from "./types.js";
import { DEFAULT_BLOCK_TIME_MS } from "./buckets.js";
import { sleep } from "./helpers/utils.js";

// Re-export SDK types for convenience
export type { FileInfo, UploadReceipt, UploadOptions };
export { ReplicationLevel };

let wasmInitPromise: Promise<void> | undefined;
async function ensureWasmReady(): Promise<void> {
  wasmInitPromise ??= initWasm();
  await wasmInitPromise;
}

function bytesTo0x(bytes: Uint8Array): `0x${string}` {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Stream a file from disk as a Web ReadableStream (no buffering in memory).
 *
 * This shape is accepted by `mspClient.files.uploadFile(...)`.
 */
export function filePathToWebStream(
  filePath: string
): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(filePath);
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

export async function getFileSizeBytes(filePath: string): Promise<number> {
  const s = await stat(filePath);
  return s.size;
}

/**
 * Compute the StorageHub Merkle fingerprint (root) by streaming the file through the SDK wasm.
 */
export async function computeFileFingerprintFromPath(
  filePath: string
): Promise<`0x${string}`> {
  await ensureWasmReady();
  const trie = new FileTrie();

  // Use a larger read buffer to reduce JS overhead; the wasm will re-chunk canonically.
  const rs = createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 });
  for await (const chunk of rs) {
    const u8 =
      chunk instanceof Uint8Array
        ? chunk
        : new Uint8Array(chunk as ArrayBuffer);
    trie.push_chunks_batched(u8);
  }

  const root = trie.get_root();
  return bytesTo0x(root);
}

/**
 * Compute the on-chain fileKey from FileMetadata (wasm).
 *
 * Note: this does NOT read file bytes; it relies on caller-provided fingerprint + size.
 */
export async function computeFileKeyFromMetadata(params: {
  owner: `0x${string}`; // 20-byte EVM address
  bucketId: `0x${string}`; // 32-byte bucketId
  location: string;
  size: bigint;
  fingerprint: `0x${string}`; // 32-byte fingerprint
}): Promise<`0x${string}`> {
  await ensureWasmReady();

  const ownerBytes = hexToBytes(params.owner);
  const bucketBytes = hexToBytes(params.bucketId);
  const fingerprintBytes = hexToBytes(params.fingerprint);
  const locationBytes = new TextEncoder().encode(params.location);

  const md = new FileMetadata(
    ownerBytes,
    bucketBytes,
    locationBytes,
    params.size,
    fingerprintBytes
  );
  return bytesTo0x(md.getFileKey());
}

/**
 * Generate a random binary file on disk without holding it in memory.
 *
 * Useful for very large payloads (GBs). You can then upload it by streaming from disk.
 */
export async function generateRandomFileOnDisk(params: {
  filePath: string;
  sizeBytes: number;
  chunkBytes?: number;
}): Promise<void> {
  const chunkBytes = params.chunkBytes ?? 8 * 1024 * 1024;
  await mkdir(dirname(params.filePath), { recursive: true });

  const ws = createWriteStream(params.filePath);
  const buf = Buffer.allocUnsafe(chunkBytes);

  let remaining = params.sizeBytes;
  while (remaining > 0) {
    const n = Math.min(remaining, chunkBytes);
    randomFillSync(buf.subarray(0, n));
    if (!ws.write(buf.subarray(0, n))) {
      await new Promise<void>((resolve) => ws.once("drain", resolve));
    }
    remaining -= n;
  }

  await new Promise<void>((resolve, reject) => {
    ws.end(() => resolve());
    ws.on("error", reject);
  });
}

/**
 * Parameters for issuing a storage request.
 * Wraps StorageHubClient.issueStorageRequest with additional context.
 */
export type IssueStorageRequestParams = Readonly<{
  accountAddress: `0x${string}`;
  bucketId: `0x${string}`;
  location: string;
  fingerprint: `0x${string}`;
  size: bigint;
  mspId: `0x${string}`;
  peerIds: string[];
  replicationLevel?: ReplicationLevel; // Default: Basic
  replicas?: number; // Required if replicationLevel is Custom
}>;

/**
 * Result of a successful storage request.
 */
export type IssueStorageRequestResult = Readonly<{
  fileKey: `0x${string}`; // Derived file key (deterministic)
  txHash: `0x${string}`;
  receipt: unknown;
  bucketId: `0x${string}`;
  location: string;
}>;

/**
 * Parameters for waiting for storage request confirmation.
 */
export type WaitForStorageRequestParams = Readonly<{
  publicClient: PublicClient;
  txHash: Hex;
  fileKey: `0x${string}`;
  bucketId: `0x${string}`;
  location: string;
  filesystemContractAddress: `0x${string}`;
  expectedWho: `0x${string}`;
  /**
   * Optional: if provided, also poll Substrate storage until storage request exists.
   */
  userApi?: PolkadotApi | undefined;
  /**
   * Number of retries for the Substrate storage check.
   * Only used if userApi is provided. Default: 3.
   */
  retries?: number;
  /**
   * Delay between Substrate storage check retries.
   * Only used if userApi is provided. Default: 6000ms (block time).
   */
  delayMs?: number;
}>;

/**
 * Result of waiting for storage request confirmation.
 */
export type WaitForStorageRequestResult = Readonly<{
  receipt: unknown;
  /**
   * Block number from the EVM receipt, if available.
   * (Viem typically returns this as a bigint.)
   */
  blockNumber: bigint | undefined;
}>;

/**
 * Verify that a NewStorageRequest event was emitted with the expected parameters.
 */
function verifyStorageRequestEvent(
  receipt: { logs?: unknown },
  filesystemContractAddress: `0x${string}`,
  expectedWho: `0x${string}`,
  expectedBucketId: `0x${string}`,
  expectedFileKey: `0x${string}`
): void {
  const logger = getLogger();
  const logs = receipt.logs;
  if (!Array.isArray(logs)) {
    logger.error(
      { bucketId: expectedBucketId, fileKey: expectedFileKey },
      "Receipt logs missing, cannot verify StorageRequestIssued event"
    );
    throw new Error(
      "Receipt logs are missing; cannot verify StorageRequestIssued event"
    );
  }

  logger.debug(
    {
      bucketId: expectedBucketId,
      fileKey: expectedFileKey,
      logCount: logs.length,
    },
    "Parsing receipt logs for StorageRequestIssued event"
  );

  // Parse events from receipt logs
  // The filesystem ABI includes StorageRequestIssued
  const events = parseEventLogs({
    abi: filesystemAbi,
    logs: logs as (Log | RpcLog)[],
    eventName: "StorageRequestIssued",
  });

  logger.debug(
    {
      bucketId: expectedBucketId,
      fileKey: expectedFileKey,
      eventCount: events.length,
    },
    "Found StorageRequestIssued events in receipt"
  );

  // Find matching event for this storage request
  const match = events.find((e) => {
    const args = e.args as {
      who?: `0x${string}`;
      bucketId?: `0x${string}`;
      fileKey?: `0x${string}`;
    };
    return (
      e.address.toLowerCase() === filesystemContractAddress.toLowerCase() &&
      args.who?.toLowerCase() === expectedWho.toLowerCase() &&
      args.bucketId?.toLowerCase() === expectedBucketId.toLowerCase() &&
      args.fileKey?.toLowerCase() === expectedFileKey.toLowerCase()
    );
  });

  if (!match) {
    logger.error(
      {
        bucketId: expectedBucketId,
        fileKey: expectedFileKey,
        expectedWho,
        totalEvents: events.length,
      },
      "StorageRequestIssued event not found with expected parameters"
    );
    throw new Error(
      `StorageRequestIssued event not found (who=${expectedWho}, bucketId=${expectedBucketId}, fileKey=${expectedFileKey})`
    );
  }

  logger.info(
    {
      bucketId: expectedBucketId,
      fileKey: expectedFileKey,
      who: expectedWho,
    },
    "StorageRequestIssued event verified successfully"
  );
}

/**
 * Poll Substrate storage until storage request exists.
 *
 * Note: The actual query path for storage requests in Substrate may vary.
 * For now, we just wait for the specified time to allow the chain to process the request.
 */
async function pollStorageRequest(
  userApi: PolkadotApi,
  fileKey: `0x${string}`,
  retries: number,
  delayMs: number
): Promise<void> {
  const logger = getLogger();

  logger.debug(
    { fileKey, retries, delayMs },
    "Starting Substrate storage polling for storage request (fileKey)"
  );

  for (let attempt = 0; attempt <= retries; attempt++) {
    logger.debug(
      { fileKey, attempt, maxRetries: retries },
      "Polling Substrate storage for storage request (fileKey)"
    );

    const opt = await userApi.query.fileSystem.storageRequests(fileKey);
    if (opt?.isSome) {
      logger.info(
        { fileKey, attempt, totalAttempts: attempt + 1 },
        "Storage request found in Substrate storage"
      );
      return;
    }

    if (attempt < retries) {
      await sleep(delayMs);
    }
  }

  logger.error(
    { fileKey, totalAttempts: retries + 1 },
    "Storage request not visible in Substrate storage after all retries"
  );
  throw new Error(
    `Storage request not visible in Substrate storage after receipt (fileKey=${fileKey}, retries=${retries}, delayMs=${delayMs})`
  );
}

/**
 * Wait for a storage request tx to be confirmed:
 * 1. Wait for transaction receipt and verify success
 * 2. Verify storage request event was emitted
 * 3. Optionally poll Substrate storage
 */
export async function waitForStorageRequest(
  params: WaitForStorageRequestParams
): Promise<WaitForStorageRequestResult> {
  const logger = getLogger();
  const startTime = Date.now();

  logger.info(
    {
      bucketId: params.bucketId,
      location: params.location,
      fileKey: params.fileKey,
      txHash: params.txHash,
      expectedWho: params.expectedWho,
    },
    "Starting storage request wait"
  );

  // 1) Wait for receipt and assert success
  logger.debug(
    {
      bucketId: params.bucketId,
      location: params.location,
      txHash: params.txHash,
    },
    "Waiting for transaction receipt"
  );
  const receipt = await params.publicClient.waitForTransactionReceipt({
    hash: params.txHash,
  });
  const receiptTime = Date.now() - startTime;
  const status = (receipt as { status?: unknown }).status;
  const receiptBlockNumber = (receipt as { blockNumber?: unknown }).blockNumber;
  const blockNumber =
    typeof receiptBlockNumber === "bigint" ? receiptBlockNumber : undefined;

  logger.info(
    {
      bucketId: params.bucketId,
      location: params.location,
      txHash: params.txHash,
      status,
      blockNumber: (receipt as { blockNumber?: unknown }).blockNumber,
      elapsedMs: receiptTime,
    },
    "Transaction receipt received"
  );

  if (status !== "success") {
    logger.error(
      {
        bucketId: params.bucketId,
        location: params.location,
        txHash: params.txHash,
        status,
      },
      "Storage request transaction failed"
    );
    throw new Error(
      `Storage request transaction failed (status=${String(status)})`
    );
  }

  // 2) Verify event
  logger.debug(
    { bucketId: params.bucketId, location: params.location },
    "Verifying storage request event"
  );
  verifyStorageRequestEvent(
    receipt,
    params.filesystemContractAddress,
    params.expectedWho,
    params.bucketId,
    params.fileKey
  );

  // 3) Optional: poll Substrate storage
  if (params.userApi) {
    logger.debug(
      { bucketId: params.bucketId, location: params.location },
      "Starting Substrate storage verification"
    );
    await pollStorageRequest(
      params.userApi,
      params.fileKey,
      params.retries ?? 3,
      params.delayMs ?? DEFAULT_BLOCK_TIME_MS
    );
  } else {
    logger.debug(
      { bucketId: params.bucketId, location: params.location },
      "Skipping Substrate storage verification (no userApi)"
    );
  }

  const totalTime = Date.now() - startTime;
  logger.info(
    {
      bucketId: params.bucketId,
      location: params.location,
      txHash: params.txHash,
      totalElapsedMs: totalTime,
      receiptMs: receiptTime,
    },
    "Storage request completed successfully"
  );

  return { receipt, blockNumber };
}

/**
 * Issue a storage request for a file.
 * This submits an EVM transaction to request storage from an MSP.
 */
export async function issueStorageRequest(
  storageHubClient: StorageHubClient,
  publicClient: PublicClient,
  filesystemContractAddress: `0x${string}`,
  params: IssueStorageRequestParams,
  userApi?: PolkadotApi,
  options?: EvmWriteOptions
): Promise<IssueStorageRequestResult> {
  const logger = getLogger();

  logger.info(
    {
      bucketId: params.bucketId,
      location: params.location,
      size: params.size.toString(),
      replicationLevel: params.replicationLevel ?? ReplicationLevel.Basic,
    },
    "Issuing storage request"
  );

  // Use SDK method with proper parameters
  const replicationLevel = params.replicationLevel ?? ReplicationLevel.Basic;
  const replicas = params.replicas ?? 1;

  // Validate replicas for Custom replication level
  if (replicationLevel === ReplicationLevel.Custom && !params.replicas) {
    throw new Error(
      "replicas parameter is required for ReplicationLevel.Custom"
    );
  }

  const txHash = await storageHubClient.issueStorageRequest(
    params.bucketId,
    params.location,
    params.fingerprint,
    params.size,
    params.mspId,
    params.peerIds,
    replicationLevel,
    replicas,
    options
  );

  if (!txHash) {
    throw new Error("issueStorageRequest returned undefined txHash");
  }

  logger.info(
    { bucketId: params.bucketId, location: params.location, txHash },
    "Storage request transaction submitted"
  );

  const fileKey = await computeFileKeyFromMetadata({
    owner: params.accountAddress,
    bucketId: params.bucketId,
    location: params.location,
    size: params.size,
    fingerprint: params.fingerprint,
  });

  // Wait for confirmation
  const { receipt } = await waitForStorageRequest({
    publicClient,
    txHash,
    fileKey,
    bucketId: params.bucketId,
    location: params.location,
    filesystemContractAddress,
    expectedWho: params.accountAddress,
    userApi,
  });

  logger.info(
    {
      bucketId: params.bucketId,
      location: params.location,
      fileKey,
      txHash,
    },
    "Storage request completed successfully"
  );

  return {
    fileKey,
    txHash,
    receipt,
    bucketId: params.bucketId,
    location: params.location,
  };
}

/**
 * Upload a file to the MSP.
 * This uses the MSP HTTP API to upload file content.
 *
 * Note: The MspClient.files.uploadFile signature is:
 * uploadFile(bucketId, fileKey, file, owner, location, options?)
 */
export async function uploadFile(
  mspClient: MspClient,
  bucketId: string,
  fileKey: string,
  owner: string,
  location: string,
  fileContent: Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
  options?: UploadOptions
): Promise<UploadReceipt> {
  const logger = getLogger();
  const startTime = Date.now();

  const size =
    typeof options?.contentLength === "number"
      ? options.contentLength
      : fileContent instanceof Uint8Array
        ? fileContent.length
        : fileContent instanceof Blob
          ? fileContent.size
          : undefined;

  logger.info(
    {
      bucketId,
      fileKey,
      location,
      owner,
      size,
    },
    "Starting file upload"
  );

  try {
    // Use actual SDK method
    const result = await mspClient.files.uploadFile(
      bucketId,
      fileKey,
      fileContent,
      owner,
      location,
      options
    );

    const elapsed = Date.now() - startTime;
    logger.info(
      {
        bucketId: result.bucketId,
        fileKey: result.fileKey,
        location: result.location,
        fingerprint: result.fingerprint,
        status: result.status,
        elapsedMs: elapsed,
      },
      "File upload completed successfully"
    );

    return result;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(
      {
        err,
        bucketId,
        fileKey,
        location,
        elapsedMs: elapsed,
      },
      "File upload failed"
    );
    throw err;
  }
}

export type WaitForMspFileStatusParams = Readonly<{
  mspClient: MspClient;
  bucketId: string;
  fileKey: string;
  desiredStatus: StorageFileInfo["status"];
  /**
   * Total timeout budget. Default: 2 minutes.
   */
  timeoutMs?: number;
  /**
   * Poll interval. Default: 3000ms.
   */
  intervalMs?: number;
}>;

export type WaitForMspToExpectFileKeyParams = Readonly<{
  mspClient: MspClient;
  bucketId: string;
  fileKey: string;
  /**
   * Total timeout budget. Default: 2 minutes.
   */
  timeoutMs?: number;
  /**
   * Poll interval. Default: 3000ms.
   */
  intervalMs?: number;
}>;

/**
 * Poll MSP until it "expects" (recognizes) a fileKey for a bucket.
 *
 * This is a pre-upload gate to avoid `HTTP 400: MSP is not expecting this file key`
 * when the backend hasn't indexed the finalized storage request yet.
 *
 * Success condition: `mspClient.files.getFileInfo(bucketId, fileKey)` returns a record.
 * Fail-fast: if MSP reports terminal states (expired/revoked/rejected).
 */
export async function waitForMspToExpectFileKey(
  params: WaitForMspToExpectFileKeyParams
): Promise<StorageFileInfo> {
  const logger = getLogger();
  const timeoutMs = params.timeoutMs ?? 120_000;
  const intervalMs = params.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const info = await params.mspClient.files.getFileInfo(
        params.bucketId,
        params.fileKey
      );

      // Fail-fast on terminal-ish states (shouldn't happen in healthy tests).
      if (
        info.status === "expired" ||
        info.status === "revoked" ||
        info.status === "rejected"
      ) {
        throw new Error(
          `MSP file entered terminal state: ${info.status} (bucketId=${params.bucketId}, fileKey=${params.fileKey})`
        );
      }

      logger.info(
        {
          bucketId: params.bucketId,
          fileKey: params.fileKey,
          status: info.status,
          attempts,
        },
        "MSP now expects fileKey"
      );
      return info;
    } catch (err) {
      // MSP not indexed yet; treat as transient until timeout.
      logger.debug(
        { err, bucketId: params.bucketId, fileKey: params.fileKey, attempts },
        "MSP does not expect fileKey yet (will retry)"
      );
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for MSP to expect fileKey (bucketId=${params.bucketId}, fileKey=${params.fileKey}, attempts=${attempts})`
  );
}

/**
 * Poll MSP until a file reaches the desired status (e.g. "ready").
 *
 * Useful to wait for eventual consistency / background processing after upload.
 */
export async function waitForMspFileStatus(
  params: WaitForMspFileStatusParams
): Promise<StorageFileInfo> {
  const logger = getLogger();
  const timeoutMs = params.timeoutMs ?? 120_000;
  const intervalMs = params.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  let lastStatus: string | undefined;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const info = await params.mspClient.files.getFileInfo(
        params.bucketId,
        params.fileKey
      );
      lastStatus = info.status;

      if (info.status === params.desiredStatus) {
        logger.info(
          {
            bucketId: params.bucketId,
            fileKey: params.fileKey,
            status: info.status,
            attempts,
          },
          "MSP file reached desired status"
        );
        return info;
      }

      // Terminal-ish failure states (fail fast)
      if (
        info.status === "expired" ||
        info.status === "revoked" ||
        info.status === "rejected"
      ) {
        throw new Error(
          `MSP file entered terminal state: ${info.status} (bucketId=${params.bucketId}, fileKey=${params.fileKey})`
        );
      }
    } catch (err) {
      // The MSP might not have indexed the file yet; treat as transient until timeout.
      logger.debug(
        { err, bucketId: params.bucketId, fileKey: params.fileKey, attempts },
        "MSP file not ready yet (will retry)"
      );
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for MSP file status=${params.desiredStatus} (bucketId=${params.bucketId}, fileKey=${params.fileKey}, lastStatus=${String(
      lastStatus
    )}, attempts=${attempts})`
  );
}

/**
 * Generate a test file with random content.
 * @param sizeBytes Size of the file in bytes
 * @param prefix Optional prefix for the content
 * @returns Buffer with the file content
 */
export function generateTestFile(
  sizeBytes: number,
  prefix = "test-file"
): Buffer {
  const content = Buffer.alloc(sizeBytes);
  const prefixBytes = Buffer.from(`${prefix}-`);

  // Write prefix at the start
  prefixBytes.copy(content, 0);

  // Fill the rest with random data or pattern
  for (let i = prefixBytes.length; i < sizeBytes; i++) {
    // Use a simple pattern for reproducibility
    content[i] = i % 256;
  }

  return content;
}

/**
 * Generate a unique file path for testing.
 * @param prefix Optional prefix for the file name
 * @returns A unique file path like "test-20260106-143025.bin"
 */
export function generateTestFilePath(prefix = "test"): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}.bin`;
}
