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
    if unshare -Ur true >/dev/null 2>&1; then
        echo "[ats] User namespaces available; retain Electron sandbox for cache generation"
    else
        export ATS_LINUX_CACHE_NO_SANDBOX=1
        echo "[ats] Namespace sandbox blocked; transient cache generation only will use --no-sandbox"
    fi
fi
# The source volume is scoped to commit and architecture. A failed install never writes this marker.
if [[ ! -f /work/dependencies-ready ]]; then
    # Match upstream: install the build tooling first, then the workspace once with its install scripts.
    # A root install with --ignore-scripts would leave pnpm considering it current and skip native builds.
    pnpm --dir build install --frozen-lockfile
    export npm_config_arch="$ATS_LINUX_ARCH" VSCODE_ARCH="$ATS_LINUX_ARCH"
    if [[ "$ATS_LINUX_ARCH" == arm64 && "$(uname -m)" == aarch64 ]]; then
        # Upstream ships an x86_64 cross toolchain for arm64; it cannot run on a native arm64 host
        # ("Exec format error"). Build with the image's own compiler instead (glibc 2.35 floor).
        export CC="ccache gcc" CXX="ccache g++"
    else
        source ./build/azure-pipelines/linux/setup-env.sh
        export CC="ccache $CC" CXX="ccache $CXX"
        export VSCODE_REMOTE_CC="ccache $VSCODE_REMOTE_CC" VSCODE_REMOTE_CXX="ccache $VSCODE_REMOTE_CXX"
    fi
    # Match upstream ordering: install and patch headers before native modules run in parallel.
    pnpm run preinstall
    pnpm install --frozen-lockfile
    touch /work/dependencies-ready
fi
# The release container does not inherit the extension-only dependencies installed by PR CI.
# Install the lockfile-pinned offline PDF parser on every attempt, including resumed work volumes.
# Its assets are required by esbuild.mts; avoid native optional deps and install scripts.
npm ci --prefix extensions/armotusitio-ide --ignore-scripts --omit=optional --no-audit --no-fund
node extensions/armotusitio-ide/esbuild.mts
gulp() { node --experimental-strip-types --max-old-space-size=8192 node_modules/gulp/bin/gulp.js "$@"; }
gulp "vscode-reh-linux-${ATS_LINUX_ARCH}-min"
if [[ "$ATS_LINUX_ARCH" == x64 ]]; then
    # Electron cache generation starts a real browser process in this headless container.
    xvfb-run -a node --experimental-strip-types --max-old-space-size=8192 node_modules/gulp/bin/gulp.js vscode-linux-x64-min
    gulp vscode-linux-x64-prepare-deb
    gulp vscode-linux-x64-build-deb
    gulp vscode-linux-x64-prepare-rpm
    gulp vscode-linux-x64-build-rpm
fi
node scripts/ats-linux-artifacts.mts "$ATS_LINUX_ARCH" /output
