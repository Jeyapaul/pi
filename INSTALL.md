# Installing Jey's Pi

`pi` — my fork of [earendil-works/pi](https://github.com/earendil-works/pi) with personal customizations on top of every upstream release. Requires Node.js ≥ 20.

## Install (any machine)

**From the latest release tarball (recommended):**

```bash
# Grab the latest release asset URL
gh release view --repo Jeyapaul/pi --json assets --jq '.assets[0].url'

# Install globally from the tarball
npm install -g "https://github.com/Jeyapaul/pi/releases/latest/download/jeyapaul-pi-$(gh release view --repo Jeyapaul/pi --json tagName --jq '.tagName' | sed 's/^v//').tgz"
```

Or simply:

```bash
gh release download --repo Jeyapaul/pi --pattern "*.tgz" --output /tmp/jey-pi.tgz
npm install -g /tmp/jey-pi.tgz
```

**From source (dev):**

```bash
git clone https://github.com/Jeyapaul/pi.git "$HOME/Development/Pi Workspace/Pi"
cd "$HOME/Development/Pi Workspace/Pi" && git checkout working
npm install && npm run build
npm install -g ./packages/coding-agent
```

## Verify

```bash
pi --version      # banner/title show "Jey's Pi"
pi -p "say hi"    # smoke test
```

## Post-install commands (my standard setup)

```bash
# 1. Sessions helper on PATH (list sessions + copyable resume commands)
export PATH="$HOME/.pi/agent/bin:$PATH"          # add to ~/.zshrc
pi-sessions                                      # table: name, cost, command

# 2. Resume by session NAME (wrapper resolves name → session file)
#    add to ~/.zshrc:
pi() { cd "/Users/jey/Development/Pi Workspace" || return
  if [[ ("$1" == "--session" || "$1" == "--fork") && -n "$2" ]]; then
    local resolved
    resolved=$(node "$HOME/.pi/agent/bin/resolve-session.js" "$2" 2>/dev/null)
    if [[ -n "$resolved" ]]; then command pi "$1" "$resolved" "${@:3}"; return; fi
  fi
  command pi "$@"
}

# 3. Fullscreen TUI (fixed input dock, scrollable transcript)
#    ~/.pi/agent/settings.json → "tuiMode": "fullscreen"

# 4. Retry policy that honors provider rate-limit waits
#    ~/.pi/agent/settings.json →
"retry": { "maxRetries": 5, "baseDelayMs": 5000,
           "provider": { "maxRetries": 3, "maxRetryDelayMs": 0 } }
```

## Config & data

Jey's Pi uses the **same `.pi` config directory** as upstream pi (intentional — see README): sessions, extensions (`~/.pi/agent/extensions/`), skills (`~/.pi/agent/skills/`), and settings carry over untouched.

## Updating

- New upstream release → sync workflow merges upstream into `main` and `working` automatically (weekly + manual: `gh workflow run sync-upstream.yml --repo Jeyapaul/pi`)
- New Jey's Pi release → merge `working` → `main`; the release workflow tests, builds, tags (`vX.Y.Z`, matching parent tags) and publishes the tarball automatically