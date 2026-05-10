#!/bin/bash

# ============================================================
#  VPS MANAGER — CLI Interaktif
#  Manage project Node.js: install, uninstall, secrets, deploy
# ============================================================

# Load config
CONFIG_FILE="/etc/vps-manager.conf"
if [ -f "$CONFIG_FILE" ]; then
  source $CONFIG_FILE
else
  # Default jika config belum ada (jalankan setup-vps-base.sh dulu)
  APP_USER="deploy"
  APP_DIR="/home/deploy/apps"
  PG_USER="dbadmin"
  PG_DB="appdb"
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; MAGENTA='\033[0;35m'
BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

# ── HELPERS ──────────────────────────────────────────────────
print_header() {
  clear
  echo -e "${CYAN}"
  echo "  ╔═══════════════════════════════════════════╗"
  echo "  ║        VPS PROJECT MANAGER  v2.0          ║"
  echo "  ║     Vultr Debian 11 — Node.js Stack       ║"
  echo "  ╚═══════════════════════════════════════════╝"
  echo -e "${NC}"
}

success() { echo -e "  ${GREEN}✔${NC}  $1"; }
warn()    { echo -e "  ${YELLOW}⚠${NC}  $1"; }
info()    { echo -e "  ${BLUE}ℹ${NC}  $1"; }
error()   { echo -e "  ${RED}✘${NC}  $1"; }
divider() { echo -e "  ${DIM}────────────────────────────────────────${NC}"; }

get_node_env() {
  sudo -u $APP_USER bash -c "export NVM_DIR=\"\$HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"; $1" 2>/dev/null
}

run_as_deploy() {
  sudo -u $APP_USER bash -c "export NVM_DIR=\"\$HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"; $1"
}

