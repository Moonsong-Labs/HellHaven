import { MspClient, type Session } from "@storagehub-sdk/msp-client";
import { StorageHubClient } from "@storagehub-sdk/core";
import { getLogger } from "../log.js";
import { NETWORKS } from "../networks.js";
import { toError } from "../helpers/errors.js";
import { buildMspHttpClientConfig } from "../sdk/mspHttpConfig.js";
import { createBucket, makeBucketName } from "../buckets.js";
import {
  ensureVars,
  getPersistedVar,
  requireVarString,
  type ArtilleryContext,
  type ArtilleryEvents,
  type Done,
} from "../helpers/artillery.js";
import { createEmitter } from "../helpers/metrics.js";
import { readEnv } from "../config.js";
import { ensure0xPrefix } from "../helpers/validation.js";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { createViemWallet, toViemChain } from "../sdk/viemWallet.js";
import { randomInt } from "node:crypto";

// Re-export an "init SIWE" helper for example scenarios.
export { SIWE as initSiwe } from "./authentication.js";

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
      transport: http(transportUrl),
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
