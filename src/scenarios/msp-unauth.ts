import { MspClient } from "@storagehub-sdk/msp-client";
import type { HttpClientConfig } from "@storagehub-sdk/core";
import type { Logger } from "pino";
import { getLogger } from "../log.js";
import { readEnv } from "../config.js";
import { NETWORKS } from "../networks.js";
import type { Env } from "../config.js";

type ArtilleryEvents = Readonly<{
  emit: (type: string, name: string, value: number) => void;
}>;

type ArtilleryContext = Readonly<{
  vars?: Record<string, unknown>;
}>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHttpConfig(env: Env): HttpClientConfig {
  const network = NETWORKS[env.network];
  const base: { baseUrl: string; timeoutMs?: number } = {
    baseUrl: network.msp.baseUrl,
  };
  if (typeof network.msp.timeoutMs === "number") {
    base.timeoutMs = network.msp.timeoutMs;
  }
  const overrideRaw = process.env.MSP_TIMEOUT_MS;
  if (overrideRaw && overrideRaw.length > 0) {
    const n = Number.parseInt(overrideRaw, 10);
    if (Number.isFinite(n)) {
      base.timeoutMs = n;
    }
  }
  return base;
}

async function connectUnauth(env: Env, logger: Logger): Promise<MspClient> {
  const config = buildHttpConfig(env);
  logger.info({ baseUrl: config.baseUrl }, "msp unauth connect");
  return await MspClient.connect(config, async () => undefined);
}

export async function mspUnauthLoad(
  context: ArtilleryContext,
  events: ArtilleryEvents
): Promise<void> {
  const logger = getLogger();
  const env = readEnv();

  const client = await connectUnauth(env, logger);

  const healthStart = Date.now();
  try {
    await client.info.getHealth();
    events.emit("counter", "msp.health.ok", 1);
    events.emit("histogram", "msp.health.ms", Date.now() - healthStart);
  } catch (err) {
    events.emit("counter", "msp.req.err", 1);
    logger.debug({ err }, "msp unauth request error");
  }

  await sleep(1000);

  const infoStart = Date.now();
  try {
    await client.info.getInfo();
    events.emit("counter", "msp.info.ok", 1);
    events.emit("histogram", "msp.info.ms", Date.now() - infoStart);
  } catch (err) {
    events.emit("counter", "msp.req.err", 1);
    logger.debug({ err }, "msp unauth request error");
  }
}
