import { MspClient, type Session } from "@storagehub-sdk/msp-client";
import { parseNetworkName } from "../config.js";
import { getLogger } from "../log.js";
import { NETWORKS } from "../networks.js";
import { toError } from "../helpers/errors.js";
import { buildMspHttpClientConfig } from "../sdk/mspHttpConfig.js";
import {
  ensureVars,
  ensureScenarioVars,
  requireVarString,
  type ArtilleryContext,
  type ArtilleryEvents,
  type Done,
} from "../helpers/artillery.js";
import { createEmitter } from "../helpers/metrics.js";

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
    const vars = ensureVars(context);
    const scenarioVars = ensureScenarioVars(context);
    const networkName = parseNetworkName(
      process.env.NETWORK?.trim() ?? requireVarString(vars, "NETWORK")
    );
    const network = NETWORKS[networkName];

    const sessionRaw = vars.__siweSession ?? scenarioVars.__siweSession;
    if (!sessionRaw || typeof sessionRaw !== "object") {
      throw new Error("Missing __siweSession (did you run initSiwe?)");
    }

    const session = sessionRaw as Readonly<Pick<Session, "token" | "user">>;
    const config = buildMspHttpClientConfig(network);
    const client = await MspClient.connect(config, async () => session as Session);

    const logger = getLogger();
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


