#!/usr/bin/env bash
set -euo pipefail

# The image starts as root solely to reconcile volumes from previous releases.
# Never run the application, Electron or build tools as root.
if [[ "$(id -u)" != 0 ]]; then
    echo "Linux build entrypoint requires root for volume ownership reconciliation" >&2
    exit 1
fi

# /work and /cache are dedicated named volumes. Legacy builds populated them as root.
# Reconcile both ownership and group, including existing dependency trees.
for directory in /work /cache; do
    [[ -d "$directory" && ! -L "$directory" ]] || { echo "Unsafe or missing volume: $directory" >&2; exit 1; }
    chown -R atsbuild:atsbuild "$directory"
done

# /output and /logs are host bind mounts; do not recursively chown the host.
# Check accessibility as the build user before starting an expensive compilation.
for directory in /output /logs; do
    [[ -d "$directory" && ! -L "$directory" ]] || { echo "Unsafe or missing bind mount: $directory" >&2; exit 1; }
    runuser -u atsbuild -- test -w "$directory" || {
        echo "Build user cannot write $directory; fix Docker Desktop bind permissions" >&2
        exit 1
    }
done

exec runuser -u atsbuild -- /usr/local/bin/ats-linux-build "$@"
