import { MspClient, type Session } from "@storagehub-sdk/msp-client";
import { StorageHubClient } from "@storagehub-sdk/core";
import { getLogger } from "../log.js";
import { NETWORKS } from "../networks.js";
import { toError } from "../helpers/errors.js";
import { buildMspHttpClientConfig } from "../sdk/mspHttpConfig.js";
import {
  checkBucketExists,
  createBucket,
  formatUtcTimestamp,
  makeBucketName,
} from "../buckets.js";
import {
  ensureVars,
  getPersistedVar,
  persistVars,
  requireVarString,
  type ArtilleryContext,
  type ArtilleryEvents,
  type Done,
} from "../helpers/artillery.js";
import type { PolkadotApi } from "../types.js";
import { createEmitter } from "../helpers/metrics.js";
import { readEnv } from "../config.js";
import { ensure0xPrefix, readNumberEnv } from "../helpers/validation.js";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient } from "viem";
import {
  createViemHttpTransport,
  createViemWallet,
  toViemChain,
} from "../sdk/viemWallet.js";
import { randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  getUserApiSingleton,
  waitForFinalizedAtLeast,
  waitForStorageRequestExistsOnChain,
  waitForStorageRequestFulfilledFinalized,
} from "../userApi.js";
import { pickSequentialResource } from "../resources/index.js";
import {
  ReplicationLevel,
  computeFileKeyFromMetadata,
  filePathToWebStream,
  uploadFile,
  waitForMspFileStatus,
  waitForMspToExpectFileKey,
  waitForStorageRequest,
} from "../files.js";

const REMOTE_LOCATION = "/";

/**
 * Example action step:
 * - recreate MspClient using the stored session
 * - call getProfile
 *
 * This demonstrates the “init -> actions” split without keeping an MspClient instance in memory.
 */
export async function actionGetProfile(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  try {
    const m = createEmitter(context, events);
    const logger = getLogger();
    const env = readEnv();
    const network = NETWORKS[env.network];

    const session = getPersistedVar(context, "__siweSession") as Session;
    const config = buildMspHttpClientConfig(network);
    const client = await MspClient.connect(config, async () => session);

    const profile = await client.auth.getProfile();
    logger.debug(
      {
        address: session.user.address,
        profile: {
          address: profile.address,
          ens: profile.ens,
        },
      },
      "action getProfile ok"
    );

    m.counter("action.getProfile.ok", 1);
    m.histogram("action.getProfile.ms", Date.now() - start);
    done?.();
  } catch (err) {
    try {
      const logger = getLogger();
      logger.error({ err }, "actionGetProfile failed");
    } catch {
      // ignore logger failures
    }
    const m = createEmitter(context, events);
    m.counter("action.getProfile.err", 1);
    done?.(toError(err));
  }
}

/**
 * Create a single bucket per VU.
 */
