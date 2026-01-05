import { MspClient, type Session } from "@storagehub-sdk/msp-client";
import { getLogger } from "../log.js";
import { NETWORKS } from "../networks.js";
import { toError } from "../helpers/errors.js";
import { buildMspHttpClientConfig } from "../sdk/mspHttpConfig.js";
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
