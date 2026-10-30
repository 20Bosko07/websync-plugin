#!/usr/bin/env bash
# Copies packages/shared from a checkout of the Syncstone server repo into ./shared, so the plugin always speaks the
# same crypto + wire protocol as the server. Usage: pnpm sync-shared ../websync
set -euo pipefail
CORE="${1:?usage: sync-shared.sh <path to the websync server repo>}"
rm -rf shared/src
cp -r "$CORE/packages/shared/src" shared/src
cp "$CORE/packages/shared/package.json" shared/package.json
echo "shared/ now matches $(git -C "$CORE" rev-parse --short HEAD)"
