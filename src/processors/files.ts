import { StorageHubClient, ReplicationLevel, FileInfo } from "@storagehub-sdk/core";
import { MspClient, type Session } from "@storagehub-sdk/msp-client";
import { createPublicClient, http, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolve } from "node:path";
import { readEnv } from "../config.js";
import { DEFAULT_EVM_RPC_TIMEOUT_MS } from "../config/constants.js";
import {
  ensureVars,
  persistVars,
  requirePersistedVar,
  requirePersistedVarNumber,
  requirePersistedVarString,
  requireVarString,
  type ArtilleryContext,
  type ArtilleryEvents,
  type Done,
} from "../helpers/artillery.js";
import { toError } from "../helpers/errors.js";
import { createEmitter } from "../helpers/metrics.js";
import { ensure0xPrefix, readNumberEnv } from "../helpers/validation.js";
import { getLogger } from "../log.js";
import { NETWORKS } from "../networks.js";
import { pickSequentialResource } from "../resources/index.js";
import { buildMspHttpClientConfig } from "../sdk/mspHttpConfig.js";
import { createViemWallet, toViemChain } from "../sdk/viemWallet.js";
import {
  computeFileKeyFromMetadata,
  filePathToWebStream,
  waitForMspFileStatus,
  waitForStorageRequestReadyForUpload,
} from "../files.js";
import {
  getUserApiSingleton,
  waitForFinalizedEvent,
  waitForFinalizedAtLeast,
  waitForStorageRequestFulfilledFinalized,
} from "../userApi.js";

// Default bucket location used by our tests.
const REMOTE_LOCATION = "/";

/**
 * Condensed upload flow:
 * - pick resource (deterministic)
 * - compute fileKey
 * - issue storage request + waits
 * - upload + waits
 *
 * Leaves all required vars persisted into `context.vars` for downstream steps (e.g. delete).
 */
export async function uploadFileFlow(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const m = createEmitter(context, events);

  try {
    const vars = ensureVars(context);
    const bucketId = requirePersistedVarString(context, "__uploadBucketId");
    const pk = ensure0xPrefix(requireVarString(vars, "privateKey"), 32);
    const account = privateKeyToAccount(pk);
    const sequence = requirePersistedVarNumber(context, "__accountIndexRaw");
    const session = requirePersistedVar(context, "__siweSession") as Session;

    const picked = pickSequentialResource({ sequence });
    const localFilePath = resolve(process.cwd(), picked.path);
    const sizeBytes = picked.sizeBytes;
    const fingerprint = picked.fingerprint;

    const fileKey = await computeFileKeyFromMetadata({
      owner: account.address,
      bucketId,
      location: REMOTE_LOCATION,
      size: BigInt(sizeBytes),
      fingerprint,
    });

    const env = readEnv();
    const network = NETWORKS[env.network];
    const { chain, transportUrl } = toViemChain(network);

    const publicClient = createPublicClient({
      chain,
      transport: http(transportUrl, { timeout: DEFAULT_EVM_RPC_TIMEOUT_MS }),
    });

    const config = buildMspHttpClientConfig(network);
    const mspClient = await MspClient.connect(config, async () => session);
    const info = await mspClient.info.getInfo();
    const mspId = ensure0xPrefix(info.mspId, 32);
    const peerIds: string[] = info.multiaddresses
      .map((addr) => {
        const parts = addr.split("/");
        return parts[parts.length - 1] || "";
      })
      .filter((id) => id.length > 0);

    const walletClient = createViemWallet(network, account);
    const storageHubClient = new StorageHubClient({
      rpcUrl: transportUrl,
      chain,
      walletClient,
      filesystemContractAddress: network.chain.filesystemPrecompileAddress,
    });

    const srStart = Date.now();
    const txHash = await storageHubClient.issueStorageRequest(
      bucketId,
      REMOTE_LOCATION,
      fingerprint,
      BigInt(sizeBytes),
      mspId,
      peerIds,
      ReplicationLevel.Custom,
      1
    );
    if (!txHash) throw new Error("issueStorageRequest returned undefined txHash");
    m.histogram("uploadFlow.issueStorageRequest.ms", Date.now() - srStart);

    // Wait until StorageRequest is processed and the backend is expecting the filekey
    const userApi = await getUserApiSingleton(network);
    const readyStart = Date.now();
    await waitForStorageRequestReadyForUpload({
      publicClient,
      txHash,
      fileKey,
      bucketId,
      location: REMOTE_LOCATION,
      filesystemContractAddress: network.chain.filesystemPrecompileAddress,
      expectedWho: account.address,
      userApi,
      mspClient,
    });
    m.histogram("uploadFlow.wait.readyForUpload.ms", Date.now() - readyStart);

    // Upload file bytes to MSP
    const upStart = Date.now();
    const uploadReceipt = await mspClient.files.uploadFile(
      bucketId,
      fileKey,
      filePathToWebStream(localFilePath),
      account.address,
      REMOTE_LOCATION,
      {
        mspDistribution: true,
        contentLength: sizeBytes,
      }
    );
    m.histogram("uploadFlow.uploadFile.ms", Date.now() - upStart);

    // Wait after upload (chain fulfillment + MSP ready)
    const fulfillStart = Date.now();
    await waitForStorageRequestFulfilledFinalized(userApi, fileKey);
    m.histogram("uploadFlow.wait.fulfilledChain.ms", Date.now() - fulfillStart);

    const mspReadyStart = Date.now();
    await waitForMspFileStatus({
      mspClient,
      bucketId,
      fileKey,
      desiredStatus: "ready",
      timeoutMs: 660_000,
      intervalMs: 3_000,
    });
    m.histogram("uploadFlow.wait.mspReady.ms", Date.now() - mspReadyStart);

    // Persist for follow-up steps (delete / waits).
    persistVars(context, {
      __uploadFileKey: fileKey,
      __uploadStorageRequestTxHash: txHash,
      __uploadLocation: REMOTE_LOCATION,
      __uploadLocalFilePath: localFilePath,
      __uploadFileSizeBytes: sizeBytes,
      __uploadFingerprint: fingerprint,
      __uploadOwner: account.address,
    });

    void uploadReceipt;
    done?.();
  } catch (err) {
    done?.(toError(err));
  }
}

