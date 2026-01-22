import { StorageHubClient, ReplicationLevel } from "@storagehub-sdk/core";
import { MspClient, type Session } from "@storagehub-sdk/msp-client";
import { createPublicClient, http } from "viem";
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
import { ensure0xPrefix } from "../helpers/validation.js";
import { NETWORKS } from "../networks.js";
import { pickSequentialResource } from "../resources/index.js";
import { buildMspHttpClientConfig } from "../sdk/mspHttpConfig.js";
import { createViemWallet, toViemChain } from "../sdk/viemWallet.js";
import {
  computeFileKeyFromMetadata,
  filePathToWebStream,
} from "../files.js";
import {
  getUserApiSingleton,
} from "../userApi.js";
import { ok } from "node:assert";
import { waitForMspFileStatus, waitForStorageRequestExistsOnChain } from "../waiting.js";

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


    const userApi = await getUserApiSingleton(network);

    // First wait stage: wait for transaction receipt
    const receiptStart = Date.now();
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    ok(receipt.status === "success", "Storage request transaction failed");
    m.histogram("uploadFlow.waitForTransactionReceipt.ms", Date.now() - receiptStart);


    // Second wait stage: wait until we can see the storage request on chain
    const onChainStart = Date.now();
    await waitForStorageRequestExistsOnChain(userApi, fileKey);
    m.histogram("uploadFlow.existOnChain.ms", Date.now() - onChainStart);

    // Thrid wait stage: wait until the file status is inProgress --> file was indexed and we can proceed with the upload
    const srAcceptedStart = Date.now();
    await waitForMspFileStatus(mspClient, bucketId, fileKey, "inProgress");
    m.histogram("uploadFlow.StorageRequestAccepted.ms", Date.now() - srAcceptedStart);

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

    // File uploaded to backend. Wait until chain fulfill the SR
    const mspReadyStart = Date.now();
    await waitForMspFileStatus(
      mspClient,
      bucketId,
      fileKey,
      "ready"
    );
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
