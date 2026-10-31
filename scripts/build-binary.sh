#!/usr/bin/env bash
# ============================================================
# Executa Tool binary packaging — mini-notes-summarizer
# ============================================================
# Builds a standalone binary with @yao-pkg/pkg and packs it into an
# Anna binary-distribution compliant archive:
#
#   <name>-<version>-<platform>.tar.gz   (macOS / Linux)
#   <name>-<version>-<platform>.zip      (Windows)
#
# Archive layout (manifest.json at the archive ROOT, per
# https://staging.anna.partners/developers/tools/executa-binary):
#
#   manifest.json          ← runtime.binary.entrypoint + permissions
#   bin/mini-notes-summarizer[.exe]
#
# Usage:
#   bash scripts/build-binary.sh                 # auto-detect host platform
#   bash scripts/build-binary.sh --platform darwin-arm64   # force target (CI)
#   bash scripts/build-binary.sh --all           # all 3 required platforms
#   bash scripts/build-binary.sh --test          # + describe smoke test
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOL_DIR="$ROOT/executas/notes-summarizer"
ENTRY="$TOOL_DIR/server.js"

TOOL_NAME="mini-notes-summarizer"
VERSION="$(node -p "require('$TOOL_DIR/package.json').version")"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"

PLATFORM=""
BUILD_ALL=false
RUN_TEST=false

for arg in "$@"; do
  case "$arg" in
    --platform) shift_for_value=true ;;
    --all)    BUILD_ALL=true ;;
    --test)   RUN_TEST=true ;;
    --help|-h)
      echo "Usage: $0 [--platform <darwin-arm64|darwin-x86_64|windows-x86_64|linux-x86_64>] [--all] [--test]"
      exit 0 ;;
    *)
      if [ "${shift_for_value:-}" = "true" ]; then PLATFORM="$arg"; shift_for_value=false; else
        echo "unknown option: $arg" >&2; exit 1
      fi ;;
  esac
done

# ── Resolve pkg binary (local devDependency preferred, npx fallback) ──
if [ -x "$TOOL_DIR/node_modules/.bin/pkg" ]; then
  PKG="$TOOL_DIR/node_modules/.bin/pkg"
else
  PKG="npx --yes @yao-pkg/pkg@latest"
fi

# ── Platform detection (host arch unless --platform given) ──────────
detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    mingw*|msys*|cygwin*) os="windows" ;;
  esac
  case "$arch" in
    amd64|x64) arch="x86_64" ;;
    aarch64|arm64) arch="${os/windows/arm64}" ;;
  esac
  echo "${os}-${arch}"
}

pkg_target_for() {
  local p="$1"
  case "$p" in
    darwin-arm64)     echo "node${NODE_MAJOR}-macos-arm64" ;;
    darwin-x86_64)    echo "node${NODE_MAJOR}-macos-x64" ;;
    linux-x86_64)     echo "node${NODE_MAJOR}-linux-x64" ;;
    linux-aarch64)    echo "node${NODE_MAJOR}-linux-arm64" ;;
    windows-x86_64)   echo "node${NODE_MAJOR}-win-x64" ;;
    windows-arm64)    echo "node${NODE_MAJOR}-win-arm64" ;;
    *) echo ""; return 1 ;;
  esac
}

ext_for() {
  case "$1" in windows-*) echo ".exe" ;; *) echo "" ;; esac
}

# ── Archive-root manifest (Anna binary distribution spec) ───────────
write_archive_manifest() {
  local dir="$1" ext="$2"
  mkdir -p "$dir/bin"
  cat > "$dir/manifest.json" <<EOF
{
  "name": "${TOOL_NAME}",
  "version": "${VERSION}",
  "runtime": {
    "binary": {
      "entrypoint": {
        "default": "bin/${TOOL_NAME}",
        "windows-x86_64": "bin/${TOOL_NAME}.exe",
        "windows-arm64": "bin/${TOOL_NAME}.exe"
      },
      "permissions": {
        "bin/${TOOL_NAME}": "0o755",
        "bin/${TOOL_NAME}.exe": "0o755"
      }
    }
  }
}
EOF
}

