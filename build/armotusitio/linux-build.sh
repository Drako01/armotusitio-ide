#!/usr/bin/env bash
set -euo pipefail
umask 022
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
# The source volume is scoped to commit and architecture. A failed install never writes this marker.
if [[ ! -f /work/dependencies-ready ]]; then
    npm ci --no-audit --no-fund
    touch /work/dependencies-ready
fi
node extensions/armotusitio-ide/esbuild.mts
gulp() { node --experimental-strip-types --max-old-space-size=8192 node_modules/gulp/bin/gulp.js "$@"; }
gulp "vscode-reh-linux-${ATS_LINUX_ARCH}-min"
if [[ "$ATS_LINUX_ARCH" == x64 ]]; then
    gulp vscode-linux-x64-min
    gulp vscode-linux-x64-prepare-deb vscode-linux-x64-build-deb
    gulp vscode-linux-x64-prepare-rpm vscode-linux-x64-build-rpm
fi
node scripts/ats-linux-artifacts.mts "$ATS_LINUX_ARCH" /output
