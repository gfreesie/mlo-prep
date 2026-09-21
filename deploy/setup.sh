#!/usr/bin/env bash
# One-time provisioning for a fresh Ubuntu 24.04 droplet.
#
#   ssh root@<DROPLET_IP>
#   bash setup.sh
#
# Safe to re-run: every step is idempotent.
set -euo pipefail

DOMAIN="${DOMAIN:-studyprep.ssopros.com}"
APP_USER="mloprep"
APP_DIR="/srv/mlo-prep"
NODE_MAJOR=22

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root."

log "Checking that $DOMAIN points at this droplet"
MY_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo unknown)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || echo none)"
echo "    this droplet: $MY_IP"
echo "    $DOMAIN -> ${DNS_IP:-none}"
if [[ "$DNS_IP" != "$MY_IP" ]]; then
  echo
  echo "    DNS does not point here yet. TLS issuance will fail until it does."
  echo "    Add this record in Google Cloud DNS, wait a minute, then re-run:"
  echo
  echo "        A    studyprep    ${MY_IP}    TTL 300"
  echo
  read -rp "    Continue anyway and skip TLS for now? [y/N] " go
  [[ "${go,,}" == "y" ]] || exit 1
  SKIP_TLS=1
else
  SKIP_TLS=0
fi

log "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw nginx fail2ban \
  unattended-upgrades build-essential python3 sqlite3

if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
  log "Installing Node.js ${NODE_MAJOR}.x"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v), npm $(npm -v)"

log "Creating service account and directories"
id -u "$APP_USER" &>/dev/null || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"/{data,backups}
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
# the deploy user pushes code; the service account owns the data
id -u deploy &>/dev/null || {
  useradd --create-home --shell /bin/bash deploy
  mkdir -p /home/deploy/.ssh
  cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys 2>/dev/null || true
  chown -R deploy:deploy /home/deploy/.ssh
  chmod 700 /home/deploy/.ssh
  chmod 600 /home/deploy/.ssh/authorized_keys 2>/dev/null || true
}
usermod -aG "$APP_USER" deploy
chmod 775 "$APP_DIR"

log "Letting the deploy user restart the service"
cat > /etc/sudoers.d/mlo-prep <<'EOF'
deploy ALL=(root) NOPASSWD: /bin/systemctl restart mlo-prep, /bin/systemctl status mlo-prep, /usr/bin/systemctl restart mlo-prep, /usr/bin/systemctl status mlo-prep
EOF
chmod 440 /etc/sudoers.d/mlo-prep
visudo -cf /etc/sudoers.d/mlo-prep

log "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/    /'

log "Automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
systemctl enable --now fail2ban >/dev/null 2>&1 || true

log "nginx site"
install -m 644 "$(dirname "$0")/nginx.conf" /etc/nginx/sites-available/"$DOMAIN"
ln -sf /etc/nginx/sites-available/"$DOMAIN" /etc/nginx/sites-enabled/"$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

log "systemd service"
install -m 644 "$(dirname "$0")/mlo-prep.service" /etc/systemd/system/mlo-prep.service
systemctl daemon-reload
systemctl enable mlo-prep >/dev/null

log "Nightly backup timer"
cat > /etc/systemd/system/mlo-prep-backup.service <<EOF
[Unit]
Description=Back up the MLO Prep database
[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR/current
Environment=DATABASE_PATH=$APP_DIR/data/mloprep.sqlite
Environment=BACKUP_DIR=$APP_DIR/backups
ExecStart=$APP_DIR/current/node_modules/.bin/tsx scripts/backup.ts
EOF
cat > /etc/systemd/system/mlo-prep-backup.timer <<'EOF'
[Unit]
Description=Nightly MLO Prep backup
[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=30m
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now mlo-prep-backup.timer >/dev/null

if [[ "$SKIP_TLS" -eq 0 ]]; then
  log "TLS certificate"
  apt-get install -y -qq certbot python3-certbot-nginx
  if [[ -z "${LETSENCRYPT_EMAIL:-}" ]]; then
    echo "    Let's Encrypt sends expiry warnings to an email address."
    read -rp "    Email for renewal notices (blank to skip): " LETSENCRYPT_EMAIL
  fi
  if [[ -n "$LETSENCRYPT_EMAIL" ]]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LETSENCRYPT_EMAIL" --redirect
  else
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
  fi
  systemctl list-timers certbot.timer --no-pager | sed 's/^/    /' | head -3
else
  log "Skipped TLS - re-run this script once DNS resolves to $MY_IP"
fi

log "Done"
cat <<EOF

    Droplet IP     $MY_IP
    Domain         $DOMAIN
    App directory  $APP_DIR
    Service        systemctl status mlo-prep
    Logs           journalctl -u mlo-prep -f

    Nothing is deployed yet. From your machine run:

        cd "MLO Prep"
        ./deploy/deploy.sh $MY_IP

EOF
