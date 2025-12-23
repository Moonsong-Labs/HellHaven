// Single entrypoint for all Artillery processor functions.
//
// All Artillery YAML files should point `config.processor` to:
//    `../dist/src/processors/index.js`
//
// This module re-exports:
// - common setup steps (e.g. pick index + derive private key, SIWE auth)
// - action steps (e.g. getProfile, download, connect, unauth health/info)
//
// Keeping one processor entrypoint avoids per-scenario re-exports and keeps YAMLs consistent.

export * from "./account-derive.js";
export * from "./authentication.js";
export * from "./download.js";
export * from "./log-smoke.js";
export * from "./metrics.js";
export * from "./msp-unauth.js";
export * from "./siwe-bootstrap.js";
export * from "./examples.js";
