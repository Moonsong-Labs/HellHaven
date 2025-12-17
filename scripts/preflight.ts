import { readEnv } from "../src/config.js";
import { getLogger } from "../src/log.js";
import {
  authenticateWithSiwe,
  connectMsp,
  validateMspConnection,
} from "../src/sdk/msp.js";
import { NETWORKS } from "../src/networks.js";
import { initWalletFromPrivateKey, to0xPrivateKey } from "../src/sdk/wallet.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(typeof err === "string" ? err : "Unknown error");
}

function readFirstPrivateKeyFromCsv(filePath: string): string | undefined {
  const text = readFileSync(filePath, "utf8");
  const lines = text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (const line of lines) {
    if (line.toLowerCase() === "privatekey") {
      continue;
    }
    // CSV is 1-column: privateKey
    return line;
  }
  return undefined;
}

async function main(): Promise<void> {
  const env = readEnv();
  const logger = getLogger();

  const fromEnv = process.env.STORAGEHUB_PRIVATE_KEY;
  const csvPath = join(process.cwd(), "data", "private_keys.csv");
  const fromCsv = (() => {
    try {
      return readFirstPrivateKeyFromCsv(csvPath);
    } catch {
      return undefined;
    }
  })();

  const privateKeyRaw = fromEnv ?? fromCsv;
  if (!privateKeyRaw) {
    throw new Error(
      "No private key available for SIWE. Set STORAGEHUB_PRIVATE_KEY or create data/private_keys.csv"
    );
  }

  const privateKey = to0xPrivateKey(privateKeyRaw);
  const network = NETWORKS[env.network];
  const { walletClient } = initWalletFromPrivateKey(network, privateKey);

  const msp = await connectMsp(env, logger);
  await validateMspConnection(msp, logger);
  await authenticateWithSiwe(msp, env, walletClient, logger);
}

main().catch((err: unknown) => {
  const error = toError(err);
  // preflight should fail fast with a clear message for CI
  console.error(error);
  process.exitCode = 1;
});