export async function actionCreateBucket(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  try {
    const m = createEmitter(context, events);
    const env = readEnv();
    const network = NETWORKS[env.network];

    const vars = ensureVars(context);
    const session = getPersistedVar(context, "__siweSession") as Session;

    const vuId = randomInt(1_000_000_000);

    // Private key is set by `deriveAccount`.
    const pkRaw = requireVarString(vars, "privateKey");
    const pk = ensure0xPrefix(pkRaw, 32).toLowerCase() as `0x${string}`;

    const account = privateKeyToAccount(pk);
    const walletClient = createViemWallet(network, account);
    const { chain, transportUrl } = toViemChain(network);
    const publicClient = createPublicClient({
      chain,
      transport: createViemHttpTransport(transportUrl),
    });

    // Check account balance
    const balance = await publicClient.getBalance({ address: account.address });
    const logger = getLogger();
    logger.info(
      {
        address: account.address,
        balance: balance.toString(),
        balanceEth: (Number(balance) / 1e18).toFixed(6),
      },
      "Account creating bucket"
    );

    const config = buildMspHttpClientConfig(network);
    const mspClient = await MspClient.connect(config, async () => session);

    // Fetch MSP metadata
    const [info, vps] = await Promise.all([
      mspClient.info.getInfo(),
      mspClient.info.getValuePropositions(),
    ]);

    const firstVp = vps[0];
    if (!firstVp) throw new Error("MSP has no value propositions");

    const mspId = ensure0xPrefix(info.mspId, 32);
    const valuePropId = ensure0xPrefix(firstVp.id, 32);

    // Create StorageHubClient for bucket operations
    const storageHubClient = new StorageHubClient({
      rpcUrl: transportUrl,
      chain,
      walletClient,
      filesystemContractAddress: network.chain.filesystemPrecompileAddress,
    });

    await createBucket(
      storageHubClient,
      publicClient,
      network.chain.filesystemPrecompileAddress,
      {
        accountAddress: account.address,
        bucketName: makeBucketName(vuId),
        mspId,
        valuePropId,
        isPrivate: false,
      }
    );

    m.counter("action.createBucket.ok", 1);
    m.histogram("action.createBucket.ms", Date.now() - start);
    done?.();
  } catch (err) {
    getLogger().error({ err }, "actionCreateBucket failed");
    createEmitter(context, events).counter("action.createBucket.err", 1);
    done?.(toError(err));
  }
}

/**
 * Get or create a bucket for file uploads.
 * - First call: generates unique bucket name, creates it, stores in context
 * - Subsequent calls: reads from context, verifies bucket exists on-chain
 * - If bucket missing on-chain: creates it again
 *
 * Stores in context:
 * - __uploadBucketName: string
 * - __uploadBucketId: 0x${string}
 */
