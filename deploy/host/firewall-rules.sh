#!/usr/bin/env bash
# Draft only. The Node generator validates inventory before writing any rules.
set -euo pipefail
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/firewall-rules.mjs" "$@"
