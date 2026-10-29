#!/usr/bin/env bash
set -euo pipefail

# Invoked exclusively via the restricted sudoers command, immediately before
# Electron generates its compile cache inside the dedicated Linux build volume.
[[ "$(id -u)" == 0 ]] || { echo "Root required for sandbox helper setup" >&2; exit 1; }
[[ "$#" == 0 ]] || { echo "Arguments are not accepted" >&2; exit 1; }

helper=/work/VSCode-linux-x64/chrome-sandbox
parent=/work/VSCode-linux-x64

[[ -d "$parent" && ! -L "$parent" ]] || { echo "Invalid Electron package directory" >&2; exit 1; }
[[ -f "$helper" && ! -L "$helper" ]] || { echo "Missing or linked Electron sandbox helper" >&2; exit 1; }
[[ "$(stat -c '%h' -- "$helper")" == 1 ]] || { echo "Sandbox helper has multiple hard links" >&2; exit 1; }

chown -- root:root "$helper"
chmod -- 4755 "$helper"
[[ "$(stat -c '%u:%g:%a' -- "$helper")" == "0:0:4755" ]] || {
    echo "Sandbox helper ownership or permissions incorrect" >&2
    exit 1
}
