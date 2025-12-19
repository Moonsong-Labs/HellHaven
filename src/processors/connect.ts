import { readEnv } from "../config.js";
import { getLogger } from "../log.js";
import {
  authenticateWithSiwe,
  connectMsp,
  validateMspConnection,
} from "../sdk/msp.js";
import { NETWORKS } from "../networks.js";
import {
  selectAccountIndex,
  cacheAccountIndex,
} from "../helpers/accountIndex.js";
import { deriveAccountFromMnemonic } from "../helpers/accounts.js";
import { createViemWallet } from "../sdk/viemWallet.js";

type Done = (error?: Error) => void;

type ArtilleryEvents = Readonly<{
  emit: (type: string, name: string, value: number) => void;
}>;

type ArtilleryContext = {
  vars?: Record<string, unknown>;
};

function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(typeof err === "string" ? err : "Unknown error");
}

function readRequiredEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim().length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v.trim();
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
    const network = NETWORKS[env.network];
    const vars = (context.vars ??= {});

    // Derive account from mnemonic + configured index mode.
    const mnemonic = readRequiredEnv("TEST_MNEMONIC");
    const selection = selectAccountIndex(vars);
    cacheAccountIndex(vars, selection);
    const derived = deriveAccountFromMnemonic(mnemonic, selection.index);
    const walletClient = createViemWallet(network, derived.account);

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
