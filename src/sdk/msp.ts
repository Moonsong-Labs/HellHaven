import type { HttpClientConfig } from "@storagehub-sdk/core";
import { MspClient, type Session } from "@storagehub-sdk/msp-client";
import type { Env } from "../config.js";
import type { Logger } from "pino";
import { NETWORKS } from "../networks.js";
import type { WalletClient } from "viem";

export type MspConnection = Readonly<{
  client: MspClient;
  setSession: (s: Readonly<Session>) => void;
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

  let session: Readonly<Session> | undefined;
  const sessionProvider = async () => session;
  const client = await MspClient.connect(config, sessionProvider);

  const setSession = (s: Readonly<Session>): void => {
    session = s;
  };

  return { client, setSession };
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

export async function authenticateWithSiwe(
  conn: MspConnection,
  env: Env,
  walletClient: WalletClient,
  logger?: Logger
): Promise<MspAuthResult> {
  const network = NETWORKS[env.network];
  const address = (await walletClient.getAddresses())[0];
  if (!address) {
    throw new Error("WalletClient has no address");
  }

  logger?.info({ address }, "msp siwe start");
  const session = await conn.client.auth.SIWE(
    walletClient,
    network.msp.siweDomain,
    network.msp.siweUri
  );

  conn.setSession(session);

  logger?.info({ address }, "msp siwe ok");
  return { session, address };
}
