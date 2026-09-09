/**
 * The user-facing extension version, rendered in the nav footer and on the
 * About page.
 *
 * Hand-written, but NOT hand-trusted: `scripts/check-version-sync.mjs` runs as
 * `prebuild` and fails the build if this disagrees with `package.json#version`
 * or `info.json#version`. Bump all three together.
 *
 * A check rather than build-time generation on purpose — generating this file
 * would rewrite tracked source on every build and put a generated artifact in
 * git history, to solve a problem one file read already catches.
 */
export const EXTENSION_VERSION = "0.1.0-alpha.143";
