import { Readable } from "node:stream";
import { readEnv } from "../config.js";
import { getLogger } from "../log.js";
import { authenticateWithSiwe, connectMsp } from "../sdk/msp.js";
import { initWalletFromPrivateKey, to0xPrivateKey } from "../sdk/wallet.js";
import { NETWORKS } from "../networks.js";
import { nextPrivateKey } from "../privateKeys.js";

type ArtilleryEvents = Readonly<{
  emit: (type: string, name: string, value: number) => void;
}>;

type ArtilleryContext = Readonly<{
  vars?: Record<string, unknown>;
}>;

function getFileKey(): string {
  const key = process.env.FILE_KEY;
  if (!key) {
    throw new Error("FILE_KEY env var is required");
  }
  return key;
}

export async function downloadFile(
  context: ArtilleryContext,
  events: ArtilleryEvents
): Promise<void> {
  const logger = getLogger();
  const env = readEnv();
  const network = NETWORKS[env.network];
  const fileKey = getFileKey();

  // Get private key (from Artillery vars or fallback)
  const privateKeyRaw =
    typeof context.vars?.privateKey === "string" && context.vars.privateKey.length > 0
      ? context.vars.privateKey
      : nextPrivateKey().privateKey;

  const privateKey = to0xPrivateKey(privateKeyRaw);
  const { walletClient } = initWalletFromPrivateKey(network, privateKey);

  // Connect and authenticate
  const conn = await connectMsp(env, logger);

  const siweStart = Date.now();
  try {
    await authenticateWithSiwe(conn, env, walletClient, logger);
    events.emit("counter", "download.siwe.ok", 1);
    events.emit("histogram", "download.siwe.ms", Date.now() - siweStart);
  } catch (err) {
    events.emit("counter", "download.siwe.err", 1);
    logger.error({ err }, "siwe failed");
    throw err;
  }

  // Download file
  const dlStart = Date.now();
  try {
    const file = await conn.client.files.downloadFile(fileKey);
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

    events.emit("counter", "download.file.ok", 1);
    events.emit("histogram", "download.file.ms", Date.now() - dlStart);
    events.emit("histogram", "download.bytes", totalBytes);
    logger.info({ fileKey, totalBytes }, "download complete");
  } catch (err) {
    events.emit("counter", "download.file.err", 1);
    logger.error({ err, fileKey }, "download failed");
    throw err;
  }
}

