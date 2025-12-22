import { Readable } from "node:stream";
import { readEnv } from "../config.js";
import { getLogger } from "../log.js";
import { authenticateWithSiwe, connectMsp } from "../sdk/msp.js";
import { NETWORKS } from "../networks.js";
import { cacheAccountIndex, selectAccountIndex } from "../helpers/accountIndex.js";
import { deriveAccountFromMnemonic } from "../helpers/accounts.js";
import { toError } from "../helpers/errors.js";
import { readRequiredEnv } from "../helpers/env.js";
import { createViemWallet } from "../sdk/viemWallet.js";

type ArtilleryEvents = Readonly<{
  emit: (type: string, name: string, value: number) => void;
}>;

type ArtilleryContext = {
  vars?: Record<string, unknown>;
};

function getFileKey(): string {
  const key = process.env.FILE_KEY;
  if (!key) {
    throw new Error("FILE_KEY env var is required");
  }
  return key;
}

function ensureVars(context: ArtilleryContext): Record<string, unknown> {
  if (!context.vars) context.vars = {};
  return context.vars;
}

export async function downloadFile(
  context: ArtilleryContext,
  events: ArtilleryEvents
): Promise<void> {
  const logger = getLogger();
  const env = readEnv();
  const network = NETWORKS[env.network];
  const fileKey = getFileKey();

  // Init: derive account from TEST_MNEMONIC + selected index (ACCOUNT_MODE vars).
  const vars = ensureVars(context);
  const mnemonic = readRequiredEnv("TEST_MNEMONIC");
  const selection = selectAccountIndex(vars);
  cacheAccountIndex(vars, selection);
  const derived = deriveAccountFromMnemonic(mnemonic, selection.index);
  const walletClient = createViemWallet(network, derived.account);

  // Connect and authenticate
  const conn = await connectMsp(env, logger);

  const siweStart = Date.now();
  try {
    await authenticateWithSiwe(conn, env, walletClient, logger);
    events.emit("counter", "download.siwe.ok", 1);
    events.emit("histogram", "download.siwe.ms", Date.now() - siweStart);
  } catch (err) {
    events.emit("counter", "download.siwe.err", 1);
    const error = toError(err);
    logger.error({ err: error }, "siwe failed");
    throw error;
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
    const error = toError(err);
    logger.error({ err: error, fileKey }, "download failed");
    throw error;
  }
}
