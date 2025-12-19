import { getLogger } from "../log.js";
import {
  cacheAccountIndex,
  selectAccountIndex,
} from "../helpers/accountIndex.js";
import { deriveAccountFromMnemonic } from "../helpers/accounts.js";
import { toError } from "../helpers/errors.js";
import { readBoolEnv, readRequiredEnv } from "../helpers/env.js";

type Done = (error?: Error) => void;

type ArtilleryEvents = Readonly<{
  emit: (type: string, name: string, value: number) => void;
}>;

type ArtilleryContext = {
  vars?: Record<string, unknown>;
};

/**
 * Phase 1 test function: derive account from mnemonic + selected index and print:
 * - index
 * - full derivation path
 * - address
 * - private key (ONLY if PRINT_DERIVED_PRIVATE_KEY=true)
 */
export async function deriveAndPrint(
  context: ArtilleryContext,
  _events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  try {
    const logger = getLogger();
    if (!context.vars) {
      context.vars = {};
    }
    const vars = context.vars;

    const mnemonic = readRequiredEnv("TEST_MNEMONIC");
    const selection = selectAccountIndex(vars);
    cacheAccountIndex(vars, selection);

    const derived = deriveAccountFromMnemonic(mnemonic, selection.index);
    vars.__accountAddress = derived.account.address;
    vars.__derivationPath = derived.derivation.path;

    const printPk = readBoolEnv("PRINT_DERIVED_PRIVATE_KEY");
    if (printPk) {
      if (!derived.privateKey) {
        logger.warn(
          {
            index: selection.index,
            path: derived.derivation.path,
            address: derived.account.address,
          },
          "derived account has no privateKey available to print"
        );
      } else {
        logger.info(
          {
            index: selection.index,
            path: derived.derivation.path,
            address: derived.account.address,
            privateKey: derived.privateKey,
          },
          "derived account (PRINT_DERIVED_PRIVATE_KEY enabled)"
        );
      }
    } else {
      logger.info(
        {
          index: selection.index,
          path: derived.derivation.path,
          address: derived.account.address,
        },
        "derived account"
      );
    }

    if (typeof done === "function") done();
  } catch (err) {
    const error = toError(err);
    if (typeof done === "function") return done(error);
    throw error;
  }
}
