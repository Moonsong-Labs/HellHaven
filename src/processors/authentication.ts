import { MspClient, type Session } from "@storagehub-sdk/msp-client";
import { parseNetworkName } from "../config.js";
import { getLogger } from "../log.js";
import { NETWORKS } from "../networks.js";
import { toError } from "../helpers/errors.js";
import { createViemWallet } from "../sdk/viemWallet.js";
import { buildMspHttpClientConfig } from "../sdk/mspHttpConfig.js";
import { privateKeyToAccount } from "viem/accounts";
import {
  ensureVars,
  persistVars,
  requireVarString,
  type ArtilleryContext,
  type ArtilleryEvents,
  type Done,
} from "../helpers/artillery.js";
import { ensure0xPrefix } from "../helpers/validation.js";
import { createEmitter } from "../helpers/metrics.js";

/**
 * Authentication step: SIWE
 *
 * Requirements:
 * - `context.vars.privateKey` (0x-prefixed)
 *
 * Side effects:
 * - sets `__siweSession` in context.vars
 */
export async function SIWE(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  try {
    const m = createEmitter(context, events);
    const logger = getLogger();
    const vars = ensureVars(context);
    const networkName = parseNetworkName(
      process.env.NETWORK?.trim() ?? requireVarString(vars, "NETWORK")
    );
    const network = NETWORKS[networkName];

    const pkRaw = requireVarString(vars, "privateKey");
    const pk = ensure0xPrefix(pkRaw, 32).toLowerCase() as `0x${string}`;

    const account = privateKeyToAccount(pk);
    const walletClient = createViemWallet(network, account);

    const config = buildMspHttpClientConfig(network);
    const mspClient = await MspClient.connect(config);

    // Use SDK directly for SIWE auth.
    const session = await mspClient.auth.SIWE(
      walletClient,
      network.msp.siweDomain,
      network.msp.siweUri
    );
    persistVars(context, {
      __siweSession: session satisfies Readonly<Session>,
    });

    logger.debug({ address: session.user.address }, "SIWE authenticated");

    m.counter("auth.siwe.ok", 1);
    m.histogram("auth.siwe.ms", Date.now() - start);
    done?.();
  } catch (err) {
    try {
      const logger = getLogger();
      logger.error({ err }, "SIWE failed");
    } catch {
      // ignore logger failures
    }
    const m = createEmitter(context, events);
    m.counter("auth.siwe.err", 1);
    done?.(toError(err));
  }
}

/**
 * Authentication step: SIWX (dummy placeholder)
 *
 * This is intentionally a no-op/dummy function so we can evolve it later without
 * changing the test flow structure.
 *
 * Side effects:
 * - sets `__siwxToken` in context.vars
 */
export async function SIWX(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  try {
    const m = createEmitter(context, events);
    const vars = ensureVars(context);
    const now = Date.now();
    // Dummy token, not used for real auth.
    vars.__siwxToken = `siwx_dummy_${now}`;
    m.counter("auth.siwx.ok", 1);
    done?.();
  } catch (err) {
    const m = createEmitter(context, events);
    m.counter("auth.siwx.err", 1);
    done?.(toError(err));
  }
}
