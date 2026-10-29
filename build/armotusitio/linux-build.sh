#!/usr/bin/env bash
set -euo pipefail
umask 022

# Caches under .build that dependency installation creates; build outputs are always regenerated.
kept_build_dirs=(node sysroots typings)

log_phase() { printf '[ats %s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }

# Replace the previous sources with the archive while keeping installed node_modules and caches.
refresh_sources() {
    local archive="$1" source="$2" marker="$3" keep="$2.keep" dir
    # A leftover keep directory means an interrupted refresh: the dependencies are incomplete.
    if [[ -e "$keep" ]]; then rm -rf "$keep" "$marker"; fi
    if [[ -d "$source" ]]; then
        mkdir -p "$keep/.build"
        while IFS= read -r -d '' dir; do mkdir -p "$keep/${dir%/*}"; mv "$source/$dir" "$keep/$dir"; done < <(cd "$source" && find . -type d -name node_modules -prune -print0)
        for dir in "${kept_build_dirs[@]}"; do if [[ -d "$source/.build/$dir" ]]; then mv "$source/.build/$dir" "$keep/.build/$dir"; fi; done
        rm -rf "$source"
    fi
    mkdir -p "$source"
    tar -xzf "$archive" -C "$source"
    if [[ -d "$keep" ]]; then
        # Dependencies of directories that the new sources no longer declare are dropped.
        while IFS= read -r -d '' dir; do if [[ -f "$source/${dir%/node_modules}/package.json" ]]; then mv "$keep/$dir" "$source/$dir"; fi; done < <(cd "$keep" && find . -type d -name node_modules -prune -print0)
        for dir in "${kept_build_dirs[@]}"; do if [[ -d "$keep/.build/$dir" ]]; then mkdir -p "$source/.build"; mv "$keep/.build/$dir" "$source/.build/$dir"; fi; done
        rm -rf "$keep"
    fi
}

# Same inputs that the upstream fast install compares, plus the scripts that compile native modules.
dependency_fingerprint() {
    { node build/npm/installStateHash.ts | node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(0, 'utf8')).current))"
      cat build/npm/*.ts build/azure-pipelines/linux/setup-env.sh
      printf '%s' "$1"; } | sha256sum | cut -d ' ' -f 1
}

main() {
    if [[ "$(id -u)" -eq 0 ]]; then echo "Refusing to compile Linux desktop or launch Electron as root" >&2; exit 1; fi
    : "${BUILD_SOURCEVERSION:?A fixed source commit is required}"
    : "${ATS_LINUX_ARCH:?A Linux architecture is required}"
    [[ "$BUILD_SOURCEVERSION" =~ ^[a-f0-9]{40}$ ]]
    [[ "$ATS_LINUX_ARCH" == x64 || "$ATS_LINUX_ARCH" == arm64 ]]
    # Keep per-phase and per-task timings next to the build inputs on the host.
    if [[ -d /logs ]]; then exec > >(tee -a "/logs/linux-$ATS_LINUX_ARCH.log") 2>&1; fi
    log_phase "sources"
    refresh_sources /input/source.tar.gz /work/source /work/dependencies-ready
    cd /work/source
    test "$(node -v)" = "v$(tr -d '\r\n' < .nvmrc)"
    git init -q
    git config --local safe.directory /work/source
    export VSCODE_QUALITY="$(node -p "require('./build/armotusitio/product-overrides.json').quality")"
    local fingerprint
    fingerprint="$(dependency_fingerprint "$ATS_LINUX_ARCH")"
    # The marker is written only after a complete install for exactly these inputs.
    if [[ "$(cat /work/dependencies-ready 2>/dev/null || true)" != "$fingerprint" ]]; then
        log_phase "dependencies: install $fingerprint"
        rm -f /work/dependencies-ready
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
        printf '%s\n' "$fingerprint" > /work/dependencies-ready
    else
        log_phase "dependencies: reuse $fingerprint"
    fi
    log_phase "compile"
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
    log_phase "artifacts"
    node scripts/ats-linux-artifacts.mts "$ATS_LINUX_ARCH" /output
    log_phase "done"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