export async function actionGetOrCreateBucket(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  const logger = getLogger();
  const m = createEmitter(context, events);

  try {
    const env = readEnv();
    const network = NETWORKS[env.network];
    const vars = ensureVars(context);
    const session = getPersistedVar(context, "__siweSession") as Session;

    // Private key is set by deriveAccount
    const pkRaw = requireVarString(vars, "privateKey");
    const pk = ensure0xPrefix(pkRaw, 32).toLowerCase() as `0x${string}`;
    const account = privateKeyToAccount(pk);

    // 1) Reuse existing bucket if possible
    const existingBucketName = getPersistedVar(context, "__uploadBucketName");
    const existingBucketId = getPersistedVar(context, "__uploadBucketId");
    const existingBucketOwner = getPersistedVar(context, "__uploadBucketOwner");

    if (
      existingBucketName &&
      typeof existingBucketName === "string" &&
      existingBucketId &&
      typeof existingBucketId === "string"
    ) {
      if (
        existingBucketOwner &&
        typeof existingBucketOwner === "string" &&
        existingBucketOwner.toLowerCase() !== account.address.toLowerCase()
      ) {
        logger.warn(
          {
            existingBucketName,
            existingBucketId,
            existingBucketOwner,
            currentOwner: account.address,
          },
          "Bucket in context belongs to a different owner; discarding and creating a new one"
        );
        persistVars(context, {
          __uploadBucketName: undefined,
          __uploadBucketId: undefined,
          __uploadBucketOwner: undefined,
        });
      } else {
        logger.info(
          { bucketName: existingBucketName, bucketId: existingBucketId },
          "Found bucket in context, verifying on-chain"
        );

        const userApi = await getUserApiSingleton(network);
        // Move start acá
        const exists = await checkBucketExists(
          userApi as unknown as PolkadotApi,
          existingBucketId as `0x${string}`
        );

        if (exists) {
          logger.info(
            {
              bucketName: existingBucketName,
              bucketId: existingBucketId,
              owner: account.address,
            },
            "Bucket exists on-chain, reusing"
          );
          m.counter("action.getOrCreateBucket.found", 1);
          m.histogram("action.getOrCreateBucket.ms", Date.now() - start);
          done?.();
          return;
        }

        logger.warn(
          { bucketName: existingBucketName, bucketId: existingBucketId },
          "Bucket in context but not found on-chain, will recreate"
        );
      }
    }

    // 2) Create a new bucket
    logger.info({ address: account.address }, "Creating new upload bucket");

    const walletClient = createViemWallet(network, account);
    const { chain, transportUrl } = toViemChain(network);
    const publicClient = createPublicClient({
      chain,
      transport: createViemHttpTransport(transportUrl),
    });

    const config = buildMspHttpClientConfig(network);
    const mspClient = await MspClient.connect(config, async () => session);

    const [info, vps] = await Promise.all([
      mspClient.info.getInfo(),
      mspClient.info.getValuePropositions(),
    ]);

    const firstVp = vps[0];
    if (!firstVp) throw new Error("MSP has no value propositions");

    const mspId = ensure0xPrefix(info.mspId, 32);
    const valuePropId = ensure0xPrefix(firstVp.id, 32);

    const timestamp = formatUtcTimestamp(new Date());
    const randomSuffix = randomUUID().slice(0, 6);
    const bucketName = `upload-${timestamp}-${randomSuffix}`;

    logger.info(
      { bucketName, address: account.address },
      "Generated bucket name"
    );

    const storageHubClient = new StorageHubClient({
      rpcUrl: transportUrl,
      chain,
      walletClient,
      filesystemContractAddress: network.chain.filesystemPrecompileAddress,
    });

    const bucketIdRaw = await storageHubClient.deriveBucketId(
      account.address,
      bucketName
    );
    if (!bucketIdRaw || typeof bucketIdRaw !== "string") {
      throw new Error("Failed to derive bucket ID");
    }
    const bucketId = ensure0xPrefix(bucketIdRaw, 32);

    // If it already exists, just persist and move on.
    const userApi = await getUserApiSingleton(network);
    const alreadyExists = await checkBucketExists(
      userApi as unknown as PolkadotApi,
      bucketId
    );
    if (alreadyExists) {
      persistVars(context, {
        __uploadBucketName: bucketName,
        __uploadBucketId: bucketId,
        __uploadBucketOwner: account.address,
      });
      m.counter("action.getOrCreateBucket.found", 1);
      m.histogram("action.getOrCreateBucket.ms", Date.now() - start);
      done?.();
      return;
    }

    const result = await createBucket(
      storageHubClient,
      publicClient,
      network.chain.filesystemPrecompileAddress,
      {
        accountAddress: account.address,
        bucketName,
        mspId,
        valuePropId,
        isPrivate: false,
      }
    );

    persistVars(context, {
      __uploadBucketName: result.bucketName,
      __uploadBucketId: result.bucketId,
      __uploadBucketOwner: account.address,
    });

    logger.info(
      { bucketName: result.bucketName, bucketId: result.bucketId },
      "Bucket created and stored in context"
    );

    m.counter("action.getOrCreateBucket.created", 1);
    m.histogram("action.getOrCreateBucket.ms", Date.now() - start);
    done?.();
  } catch (err) {
    logger.error({ err }, "actionGetOrCreateBucket failed");
    m.counter("action.getOrCreateBucket.err", 1);
    done?.(toError(err));
  }
}

/**
 * Issue a storage request for a file.
 * This submits an EVM transaction to request storage from the MSP.
 *
 * Reads from context:
 * - __uploadBucketName
 * - __uploadBucketId
 * - privateKey
 * - __siweSession
 *
 * Stores in context:
 * - __uploadFileKey: the file key/ID for the storage request
 * - __uploadLocation: the file path within the bucket
 * - __uploadLocalFilePath: absolute local file path on disk (NOT the file bytes)
 * - __uploadFileSizeBytes: number
 */
