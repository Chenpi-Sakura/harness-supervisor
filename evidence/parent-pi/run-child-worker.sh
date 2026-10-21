#!/usr/bin/env bash
set -euo pipefail
cd "C:/Users/Lenovo/AppData/Local/Temp/hs-parent-pi-work-tsjvrF"
cat "D:/Projects/Harness-Supervisor/evidence/parent-pi/child-prompt.txt" | node "D:/Projects/Harness-Supervisor/dist/src/cli.js" spawn --state-dir "C:/Users/Lenovo/AppData/Local/Temp/hs-parent-pi-state-7OGw0N" --cwd "C:/Users/Lenovo/AppData/Local/Temp/hs-parent-pi-work-tsjvrF" --model "deepseek-v4.1-flash-1017" --provider "new-api" --thinking off --tools read,bash,write --max-duration-ms 150000 --extra-args '["--no-extensions","--no-skills","--no-prompt-templates","--no-context-files"]' --prompt - --wait --json
