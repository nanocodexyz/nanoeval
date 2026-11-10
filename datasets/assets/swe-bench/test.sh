#!/bin/bash
set -uo pipefail

mkdir -p /logs/verifier
cd /testbed

if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/0.9.5/install.sh | sh || exit 1
  . "$HOME/.local/bin/env"
fi

grader() {
  uv run --no-project --python 3.12 \
    --with swebench==4.0.3 --with datasets==2.16.1 --with 'fastcore<1.11' \
    python /tests/grade.py "$@"
}

grader script >/tmp/nanoeval-eval.sh || exit 1
bash /tmp/nanoeval-eval.sh >/logs/verifier/test-output.txt 2>&1
grader report
