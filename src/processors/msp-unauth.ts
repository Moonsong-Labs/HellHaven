import { MspClient } from "@storagehub-sdk/msp-client";
import type { HttpClientConfig } from "@storagehub-sdk/core";
import { getLogger } from "../log.js";
import { readEnv } from "../config.js";
import { NETWORKS } from "../networks.js";
import { createEmitter } from "../helpers/metrics.js";
import type {
  ArtilleryContext,
  ArtilleryEvents,
} from "../helpers/artillery.js";
import { buildMspHttpClientConfig } from "../sdk/mspHttpConfig.js";

export async function getHealth(
  context: ArtilleryContext,
  events: ArtilleryEvents
): Promise<void> {
  const m = createEmitter(context, events);
  const logger = getLogger();
  const env = readEnv();
  const network = NETWORKS[env.network];

  const config = buildMspHttpClientConfig(network);
  const client = await MspClient.connect(config);

  const healthStart = Date.now();
  try {
    await client.info.getHealth();
    m.counter("msp.health.ok", 1);
    m.histogram("msp.health.ms", Date.now() - healthStart);
  } catch (err) {
    m.counter("msp.req.err", 1);
    logger.debug({ err }, "msp unauth request error");
  }
}

export async function getInfo(
  context: ArtilleryContext,
  events: ArtilleryEvents
): Promise<void> {
  const m = createEmitter(context, events);
  const logger = getLogger();
  const env = readEnv();
  const network = NETWORKS[env.network];

  const config = buildMspHttpClientConfig(network);
  const client = await MspClient.connect(config);

  const infoStart = Date.now();
  try {
    await client.info.getInfo();
    m.counter("msp.info.ok", 1);
    m.histogram("msp.info.ms", Date.now() - infoStart);
  } catch (err) {
    m.counter("msp.req.err", 1);
    logger.debug({ err }, "msp unauth request error");
  }
}
