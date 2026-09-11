#!/usr/bin/env bash
exec bun run "$(cd "$(dirname "$0")/.." && pwd)/scripts/cdp-setup.ts" "$@"
