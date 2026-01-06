import { Readable } from "node:stream";
import { readEnv } from "../config.js";
import { getLogger } from "../log.js";
import { MspClient, type Session } from "@storagehub-sdk/msp-client";
import { NETWORKS } from "../networks.js";
import { toError } from "../helpers/errors.js";
import { readRequiredEnv } from "../helpers/env.js";
import { buildMspHttpClientConfig } from "../sdk/mspHttpConfig.js";
import { createEmitter } from "../helpers/metrics.js";
import {
  getPersistedVar,
  type ArtilleryContext,
  type ArtilleryEvents,
} from "../helpers/artillery.js";

export async function downloadFile(
  context: ArtilleryContext,
  events: ArtilleryEvents
): Promise<void> {
  const m = createEmitter(context, events);
  const logger = getLogger();
  const env = readEnv();
  const network = NETWORKS[env.network];
  const fileKey = readRequiredEnv("FILE_KEY");

  const session = getPersistedVar(context, "__siweSession") as Session;
  const config = buildMspHttpClientConfig(network);
  const client = await MspClient.connect(config, async () => session);

  // Download file
  const dlStart = Date.now();
  try {
    const file = await client.files.downloadFile(fileKey);
    if (!file?.stream) {
      throw new Error("downloadFile returned no stream");
    }

    // Consume stream, count bytes (no disk write)
    // Type assertion needed: SDK returns web ReadableStream, Node expects its own variant
    const nodeReadable = Readable.fromWeb(
      file.stream as unknown as import("stream/web").ReadableStream
    );
    let totalBytes = 0;
    for await (const chunk of nodeReadable) {
      totalBytes += (chunk as Buffer).length;
    }

    m.counter("download.file.ok", 1);
    m.histogram("download.file.ms", Date.now() - dlStart);
    m.histogram("download.bytes", totalBytes);
    logger.info({ fileKey, totalBytes }, "download complete");
  } catch (err) {
    m.counter("download.file.err", 1);
    const error = toError(err);
    logger.error({ err: error, fileKey }, "download failed");
    throw error;
  }
}