list_projects() {
  ls -d $APP_DIR/*/ 2>/dev/null | xargs -I{} basename {} || echo ""
}

get_project_port() {
  local app=$1
  local env_file="$APP_DIR/$app/.env"
  if [ -f "$env_file" ]; then
    grep "^PORT=" "$env_file" | cut -d= -f2
  fi
}

get_project_domain() {
  local app=$1
  local meta_file="$APP_DIR/$app/.vps-meta"
  if [ -f "$meta_file" ]; then
    grep "^DOMAIN=" "$meta_file" | cut -d= -f2
  fi
}

get_project_status() {
  local app=$1
  run_as_deploy "pm2 jlist 2>/dev/null | python3 -c \"
import sys,json
try:
  procs = json.load(sys.stdin)
  p = next((x for x in procs if x['name']=='$app'), None)
  print(p['pm2_env']['status'] if p else 'stopped')
except: print('stopped')
\"" 2>/dev/null || echo "stopped"
}

# ── MAIN MENU ────────────────────────────────────────────────
main_menu() {
  print_header
  echo -e "  ${BOLD}MENU UTAMA${NC}"
  divider
  echo -e "  ${GREEN}1${NC}  📦  Install Project Baru"
  echo -e "  ${RED}2${NC}  🗑️   Uninstall Project"
  echo -e "  ${CYAN}3${NC}  🔑  Manage Secrets / Env"
  echo -e "  ${YELLOW}4${NC}  🚀  Deploy / Restart Project"
  echo -e "  ${BLUE}5${NC}  📊  Status Semua Project"
  echo -e "  ${MAGENTA}6${NC}  🌐  Manage Domain & SSL"
  echo -e "  ${CYAN}7${NC}  📋  Lihat Logs Project"
  echo -e "  ${BLUE}8${NC}  🗄️   Database Manager"
  echo -e "  ${DIM}0${NC}  ❌  Keluar"
  divider
  echo -n -e "  ${BOLD}Pilih:${NC} "
  read choice
  case $choice in
    1) menu_install ;;
    2) menu_uninstall ;;
    3) menu_secrets ;;
    4) menu_deploy ;;
    5) menu_status ;;
    6) menu_domain ;;
    7) menu_logs ;;
    8) menu_database ;;
    0) echo -e "\n  Sampai jumpa! 👋\n"; exit 0 ;;
    *) warn "Pilihan tidak valid"; sleep 1; main_menu ;;
  esac
}

# ── 1. INSTALL PROJECT ────────────────────────────────────────
menu_install() {
  print_header
  echo -e "  ${BOLD}📦 INSTALL PROJECT BARU${NC}"
  divider

  echo -n -e "  URL GitHub repo  : "
  read REPO_URL
  [ -z "$REPO_URL" ] && { warn "URL tidak boleh kosong"; sleep 1; main_menu; return; }

  # Auto-detect nama dari URL
  DEFAULT_NAME=$(basename "$REPO_URL" .git)
  echo -n -e "  Nama app ${DIM}[$DEFAULT_NAME]${NC}: "
  read APP_NAME
  APP_NAME=${APP_NAME:-$DEFAULT_NAME}
  APP_NAME=$(echo "$APP_NAME" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')

  # Cek apakah sudah ada
  if [ -d "$APP_DIR/$APP_NAME" ]; then
    error "Project '$APP_NAME' sudah ada! Gunakan Deploy untuk update."
    sleep 2; main_menu; return
  fi

  # Cari port yang tersedia mulai dari 3001
  NEXT_PORT=3001
  while true; do
    IN_USE=false
    for proj in $(list_projects); do
      USED_PORT=$(get_project_port "$proj")
      [ "$USED_PORT" = "$NEXT_PORT" ] && IN_USE=true && break
    done
    $IN_USE && NEXT_PORT=$((NEXT_PORT + 1)) || break
  done

  echo -n -e "  Port ${DIM}[$NEXT_PORT]${NC}: "
  read PORT
  PORT=${PORT:-$NEXT_PORT}

  echo -n -e "  Domain (kosongkan jika belum): "
  read DOMAIN

  echo -n -e "  Branch ${DIM}[main]${NC}: "
  read BRANCH
  BRANCH=${BRANCH:-main}

  divider
  info "Menginstall '$APP_NAME' dari $REPO_URL..."
  echo ""

  # Clone repo
  sudo -u $APP_USER git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR/$APP_NAME" 2>&1 | \
    sed 's/^/    /'

  if [ ! -d "$APP_DIR/$APP_NAME" ]; then
    error "Clone gagal! Cek URL dan akses repo."
    sleep 2; main_menu; return
  fi

  # npm install
  info "Menginstall dependencies..."
  run_as_deploy "cd $APP_DIR/$APP_NAME && npm install" 2>&1 | sed 's/^/    /'

  # Buat .env default
  cat > "$APP_DIR/$APP_NAME/.env" <<ENV
# ── Secrets untuk $APP_NAME ──────────────────
NODE_ENV=production
PORT=$PORT

# Database (PostgreSQL)
DATABASE_URL=postgresql://$PG_USER:$PG_PASS@localhost:5432/$PG_DB

# Redis
REDIS_URL=redis://:$REDIS_PASS@localhost:6379

# Tambahkan secrets lain di bawah ini
ENV
  chown $APP_USER:$APP_USER "$APP_DIR/$APP_NAME/.env"

  # Simpan metadata project
  cat > "$APP_DIR/$APP_NAME/.vps-meta" <<META
APP_NAME=$APP_NAME
REPO_URL=$REPO_URL
BRANCH=$BRANCH
PORT=$PORT
DOMAIN=$DOMAIN
INSTALLED_AT=$(date '+%Y-%m-%d %H:%M:%S')
META
  chown $APP_USER:$APP_USER "$APP_DIR/$APP_NAME/.vps-meta"

  # Setup Nginx jika ada domain
  if [ -n "$DOMAIN" ]; then
    _setup_nginx "$APP_NAME" "$DOMAIN" "$PORT"
  fi

  # Deteksi entry point & start PM2
  info "Menjalankan app dengan PM2..."
  _start_pm2 "$APP_NAME"

  echo ""
  success "Project '$APP_NAME' berhasil diinstall!"
  divider
  echo -e "  ${YELLOW}⚠ Jangan lupa edit secrets!${NC}"
  echo -e "  Tekan Enter untuk setup secrets sekarang, atau 's' untuk skip."
  echo -n -e "  Pilihan: "
  read setup_now
  if [ "$setup_now" != "s" ]; then
    _edit_secrets "$APP_NAME"
  fi
  main_menu
}

_start_pm2() {
  local APP=$1
  local TARGET="$APP_DIR/$APP"
  run_as_deploy "
    cd $TARGET
    ENTRY='index.js'
    [ -f server.js ] && ENTRY='server.js'
    [ -f app.js ] && ENTRY='app.js'
    [ -f src/index.js ] && ENTRY='src/index.js'
    [ -f dist/index.js ] && ENTRY='dist/index.js'

    if grep -q '\"start\"' package.json 2>/dev/null; then
      pm2 start npm --name '$APP' -- start
    else
      pm2 start \$ENTRY --name '$APP'
    fi
    pm2 save
  "
}

# ── 2. UNINSTALL PROJECT ─────────────────────────────────────
menu_uninstall() {
  print_header
  echo -e "  ${BOLD}🗑️  UNINSTALL PROJECT${NC}"
  divider

  PROJECTS=$(list_projects)
  if [ -z "$PROJECTS" ]; then
    warn "Tidak ada project yang terinstall."
    sleep 2; main_menu; return
  fi

  echo -e "  Project yang tersedia:"
  echo ""
  i=1
  declare -A IDX_MAP
  for proj in $PROJECTS; do
    STATUS=$(get_project_status "$proj")
    PORT=$(get_project_port "$proj")
    DOMAIN=$(get_project_domain "$proj")
    STATUS_COLOR="${GREEN}"
    [[ "$STATUS" != "online" ]] && STATUS_COLOR="${RED}"
    echo -e "  ${BOLD}$i${NC}  $proj  ${DIM}:$PORT${NC}  ${STATUS_COLOR}[$STATUS]${NC}  ${DIM}$DOMAIN${NC}"
    IDX_MAP[$i]=$proj
    i=$((i+1))
  done

  echo ""
  echo -n -e "  Nomor project (0=batal): "
  read IDX
  [ "$IDX" = "0" ] && main_menu && return
  APP_NAME=${IDX_MAP[$IDX]}
  [ -z "$APP_NAME" ] && { warn "Pilihan tidak valid"; sleep 1; menu_uninstall; return; }

  echo ""
  error "PERHATIAN: Ini akan menghapus project '$APP_NAME' secara permanen!"
  echo -n -e "  Ketik nama project untuk konfirmasi: "
  read CONFIRM
  if [ "$CONFIRM" != "$APP_NAME" ]; then
    warn "Nama tidak cocok, uninstall dibatalkan."
    sleep 2; main_menu; return
  fi

  info "Menghentikan PM2..."
  run_as_deploy "pm2 stop $APP_NAME 2>/dev/null; pm2 delete $APP_NAME 2>/dev/null; pm2 save" || true

  DOMAIN=$(get_project_domain "$APP_NAME")
  if [ -n "$DOMAIN" ]; then
    info "Menghapus Nginx config..."
    rm -f "/etc/nginx/sites-enabled/$APP_NAME"
    rm -f "/etc/nginx/sites-available/$APP_NAME"
    nginx -t && systemctl reload nginx || true
  fi

  info "Menghapus folder project..."
  rm -rf "$APP_DIR/$APP_NAME"

  success "Project '$APP_NAME' berhasil diuninstall!"
  sleep 2; main_menu
}

# ── 3. SECRETS MANAGER ───────────────────────────────────────
menu_secrets() {
  print_header
  echo -e "  ${BOLD}🔑 SECRETS / ENV MANAGER${NC}"
  divider

  PROJECTS=$(list_projects)
  if [ -z "$PROJECTS" ]; then
    warn "Tidak ada project yang terinstall."
    sleep 2; main_menu; return
  fi

  echo -e "  Pilih project:"
  echo ""
  i=1; declare -A IDX_MAP
  for proj in $PROJECTS; do
    echo -e "  ${BOLD}$i${NC}  $proj"
    IDX_MAP[$i]=$proj; i=$((i+1))
  done

  echo ""
  echo -n -e "  Nomor (0=kembali): "
  read IDX
  [ "$IDX" = "0" ] && main_menu && return
  APP_NAME=${IDX_MAP[$IDX]}
  [ -z "$APP_NAME" ] && { warn "Tidak valid"; sleep 1; menu_secrets; return; }

  _secrets_submenu "$APP_NAME"
}

_secrets_submenu() {
  local APP=$1
  local ENV_FILE="$APP_DIR/$APP/.env"

  print_header
  echo -e "  ${BOLD}🔑 SECRETS — $APP${NC}"
  divider
  echo -e "  ${GREEN}1${NC}  Lihat semua secrets"
  echo -e "  ${CYAN}2${NC}  Tambah / Update secret"
  echo -e "  ${RED}3${NC}  Hapus secret"
  echo -e "  ${YELLOW}4${NC}  Edit manual (nano)"
  echo -e "  ${BLUE}5${NC}  Import dari file .env"
  echo -e "  ${DIM}0${NC}  Kembali"
  divider
  echo -n -e "  Pilih: "
  read sub
  case $sub in
    1) _view_secrets "$APP" ;;
    2) _add_secret "$APP" ;;
    3) _delete_secret "$APP" ;;
    4) nano "$ENV_FILE"; _restart_after_secret "$APP" ;;
    5) _import_env "$APP" ;;
    0) main_menu; return ;;
    *) _secrets_submenu "$APP" ;;
  esac
}

_view_secrets() {
  local APP=$1
  local ENV_FILE="$APP_DIR/$APP/.env"
  print_header
  echo -e "  ${BOLD}🔑 Secrets — $APP${NC}"
  divider
  echo ""
  while IFS= read -r line; do
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && { echo -e "  ${DIM}$line${NC}"; continue; }
    KEY=$(echo "$line" | cut -d= -f1)
    VAL=$(echo "$line" | cut -d= -f2-)
    # Mask nilai sensitif
    if [[ "$KEY" =~ (PASS|SECRET|KEY|TOKEN|PWD|PRIVATE) ]]; then
      MASKED="****$(echo $VAL | tail -c 5)"
      echo -e "  ${CYAN}$KEY${NC}=${YELLOW}$MASKED${NC}"
    else
      echo -e "  ${CYAN}$KEY${NC}=${GREEN}$VAL${NC}"
    fi
  done < "$ENV_FILE"
  echo ""
  divider
  echo -n -e "  Enter untuk kembali..."
  read
  _secrets_submenu "$APP"
}

_add_secret() {
  local APP=$1
  local ENV_FILE="$APP_DIR/$APP/.env"
  print_header
  echo -e "  ${BOLD}➕ Tambah / Update Secret — $APP${NC}"
  divider
  echo ""
  echo -n -e "  Nama variabel (contoh: API_KEY): "
  read KEY
  [ -z "$KEY" ] && { _secrets_submenu "$APP"; return; }
  KEY=$(echo "$KEY" | tr '[:lower:]' '[:upper:]' | tr ' ' '_')

  # Cek apakah sudah ada
  if grep -q "^$KEY=" "$ENV_FILE" 2>/dev/null; then
    CURRENT=$(grep "^$KEY=" "$ENV_FILE" | cut -d= -f2-)
    echo -e "  ${YELLOW}Sudah ada:${NC} $KEY=${DIM}$CURRENT${NC}"
    echo -n -e "  Nilai baru: "
  else
    echo -n -e "  Nilai: "
  fi
  read VALUE
  [ -z "$VALUE" ] && { warn "Nilai tidak boleh kosong"; sleep 1; _add_secret "$APP"; return; }

  # Update atau tambah
  if grep -q "^$KEY=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^$KEY=.*|$KEY=$VALUE|" "$ENV_FILE"
    success "Secret '$KEY' diupdate!"
  else
    echo "$KEY=$VALUE" >> "$ENV_FILE"
    success "Secret '$KEY' ditambahkan!"
  fi

  echo -n -e "\n  Tambah secret lagi? (y/n): "
  read more
  [ "$more" = "y" ] && { _add_secret "$APP"; return; }

  _restart_after_secret "$APP"
  _secrets_submenu "$APP"
}

_delete_secret() {
  local APP=$1
  local ENV_FILE="$APP_DIR/$APP/.env"
  print_header
  echo -e "  ${BOLD}🗑️  Hapus Secret — $APP${NC}"
  divider
  echo ""
  # Tampilkan keys saja
  grep -v "^#" "$ENV_FILE" | grep -v "^$" | cut -d= -f1 | nl -w2 -s". "
  echo ""
  echo -n -e "  Nama variabel yang ingin dihapus: "
  read KEY
  [ -z "$KEY" ] && { _secrets_submenu "$APP"; return; }
  KEY=$(echo "$KEY" | tr '[:lower:]' '[:upper:]')

  if grep -q "^$KEY=" "$ENV_FILE"; then
    sed -i "/^$KEY=/d" "$ENV_FILE"
    success "Secret '$KEY' dihapus!"
  else
    warn "Secret '$KEY' tidak ditemukan"
  fi

  _restart_after_secret "$APP"
  sleep 1; _secrets_submenu "$APP"
}

_import_env() {
  local APP=$1
  print_header
  echo -e "  ${BOLD}📥 Import .env — $APP${NC}"
  divider
  echo ""
  echo -n -e "  Path file .env yang akan diimport: "
  read IMPORT_PATH
  if [ ! -f "$IMPORT_PATH" ]; then
    error "File tidak ditemukan: $IMPORT_PATH"
    sleep 2; _secrets_submenu "$APP"; return
  fi

  # Merge: tambah key yang belum ada, update yang sudah ada
  UPDATED=0; ADDED=0
  while IFS= read -r line; do
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    KEY=$(echo "$line" | cut -d= -f1)
    if grep -q "^$KEY=" "$APP_DIR/$APP/.env" 2>/dev/null; then
      sed -i "s|^$KEY=.*|$line|" "$APP_DIR/$APP/.env"
      UPDATED=$((UPDATED+1))
    else
      echo "$line" >> "$APP_DIR/$APP/.env"
      ADDED=$((ADDED+1))
    fi
  done < "$IMPORT_PATH"

  success "Import selesai! $ADDED ditambahkan, $UPDATED diupdate."
  _restart_after_secret "$APP"
  sleep 2; _secrets_submenu "$APP"
}

_restart_after_secret() {
  local APP=$1
  echo ""
  echo -n -e "  ${YELLOW}Restart app agar secrets berlaku?${NC} (y/n): "
  read restart
  if [ "$restart" = "y" ]; then
    run_as_deploy "pm2 restart $APP" && success "App '$APP' direstart!"
  fi
}

# ── 4. DEPLOY ────────────────────────────────────────────────
menu_deploy() {
  print_header
  echo -e "  ${BOLD}🚀 DEPLOY / RESTART PROJECT${NC}"
  divider

  PROJECTS=$(list_projects)
  [ -z "$PROJECTS" ] && { warn "Tidak ada project."; sleep 2; main_menu; return; }

  echo -e "  ${BOLD}a${NC}  Deploy SEMUA project"
  divider
  i=1; declare -A IDX_MAP
  for proj in $PROJECTS; do
    STATUS=$(get_project_status "$proj")
    STATUS_COLOR="${GREEN}"; [[ "$STATUS" != "online" ]] && STATUS_COLOR="${RED}"
    echo -e "  ${BOLD}$i${NC}  $proj  ${STATUS_COLOR}[$STATUS]${NC}"
    IDX_MAP[$i]=$proj; i=$((i+1))
  done
  divider
  echo -n -e "  Pilih (0=kembali): "
  read IDX
  [ "$IDX" = "0" ] && main_menu && return

  if [ "$IDX" = "a" ]; then
    for proj in $PROJECTS; do _deploy_project "$proj"; done
    success "Semua project selesai dideploy!"
  else
    APP_NAME=${IDX_MAP[$IDX]}
    [ -z "$APP_NAME" ] && { warn "Tidak valid"; sleep 1; menu_deploy; return; }
    _deploy_project "$APP_NAME"
  fi

  sleep 2; main_menu
}

_deploy_project() {
  local APP=$1
  local META="$APP_DIR/$APP/.vps-meta"
  local BRANCH="main"
  [ -f "$META" ] && BRANCH=$(grep "^BRANCH=" "$META" | cut -d= -f2)

  info "Deploying '$APP' (branch: $BRANCH)..."
  sudo -u $APP_USER git -C "$APP_DIR/$APP" fetch --all
  sudo -u $APP_USER git -C "$APP_DIR/$APP" reset --hard origin/$BRANCH

  run_as_deploy "cd $APP_DIR/$APP && npm install --production"

  # Build jika ada script build
  if run_as_deploy "cd $APP_DIR/$APP && node -e \"const p=require('./package.json'); process.exit(p.scripts&&p.scripts.build?0:1)\"" 2>/dev/null; then
    info "Menjalankan npm build..."
    run_as_deploy "cd $APP_DIR/$APP && npm run build"
  fi

  run_as_deploy "pm2 restart $APP 2>/dev/null || true"
  success "✓ '$APP' berhasil dideploy!"
}

# ── 5. STATUS ─────────────────────────────────────────────────
menu_status() {
  print_header
  echo -e "  ${BOLD}📊 STATUS SEMUA PROJECT${NC}"
  divider
  echo ""

  PROJECTS=$(list_projects)
  if [ -z "$PROJECTS" ]; then
    warn "Tidak ada project yang terinstall."
    echo ""
    echo -n -e "  Enter untuk kembali..."
    read; main_menu; return
  fi

  printf "  %-20s %-8s %-10s %-6s %-25s\n" "APP" "STATUS" "UPTIME" "PORT" "DOMAIN"
  divider
  for proj in $PROJECTS; do
    STATUS=$(get_project_status "$proj")
    PORT=$(get_project_port "$proj")
    DOMAIN=$(get_project_domain "$proj")
    # Uptime dari PM2
    UPTIME=$(run_as_deploy "pm2 jlist 2>/dev/null | python3 -c \"
import sys,json,time
try:
  procs=json.load(sys.stdin)
  p=next((x for x in procs if x['name']=='$proj'),None)
  if p and p['pm2_env']['status']=='online':
    secs=int((time.time()*1000-p['pm2_env']['pm_uptime'])/1000)
    h=secs//3600; m=(secs%3600)//60; s=secs%60
    print(f'{h}h{m}m' if h>0 else f'{m}m{s}s')
  else: print('-')
except: print('-')
\"" 2>/dev/null)

    COLOR="${GREEN}"; [[ "$STATUS" != "online" ]] && COLOR="${RED}"
    printf "  %-20s ${COLOR}%-10s${NC} %-10s %-6s %-25s\n" \
      "$proj" "$STATUS" "${UPTIME:--}" "${PORT:--}" "${DOMAIN:--}"
  done

  echo ""
  echo -e "  ${DIM}Resource VPS:${NC}"
  echo -n "  CPU: "; top -bn1 | grep "Cpu(s)" | awk '{print $2 + $4"%"}'
  echo -n "  RAM: "; free -h | awk '/^Mem:/{print $3 "/" $2 " used"}'
  echo -n "  Disk: "; df -h / | awk 'NR==2{print $3 "/" $2 " used (" $5 ")"}'

  echo ""
  divider
  echo -n -e "  Enter untuk kembali..."
  read; main_menu
}

# ── 6. DOMAIN & SSL ───────────────────────────────────────────
menu_domain() {
  print_header
  echo -e "  ${BOLD}🌐 DOMAIN & SSL MANAGER${NC}"
  divider
  echo -e "  ${GREEN}1${NC}  Tambah domain ke project"
  echo -e "  ${CYAN}2${NC}  Install / Renew SSL"
  echo -e "  ${RED}3${NC}  Hapus domain dari project"
  echo -e "  ${BLUE}4${NC}  Lihat semua domain"
  echo -e "  ${DIM}0${NC}  Kembali"
  divider
  echo -n -e "  Pilih: "
  read sub
  case $sub in
    1) _add_domain ;;
    2) _install_ssl ;;
    3) _remove_domain ;;
    4) _list_domains ;;
    0) main_menu ;;
    *) menu_domain ;;
  esac
}

_add_domain() {
  print_header
  echo -e "  ${BOLD}➕ Tambah Domain${NC}"
  divider
  PROJECTS=$(list_projects)
  i=1; declare -A IDX_MAP
  for proj in $PROJECTS; do
    echo -e "  ${BOLD}$i${NC}  $proj"
    IDX_MAP[$i]=$proj; i=$((i+1))
  done
  echo -n -e "  Pilih project (0=batal): "
  read IDX
  [ "$IDX" = "0" ] && menu_domain && return
  APP_NAME=${IDX_MAP[$IDX]}
  [ -z "$APP_NAME" ] && menu_domain && return

  echo -n -e "  Domain (contoh: app.domain.com): "
  read DOMAIN
  [ -z "$DOMAIN" ] && menu_domain && return

  PORT=$(get_project_port "$APP_NAME")
  _setup_nginx "$APP_NAME" "$DOMAIN" "$PORT"

  # Update metadata
  sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" "$APP_DIR/$APP_NAME/.vps-meta" 2>/dev/null || \
    echo "DOMAIN=$DOMAIN" >> "$APP_DIR/$APP_NAME/.vps-meta"

  success "Domain '$DOMAIN' ditambahkan ke '$APP_NAME'!"
  echo -n -e "  Install SSL sekarang? (y/n): "
  read ssl_now
  [ "$ssl_now" = "y" ] && certbot --nginx -d "$DOMAIN" --agree-tos --email "${SSL_EMAIL:-admin@$DOMAIN}" --non-interactive --redirect
  sleep 2; menu_domain
}

_setup_nginx() {
  local APP=$1; local DOMAIN=$2; local PORT=$3
  cat > /etc/nginx/sites-available/$APP <<NGINX
server {
    listen 80;
    server_name $DOMAIN;

    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-XSS-Protection "1; mode=block";
    add_header X-Content-Type-Options "nosniff";

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/$APP /etc/nginx/sites-enabled/$APP
  nginx -t && systemctl reload nginx
  success "Nginx config: $DOMAIN → port $PORT"
}

_install_ssl() {
  print_header
  echo -e "  ${BOLD}🔒 Install SSL${NC}"
  divider
  echo -n -e "  Domain: "
  read DOMAIN
  echo -n -e "  Email: "
  read EMAIL
  certbot --nginx -d "$DOMAIN" --agree-tos --email "$EMAIL" --non-interactive --redirect
  # Auto-renew
  (crontab -l 2>/dev/null | grep -v certbot; echo "0 3 * * * certbot renew --quiet && systemctl reload nginx") | crontab -
  success "SSL aktif untuk $DOMAIN!"
  sleep 2; menu_domain
}

_remove_domain() {
  print_header
  PROJECTS=$(list_projects)
  i=1; declare -A IDX_MAP
  for proj in $PROJECTS; do
    DOMAIN=$(get_project_domain "$proj")
    [ -n "$DOMAIN" ] && { echo -e "  ${BOLD}$i${NC}  $proj  ${DIM}($DOMAIN)${NC}"; IDX_MAP[$i]=$proj; i=$((i+1)); }
  done
  echo -n -e "  Pilih project (0=batal): "
  read IDX
  [ "$IDX" = "0" ] && menu_domain && return
  APP_NAME=${IDX_MAP[$IDX]}
  rm -f "/etc/nginx/sites-enabled/$APP_NAME" "/etc/nginx/sites-available/$APP_NAME"
  nginx -t && systemctl reload nginx
  sed -i "s/^DOMAIN=.*/DOMAIN=/" "$APP_DIR/$APP_NAME/.vps-meta" 2>/dev/null
  success "Domain dihapus dari '$APP_NAME'!"
  sleep 2; menu_domain
}

