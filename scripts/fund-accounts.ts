/* eslint-disable no-console */
import { deriveAccountFromMnemonic } from "../src/helpers/accounts.js";
import { NETWORKS } from "../src/networks.js";
import { parseNetworkName } from "../src/config.js";
import {
  ensure0xPrefix,
  requireInteger,
  requireNonEmptyString,
} from "../src/helpers/validation.js";
import { createPublicClient, http, parseEther } from "viem";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createViemWallet, toViemChain } from "../src/sdk/viemWallet.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readOptionalStringArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) {
    throw new Error(`Missing value for --${name}`);
  }
  return requireNonEmptyString(v, `--${name}`);
}

function readOptionalNonNegativeIntArg(name: string): number | undefined {
  const raw = readOptionalStringArg(name);
  if (raw === undefined) return undefined;
  const n = requireInteger(raw, `--${name}`);
  if (n < 0) {
    throw new Error(`Invalid --${name}: ${String(n)} (expected integer >= 0)`);
  }
  return n;
}

function readOptionalPositiveIntArg(name: string): number | undefined {
  const n = readOptionalNonNegativeIntArg(name);
  if (n === undefined) return undefined;
  if (n <= 0) {
    throw new Error(`Invalid --${name}: ${String(n)} (expected integer > 0)`);
  }
  return n;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  # Print recipients (no transfers):",
      '  pnpm util:fund-accounts -- --mnemonic "..." [--count 10] [--start 0] [--json|--tsv]',
      "",
      "  # Fund recipients (native token transfers):",
      '  NETWORK=local TEST_MNEMONIC="..." pnpm util:fund-accounts -- --privateKey 0x... --amount 0.01 [--count 10] [--start 0] [--batchSize 10]',
      "",
      "Alternatively set env var TEST_MNEMONIC and omit --mnemonic.",
      "",
      "Options:",
      "  --batchSize N    Process N transactions in parallel per batch (default: 10)",
      "                   Higher values = faster but may hit RPC rate limits",
      "",
      "Examples:",
      '  TEST_MNEMONIC="..." pnpm util:fund-accounts -- --count 10',
      '  pnpm util:fund-accounts -- --mnemonic "..." --start 0 --count 10 --json',
      '  NETWORK=local TEST_MNEMONIC="..." pnpm util:fund-accounts -- --privateKey 0x... --amount 0.01 --count 10',
      '  NETWORK=stagenet TEST_MNEMONIC="..." pnpm util:fund-accounts -- --privateKey 0x... --amount 0.1 --count 100 --batchSize 20',
    ].join("\n")
  );
  process.exit(1);
}

type AccountRow = {
  index: number;
  path: string;
  address: string;
};

function printTable(rows: AccountRow[], start: number, count: number): void {
  const indexWidth = Math.max(String(start + count - 1).length, "index".length);
  const pathWidth = Math.max(
    ...rows.map((r) => r.path.length),
    "derivationPath".length
  );

  // Header
  console.log(
    `${"index".padStart(indexWidth)}  ${"derivationPath".padEnd(pathWidth)}  address`
  );
  // Separator
  console.log(
    `${"".padStart(indexWidth, "-")}  ${"".padEnd(pathWidth, "-")}  ------------------------------------------`
  );

  // Rows
  for (const r of rows) {
    console.log(
      `${String(r.index).padStart(indexWidth)}  ${r.path.padEnd(pathWidth)}  ${r.address}`
    );
  }
}

