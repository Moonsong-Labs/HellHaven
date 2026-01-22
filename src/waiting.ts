import type { MspClient } from "@storagehub-sdk/msp-client";
import type { StorageFileInfo } from "@storagehub-sdk/msp-client";
import type { ApiPromise } from "@polkadot/api";
import { getLogger } from "./log.js";
import { sleep } from "./helpers/utils.js";


/**
 * Poll Substrate storage until `fileSystem.storageRequests(fileKey)` is Some.
 */
export async function waitForStorageRequestExistsOnChain(
  api: ApiPromise,
  fileKey: `0x${string}`,
): Promise<void> {
  const timeoutMs = 180_000;
  const intervalMs = 1_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await api.query.fileSystem.storageRequests(fileKey);
    if (result.isSome) return;
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for on-chain storage request (fileKey=${fileKey})`
  );
}

async function optional<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/**
 * Poll MSP until a file reaches the desired status.
 */
export async function waitForMspFileStatus(
  mspClient: MspClient,
  bucketId: `0x${string}`,
  fileKey: `0x${string}`,
  desiredStatus: string,
): Promise<StorageFileInfo> {
  const logger = getLogger();
  const timeoutMs = 700_000; // At least 11min to wait for expiration
  const intervalMs = 2_000; // 2 seconds interval
  const deadline = Date.now() + timeoutMs;

  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const info = await optional(() =>
      mspClient.files.getFileInfo(bucketId, fileKey)
    );

    if (info) {
      // Fail-fast on terminal-ish states (shouldn't happen in healthy tests).
      if (
        info.status === "expired" ||
        info.status === "revoked" ||
        info.status === "rejected"
      ) {
        logger.error(`Terminal status: ${info.status} -  Filekey: ${fileKey}`);
        throw new Error(
          `MSP file entered terminal state: ${info.status} (bucketId=${bucketId}, fileKey=${fileKey})`
        );
      }

      // File status will turn into Ready when all requested BSPs confirm
      if (info.status === desiredStatus) {
        logger.info(
          `File: ${fileKey} reached desired status: ${info.status}`
        );
        return info;
      }
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for MSP to expect fileKey (bucketId=${bucketId}, fileKey=${fileKey}, attempts=${attempts})`
  );
}