export async function actionIssueStorageRequest(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  const logger = getLogger();
  const m = createEmitter(context, events);

  try {
    const env = readEnv();
    const network = NETWORKS[env.network];
    const vars = ensureVars(context);
    const session = getPersistedVar(context, "__siweSession") as Session;

    // Read bucket info from context
    const bucketName = getPersistedVar(context, "__uploadBucketName");
    const bucketId = getPersistedVar(context, "__uploadBucketId");
    const bucketOwner = getPersistedVar(context, "__uploadBucketOwner");

    if (!bucketName || typeof bucketName !== "string") {
      throw new Error(
        "No __uploadBucketName in context. Run actionGetOrCreateBucket first."
      );
    }

    if (!bucketId || typeof bucketId !== "string") {
      throw new Error(
        "No __uploadBucketId in context. Run actionGetOrCreateBucket first."
      );
    }

    // Get account info
    const pkRaw = requireVarString(vars, "privateKey");
    const pk = ensure0xPrefix(pkRaw, 32).toLowerCase() as `0x${string}`;
    const account = privateKeyToAccount(pk);

    if (
      bucketOwner &&
      typeof bucketOwner === "string" &&
      bucketOwner.toLowerCase() !== account.address.toLowerCase()
    ) {
      throw new Error(
        `Bucket owner mismatch: bucketOwner=${bucketOwner} currentOwner=${account.address}. Run actionGetOrCreateBucket again to create a bucket for this account.`
      );
    }

    const walletClient = createViemWallet(network, account);
    const { chain, transportUrl } = toViemChain(network);

    const config = buildMspHttpClientConfig(network);
    const mspClient = await MspClient.connect(config, async () => session);

    // Fetch MSP metadata
    const info = await mspClient.info.getInfo();
    const mspId = ensure0xPrefix(info.mspId, 32);

    // Get MSP peer IDs from multiaddresses
    const peerIds: string[] = info.multiaddresses
      .map((addr) => {
        // Extract peer ID from multiaddress (typically the last component)
        // Format: /ip4/x.x.x.x/tcp/xxxx/p2p/<peer-id>
        const parts = addr.split("/");
        const peerId = parts[parts.length - 1];
        return peerId || "";
      })
      .filter((id) => id.length > 0);

    const allocatorRaw = vars.__allocatorRawIndex;
    const seq =
      typeof allocatorRaw === "number" && Number.isInteger(allocatorRaw)
        ? allocatorRaw
        : typeof vars.__accountIndex === "number" && Number.isInteger(vars.__accountIndex)
          ? (vars.__accountIndex as number)
          : 0;
    const picked = pickSequentialResource({ sequence: seq });
    const localFilePath = resolve(process.cwd(), picked.path);

    const sizeBytes = picked.sizeBytes;
    const fingerprint = picked.fingerprint;

    const fileKey = await computeFileKeyFromMetadata({
      owner: account.address,
      bucketId: bucketId as `0x${string}`,
      location: REMOTE_LOCATION,
      size: BigInt(sizeBytes),
      fingerprint,
    });

    logger.info(
      {
        bucketId,
        bucketName,
        localFilePath,
        location: REMOTE_LOCATION,
        fileKey,
        sizeBytes,
        fingerprint,
        resource: picked?.path,
        mspId,
        peerIdCount: peerIds.length,
      },
      "Preparing to issue storage request"
    );

    // Create StorageHubClient
    const storageHubClient = new StorageHubClient({
      rpcUrl: transportUrl,
      chain,
      walletClient,
      filesystemContractAddress: network.chain.filesystemPrecompileAddress,
    });

    // Phase A: SR creation (tx submission)
    const createStart = Date.now();
    const txHash = await storageHubClient.issueStorageRequest(
      bucketId as `0x${string}`,
      REMOTE_LOCATION,
      fingerprint,
      BigInt(sizeBytes),
      mspId,
      peerIds,
      ReplicationLevel.Basic,
      1
    );
    if (!txHash)
      throw new Error("issueStorageRequest returned undefined txHash");
    m.histogram(
      "action.issueStorageRequest.create.ms",
      Date.now() - createStart
    );

    // Store file info in context for upload step
    persistVars(context, {
      __uploadFileKey: fileKey,
      __uploadStorageRequestTxHash: txHash,
      __uploadLocation: REMOTE_LOCATION,
      __uploadLocalFilePath: localFilePath,
      __uploadFileSizeBytes: sizeBytes,
      __uploadFingerprint: fingerprint,
      __uploadOwner: account.address,
    });

    m.counter("action.issueStorageRequest.ok", 1);
    m.histogram("action.issueStorageRequest.ms", Date.now() - start);
    done?.();
  } catch (err) {
    logger.error({ err }, "actionIssueStorageRequest failed");
    m.counter("action.issueStorageRequest.err", 1);
    done?.(toError(err));
  }
}