_list_domains() {
  print_header
  echo -e "  ${BOLD}📋 Domain Terdaftar${NC}"
  divider
  echo ""
  for proj in $(list_projects); do
    DOMAIN=$(get_project_domain "$proj")
    PORT=$(get_project_port "$proj")
    SSL=""
    [ -f "/etc/letsencrypt/live/$DOMAIN/cert.pem" ] && SSL=" 🔒 SSL"
    echo -e "  ${CYAN}$proj${NC}  →  ${BOLD}${DOMAIN:-(belum ada domain)}${NC}${GREEN}$SSL${NC}"
  done
  echo ""
  echo -n -e "  Enter untuk kembali..."
  read; menu_domain
}

# ── 7. LOGS ───────────────────────────────────────────────────
menu_logs() {
  print_header
  echo -e "  ${BOLD}📋 LOGS PROJECT${NC}"
  divider
  PROJECTS=$(list_projects)
  i=1; declare -A IDX_MAP
  for proj in $PROJECTS; do
    echo -e "  ${BOLD}$i${NC}  $proj"
    IDX_MAP[$i]=$proj; i=$((i+1))
  done
  echo ""
  echo -n -e "  Pilih (0=kembali): "
  read IDX
  [ "$IDX" = "0" ] && main_menu && return
  APP_NAME=${IDX_MAP[$IDX]}
  [ -z "$APP_NAME" ] && main_menu && return

  echo ""
  echo -e "  ${CYAN}1${NC}  Live logs (Ctrl+C untuk stop)"
  echo -e "  ${CYAN}2${NC}  50 baris terakhir"
  echo -e "  ${CYAN}3${NC}  Error logs saja"
  echo -n -e "  Pilih: "
  read log_type
  case $log_type in
    1) run_as_deploy "pm2 logs $APP_NAME" ;;
    2) run_as_deploy "pm2 logs $APP_NAME --lines 50 --nostream" ;;
    3) run_as_deploy "pm2 logs $APP_NAME --err --lines 50 --nostream" ;;
  esac
  main_menu
}

