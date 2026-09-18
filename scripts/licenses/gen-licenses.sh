#!/usr/bin/env bash
# Regenerate src-tauri/THIRD_PARTY_LICENSES from the Rust and npm dependency
# trees plus the hand-written vendored notices. Run before each release.
#
# Requires: cargo-about (cargo install cargo-about --locked),
#           license-checker-rseidelsohn (npm i -D), node.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIC="$ROOT/scripts/licenses"
BUILD="$LIC/.build"
OUT="$ROOT/src-tauri/THIRD_PARTY_LICENSES"
ALLOW='MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;Zlib;Unlicense;MPL-2.0'

mkdir -p "$BUILD"

echo "==> Rust dependencies (cargo-about)"
cargo about generate \
  --manifest-path "$ROOT/src-tauri/Cargo.toml" \
  --config "$LIC/about.toml" \
  --locked --fail \
  "$LIC/about.hbs" > "$BUILD/rust.txt"

echo "==> Frontend dependencies (license-checker-rseidelsohn)"
( cd "$ROOT" && npx --no-install license-checker-rseidelsohn \
  --production \
  --excludePrivatePackages \
  --onlyAllow "$ALLOW" \
  --json \
  --customPath "$LIC/frontend-format.json" ) > "$BUILD/frontend.json"

echo "==> Validate and format frontend licenses"
node "$LIC/format-frontend.cjs" "$BUILD/frontend.json" > "$BUILD/frontend.txt"

echo "==> Assemble THIRD_PARTY_LICENSES"
TMP="$BUILD/THIRD_PARTY_LICENSES.tmp"
{
  echo "Third-party licenses for Marku"
  echo
  echo "This file lists the licenses of bundled third-party software."
  echo "The frontend section reflects the npm production dependency tree, which"
  echo "may be a superset of what the final bundle ships (extra entries are"
  echo "acceptable; missing ones are not)."
  echo
  echo
  cat "$BUILD/rust.txt"
  echo
  cat "$BUILD/frontend.txt"
  echo
  cat "$LIC/vendored.txt"
} > "$TMP"

mv "$TMP" "$OUT"
echo "==> Wrote $OUT"
