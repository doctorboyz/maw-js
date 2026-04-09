#!/bin/bash
# maw-js installer — install maw CLI from any branch/tag via bun
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Soul-Brews-Studio/maw-js/alpha/install.sh | bash
#
# Options:
#   MAW_BRANCH=alpha        Branch or tag to install (default: alpha)
#   MAW_SKIP_PM2=1          Skip PM2 setup
#   MAW_GHQ=1               Also clone repo via ghq (for development)

set -e

BRANCH="${MAW_BRANCH:-alpha}"
REPO="Soul-Brews-Studio/maw-js"

echo ""
echo "  🍺 maw-js installer"
echo "  ─────────────────────"
echo "  Branch: ${BRANCH}"
echo ""

# ── Check bun ───────────────────────────────────────────────

if ! command -v bun >/dev/null 2>&1; then
  echo "📦 Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "  bun: $(bun --version)"

# ── Install maw via bun global ──────────────────────────────

echo ""
echo "📦 Installing maw from github:${REPO}#${BRANCH}..."
bun add -g "github:${REPO}#${BRANCH}"

# Verify
if command -v maw >/dev/null 2>&1; then
  echo ""
  echo "  ✅ $(maw --version 2>/dev/null || echo 'maw installed')"
else
  # bun global bin might not be in PATH
  if [ -f "$HOME/.bun/bin/maw" ]; then
    echo ""
    echo "  ✅ maw installed at ~/.bun/bin/maw"
    echo "  ⚠️  Add to PATH: export PATH=\"\$HOME/.bun/bin:\$PATH\""
  else
    echo "  ❌ maw binary not found after install"
    exit 1
  fi
fi

# ── Optional: clone repo via ghq (for development) ─────────

if [ "${MAW_GHQ}" = "1" ]; then
  if command -v ghq >/dev/null 2>&1; then
    echo ""
    echo "📂 Cloning repo via ghq..."
    ghq get -u "github.com/${REPO}"
    GHQ_PATH="$(ghq root)/github.com/${REPO}"
    cd "$GHQ_PATH"
    git checkout "${BRANCH}" 2>/dev/null || true
    bun install
    echo "  ✅ Repo at ${GHQ_PATH} (branch: ${BRANCH})"
  else
    echo "  ⚠️  ghq not found — skipping repo clone"
  fi
fi

# ── Optional: PM2 setup ────────────────────────────────────

if [ "${MAW_SKIP_PM2}" != "1" ] && command -v pm2 >/dev/null 2>&1; then
  echo ""
  echo "🔧 PM2 detected. To start maw server:"
  echo "  cd $(ghq root 2>/dev/null || echo '~/Code')/github.com/${REPO}"
  echo "  pm2 start ecosystem.config.cjs"
  echo ""
  echo "  Or if using bun global install:"
  echo "  pm2 start maw --interpreter bun -- serve"
fi

# ── Done ────────────────────────────────────────────────────

echo ""
echo "  🍺 Done! Run 'maw --version' to verify."
echo ""
echo "  Quick start:"
echo "    maw oracle scan        # discover oracles"
echo "    maw oracle fleet       # see the constellation"
echo "    maw wake <oracle>      # start an oracle"
echo "    maw peek               # see all oracle panes"
echo ""
echo "  Update later:"
echo "    bun add -g github:${REPO}#${BRANCH}"
echo ""