/**
 * Wait for the storage request to be confirmed on-chain:
 * - EVM receipt + NewStorageRequest event
 * - Substrate storage: fileSystem.storageRequests(fileKey) is Some
 *
 * Reads from context:
 * - __uploadBucketId
 * - __uploadFileKey
 * - __uploadLocation
 * - __uploadOwner
 * - __uploadStorageRequestTxHash
 */
export async function actionWaitForStorageRequestOnChain(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  const logger = getLogger();
  const m = createEmitter(context, events);

  try {
    const env = readEnv();
    const network = NETWORKS[env.network];
    const session = getPersistedVar(context, "__siweSession") as Session;

    const bucketId = getPersistedVar(context, "__uploadBucketId");
    const fileKey = getPersistedVar(context, "__uploadFileKey");
    const location = getPersistedVar(context, "__uploadLocation");
    const owner = getPersistedVar(context, "__uploadOwner");
    const txHash = getPersistedVar(context, "__uploadStorageRequestTxHash");

    if (!bucketId || typeof bucketId !== "string") {
      throw new Error(
        "No __uploadBucketId in context. Run actionGetOrCreateBucket first."
      );
    }
    if (!fileKey || typeof fileKey !== "string") {
      throw new Error(
        "No __uploadFileKey in context. Run actionIssueStorageRequest first."
      );
    }
    if (!location || typeof location !== "string") {
      throw new Error(
        "No __uploadLocation in context. Run actionIssueStorageRequest first."
      );
    }
    if (!owner || typeof owner !== "string") {
      throw new Error(
        "No __uploadOwner in context. Run actionIssueStorageRequest first."
      );
    }
    if (!txHash || typeof txHash !== "string") {
      throw new Error(
        "No __uploadStorageRequestTxHash in context. Run actionIssueStorageRequest first."
      );
    }
    if (!session || typeof session !== "object") {
      throw new Error("No __siweSession in context. Run SIWE first.");
    }

    const { chain, transportUrl } = toViemChain(network);
    const publicClient = createPublicClient({
      chain,
      transport: createViemHttpTransport(transportUrl),
    });

    const sr = await waitForStorageRequest({
      publicClient,
      txHash: txHash as `0x${string}`,
      fileKey: fileKey as `0x${string}`,
      bucketId: bucketId as `0x${string}`,
      location,
      filesystemContractAddress: network.chain.filesystemPrecompileAddress,
      expectedWho: owner as `0x${string}`,
    });

    const userApi = await getUserApiSingleton(network);

    // 1) On-chain: SR exists
    const existsStart = Date.now();
    await waitForStorageRequestExistsOnChain(userApi, fileKey as `0x${string}`, {
      timeoutMs: 120_000,
      intervalMs: 3_000,
    });
    m.histogram(
      "action.waitForStorageRequestOnChain.existsOnChain.ms",
      Date.now() - existsStart
    );

    // MSP backends often only react to finalized chain state; waiting here avoids
    // transient upload errors like "Not found: Record" / "MSP is not expecting this file key".
    if (typeof sr.blockNumber === "bigint") {
      // Wait for at least one finalized block *after* the SR block by default.
      // This gives indexers/backends time to ingest the finalized SR.
      const lagBlocks = BigInt(readNumberEnv("SR_FINALIZATION_LAG_BLOCKS", 1));
      const target = sr.blockNumber + lagBlocks;
      const finalizeStart = Date.now();
      await waitForFinalizedAtLeast(userApi, target, 120_000);
      m.histogram(
        "action.waitForStorageRequestOnChain.finalizedLag.ms",
        Date.now() - finalizeStart
      );
    }

    // 2) MSP: wait until backend expects this fileKey (pre-upload gate)
    const mspStart = Date.now();
    const config = buildMspHttpClientConfig(network);
    const mspClient = await MspClient.connect(config, async () => session);
    await waitForMspToExpectFileKey({
      mspClient,
      bucketId,
      fileKey,
      timeoutMs: readNumberEnv("MSP_EXPECT_FILEKEY_TIMEOUT_MS", 120_000),
      intervalMs: readNumberEnv("MSP_EXPECT_FILEKEY_POLL_MS", 3_000),
    });
    m.histogram(
      "action.waitForStorageRequestOnChain.mspExpecting.ms",
      Date.now() - mspStart
    );

    m.counter("action.waitForStorageRequestOnChain.ok", 1);
    m.histogram("action.waitForStorageRequestOnChain.ms", Date.now() - start);
    done?.();
  } catch (err) {
    logger.error({ err }, "actionWaitForStorageRequestOnChain failed");
    m.counter("action.waitForStorageRequestOnChain.err", 1);
    done?.(toError(err));
  }
}

