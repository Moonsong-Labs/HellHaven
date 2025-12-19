import type { Account } from "viem/accounts";
import { readEnv } from "../config.js";
import { getLogger } from "../log.js";
import { NETWORKS, type NetworkConfig } from "../networks.js";
import {
  selectAccountIndex,
  cacheAccountIndex,
} from "../helpers/accountIndex.js";
import { deriveAccountFromMnemonic } from "../helpers/accounts.js";
import { toError } from "../helpers/errors.js";
import { readRequiredEnv } from "../helpers/env.js";
import { authenticateSIWE } from "../sdk/msp.js";
import { buildMspHttpClientConfig } from "../sdk/mspHttpConfig.js";
import { MspClient } from "@storagehub-sdk/msp-client";
import { createViemWallet } from "../sdk/viemWallet.js";

type Done = (error?: Error) => void;

type ArtilleryEvents = Readonly<{
  emit: (type: string, name: string, value: number) => void;
}>;

type ArtilleryContext = {
  vars?: Record<string, unknown>;
};

/**
 * Real SIWE test function:
 * - select account index using YAML variables (sequential mode for this scenario)
 * - derive account from TEST_MNEMONIC + index
 * - run MSP SIWE auth
 * - log session token at debug level
 */
export async function siweAuth(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  try {
    const logger = getLogger();
    const env = readEnv();
    const network = NETWORKS[env.network];

    const vars = (context.vars ??= {});
    const mnemonic = readRequiredEnv("TEST_MNEMONIC");

    // Select index to derive account
    const selection = selectAccountIndex(vars);
    cacheAccountIndex(vars, selection);

    // Create derived account and wallet client
    const derived = deriveAccountFromMnemonic(mnemonic, selection.index);
    const walletClient = createViemWallet(network, derived.account);

    // Create MspClient
    const config = buildMspHttpClientConfig(network);
    const mspClient = await MspClient.connect(config);

    const start = Date.now();
    const session = await authenticateSIWE(
      walletClient,
      mspClient,
      network.msp.siweDomain,
      network.msp.siweUri,
      logger
    );
    mspClient.setSessionProvider(async () => session);

    // Retrieve user's profile to check that authentication was ok
    // This is an optional step since it will increase the time from this test
    await mspClient.auth.getProfile();

    events.emit("counter", "siwe.ok", 1);
    events.emit("histogram", "siwe.ms", Date.now() - start);

    if (typeof done === "function") done();
  } catch (err) {
    const error = toError(err);
    events.emit("counter", "siwe.err", 1);
    if (typeof done === "function") return done(error);
    throw error;
  }
}