async function transferToAccount(
  walletClient: WalletClient,
  publicClient: PublicClient,
  account: ReturnType<typeof privateKeyToAccount>,
  to: Address,
  value: bigint,
  index: number,
  nonce?: number
): Promise<void> {
  const hash = await walletClient.sendTransaction({
    account,
    chain: null,
    to,
    value,
    nonce,
  });
  console.log(`tx sent index=${index} to=${to} nonce=${nonce} hash=${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(
    `tx mined index=${index} status=${receipt.status} block=${receipt.blockNumber}`
  );

  if (receipt.status !== "success") {
    throw new Error(`Transfer failed (index=${index}, to=${to}, hash=${hash})`);
  }
}

/**
 * Send many native-token transfers with explicit nonce management.
 *
 *
 * Why explicit nonces:
 * - We read the sender's current nonce from the chain (using `blockTag: "pending"`).
 * - We then assign nonces deterministically as:
 *   `nonce = startNonce + globalOffset`, where `globalOffset` is the 0-based index
 *   in the full `recipients` list.
 *
 * Why batching:
 * - We submit up to `batchSize` transactions in parallel, then wait for them to be mined.
 * - This keeps throughput high while avoiding overwhelming the RPC endpoint.
 *
 * Failure mode:
 * - If one tx in a batch fails, this will throw. Some previous txs may still have been
 *   sent/mined already (best-effort utility script).
 */
async function transferBatch(
  walletClient: WalletClient,
  publicClient: PublicClient,
  account: ReturnType<typeof privateKeyToAccount>,
  recipients: Array<{ to: Address; value: bigint; index: number }>,
  batchSize: number
): Promise<void> {
  // Get current nonce from chain
  const startNonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });

  console.log(
    `Starting batch from nonce=${startNonce}, total transfers=${recipients.length}`
  );

  // Process in batches to avoid overwhelming the RPC
  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(recipients.length / batchSize);

    console.log(
      `\nProcessing batch ${batchNum}/${totalBatches} (${batch.length} txs)...`
    );

    // Submit all txs in this batch in parallel with explicit nonces.
    // Note: `i` is the start offset of this batch in the overall recipients list.
    const promises = batch.map((recipient, batchIdx) => {
      const globalOffset = i + batchIdx;
      const nonce = startNonce + globalOffset;
      return transferToAccount(
        walletClient,
        publicClient,
        account,
        recipient.to,
        recipient.value,
        recipient.index,
        nonce
      );
    });

    // Wait for all transactions in this batch to complete
    await Promise.all(promises);

    console.log(`✓ Batch ${batchNum}/${totalBatches} completed`);
  }
}

type PrintArgs = Readonly<{
  mode: "print";
  mnemonic: string;
  start: number;
  count: number;
  format: "json" | "tsv" | "table";
}>;

type FundArgs = Readonly<{
  mode: "fund";
  mnemonic: string;
  start: number;
  count: number;
  batchSize: number;
  networkName: ReturnType<typeof parseNetworkName>;
  privateKeyRaw: string;
  value: bigint;
}>;

function parseArgs(): PrintArgs | FundArgs {
  const mnemonic =
    readOptionalStringArg("mnemonic") ?? process.env.TEST_MNEMONIC?.trim();
  if (!mnemonic) usage();

  const start = readOptionalNonNegativeIntArg("start") ?? 0;
  const count = readOptionalPositiveIntArg("count") ?? 10;

  const format: PrintArgs["format"] = hasFlag("json")
    ? "json"
    : hasFlag("tsv")
      ? "tsv"
      : "table";

  const privateKeyRaw =
    readOptionalStringArg("privateKey") ?? process.env.SENDER_PRIVATE_KEY?.trim();
  const amountRaw = readOptionalStringArg("amount");

  const wantsFunding = Boolean(privateKeyRaw || amountRaw);
  if (!wantsFunding) {
    return { mode: "print", mnemonic, start, count, format };
  }

  if (!privateKeyRaw) {
    throw new Error("Missing --privateKey (or env SENDER_PRIVATE_KEY)");
  }
  if (!amountRaw) throw new Error("Missing --amount");

  const batchSize = readOptionalPositiveIntArg("batchSize") ?? 10;
  const networkName = parseNetworkName(process.env.NETWORK?.trim() ?? "local");

  let value: bigint;
  try {
    value = parseEther(amountRaw);
  } catch {
    throw new Error(`Invalid --amount: ${String(amountRaw)}`);
  }

  return {
    mode: "fund",
    mnemonic,
    start,
    count,
    batchSize,
    networkName,
    privateKeyRaw,
    value,
  };
}

const args = parseArgs();

const rows = Array.from({ length: args.count }, (_, i) => {
  const idx = args.start + i;
  const derived = deriveAccountFromMnemonic(args.mnemonic, idx);
  return {
    index: idx,
    path: derived.derivation.path,
    address: derived.account.address,
  };
});

if (args.mode === "print") {
  if (args.format === "json") {
    console.log(JSON.stringify(rows, null, 2));
  } else if (args.format === "tsv") {
    for (const r of rows) {
      console.log(`${r.index}\t${r.path}\t${r.address}`);
    }
  } else {
    printTable(rows, args.start, args.count);
  }
} else {
  const network = NETWORKS[args.networkName];
  const { chain, transportUrl } = toViemChain(network);

  const pk = ensure0xPrefix(args.privateKeyRaw, 32).toLowerCase() as Hex;
  const account = privateKeyToAccount(pk);
  const walletClient = createViemWallet(network, account);
  const publicClient = createPublicClient({
    chain,
    transport: http(transportUrl),
  });

  console.log(
    `Funding ${rows.length} accounts on ${network.name} from ${account.address} with value=${args.value} wei (batchSize=${args.batchSize})`
  );

  const recipients = rows.map((r) => ({
    to: r.address as Address,
    value: args.value,
    index: r.index,
  }));

  const startTime = Date.now();
  await transferBatch(
    walletClient,
    publicClient,
    account,
    recipients,
    args.batchSize
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(`\n✅ All ${recipients.length} transfers completed in ${elapsed}s`);
}
