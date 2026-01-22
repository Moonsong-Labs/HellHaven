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
import { createPublicClient, http } from "viem";
import {
  createViemWallet,
  toViemChain,
} from "../sdk/viemWallet.js";
import { DEFAULT_EVM_RPC_TIMEOUT_MS } from "../config/constants.js";
import { randomInt, randomUUID } from "node:crypto";
import {
  getUserApiSingleton,
} from "../userApi.js";

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
      transport: http(transportUrl, { timeout: DEFAULT_EVM_RPC_TIMEOUT_MS }),
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
      transport: http(transportUrl, { timeout: DEFAULT_EVM_RPC_TIMEOUT_MS }),
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
