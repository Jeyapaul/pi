#!/usr/bin/env bash
# Jey's Pi — post-install setup. Idempotent: safe to run repeatedly.
# Installs personal extensions, skills, helpers and settings into ~/.pi/agent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${HOME}/.pi/agent"

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/skills" "$AGENT_DIR/bin"

# 1. Extensions + skills + helpers (sync from repo, overwrite older copies)
cp -f "$(dirname "$0")/extensions/"*.ts "$AGENT_DIR/extensions/"
cp -f "$(dirname "$0")/bin/"* "$AGENT_DIR/bin/"
chmod +x "$AGENT_DIR/bin/"*
if [ -d "$(dirname "$0")/skills/plan-mode" ]; then
	mkdir -p "$AGENT_DIR/skills/plan-mode/references"
	cp -f "$(dirname "$0")/skills/plan-mode/SKILL.md" "$AGENT_DIR/skills/plan-mode/SKILL.md"
	cp -f "$(dirname "$0")/skills/plan-mode/references/"* "$AGENT_DIR/skills/plan-mode/references/"
fi

# 2. Settings: merge only missing keys — never overwrite user's models/sessions
python3 - "$AGENT_DIR/settings.json" << 'PYEOF'
import json, sys, os
settings_path = sys.argv[1]
mine = json.load(open(os.path.join(os.path.dirname(__file__) or ".", "settings.json"))) if os.path.exists(os.path.join(os.path.dirname(__file__), "settings.json")) else {}
here = os.path.dirname(os.path.abspath(__file__))
mine = json.load(open(os.path.join(here, "settings.json")))
cur = {}
if os.path.exists(settings_path):
	cur = json.load(open(settings_path))
changed = False
for key in ("theme", "tuiMode", "retry", "terminal", "showCacheMissNotices"):
	if key not in cur and key in mine:
		cur[key] = mine[key]
		changed = True
if changed:
	json.dump(cur, open(settings_path, "w"), indent=2)
	print(f"settings.json updated: {', '.join(cur.keys())}")
else:
	print("settings.json already has Jey's Pi keys (unchanged)")
PYEOF

# 3. PATH: ensure ~/.pi/agent/bin is on PATH in the user's shell rc (once)
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
	if [ -f "$rc" ] && ! grep -q ".pi/agent/bin" "$rc"; then
		printf '\n# pi helper scripts (pi-sessions)\nexport PATH="$HOME/.pi/agent/bin:$PATH"\n' >> "$rc"
		echo "PATH added to $rc"
	fi
done

echo "Jey's Pi setup complete. Extensions: $(ls "$AGENT_DIR/extensions" | tr '\n' ' ')"
