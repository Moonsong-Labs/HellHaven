import { MspClient, type Session } from "@storagehub-sdk/msp-client";
import { readEnv } from "../config.js";
import { getLogger } from "../log.js";
import { NETWORKS } from "../networks.js";
import { cacheAccountIndex, selectAccountIndex } from "../helpers/accountIndex.js";
import { deriveAccountFromMnemonic } from "../helpers/accounts.js";
import { toError } from "../helpers/errors.js";
import { readRequiredEnv } from "../helpers/env.js";
import { createViemWallet } from "../sdk/viemWallet.js";
import { authenticateSIWE } from "../sdk/msp.js";
import { buildMspHttpClientConfig } from "../sdk/mspHttpConfig.js";
import { privateKeyToAccount } from "viem/accounts";

type Done = (error?: Error) => void;

type ArtilleryEvents = Readonly<{
  emit: (type: string, name: string, value: number) => void;
}>;

type ArtilleryContext = {
  vars?: Record<string, unknown>;
};

function requireVarString(vars: Record<string, unknown>, key: string): string {
  const v = vars[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`Missing or invalid var: ${key}`);
  }
  return v.trim();
}

function require0xPrivateKey(raw: string): `0x${string}` {
  const s = raw.trim();
  if (!s.startsWith("0x")) {
    throw new Error("privateKey must be 0x-prefixed");
  }
  return s as `0x${string}`;
}

function ensureVars(context: ArtilleryContext): Record<string, unknown> {
  if (!context.vars) context.vars = {};
  return context.vars;
}

async function fetchNextIndex(): Promise<number> {
  const baseUrl = process.env.INDEX_ALLOCATOR_URL?.trim();
  if (!baseUrl) {
    throw new Error("Missing INDEX_ALLOCATOR_URL (index allocator not running)");
  }

  const timeoutMsRaw = process.env.INDEX_ALLOCATOR_TIMEOUT_MS?.trim();
  const timeoutMs =
    timeoutMsRaw && timeoutMsRaw.length > 0
      ? Number.parseInt(timeoutMsRaw, 10)
      : 2000;
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2000;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${baseUrl}/next`, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`allocator /next failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object") {
      throw new Error("allocator response is not an object");
    }
    const idx = (body as { index?: unknown }).index;
    if (!Number.isInteger(idx) || (idx as number) < 0) {
      throw new Error(`allocator returned invalid index: ${String(idx)}`);
    }
    return idx as number;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Init phase (1):
 * - pick an index (ACCOUNT_MODE + vars)
 * - derive account from TEST_MNEMONIC
 * - store the derived privateKey (and some debug info) in context.vars
 */
export async function initPickIndexAndDerivePrivateKey(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  try {
    const logger = getLogger();
    const vars = ensureVars(context);

    const mnemonic = readRequiredEnv("TEST_MNEMONIC");
    // Cache: keep index stable for the duration of the VU.
    let selection = selectAccountIndex(vars);
    if (process.env.INDEX_ALLOCATOR_URL?.trim()) {
      // When allocator is enabled, override the selection once per VU
      // (this avoids duplicates caused by Artillery sandboxing).
      if (!Number.isInteger(vars.__accountIndex)) {
        const idx = await fetchNextIndex();
        selection = { mode: "byIndex", index: idx, source: "allocator:/next" };
        vars.accountIndex = idx;
      }
    }
    cacheAccountIndex(vars, selection);

    const derived = deriveAccountFromMnemonic(mnemonic, selection.index);
    if (!derived.privateKey) {
      throw new Error("Derived account has no privateKey available");
    }

    vars.privateKey = derived.privateKey;
    vars.__accountAddress = derived.account.address;
    vars.__derivationPath = derived.derivation.path;

    logger.debug(
      {
        index: selection.index,
        path: derived.derivation.path,
        address: derived.account.address,
        source: selection.source,
      },
      "init (1/2) derived account"
    );

    events.emit("counter", "init.derive.ok", 1);
    events.emit("histogram", "init.derive.ms", Date.now() - start);
    done?.();
  } catch (err) {
    events.emit("counter", "init.derive.err", 1);
    done?.(toError(err));
  }
}

/**
 * Init phase (3):
 * - create a new MspClient
 * - authenticate with SIWE using the wallet
 * - store token (and minimal session fields) in context.vars
 */
export async function initSiwe(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  try {
    const logger = getLogger();
    const env = readEnv();
    const network = NETWORKS[env.network];
    const vars = ensureVars(context);

    const pkRaw = requireVarString(vars, "privateKey");
    const pk = require0xPrivateKey(pkRaw);

    const account = privateKeyToAccount(pk);
    const walletClient = createViemWallet(network, account);

    const config = buildMspHttpClientConfig(network);
    const mspClient = await MspClient.connect(config);

    const session = await authenticateSIWE(
      walletClient,
      mspClient,
      network.msp.siweDomain,
      network.msp.siweUri,
      logger
    );

    // Store only what we need to recreate sessionProvider later.
    const sessionLite: Readonly<Pick<Session, "token" | "user">> = {
      token: session.token,
      user: session.user,
    };
    vars.__siweToken = session.token;
    vars.__siweSession = sessionLite;

    logger.debug(
      { address: session.user.address },
      "init (2/2) SIWE authenticated"
    );

    events.emit("counter", "init.siwe.ok", 1);
    events.emit("histogram", "init.siwe.ms", Date.now() - start);
    done?.();
  } catch (err) {
    events.emit("counter", "init.siwe.err", 1);
    done?.(toError(err));
  }
}

/**
 * Example action step:
 * - recreate MspClient using the stored session
 * - call getProfile
 *
 * This demonstrates the “init -> actions” split without keeping an MspClient instance in memory.
 */
export async function actionGetProfile(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const start = Date.now();
  try {
    const env = readEnv();
    const network = NETWORKS[env.network];
    const vars = ensureVars(context);

    const sessionRaw = vars.__siweSession;
    if (!sessionRaw || typeof sessionRaw !== "object") {
      throw new Error("Missing __siweSession (did you run initSiwe?)");
    }

    const session = sessionRaw as Readonly<Pick<Session, "token" | "user">>;
    const config = buildMspHttpClientConfig(network);
    const client = await MspClient.connect(config, async () => session as Session);

    const logger = getLogger();
    const profile = await client.auth.getProfile();
    logger.debug(
      {
        address: session.user.address,
        profile: {
          address: profile.address,
          ens: profile.ens,
        },
      },
      "action getProfile ok"
    );

    events.emit("counter", "action.getProfile.ok", 1);
    events.emit("histogram", "action.getProfile.ms", Date.now() - start);
    done?.();
  } catch (err) {
    events.emit("counter", "action.getProfile.err", 1);
    done?.(toError(err));
  }
}