/**
 * Upload a file to the bucket.
 * This uses the MSP HTTP API to upload the file content.
 *
 * Reads from context:
 * - __uploadBucketName
 * - __uploadBucketId
 * - __uploadFileKey
 * - __uploadLocation
 * - __uploadLocalFilePath
 * - __uploadFileSizeBytes
 * - __uploadOwner
 * - __siweSession
 */
export async function actionUploadFile(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  const logger = getLogger();
  const m = createEmitter(context, events);

  try {
    const env = readEnv();
    const network = NETWORKS[env.network];
    const session = getPersistedVar(context, "__siweSession") as Session;

    // Read bucket and file info from context
    const bucketName = getPersistedVar(context, "__uploadBucketName");
    const bucketId = getPersistedVar(context, "__uploadBucketId");
    const fileKey = getPersistedVar(context, "__uploadFileKey");
    const location = getPersistedVar(context, "__uploadLocation");
    const localFilePath = getPersistedVar(context, "__uploadLocalFilePath");
    const fileSizeBytes = getPersistedVar(context, "__uploadFileSizeBytes");
    const owner = getPersistedVar(context, "__uploadOwner");

    if (!bucketName || typeof bucketName !== "string") {
      throw new Error(
        "No __uploadBucketName in context. Run actionGetOrCreateBucket first."
      );
    }

    if (!bucketId || typeof bucketId !== "string") {
      throw new Error(
        "No __uploadBucketId in context. Run actionGetOrCreateBucket first."
      );
    }

    if (!fileKey || typeof fileKey !== "string") {
      throw new Error(
        "No __uploadFileKey in context. Run actionIssueStorageRequest first."
      );
    }

    if (!location || typeof location !== "string") {
      throw new Error(
        "No __uploadLocation in context. Run actionIssueStorageRequest first."
      );
    }

    if (!localFilePath || typeof localFilePath !== "string") {
      throw new Error(
        "No __uploadLocalFilePath in context. Run actionIssueStorageRequest first."
      );
    }

    if (typeof fileSizeBytes !== "number") {
      throw new Error(
        "No __uploadFileSizeBytes in context. Run actionIssueStorageRequest first."
      );
    }

    if (!owner || typeof owner !== "string") {
      throw new Error(
        "No __uploadOwner in context. Run actionIssueStorageRequest first."
      );
    }

    logger.info(
      {
        bucketName,
        bucketId,
        location,
        fileKey,
        owner,
        localFilePath,
        sizeBytes: fileSizeBytes,
      },
      "Preparing to upload file"
    );

    const config = buildMspHttpClientConfig(network);
    const mspClient = await MspClient.connect(config, async () => session);

    // Upload file using MSP client (measure only client->MSP time here)
    const fileStream = filePathToWebStream(localFilePath);

    const result = await uploadFile(
      mspClient,
      bucketId,
      fileKey,
      owner,
      location,
      fileStream,
      {
        // required by SDK type
        mspDistribution: true,
        contentLength: fileSizeBytes,
      }
    );

    logger.info(
      {
        bucketId: result.bucketId,
        fileKey: result.fileKey,
        location: result.location,
        fingerprint: result.fingerprint,
        status: result.status,
      },
      "File uploaded successfully"
    );

    // Persist minimal upload receipt info for the follow-up wait step.
    persistVars(context, {
      __uploadReceiptStatus: result.status,
      __uploadReceiptFingerprint: result.fingerprint,
    });

    m.counter("action.uploadFile.ok", 1);
    m.histogram("action.uploadFile.ms", Date.now() - start);
    done?.();
  } catch (err) {
    logger.error({ err }, "actionUploadFile failed");
    m.counter("action.uploadFile.err", 1);
    done?.(toError(err));
  }
}

