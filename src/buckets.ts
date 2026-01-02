import { type StorageHubClient, filesystemAbi } from "@storagehub-sdk/core";
import { randomUUID } from "node:crypto";
import { parseEventLogs } from "viem";
import type { Hex, Log, PublicClient, RpcLog } from "viem";
import { sleep } from "./helpers/utils.js";
import { ensure0xPrefix } from "./helpers/validation.js";
import { getLogger } from "./log.js";
import type {
  BucketParams,
  CreateBucketResult,
  PolkadotApi,
  WaitForBucketCreationParams,
  WaitForBucketCreationResult,
} from "./types.js";

export const DEFAULT_BLOCK_TIME_MS = 6_000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Format a UTC timestamp as: YYYY-MM-DD-HH-mm-ss
 */
export function formatUtcTimestamp(d = new Date()): string {
  return [
    d.getUTCFullYear(),
    pad2(d.getUTCMonth() + 1),
    pad2(d.getUTCDate()),
    pad2(d.getUTCHours()),
    pad2(d.getUTCMinutes()),
    pad2(d.getUTCSeconds()),
  ].join("-");
}

/**
 * Bucket name format (legible + unique):
 *   artillery-YYYY-MM-DD-HH-mm-ss-vuid-uuid
 *
 * Notes:
 * - timestamp is UTC to avoid timezone surprises
 * - vuid should be stable per VU (we typically use derived `__accountIndex`)
 * - uuid avoids collisions if multiple VUs create buckets in the same second
 */
export function makeBucketName(vuId: string | number, d = new Date()): string {
  const ts = formatUtcTimestamp(d);
  const uuid = randomUUID();
  return `artillery-${ts}-${String(vuId)}-${uuid}`;
}

/**
 * Verify that a BucketCreated event was emitted with the expected parameters.
 */
function verifyBucketCreatedEvent(
  receipt: { logs?: unknown },
  filesystemContractAddress: `0x${string}`,
  expectedWho: `0x${string}`,
  expectedBucketId: `0x${string}`,
  expectedMspId: `0x${string}`
): void {
  const logger = getLogger();
  const logs = receipt.logs;
  if (!Array.isArray(logs)) {
    logger.error(
      { bucketId: expectedBucketId },
      "Receipt logs missing, cannot verify BucketCreated event"
    );
    throw new Error(
      "Receipt logs are missing; cannot verify BucketCreated event"
    );
  }

  logger.debug(
    { bucketId: expectedBucketId, logCount: logs.length },
    "Parsing receipt logs for BucketCreated event"
  );

  const events = parseEventLogs({
    abi: filesystemAbi,
    logs: logs as (Log | RpcLog)[],
    eventName: "BucketCreated",
  });

  logger.debug(
    { bucketId: expectedBucketId, eventCount: events.length },
    "Found BucketCreated events in receipt"
  );

  const match = events.find((e) => {
    const args = e.args as {
      who?: `0x${string}`;
      bucketId?: `0x${string}`;
      mspId?: `0x${string}`;
    };
    return (
      e.address.toLowerCase() === filesystemContractAddress.toLowerCase() &&
      args.who?.toLowerCase() === expectedWho.toLowerCase() &&
      args.bucketId?.toLowerCase() === expectedBucketId.toLowerCase() &&
      args.mspId?.toLowerCase() === expectedMspId.toLowerCase()
    );
  });

  if (!match) {
    logger.error(
      {
        bucketId: expectedBucketId,
        expectedWho,
        expectedMspId,
        totalEvents: events.length,
      },
      "BucketCreated event not found with expected parameters"
    );
    throw new Error(
      `BucketCreated event not found (who=${expectedWho}, bucketId=${expectedBucketId}, mspId=${expectedMspId})`
    );
  }

  logger.info(
    {
      bucketId: expectedBucketId,
      who: expectedWho,
      mspId: expectedMspId,
    },
    "BucketCreated event verified successfully"
  );
}

/**
 * Poll Substrate storage until bucket exists.
 */
async function pollSubstrateStorage(
  userApi: PolkadotApi,
  bucketId: `0x${string}`,
  retries: number,
  delayMs: number
): Promise<void> {
  const logger = getLogger();

  logger.debug(
    { bucketId, retries, delayMs },
    "Starting Substrate storage polling for bucket"
  );

  for (let attempt = 0; attempt <= retries; attempt++) {
    logger.debug(
      { bucketId, attempt, maxRetries: retries },
      "Polling Substrate storage for bucket"
    );

    const bucketOpt = await userApi.query.providers.buckets(bucketId);
    if (bucketOpt?.isSome) {
      logger.info(
        { bucketId, attempt, totalAttempts: attempt + 1 },
        "Bucket found in Substrate storage"
      );
      return;
    }

    if (attempt < retries) {
      logger.debug(
        { bucketId, attempt, waitingMs: delayMs },
        "Bucket not found yet, waiting before retry"
      );
      await sleep(delayMs);
    }
  }

  logger.error(
    { bucketId, retries, delayMs, totalAttempts: retries + 1 },
    "Bucket not visible in Substrate storage after all retries"
  );
  throw new Error(
    `Bucket not visible in Substrate storage after receipt (bucketId=${bucketId}, retries=${retries}, delayMs=${delayMs})`
  );
}

