/* eslint-disable no-console */
import { deriveAccountFromMnemonic } from "../src/helpers/accounts.js";
import { NETWORKS } from "../src/networks.js";
import { parseNetworkName } from "../src/config.js";
import { ensure0xPrefix } from "../src/helpers/validation.js";
import { createPublicClient, http, parseEther } from "viem";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createViemWallet, toViemChain } from "../src/sdk/viemWallet.js";

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return undefined;
  return v;
}

function readIntArg(name: string, fallback: number): number {
  const raw = readArg(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid --${name}: ${raw}`);
  }
  return n;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  # Print recipients (no transfers):",
      "  pnpm util:fund-accounts -- --mnemonic \"...\" [--count 10] [--start 0] [--json|--tsv]",
      "",
      "  # Fund recipients (native token transfers):",
      "  NETWORK=local TEST_MNEMONIC=\"...\" pnpm util:fund-accounts -- --privateKey 0x... --amount 0.01 [--count 10] [--start 0] --yes",
      "  NETWORK=local TEST_MNEMONIC=\"...\" pnpm util:fund-accounts -- --privateKey 0x... --amountWei 10000000000000000 [--count 10] [--start 0] --yes",
      "",
      "Alternatively set env var TEST_MNEMONIC and omit --mnemonic.",
      "",
      "Examples:",
      "  TEST_MNEMONIC=\"...\" pnpm util:fund-accounts -- --count 10",
      "  pnpm util:fund-accounts -- --mnemonic \"...\" --start 0 --count 10 --json",
      "  NETWORK=local TEST_MNEMONIC=\"...\" pnpm util:fund-accounts -- --privateKey 0x... --amount 0.01 --count 10 --yes",
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
    `${"index".padStart(indexWidth)}  ` +
    `${"derivationPath".padEnd(pathWidth)}  ` +
    "address"
  );
  // Separator
  console.log(
    `${"".padStart(indexWidth, "-")}  ` +
    `${"".padEnd(pathWidth, "-")}  ` +
    "------------------------------------------"
  );

  // Rows
  for (const r of rows) {
    console.log(
      `${String(r.index).padStart(indexWidth)}  ` +
      `${r.path.padEnd(pathWidth)}  ` +
      r.address
    );
  }
}

async function transferToAccount(
  walletClient: WalletClient,
  publicClient: PublicClient,
  account: ReturnType<typeof privateKeyToAccount>,
  to: Address,
  value: bigint,
  index: number
): Promise<void> {
  const hash = await walletClient.sendTransaction({
    account,
    chain: null,
    to,
    value,
  });
  console.log(`tx sent index=${index} to=${to} hash=${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`tx mined index=${index} status=${receipt.status} block=${receipt.blockNumber}`);

  if (receipt.status !== "success") {
    throw new Error(`Transfer failed (index=${index}, to=${to}, hash=${hash})`);
  }
}

const mnemonic = readArg("mnemonic") ?? process.env.TEST_MNEMONIC?.trim();
if (!mnemonic) usage();

const start = readIntArg("start", 0);
const count = readIntArg("count", 10);
const asJson = process.argv.includes("--json");
const asTsv = process.argv.includes("--tsv");
const dryRun = process.argv.includes("--dry-run");
const yes = process.argv.includes("--yes");

const privateKeyRaw = readArg("privateKey") ?? process.env.SENDER_PRIVATE_KEY?.trim();
// `--amount` is a native-token decimal amount (MOCK/STAGE/SH/etc depending on network).
const amountRaw = readArg("amount");
const amountWeiRaw = readArg("amountWei");

const wantsFunding = Boolean(privateKeyRaw || amountRaw || amountWeiRaw);

const rows = Array.from({ length: count }, (_, i) => {
  const idx = start + i;
  const derived = deriveAccountFromMnemonic(mnemonic, idx);
  return {
    index: idx,
    path: derived.derivation.path,
    address: derived.account.address,
  };
});

if (!wantsFunding) {
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
  } else if (asTsv) {
    for (const r of rows) {
      console.log(`${r.index}\t${r.path}\t${r.address}`);
    }
  } else {
    printTable(rows, start, count);
  }
} else {
  if (!privateKeyRaw) {
    throw new Error("Missing --privateKey (or env SENDER_PRIVATE_KEY)");
  }
  if ((amountRaw && amountWeiRaw) || (!amountRaw && !amountWeiRaw)) {
    throw new Error("Provide exactly one of: --amount or --amountWei");
  }
  if (!yes && !dryRun) {
    throw new Error("Refusing to send transactions without --yes (or use --dry-run)");
  }

  const networkName = parseNetworkName(
    process.env.NETWORK?.trim() ?? readArg("NETWORK") ?? "local"
  );
  const network = NETWORKS[networkName];
  const { chain, transportUrl } = toViemChain(network);

  const pk = ensure0xPrefix(privateKeyRaw, 32).toLowerCase() as Hex;
  const account = privateKeyToAccount(pk);
  const walletClient = createViemWallet(network, account);
  const publicClient = createPublicClient({ chain, transport: http(transportUrl) });

  const value: bigint = amountRaw ? parseEther(amountRaw) : BigInt(amountWeiRaw!);

  console.log(
    `Funding ${rows.length} accounts on ${network.name} from ${account.address} with value=${value} wei` +
    (dryRun ? " (dry-run)" : "")
  );

  for (const r of rows) {
    const to = r.address as Address;
    if (dryRun) {
      console.log(`[dry-run] -> ${to} value=${value} wei (index=${r.index})`);
      continue;
    }

    await transferToAccount(walletClient, publicClient, account, to, value, r.index);
  }
}
