#!/usr/bin/env bash
# Push the app to the droplet. Run from the "MLO Prep" directory.
#
#   ./deploy/deploy.sh 203.0.113.10
#   HOST=203.0.113.10 ./deploy/deploy.sh
#
# Uses tar over ssh rather than rsync, which is not installed in Git Bash on
# Windows. The release is unpacked beside the live one and swapped in, so a
# half-uploaded build is never served, and the previous release stays on disk
# as .old for a one-command rollback.
set -euo pipefail

HOST="${1:-${HOST:-}}"
[[ -n "$HOST" ]] || { echo "Usage: ./deploy/deploy.sh <droplet-ip>" >&2; exit 1; }

SSH_USER="${SSH_USER:-deploy}"
APP_DIR="/srv/mlo-prep"
REMOTE="$SSH_USER@$HOST"

step() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

step "Building"
node build.mjs

step "Uploading to $REMOTE"
# app code + built site + server sources; never the local database or node_modules
tar czf - \
  dist server scripts package.json package-lock.json \
  | ssh "$REMOTE" "
      set -euo pipefail
      rm -rf $APP_DIR/release.new
      mkdir -p $APP_DIR/release.new
      tar xzf - -C $APP_DIR/release.new
    "

step "Installing dependencies and swapping the release"
ssh "$REMOTE" "
  set -euo pipefail
  cd $APP_DIR/release.new
  # tsx is a runtime dependency, so --omit=dev still installs it
  npm ci --omit=dev --no-audit --no-fund

  cd $APP_DIR
  rm -rf release.old
  [ -d current ] && mv current release.old || true
  mv release.new current

  # data and backups live outside the release so they survive a deploy
  ln -sfn $APP_DIR/data    current/data
  ln -sfn $APP_DIR/backups current/backups
"

step "Restarting the service"
ssh "$REMOTE" "sudo systemctl restart mlo-prep && sleep 2 && systemctl is-active mlo-prep"

step "Health check"
for i in 1 2 3 4 5; do
  if curl -fsS --max-time 10 "http://$HOST/healthz" >/dev/null 2>&1; then
    echo "    healthy"
    break
  fi
  [[ $i -eq 5 ]] && { echo "    NOT healthy - check: ssh $REMOTE 'journalctl -u mlo-prep -n 50'"; exit 1; }
  sleep 3
done

step "Deployed"
echo "    https://studyprep.ssopros.com"
echo "    Rollback:  ssh $REMOTE 'cd $APP_DIR && rm -rf current && mv release.old current && sudo systemctl restart mlo-prep'"
