import {
  FileMetadata,
  FileTrie,
  type FileInfo,
  hexToBytes,
  initWasm,
  ReplicationLevel,
} from "@storagehub-sdk/core";
import type { UploadReceipt, UploadOptions } from "@storagehub-sdk/msp-client";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

// Re-export SDK types for convenience
export type { FileInfo, UploadReceipt, UploadOptions };
export { ReplicationLevel };

let wasmInitPromise: Promise<void> | undefined;
async function ensureWasmReady(): Promise<void> {
  wasmInitPromise ??= initWasm();
  await wasmInitPromise;
}

function bytesTo0x(bytes: Uint8Array): `0x${string}` {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Stream a file from disk as a Web ReadableStream (no buffering in memory).
 *
 * This shape is accepted by `mspClient.files.uploadFile(...)`.
 */
export function filePathToWebStream(
  filePath: string
): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(filePath);
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

export async function getFileSizeBytes(filePath: string): Promise<number> {
  const s = await stat(filePath);
  return s.size;
}

/**
 * Compute the StorageHub Merkle fingerprint (root) by streaming the file through the SDK wasm.
 */
export async function computeFileFingerprintFromPath(
  filePath: string
): Promise<`0x${string}`> {
  await ensureWasmReady();
  const trie = new FileTrie();

  // Use a larger read buffer to reduce JS overhead; the wasm will re-chunk canonically.
  const rs = createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 });
  for await (const chunk of rs) {
    const u8 =
      chunk instanceof Uint8Array
        ? chunk
        : new Uint8Array(chunk as ArrayBuffer);
    trie.push_chunks_batched(u8);
  }

  const root = trie.get_root();
  return bytesTo0x(root);
}

/**
 * Compute the on-chain fileKey from FileMetadata (wasm).
 *
 * Note: this does NOT read file bytes; it relies on caller-provided fingerprint + size.
 */
export async function computeFileKeyFromMetadata(params: {
  owner: `0x${string}`; // 20-byte EVM address
  bucketId: `0x${string}`; // 32-byte bucketId
  location: string;
  size: bigint;
  fingerprint: `0x${string}`; // 32-byte fingerprint
}): Promise<`0x${string}`> {
  await ensureWasmReady();

  const ownerBytes = hexToBytes(params.owner);
  const bucketBytes = hexToBytes(params.bucketId);
  const fingerprintBytes = hexToBytes(params.fingerprint);
  const locationBytes = new TextEncoder().encode(params.location);

  const md = new FileMetadata(
    ownerBytes,
    bucketBytes,
    locationBytes,
    params.size,
    fingerprintBytes
  );
  return bytesTo0x(md.getFileKey());
}