# resources/

Drop real upload payloads in this folder.

On `pnpm build`, the project runs a **pre-build step** that scans `resources/`, computes
file metadata (size + fingerprint), and regenerates the manifest:

- `src/resources/manifest.ts`

That manifest is what the load tests use to pick files for upload.

We do this so we **don’t recompute fingerprints** for the same files on every VU/iteration,
and so the **timing measurements exclude local hashing cost** (they focus on chain/MSP behavior).

## Adding a new resource

1. Copy your file into `resources/`
2. Run:

```bash
pnpm build
```

If you want to regenerate only the manifest:

```bash
pnpm util:resources:manifest
```

## Optional: generate random resources (dedupe-safe)

If the system dedupes by fingerprint/content and you want to ensure each upload is “real”,
you can generate random files locally (bytes only; no units):

```bash
pnpm exec tsx scripts/resources.ts --generate --count 10 --min-bytes 1048576 --max-bytes 1048576 --clean
```

Safety: the generator enforces a **15 GiB** total cap per run (`count * max-bytes`), and will throw if exceeded.