/**
 * Wait for the upload to be fully "complete":
 * - Chain finalized fulfillment event (StorageRequestFulfilled)
 * - MSP backend indexed & file status becomes "ready"
 *
 * This is intentionally separate from `actionUploadFile` so we can measure
 * pure upload latency vs consistency/confirmation latency.
 *
 * Reads from context:
 * - __uploadBucketId
 * - __uploadFileKey
 * - __siweSession
 */
export async function actionWaitForUploadFulfillment(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  const logger = getLogger();
  const m = createEmitter(context, events);

  try {
    const env = readEnv();
    const network = NETWORKS[env.network];
    const session = getPersistedVar(context, "__siweSession") as Session;

    const bucketId = getPersistedVar(context, "__uploadBucketId");
    const fileKey = getPersistedVar(context, "__uploadFileKey");

    if (!bucketId || typeof bucketId !== "string") {
      throw new Error(
        "No __uploadBucketId in context. Run actionGetOrCreateBucket first."
      );
    }
    if (!fileKey || typeof fileKey !== "string") {
      throw new Error(
        "No __uploadFileKey in context. Run actionIssueStorageRequest first."
      );
    }

    // Chain: finalized fulfillment event
    const fulfillStart = Date.now();
    const userApi = await getUserApiSingleton(network);
    await waitForStorageRequestFulfilledFinalized(
      userApi,
      fileKey as `0x${string}`
    );
    m.histogram(
      "action.waitForUploadFulfillment.fulfilledChain.ms",
      Date.now() - fulfillStart
    );

    // Backend: MSP indexed + ready
    const config = buildMspHttpClientConfig(network);
    const mspClient = await MspClient.connect(config, async () => session);

    const indexStart = Date.now();
    const finalInfo = await waitForMspFileStatus({
      mspClient,
      bucketId,
      fileKey,
      desiredStatus: "ready",
      timeoutMs: 660_000,
      intervalMs: 3_000,
    });
    m.histogram(
      "action.waitForUploadFulfillment.indexedMsp.ms",
      Date.now() - indexStart
    );

    logger.info(
      {
        bucketId,
        fileKey,
        status: finalInfo.status,
        uploadedAt: finalInfo.uploadedAt,
      },
      "Upload fulfilled on-chain and indexed on MSP"
    );

    m.counter("action.waitForUploadFulfillment.ok", 1);
    m.histogram("action.waitForUploadFulfillment.ms", Date.now() - start);
    done?.();
  } catch (err) {
    logger.error({ err }, "actionWaitForUploadFulfillment failed");
    m.counter("action.waitForUploadFulfillment.err", 1);
    done?.(toError(err));
  }
}
