#!/usr/bin/env bash
set -euo pipefail
# Apply and commit the bounded native IDE Harness increment on its intended branch.
if [[ "$(git branch --show-current)" != 'feat/harness' ]]; then
  echo 'ERROR: run only on feat/harness' >&2; exit 2
fi
if [[ ! -f extensions/armotusitio-ide/src/native-harness.ts ]]; then
  echo 'ERROR: first extract the release ZIP at repository root.' >&2; exit 2
fi
python tools/apply-native-harness.py
git add -- extensions/armotusitio-ide/src/native-harness.ts extensions/armotusitio-ide/src/native-integration.ts extensions/armotusitio-ide/test/native-harness.test.mts extensions/armotusitio-ide/extension.ts extensions/armotusitio-ide/package.json tools/apply-native-harness.py tools/commit-native-harness.sh
git diff --cached --check
git commit -m 'feat(ide): add native project-independent harness engine and commands'
echo 'Committed locally. No push, merge, release or GitHub Actions change was made.'
