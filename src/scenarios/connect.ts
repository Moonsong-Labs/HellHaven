import { readEnv } from "../config.js";
import { getLogger } from "../log.js";
import {
  authenticateWithSiwe,
  connectMsp,
  validateMspConnection,
} from "../sdk/msp.js";
import { initWalletFromPrivateKey, to0xPrivateKey } from "../sdk/wallet.js";
import { NETWORKS } from "../networks.js";
import { nextPrivateKey } from "../privateKeys.js";
import { nextWalletFromPool } from "../sdk/walletPool.js";

type Done = (error?: Error) => void;

type ArtilleryEvents = Readonly<{
  emit: (type: string, name: string, value: number) => void;
}>;

type ArtilleryContext = Readonly<{
  vars?: Record<string, unknown>;
}>;

function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(typeof err === "string" ? err : "Unknown error");
}

function readVarString(ctx: ArtilleryContext, key: string): string {
  const v = ctx.vars?.[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing or invalid VU var: ${key}`);
  }
  return v;
}

function readPrivateKeyForVu(ctx: ArtilleryContext): string {
  const fromVars = ctx.vars?.privateKey;
  if (typeof fromVars === "string" && fromVars.length > 0) {
    return fromVars;
  }
  const fallback = nextPrivateKey();
  getLogger().warn(
    { sourcePath: fallback.sourcePath },
    "privateKey not provided by Artillery vars; using fallback from file"
  );
  return fallback.privateKey;
}

async function maybeClose(obj: unknown): Promise<void> {
  if (!obj || typeof obj !== "object") {
    return;
  }
  const record = obj as Record<string, unknown>;
  const close = record.close;
  const destroy = record.destroy;

  const fn =
    typeof close === "function"
      ? close
      : typeof destroy === "function"
        ? destroy
        : undefined;
  if (!fn) {
    return;
  }
  await Promise.resolve(fn());
}

export async function connectClients(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  try {
    const env = readEnv();
    const logger = getLogger();

    const privateKeyRaw = readPrivateKeyForVu(context);
    const privateKey = to0xPrivateKey(privateKeyRaw);

    const network = NETWORKS[env.network];
    const { walletClient } = context.vars?.privateKey
      ? initWalletFromPrivateKey(network, privateKey)
      : nextWalletFromPool(network);
    const mspConn = await connectMsp(env, logger);

    const mspStart = Date.now();
    await validateMspConnection(mspConn, logger);
    events.emit("counter", "sdk.msp.connect.ok", 1);
    events.emit("histogram", "sdk.msp.connect.ms", Date.now() - mspStart);

    const authStart = Date.now();
    await authenticateWithSiwe(mspConn, env, walletClient, logger);
    events.emit("counter", "sdk.msp.siwe.ok", 1);
    events.emit("histogram", "sdk.msp.siwe.ms", Date.now() - authStart);

    // Option A teardown: best-effort (SDK clients may not expose explicit close)
    try {
      await maybeClose(mspConn.client);
      events.emit("counter", "sdk.disconnect.ok", 1);
    } catch (err) {
      events.emit("counter", "sdk.disconnect.error", 1);
      throw err;
    }

    if (typeof done === "function") {
      done();
    }
  } catch (err) {
    const error = toError(err);
    events.emit("counter", "sdk.connect.error", 1);
    if (typeof done === "function") {
      done(error);
      return;
    }
    throw error;
  }
}
