#!/usr/bin/env bash
# 依序執行：內容檢查 → 端對端測試。其餘參數會傳給 e2e.py(例如 --url、--shots)。
set -e
cd "$(dirname "$0")/.."
python3 tests/lint_pack.py
python3 tests/e2e.py "$@"
