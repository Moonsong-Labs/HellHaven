import { MspClient, type Session } from "@storagehub-sdk/msp-client";
import { readEnv } from "../config.js";
import { getLogger } from "../log.js";
import { NETWORKS } from "../networks.js";
import { toError } from "../helpers/errors.js";
import { buildMspHttpClientConfig } from "../sdk/mspHttpConfig.js";
import {
  ensureVars,
  type ArtilleryContext,
  type ArtilleryEvents,
  type Done,
} from "../helpers/artillery.js";
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
    const env = readEnv();
    const network = NETWORKS[env.network];
    const vars = ensureVars(context);

    const sessionRaw = vars.__siweSession;
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

    events.emit("counter", "action.getProfile.ok", 1);
    events.emit("histogram", "action.getProfile.ms", Date.now() - start);
    done?.();
  } catch (err) {
    events.emit("counter", "action.getProfile.err", 1);
    done?.(toError(err));
  }
}


