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

## Post-install setup (automated)

The fork ships my personal config in [`jey/`](jey/): extensions, skills, helper scripts, and a settings template.

```bash
# from a clone of this repo:
./jey/setup.sh
```

This installs (idempotently — safe to re-run):
- **Extensions**: `status-line.ts` (3-line footer: context bar, cost, times, diff, req counters, rate-limit countdown), `message-header.ts` (previous-message breadcrumb bar, fullscreen mode)
- **Skill**: `plan-mode` (token-efficient planning workflow, `/skill:plan-mode`)
- **Helpers**: `pi-sessions` (session table with copyable resume commands), `resolve-session.js` (resume by session name) + PATH entry
- **Settings**: merges missing keys (`tuiMode: fullscreen`, rate-limit-honoring retry policy) — never overwrites your model, packages, or existing values

Then add the resume-by-name wrapper to `~/.zshrc` (manual — it pins a project directory):

```bash
pi() { cd "/Users/jey/Development/Pi Workspace" || return
  if [[ ("$1" == "--session" || "$1" == "--fork") && -n "$2" ]]; then
    local resolved
    resolved=$(node "$HOME/.pi/agent/bin/resolve-session.js" "$2" 2>/dev/null)
    if [[ -n "$resolved" ]]; then command pi "$1" "$resolved" "${@:3}"; return; fi
  fi
  command pi "$@"
}
pi-sessions   # verify: table of sessions with copyable resume commands
```

## Config & data

Jey's Pi uses the **same `.pi` config directory** as upstream pi (intentional — see README): sessions, extensions (`~/.pi/agent/extensions/`), skills (`~/.pi/agent/skills/`), and settings carry over untouched.

## Updating

- New upstream release → sync workflow merges upstream into `main` and `working` automatically (weekly + manual: `gh workflow run sync-upstream.yml --repo Jeyapaul/pi`)
- New Jey's Pi release → merge `working` → `main`; the release workflow tests, builds, tags (`vX.Y.Z`, matching parent tags) and publishes the tarball automatically