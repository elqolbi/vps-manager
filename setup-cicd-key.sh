#!/bin/bash

# ============================================================
#  SETUP CI/CD — Buat SSH Deploy Key untuk GitHub Actions
#  Jalankan di VPS sebagai root atau user deploy
# ============================================================

set -e

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${GREEN}[✔]${NC} $1"; }
info() { echo -e "${CYAN}[i]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }

# ── Config ────────────────────────────────────────────────────
DEPLOY_USER="${1:-deploy}"
KEY_NAME="github_actions_deploy"
KEY_PATH="/home/$DEPLOY_USER/.ssh/$KEY_NAME"

info "Setup SSH deploy key untuk user: $DEPLOY_USER"
echo ""

# ── Buat SSH key pair ─────────────────────────────────────────
mkdir -p /home/$DEPLOY_USER/.ssh
chmod 700 /home/$DEPLOY_USER/.ssh

if [ -f "$KEY_PATH" ]; then
  warn "Key sudah ada di $KEY_PATH, skip generate."
else
  ssh-keygen -t ed25519 -C "github-actions-deploy" -f "$KEY_PATH" -N ""
  log "SSH key pair dibuat"
fi

# ── Tambahkan public key ke authorized_keys ───────────────────
AUTH_KEYS="/home/$DEPLOY_USER/.ssh/authorized_keys"
PUB_KEY=$(cat "$KEY_PATH.pub")

if ! grep -q "$PUB_KEY" "$AUTH_KEYS" 2>/dev/null; then
  echo "$PUB_KEY" >> "$AUTH_KEYS"
  chmod 600 "$AUTH_KEYS"
  log "Public key ditambahkan ke authorized_keys"
else
  warn "Public key sudah ada di authorized_keys"
fi

chown -R $DEPLOY_USER:$DEPLOY_USER /home/$DEPLOY_USER/.ssh

# ── Tampilkan instruksi ───────────────────────────────────────
echo ""
echo -e "${CYAN}════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  LANGKAH SELANJUTNYA — Tambahkan ke GitHub Secrets${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════${NC}"
echo ""
echo -e "Buka: ${CYAN}https://github.com/USERNAME/REPO/settings/secrets/actions${NC}"
echo ""
echo -e "${BOLD}Tambahkan secrets berikut:${NC}"
echo ""

VPS_IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo -e "┌─────────────────────────────────────────────────────┐"
echo -e "│  Secret Name       │  Value                        │"
echo -e "├─────────────────────────────────────────────────────┤"
echo -e "│  VPS_HOST          │  $VPS_IP"
echo -e "│  VPS_USER          │  $DEPLOY_USER"
echo -e "│  VPS_PORT          │  22"
echo -e "│  VPS_SSH_KEY       │  (isi dengan private key di bawah)"
echo -e "│  NOTIFY_EMAIL      │  email@kamu.com"
echo -e "│  SMTP_HOST         │  smtp.gmail.com"
echo -e "│  SMTP_PORT         │  587"
echo -e "│  SMTP_USER         │  email@gmail.com"
echo -e "│  SMTP_PASS         │  (Gmail App Password)"
echo -e "└─────────────────────────────────────────────────────┘"
echo ""

echo -e "${BOLD}Tambahkan juga Variables (bukan Secrets):${NC}"
echo -e "  APP_URL  →  https://domain-app-kamu.com"
echo ""

echo -e "${YELLOW}════ PRIVATE KEY (untuk VPS_SSH_KEY) ════${NC}"
echo ""
cat "$KEY_PATH"
echo ""
echo -e "${YELLOW}════════════════════════════════════════${NC}"
echo ""
echo -e "${GREEN}Tips Gmail App Password:${NC}"
echo -e "  Buka: https://myaccount.google.com/apppasswords"
echo -e "  Pilih App: Mail, Device: Other → beri nama 'VPS CI/CD'"
echo ""

# ── Setup sudoers agar deploy user bisa reload nginx ─────────
SUDOERS_FILE="/etc/sudoers.d/deploy-cicd"
if [ ! -f "$SUDOERS_FILE" ] && [ "$EUID" -eq 0 ]; then
  cat > "$SUDOERS_FILE" <<SUDO
$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t
$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx
SUDO
  chmod 440 "$SUDOERS_FILE"
  log "Sudoers dikonfigurasi untuk $DEPLOY_USER"
fi

log "Setup selesai!"