/**
 * Wait for a bucket creation tx to be confirmed:
 * 1. Wait for transaction receipt and verify success
 * 2. Verify BucketCreated event was emitted with expected parameters
 * 3. Optionally poll Substrate storage until bucket exists
 */
export async function waitForBucketCreation(
  params: WaitForBucketCreationParams
): Promise<WaitForBucketCreationResult> {
  const logger = getLogger();
  const startTime = Date.now();

  logger.info(
    {
      bucketId: params.bucketId,
      txHash: params.txHash,
      expectedWho: params.expectedWho,
    },
    "Starting bucket creation wait"
  );

  // Optional: wait for tx in pool before waiting for receipt
  if (params.waitForTxInPool) {
    logger.debug({ bucketId: params.bucketId }, "Waiting for tx in pool");
    await params.waitForTxInPool();
  }

  // 1) Wait for receipt and assert success
  logger.debug(
    { bucketId: params.bucketId, txHash: params.txHash },
    "Waiting for transaction receipt"
  );
  const receipt = await params.publicClient.waitForTransactionReceipt({
    hash: params.txHash,
  });
  const receiptTime = Date.now() - startTime;
  const status = (receipt as { status?: unknown }).status;

  logger.info(
    {
      bucketId: params.bucketId,
      txHash: params.txHash,
      status,
      blockNumber: (receipt as { blockNumber?: unknown }).blockNumber,
      elapsedMs: receiptTime,
    },
    "Transaction receipt received"
  );

  if (status !== "success") {
    logger.error(
      { bucketId: params.bucketId, txHash: params.txHash, status },
      "Bucket creation transaction failed"
    );
    throw new Error(
      `Create bucket transaction failed (status=${String(status)})`
    );
  }

  // 2) Verify BucketCreated event
  logger.debug({ bucketId: params.bucketId }, "Verifying BucketCreated event");
  verifyBucketCreatedEvent(
    receipt,
    params.filesystemContractAddress,
    params.expectedWho,
    params.bucketId,
    params.expectedMspId
  );

  // 3) Optional: poll Substrate storage until bucket exists
  if (params.userApi) {
    logger.debug(
      { bucketId: params.bucketId },
      "Starting Substrate storage verification"
    );
    await pollSubstrateStorage(
      params.userApi,
      params.bucketId,
      params.retries ?? 3,
      params.delayMs ?? DEFAULT_BLOCK_TIME_MS
    );
  } else {
    logger.debug(
      { bucketId: params.bucketId },
      "Skipping Substrate storage verification (no userApi)"
    );
  }

  const totalTime = Date.now() - startTime;
  logger.info(
    {
      bucketId: params.bucketId,
      txHash: params.txHash,
      totalElapsedMs: totalTime,
      receiptMs: receiptTime,
    },
    "Bucket creation completed successfully"
  );

  return { receipt };
}

/**
 * Minimal bucket creation flow:
 * - derive bucketId from account + name
 * - submit createBucket tx
 * - wait for EVM receipt and verify BucketCreated event
 * - optionally poll Substrate storage (if userApi provided)
 */
export async function createBucket(
  storageHubClient: StorageHubClient,
  publicClient: PublicClient,
  filesystemContractAddress: `0x${string}`,
  params: BucketParams,
  userApi?: PolkadotApi
): Promise<CreateBucketResult> {
  // 1) Derive bucketId
  const bucketIdPromise = storageHubClient.deriveBucketId(
    params.accountAddress,
    params.bucketName
  );
  if (!bucketIdPromise) throw new Error("deriveBucketId returned undefined");
  const bucketIdRaw = await bucketIdPromise;
  if (typeof bucketIdRaw !== "string") {
    throw new Error("deriveBucketId returned non-string value");
  }
  const bucketId = ensure0xPrefix(bucketIdRaw, 32);

  // 2) Submit tx
  const txHash = await storageHubClient.createBucket(
    params.mspId,
    params.bucketName,
    params.isPrivate,
    params.valuePropId
  );

  if (!txHash) throw new Error("createBucket returned empty txHash");

  // 3) Wait for confirmation (all checks happen in waitForBucketCreation)
  const { receipt } = await waitForBucketCreation({
    publicClient,
    txHash,
    bucketId,
    filesystemContractAddress,
    expectedWho: params.accountAddress,
    expectedMspId: params.mspId,
    userApi, // optional: if provided, also polls Substrate storage
  });

  return {
    bucketName: params.bucketName,
    bucketId,
    txHash,
    receipt,
    mspId: params.mspId,
    valuePropId: params.valuePropId,
  };
}