# ── 8. DATABASE ───────────────────────────────────────────────
menu_database() {
  print_header
  echo -e "  ${BOLD}🗄️  DATABASE MANAGER${NC}"
  divider
  echo -e "  ${GREEN}1${NC}  Buat database baru"
  echo -e "  ${CYAN}2${NC}  List semua database"
  echo -e "  ${YELLOW}3${NC}  Buat user DB baru"
  echo -e "  ${BLUE}4${NC}  Buka PostgreSQL shell"
  echo -e "  ${MAGENTA}5${NC}  Backup database"
  echo -e "  ${DIM}0${NC}  Kembali"
  divider
  echo -n -e "  Pilih: "
  read sub
  case $sub in
    1)
      echo -n -e "  Nama database baru: "; read DBNAME
      echo -n -e "  Owner (Enter=$PG_USER): "; read DBOWNER; DBOWNER=${DBOWNER:-$PG_USER}
      sudo -u postgres psql -c "CREATE DATABASE $DBNAME OWNER $DBOWNER;"
      success "Database '$DBNAME' dibuat!"; sleep 2; menu_database ;;
    2)
      sudo -u postgres psql -c "\l"
      echo -n -e "  Enter untuk kembali..."; read; menu_database ;;
    3)
      echo -n -e "  Username baru: "; read NEWUSER
      echo -n -e "  Password: "; read -s NEWPASS; echo
      sudo -u postgres psql -c "CREATE ROLE $NEWUSER LOGIN PASSWORD '$NEWPASS';"
      success "User '$NEWUSER' dibuat!"; sleep 2; menu_database ;;
    4) sudo -u postgres psql; menu_database ;;
    5)
      BACKUP_DIR="/home/$APP_USER/backups"
      mkdir -p $BACKUP_DIR
      FILENAME="$BACKUP_DIR/backup_$(date +%Y%m%d_%H%M%S).sql.gz"
      sudo -u postgres pg_dumpall | gzip > "$FILENAME"
      success "Backup disimpan: $FILENAME"; sleep 2; menu_database ;;
    0) main_menu ;;
    *) menu_database ;;
  esac
}

# ── ENTRY POINT ───────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  error "Jalankan sebagai root: sudo bash vps-manager.sh"
  exit 1
fi

main_menu
