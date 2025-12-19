import type { HttpClientConfig } from "@storagehub-sdk/core";
import { MspClient, type Session } from "@storagehub-sdk/msp-client";
import type { Env } from "../config.js";
import type { Logger } from "pino";
import { NETWORKS } from "../networks.js";
import type { WalletClient } from "viem";

export type MspConnection = Readonly<{
  client: MspClient;
  setSession: (s: Readonly<Session>) => void;
  getSession: () => Readonly<Session> | undefined;
  /**
   * Convenience helper to retrieve the current auth token (if any).
   * This is derived from the stored Session that is also returned by sessionProvider.
   */
  getToken: () => string | undefined;
}>;

export type MspAuthResult = Readonly<{
  session: Readonly<Session>;
  address: `0x${string}`;
}>;

export async function connectMsp(
  env: Env,
  logger?: Logger
): Promise<MspConnection> {
  const network = NETWORKS[env.network];
  const { msp } = network;

  const config = {
    baseUrl: msp.baseUrl,
    ...(typeof msp.timeoutMs === "number" ? { timeoutMs: msp.timeoutMs } : {}),
  } satisfies HttpClientConfig;

  logger?.info({ baseUrl: config.baseUrl }, "msp connect");

  let sessionRef: Readonly<Session> | undefined;
  const sessionProvider = async () => sessionRef;
  const client = await MspClient.connect(config, sessionProvider);

  const setSession = (s: Readonly<Session>): void => {
    sessionRef = s;
  };

  const getSession = (): Readonly<Session> | undefined => sessionRef;
  const getToken = (): string | undefined => sessionRef?.token;

  return { client, setSession, getSession, getToken };
}

export async function validateMspConnection(
  conn: MspConnection,
  logger?: Logger
): Promise<void> {
  logger?.debug("msp getHealth");
  const health = await conn.client.info.getHealth();
  logger?.debug({ health }, "msp health response");
  logger?.info("msp health ok");
}

/**
 * Authenticate with SIWE and return the Session.
 * The user's address is available as `session.user.address`.
 * Usage:
 *   const session = await authenticateSIWE(walletClient, mspClient, domain, uri)
 */
export async function authenticateSIWE(
  walletClient: WalletClient,
  mspClient: MspClient,
  siweDomain: string,
  siweURI: string,
  logger?: Logger
): Promise<Readonly<Session>> {
  const address =
    walletClient.account?.address ?? (await walletClient.getAddresses())[0];
  if (!address) throw new Error("WalletClient has no address");

  const session = await mspClient.auth.SIWE(walletClient, siweDomain, siweURI);

  logger?.debug(
    { address: session.user.address, token: session.token },
    "SIWE ✅"
  );
  return session;
}

/**
 * Convenience wrapper used by existing processors:
 * - runs SIWE against the connected MSP client
 * - stores the returned session into the connection (so sessionProvider starts returning it)
 * - returns an object for readability at call sites
 */
export async function authenticateWithSiwe(
  conn: MspConnection,
  env: Env,
  walletClient: WalletClient,
  logger?: Logger
): Promise<Readonly<Session>> {
  const network = NETWORKS[env.network];
  const session = await authenticateSIWE(
    walletClient,
    conn.client,
    network.msp.siweDomain,
    network.msp.siweUri,
    logger
  );
  conn.setSession(session);
  return session;
}
