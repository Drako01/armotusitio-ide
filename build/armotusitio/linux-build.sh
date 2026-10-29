#!/usr/bin/env bash
set -euo pipefail
umask 022

# Dedicated commit volume; never reuse dependency trees from another revision.
if [[ "$(id -u)" -eq 0 ]]; then echo "Refusing Linux build as root" >&2; exit 1; fi
if [[ -d /logs ]]; then exec > >(tee -a "/logs/linux-${ATS_LINUX_ARCH:?}.log") 2>&1; fi
: "${BUILD_SOURCEVERSION:?A fixed source commit is required}"
: "${ATS_LINUX_ARCH:?A Linux architecture is required}"
[[ "$BUILD_SOURCEVERSION" =~ ^[a-f0-9]{40}$ ]]
[[ "$ATS_LINUX_ARCH" == x64 || "$ATS_LINUX_ARCH" == arm64 ]]
mkdir -p /work/source
cd /work/source
tar -xzf /input/source.tar.gz
test "$(node -v)" = "v$(tr -d '\r\n' < .nvmrc)"
git init -q
git config --local safe.directory /work/source
export VSCODE_QUALITY="$(node -p "require('./build/armotusitio/product-overrides.json').quality")"
# Docker Desktop disallows Chromium namespace creation even when SUID is available.
# Restrict the override to cache generation; it is not a product runtime setting.
if [[ "$ATS_LINUX_ARCH" == x64 ]]; then
    if runuser -u "$(id -un)" -- unshare -Ur true >/dev/null 2>&1; then
        echo "[ats] User namespaces available; retain Electron sandbox for cache generation"
    else
        export ATS_LINUX_CACHE_NO_SANDBOX=1
        echo "[ats] Namespace sandbox blocked; transient cache generation only will use --no-sandbox"
    fi
fi
# The source volume is scoped to commit and architecture. A failed install never writes this marker.
if [[ ! -f /work/dependencies-ready ]]; then
    # Bootstrap JS tooling before the upstream Electron/Node compiler setup.
    npm ci --ignore-scripts --no-audit --no-fund
    npm ci --prefix build --ignore-scripts --no-audit --no-fund
    export npm_config_arch="$ATS_LINUX_ARCH" VSCODE_ARCH="$ATS_LINUX_ARCH"
    source ./build/azure-pipelines/linux/setup-env.sh
    export CC="ccache $CC" CXX="ccache $CXX"
    export VSCODE_REMOTE_CC="ccache $VSCODE_REMOTE_CC" VSCODE_REMOTE_CXX="ccache $VSCODE_REMOTE_CXX"
    # Match upstream ordering: install and patch headers before native modules run in parallel.
    node build/npm/preinstall.ts
    npm ci --no-audit --no-fund
    touch /work/dependencies-ready
fi
node extensions/armotusitio-ide/esbuild.mts
gulp() { node --experimental-strip-types --max-old-space-size=8192 node_modules/gulp/bin/gulp.js "$@"; }
gulp "vscode-reh-linux-${ATS_LINUX_ARCH}-min"
if [[ "$ATS_LINUX_ARCH" == x64 ]]; then
    gulp vscode-linux-x64-min
    gulp vscode-linux-x64-prepare-deb
    gulp vscode-linux-x64-build-deb
    gulp vscode-linux-x64-prepare-rpm
    gulp vscode-linux-x64-build-rpm
fi
node scripts/ats-linux-artifacts.mts "$ATS_LINUX_ARCH" /output
