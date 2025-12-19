import type { Hex } from "viem";
import { toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { HDAccount } from "viem/accounts";

export type DerivationInfo = Readonly<{
  index: number;
  path: `m/44'/60'/${string}`;
}>;

export type DerivedAccount = Readonly<{
  account: HDAccount;
  derivation: DerivationInfo;
  /**
   * Derived private key (hex, 0x-prefixed) if available.
   *
   * IMPORTANT: Never log this unless explicitly gated by config.
   */
  privateKey?: Hex;
}>;

export function derivePath(index: number): `m/44'/60'/${string}` {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `Invalid derivation index: ${String(index)} (expected integer >= 0)`
    );
  }
  return `m/44'/60'/0'/0/${index}`;
}

export function deriveAccountFromMnemonic(
  mnemonic: string,
  index: number
): DerivedAccount {
  if (typeof mnemonic !== "string" || mnemonic.trim().length === 0) {
    throw new Error("Missing or invalid mnemonic");
  }

  const path = derivePath(index);
  const account = mnemonicToAccount(mnemonic, { path });

  const hdKey = account.getHdKey();
  const privateKey =
    hdKey.privateKey && hdKey.privateKey.length > 0
      ? toHex(hdKey.privateKey)
      : undefined;

  const base: {
    account: HDAccount;
    derivation: DerivationInfo;
    privateKey?: Hex;
  } = {
    account,
    derivation: { index, path },
  };

  if (privateKey) {
    base.privateKey = privateKey;
  }

  return base;
}
