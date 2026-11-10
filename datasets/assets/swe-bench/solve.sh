#!/bin/bash
set -euo pipefail

cd /testbed
git apply --verbose /solution/patch.diff || patch --batch --fuzz=5 -p1 -i /solution/patch.diff
