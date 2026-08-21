#!/usr/bin/env bash
set -euo pipefail

# Run locally (uses .env automatically):
ntn workers exec summarizeSlackChannels --local -d '{"daysBack": 30}'