/**
 * Condensed delete flow:
 * - read persisted upload vars from `context.vars`
 * - fetch the storage-request receipt (to get the creation blockHash)
 * - request delete on-chain
 *
 * Persists:
 * - __deleteRequestedAt: number (ms since epoch)
 * - __deleteFileTxHash: 0x-hash
 */
export async function deleteFileFlow(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  const logger = getLogger();
  const m = createEmitter(context, events);

  try {
    const vars = ensureVars(context);
    const session = requirePersistedVar(context, "__siweSession") as Session;

    const owner = requirePersistedVarString(context, "__uploadOwner");
    const bucketId = ensure0xPrefix(
      requirePersistedVarString(context, "__uploadBucketId"),
      32
    );
    const fileKey = ensure0xPrefix(
      requirePersistedVarString(context, "__uploadFileKey"),
      32
    );
    const locationRaw = requirePersistedVarString(context, "__uploadLocation");
    const location = (() => {
      // Normalize to the plain path string (e.g. "/") because fileKey derivation uses UTF-8 bytes.
      // We’ve seen accidental encodings like:
      // - "/"
      // - "0x/" (ensure0xPrefix applied to a path)
      // - "0x30782f" (hex of "0x/")
      // - "0x3078333037383266" (hex of "0x30782f")  ← double-encoded
      let s = locationRaw.trim();
      for (let i = 0; i < 3; i++) {
        if (s.startsWith("0x/")) s = s.slice(2);
        if (s.startsWith("/")) return s;
        if (s.startsWith("0x")) {
          const hex = s.slice(2);
          if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
            s = Buffer.from(hex, "hex").toString("utf8").trim();
            continue;
          }
        }
        break;
      }
      return s;
    })();
    const fingerprint = ensure0xPrefix(
      requirePersistedVarString(context, "__uploadFingerprint"),
      32
    );
    const sizeBytes = requirePersistedVarNumber(
      context,
      "__uploadFileSizeBytes"
    );
    const srTxHash = ensure0xPrefix(
      requirePersistedVarString(context, "__uploadStorageRequestTxHash"),
      32
    );

    // Private key is set by deriveAccount
    const pk = ensure0xPrefix(requireVarString(vars, "privateKey"), 32);
    const account = privateKeyToAccount(pk);
    if (owner.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(
        `deleteFileFlow owner mismatch: __uploadOwner=${owner}, derived=${account.address}`
      );
    }

    const env = readEnv();
    const network = NETWORKS[env.network];
    const { chain, transportUrl } = toViemChain(network);

    const publicClient = createPublicClient({
      chain,
      transport: http(transportUrl, { timeout: DEFAULT_EVM_RPC_TIMEOUT_MS }),
    });

    const walletClient = createViemWallet(network, account);
    const storageHubClient = new StorageHubClient({
      rpcUrl: transportUrl,
      chain,
      walletClient,
      filesystemContractAddress: network.chain.filesystemPrecompileAddress,
    });

    logger.info(
      { bucketId, fileKey, who: account.address, locationRaw, location },
      "deleteFileFlow starting"
    );

    const srReceiptStart = Date.now();
    const srReceipt = await publicClient.waitForTransactionReceipt({
      hash: srTxHash,
    });
    m.histogram(
      "deleteFileFlow.wait.storageRequestReceipt.ms",
      Date.now() - srReceiptStart
    );
    logger.debug(
      { bucketId, fileKey, srTxHash, blockHash: srReceipt.blockHash },
      "deleteFileFlow got storage-request receipt"
    );

    const fileInfo: FileInfo = {
      fileKey,
      fingerprint,
      bucketId,
      // IMPORTANT: requestDeleteFile expects `location` bytes (same bytes used when computing fileKey).
      // Passing a plain string may be auto-0x-prefixed somewhere and ends up as bytes for "0x/" (0x30782f),
      // which breaks metadata matching and causes InvalidFileKeyMetadata.
      location: location,
      size: BigInt(sizeBytes),
      blockHash: srReceipt.blockHash,
      txHash: srTxHash,
    };

    const delStart = Date.now();
    let deleteTxHash: `0x${string}` | undefined;
    try {
      deleteTxHash = await storageHubClient.requestDeleteFile(fileInfo);
    } finally {
      // Always measure the attempt, even if the request throws.
      m.histogram("deleteFileFlow.requestDeleteFile.ms", Date.now() - delStart);
    }
    if (!deleteTxHash) {
      throw new Error("requestDeleteFile returned undefined txHash");
    }

    persistVars(context, {
      __deleteRequestedAt: Date.now(),
      __deleteFileTxHash: deleteTxHash,
    });
    logger.info(
      { bucketId, fileKey, deleteTxHash },
      "deleteFileFlow delete requested (on-chain)"
    );

    // 1) EVM receipt success
    const receiptStart = Date.now();
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: deleteTxHash,
    });
    m.histogram("deleteFileFlow.wait.receipt.ms", Date.now() - receiptStart);
    if (receipt.status !== "success") {
      throw new Error(
        `Delete tx failed (hash=${deleteTxHash}, status=${receipt.status})`
      );
    }
    logger.info(
      { bucketId, fileKey, deleteTxHash, blockNumber: receipt.blockNumber },
      "deleteFileFlow delete receipt confirmed"
    );

    // 2) Substrate: finalized delete event + finalized lag (mirrors SR finalization strategy)
    if (typeof receipt.blockNumber === "bigint") {
      const userApi = await getUserApiSingleton(network);

      const eventStart = Date.now();
      const hit = await waitForFinalizedEvent(
        userApi,
        {
          section: "fileSystem",
          method: "FileDeletionRequested",
          matchData: (data) => {
            const target = fileKey.toLowerCase().replace(/^0x/, "");
            return data.some((d) => String(d).toLowerCase().replace(/^0x/, "") === target);
          },
        },
        240_000
      );
      m.histogram("deleteFileFlow.wait.finalizedEvent.ms", Date.now() - eventStart);
      logger.info(
        {
          bucketId,
          fileKey,
          deleteTxHash,
          blockNumber: hit.blockNumber.toString(),
          blockHash: hit.blockHash,
        },
        "deleteFileFlow finalized FileDeletionRequested observed"
      );

      const lagBlocks = BigInt(readNumberEnv("DELETE_FINALIZATION_LAG_BLOCKS", 1));
      const target = hit.blockNumber + lagBlocks;
      const finalizeStart = Date.now();
      await waitForFinalizedAtLeast(userApi, target, 240_000);
      m.histogram(
        "deleteFileFlow.wait.finalizedLag.ms",
        Date.now() - finalizeStart
      );
      logger.info(
        { bucketId, fileKey, deleteTxHash, targetFinalizedBlock: target.toString() },
        "deleteFileFlow finalized lag satisfied"
      );
    }

    // 3) MSP grace period (gives backend a head start after finalization)
    const graceMs = readNumberEnv("DELETE_MSP_GRACE_MS", 10_000);
    const graceStart = Date.now();
    await new Promise((r) => setTimeout(r, graceMs));
    m.histogram("deleteFileFlow.wait.mspGrace.ms", Date.now() - graceStart);

    // 4) MSP deletion reflected (eventual consistency): prefer bucket tree listing.
    const config = buildMspHttpClientConfig(network);
    const mspClient = await MspClient.connect(config, async () => session);
    const deletedStart = Date.now();
    const timeoutMs = 1_800_000; // 30 minutes
    const intervalMs = 10_000;
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;

    function containsFileKey(root: unknown, targetFileKey: string): boolean {
      const target = targetFileKey.toLowerCase();
      const stack: unknown[] = [root];
      let visited = 0;
      while (stack.length > 0) {
        const cur = stack.pop();
        visited += 1;
        if (visited > 50_000) return true; // fail-safe: treat as still present
        if (!cur) continue;
        if (typeof cur === "string") {
          if (cur.toLowerCase() === target) return true;
          continue;
        }
        if (Array.isArray(cur)) {
          for (const x of cur) stack.push(x);
          continue;
        }
        if (typeof cur === "object") {
          const o = cur as Record<string, unknown>;
          const fk = o.fileKey;
          if (typeof fk === "string" && fk.toLowerCase() === target) return true;
          const children = o.children;
          const files = o.files;
          if (Array.isArray(children)) stack.push(children);
          if (Array.isArray(files)) stack.push(files);
          // Generic walk (best-effort)
          for (const v of Object.values(o)) {
            if (v && typeof v === "object") stack.push(v);
          }
        }
      }
      return false;
    }

    async function isFilePresentOnMsp(): Promise<boolean> {
      const anyClient = mspClient as unknown as {
        buckets?: { getFiles?: (bucketId: string) => Promise<unknown> };
        files?: { getFileInfo?: (bucketId: string, fileKey: string) => Promise<unknown> };
      };

      // Prefer bucket listing (matches your other project's approach).
      if (anyClient.buckets?.getFiles) {
        try {
          const resp = await anyClient.buckets.getFiles(bucketId);
          const root = (resp as { files?: unknown })?.files ?? resp;
          return containsFileKey(root, fileKey);
        } catch {
          // fall through to file endpoint
        }
      }

      // Fallback: treat getFileInfo throwing as deleted.
      try {
        await anyClient.files?.getFileInfo?.(bucketId, fileKey);
        return true;
      } catch {
        return false;
      }
    }

    while (Date.now() < deadline) {
      attempts += 1;
      const present = await isFilePresentOnMsp();
      if (!present) {
        m.histogram("deleteFileFlow.wait.mspDeleted.ms", Date.now() - deletedStart);
        logger.info({ bucketId, fileKey, attempts }, "deleteFileFlow MSP deletion observed");
        break;
      }
      if (attempts === 1 || attempts % 10 === 0) {
        logger.debug(
          { bucketId, fileKey, attempts },
          "deleteFileFlow waiting for MSP deletion (polling getFiles/getFileInfo)"
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for MSP deletion (bucketId=${bucketId}, fileKey=${fileKey}, timeoutMs=${timeoutMs})`
      );
    }

    logger.info({ bucketId, fileKey }, "deleteFileFlow completed");
    m.counter("deleteFileFlow.ok", 1);
    m.histogram("deleteFileFlow.ms", Date.now() - start);
    done?.();
  } catch (err) {
    logger.error({ err }, "deleteFileFlow failed");
    m.counter("deleteFileFlow.err", 1);
    done?.(toError(err));
  }
}
