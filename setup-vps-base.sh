#!/bin/bash

# ============================================================
#  SETUP VPS BASE — Vultr Debian 11
#  Jalankan SEKALI untuk install semua dependency
#  Node.js, Nginx, PostgreSQL, Redis, Docker, PM2, SSL
# ============================================================

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()     { echo -e "${GREEN}[✔]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
info()    { echo -e "${BLUE}[i]${NC} $1"; }
error()   { echo -e "${RED}[✘]${NC} $1"; exit 1; }
section() { echo -e "\n${CYAN}══════════════════════════════════════${NC}\n${CYAN}  $1${NC}\n${CYAN}══════════════════════════════════════${NC}"; }

[ "$EUID" -ne 0 ] && error "Jalankan sebagai root: sudo bash setup-vps-base.sh"

# ── KONFIGURASI ──────────────────────────────────────────────
APP_USER="deploy"
NODE_VERSION="20"
PG_USER="dbadmin"
PG_PASS="${PG_PASSWORD:-$(openssl rand -base64 16)}"
PG_DB="appdb"
REDIS_PASS="${REDIS_PASSWORD:-$(openssl rand -base64 16)}"
MANAGER_PORT="9000"
MANAGER_SECRET="${MANAGER_SECRET:-$(openssl rand -base64 24)}"
VPS_MANAGER_DIR="/opt/vps-manager"

section "1. Update Sistem"
apt-get update -y && apt-get upgrade -y
apt-get install -y curl wget git unzip build-essential ca-certificates gnupg \
  lsb-release apt-transport-https ufw fail2ban htop nano software-properties-common jq
log "Sistem updated"

section "2. User Deploy"
if ! id "$APP_USER" &>/dev/null; then
  adduser --disabled-password --gecos "" $APP_USER
  usermod -aG sudo $APP_USER
  [ -f /root/.ssh/authorized_keys ] && {
    mkdir -p /home/$APP_USER/.ssh
    cp /root/.ssh/authorized_keys /home/$APP_USER/.ssh/
    chown -R $APP_USER:$APP_USER /home/$APP_USER/.ssh
    chmod 700 /home/$APP_USER/.ssh && chmod 600 /home/$APP_USER/.ssh/authorized_keys
  }
  log "User '$APP_USER' dibuat"
else
  warn "User '$APP_USER' sudah ada"
fi
mkdir -p /home/$APP_USER/apps
chown $APP_USER:$APP_USER /home/$APP_USER/apps

section "3. Firewall"
ufw --force reset
ufw default deny incoming && ufw default allow outgoing
ufw allow ssh && ufw allow 80/tcp && ufw allow 443/tcp
ufw allow $MANAGER_PORT/tcp
ufw --force enable
log "UFW aktif"

section "4. Fail2Ban"
systemctl enable fail2ban && systemctl start fail2ban
log "Fail2Ban aktif"

section "5. Node.js $NODE_VERSION"
sudo -u $APP_USER bash -c "
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR=\"\$HOME/.nvm\"
  [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"
  nvm install $NODE_VERSION && nvm alias default $NODE_VERSION
"
NODE_BIN="/home/$APP_USER/.nvm/versions/node/$(sudo -u $APP_USER bash -c 'source ~/.nvm/nvm.sh && node -e "console.log(process.version)"' | tr -d 'v')/bin"
log "Node.js installed"

section "6. PM2"
sudo -u $APP_USER bash -c "
  export NVM_DIR=\"\$HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"
  npm install -g pm2
"
sudo -u $APP_USER bash -c "
  export NVM_DIR=\"\$HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"
  pm2 startup systemd -u $APP_USER --hp /home/$APP_USER | tail -1 | bash
  pm2 save
" || true
log "PM2 installed"

section "7. PostgreSQL"
if ! command -v psql &>/dev/null; then
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg
  echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y && apt-get install -y postgresql postgresql-contrib
fi
systemctl enable postgresql && systemctl start postgresql
sudo -u postgres psql <<PSQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='$PG_USER') THEN
    CREATE ROLE $PG_USER LOGIN PASSWORD '$PG_PASS' CREATEDB;
  END IF;
END \$\$;
SELECT 'CREATE DATABASE $PG_DB OWNER $PG_USER' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='$PG_DB')\gexec
GRANT ALL PRIVILEGES ON DATABASE $PG_DB TO $PG_USER;
ALTER ROLE $PG_USER CREATEDB;
PSQL
log "PostgreSQL aktif — DB: $PG_DB"

section "8. Redis"
apt-get install -y redis-server
sed -i "s/# requirepass foobared/requirepass $REDIS_PASS/" /etc/redis/redis.conf
sed -i "s/^bind 127.0.0.1 ::1/bind 127.0.0.1/" /etc/redis/redis.conf
systemctl enable redis-server && systemctl restart redis-server
log "Redis aktif"

section "9. Docker"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
usermod -aG docker $APP_USER
systemctl enable docker && systemctl start docker
log "Docker installed"

section "10. Nginx"
apt-get install -y nginx certbot python3-certbot-nginx
systemctl enable nginx && systemctl start nginx
rm -f /etc/nginx/sites-enabled/default
log "Nginx installed"

section "11. VPS Manager API"
mkdir -p $VPS_MANAGER_DIR

# Install dependencies manager
sudo -u $APP_USER bash -c "
  export NVM_DIR=\"\$HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"
  mkdir -p $VPS_MANAGER_DIR
  cd $VPS_MANAGER_DIR
  npm init -y
  npm install express cors bcryptjs jsonwebtoken
"
chown -R $APP_USER:$APP_USER $VPS_MANAGER_DIR

# Simpan config global
cat > /etc/vps-manager.conf <<CONF
APP_USER=$APP_USER
APP_DIR=/home/$APP_USER/apps
PG_USER=$PG_USER
PG_PASS=$PG_PASS
PG_DB=$PG_DB
REDIS_PASS=$REDIS_PASS
MANAGER_PORT=$MANAGER_PORT
MANAGER_SECRET=$MANAGER_SECRET
VPS_MANAGER_DIR=$VPS_MANAGER_DIR
CONF
chmod 600 /etc/vps-manager.conf
log "Config disimpan di /etc/vps-manager.conf"

section "✅ BASE SETUP SELESAI"
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║      BASE SETUP BERHASIL!                ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}PostgreSQL:${NC}  $PG_USER / $PG_PASS @ localhost/$PG_DB"
echo -e "  ${CYAN}Redis:${NC}       :$REDIS_PASS @ localhost:6379"
echo -e "  ${CYAN}Manager:${NC}     http://IP:$MANAGER_PORT"
echo -e "  ${CYAN}API Secret:${NC}  $MANAGER_SECRET"
echo ""
echo -e "${YELLOW}Simpan credentials di atas!${NC}"
echo ""
echo -e "Jalankan selanjutnya: ${BOLD}bash vps-manager.sh${NC}"
