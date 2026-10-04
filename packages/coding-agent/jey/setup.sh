#!/usr/bin/env bash
# Jey's Pi — post-install setup. Idempotent: safe to run repeatedly.
# Installs personal extensions, skills, helpers and settings into ~/.pi/agent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${HOME}/.pi/agent"

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/skills" "$AGENT_DIR/bin"

# 0. ketch CLI — web search / scrape / library docs / OSS code search tools
if ! command -v ketch > /dev/null 2>&1; then
	echo "Installing ketch CLI (web search tools)..."
	npm install -g ketch-cli || echo "WARN: ketch install failed — internet_search/internet_scrape/ketch_docs/ketch_code tools will be unavailable"
fi
if command -v ketch > /dev/null 2>&1 && [ -n "${CONTEXT7_API_KEY:-}" ]; then
	ketch config set context7_api_key "$CONTEXT7_API_KEY" && echo "Context7 key configured for ketch_docs"
fi

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
python3 - "$AGENT_DIR/settings.json" "$(dirname "$0")/settings.json" << 'PYEOF'
import json, sys, os
settings_path, template_path = sys.argv[1], sys.argv[2]
mine = json.load(open(template_path))
cur = json.load(open(settings_path)) if os.path.exists(settings_path) else {}
changed, added = False, []
for key in ("theme", "tuiMode", "retry", "terminal", "showCacheMissNotices"):
	if key not in cur and key in mine:
		cur[key] = mine[key]
		added.append(key)
		changed = True
if changed:
	json.dump(cur, open(settings_path, "w"), indent=2)
	print("settings.json updated:", ", ".join(added))
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

echo ""
echo "==============================================================="
echo " Jey's Pi installed successfully."
echo "==============================================================="
echo " Done automatically: extensions + skills + helpers copied to"
echo "   ~/.pi/agent/{extensions,skills,bin}"
echo "   settings merged (fullscreen TUI, retry policy, theme)"
echo ""
echo " Remaining manual steps:"
echo "   1. pi                 # start; /model to pick your model"
echo "   2. /login             # provider auth (or set API keys in settings.json)"
echo "   3. Optional: CONTEXT7_API_KEY=<key> bash setup.sh   # enables ketch_docs (library docs search); free key at context7.com"
echo "   3. Add the resume-by-name wrapper to ~/.zshrc"
echo "      (see the repo INSTALL.md — pins a project directory)"
echo ""
echo " Extensions installed: $(ls "$AGENT_DIR/extensions" 2>/dev/null | tr '\n' ' ')"
echo "==============================================================="
