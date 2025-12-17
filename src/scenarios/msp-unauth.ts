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

const runStartedAtMs = Date.now();

function readInt(ctx: ArtilleryContext, key: string, fallback: number): number {
  const v = ctx.vars?.[key];
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.length > 0) {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  const envRaw = process.env[key];
  if (envRaw && envRaw.length > 0) {
    const n = Number.parseInt(envRaw, 10);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return fallback;
}

function randIntInclusive(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

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

  const totalDurationSec = readInt(context, "TEST_TOTAL_DURATION_SEC", 270);
  const endAtMs = runStartedAtMs + totalDurationSec * 1000;

  const sleepMinMs = readInt(context, "VU_SLEEP_MIN_MS", 50);
  const sleepMaxMs = readInt(context, "VU_SLEEP_MAX_MS", 250);

  const client = await connectUnauth(env, logger);

  while (Date.now() < endAtMs) {
    const which = randIntInclusive(0, 1);
    const start = Date.now();

    try {
      if (which === 0) {
        await client.info.getHealth();
        events.emit("counter", "msp.health.ok", 1);
        events.emit("histogram", "msp.health.ms", Date.now() - start);
      } else if (which === 1) {
        await client.info.getInfo();
        events.emit("counter", "msp.info.ok", 1);
        events.emit("histogram", "msp.info.ms", Date.now() - start);
      }
    } catch (err) {
      events.emit("counter", "msp.req.err", 1);
      // We continue until the end; log at debug to avoid noisy runs.
      logger.debug({ err }, "msp unauth request error");
    }

    await sleep(randIntInclusive(sleepMinMs, sleepMaxMs));
  }
}