build_one() {
  local platform="$1"
  local target ext staging archive
  target="$(pkg_target_for "$platform")" || { echo "unsupported platform: $platform" >&2; return 1; }
  ext="$(ext_for "$platform")"

  echo "── building ${TOOL_NAME} ${VERSION} for ${platform} (pkg target ${target})"

  staging="$ROOT/dist/staging-${platform}"
  rm -rf "$staging"
  write_archive_manifest "$staging" "$ext"

  $PKG "$ENTRY" \
    --target "$target" \
    --output "$staging/bin/${TOOL_NAME}${ext}" \
    --compress Brotli

  chmod 755 "$staging/bin/${TOOL_NAME}${ext}"

  # Package: tar.gz on POSIX platforms, zip on Windows.
  mkdir -p "$ROOT/dist"
  if [[ "$platform" == windows-* ]]; then
    archive="$ROOT/dist/${TOOL_NAME}-${VERSION}-${platform}.zip"
    rm -f "$archive"
    ( cd "$staging" && zip -qr "$archive" manifest.json bin )
  else
    archive="$ROOT/dist/${TOOL_NAME}-${VERSION}-${platform}.tar.gz"
    rm -f "$archive"
    ( cd "$staging" && tar czf "$archive" manifest.json bin )
  fi

  echo "   → $archive"
}

run_smoke() {
  local platform="$1"
  local staging="$ROOT/dist/staging-${platform}"
  local bin="$staging/bin/${TOOL_NAME}$(ext_for "$platform")"
  echo "── smoke test: describe JSON-RPC against $bin"
  local out
  out="$(echo '{"jsonrpc":"2.0","method":"describe","id":1}' | "$bin" 2>/dev/null | head -n1)"
  echo "$out" | node -e '
    let d = ""; process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      const r = JSON.parse(d);
      if (r.jsonrpc !== "2.0" || !r.result || r.result.name !== "mini-notes-summarizer"
          || !r.result.host_capabilities.includes("llm.sample")) {
        console.error("smoke test failed: " + d.slice(0, 200)); process.exit(1);
      }
      console.log("   ✓ describe responded with a valid manifest (name + llm.sample)");
    });
  ' <<<"$out"
  # Full protocol test (initialize/describe/invoke+sampling/health) via fake host.
  echo "── full protocol test (fake host) against packaged binary"
  node "$ROOT/scripts/test-protocol.js" "$bin"
}

# ── Go ───────────────────────────────────────────────────────────────

cd "$ROOT"
mkdir -p dist

echo "============================================================"
echo " mini-notes-summarizer binary packager"
echo " version:  ${VERSION}   node: ${NODE_MAJOR}.x"
echo " pkg:      ${PKG}"
echo "============================================================"

if $BUILD_ALL; then
  for p in darwin-arm64 darwin-x86_64 windows-x86_64; do
    build_one "$p"
  done
else
  if [ -z "$PLATFORM" ]; then
    PLATFORM="$(detect_platform)"
    echo "detected host platform: ${PLATFORM}"
  fi
  build_one "$PLATFORM"
fi

if $RUN_TEST; then
  # Only the host platform's binary can execute locally.
  HOST_PLATFORM="$(detect_platform)"
  if [ -d "$ROOT/dist/staging-${HOST_PLATFORM}" ]; then
    run_smoke "$HOST_PLATFORM"
  else
    echo "--test: no locally runnable build present (built: ${PLATFORM:-all cross-compiled}); skipping"
  fi
fi

echo ""
echo "Artifacts:"
ls -lh "$ROOT/dist" | grep -E "${TOOL_NAME}-${VERSION}" || true
sha256sum "$ROOT/dist/${TOOL_NAME}-${VERSION}"* 2>/dev/null || \
  shasum -a 256 "$ROOT/dist/${TOOL_NAME}-${VERSION}"* 2>/dev/null || true
