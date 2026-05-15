// ============================================================
//  VPS Manager — Web Dashboard API Server
//  Simpan sebagai: /opt/vps-manager/server.js
//  Jalankan: pm2 start server.js --name vps-manager
// ============================================================

const express = require('express');
const { execSync, exec, execFileSync, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns').promises;
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.MANAGER_PORT || 9000;
const SECRET = process.env.MANAGER_SECRET || 'change-this-secret';
const APP_DIR = process.env.APP_DIR || '/home/deploy/apps';
const APP_USER = process.env.APP_USER || 'deploy';
const PG_USER = process.env.PG_USER || 'dbadmin';
const PG_PASS = process.env.PG_PASS || '';
const PG_DB = process.env.PG_DB || 'appdb';
const REDIS_PASS = process.env.REDIS_PASS || '';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'admin123';
const AUTH_FILE = path.join(__dirname, '.dashboard-auth.json');

const readPasswordHash = () => {
  try {
    const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    return data.passwordHash || null;
  } catch { return null; }
};

const verifyDashboardPassword = (password) => {
  const hash = readPasswordHash();
  if (hash) return bcrypt.compareSync(String(password), hash);
  return String(password) === DASHBOARD_PASS;
};

const saveDashboardPassword = (password) => {
  const passwordHash = bcrypt.hashSync(String(password), 10);
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ passwordHash }), { mode: 0o600 });
};
/** Identitas commit untuk perintah git dari manager (user deploy sering belum punya user.name / user.email global). */
const MANAGER_GIT_AUTHOR_NAME = process.env.MANAGER_GIT_AUTHOR_NAME || 'VPS Manager';
const MANAGER_GIT_AUTHOR_EMAIL = process.env.MANAGER_GIT_AUTHOR_EMAIL || 'vps-manager@localhost';
const DB_DUMP_DIR = process.env.VPS_MANAGER_DUMPS || path.join(os.homedir(), '.vps-manager-dumps');
const jsonLarge = express.json({ limit: '100mb' });

try {
  fs.mkdirSync(DB_DUMP_DIR, { recursive: true, mode: 0o700 });
} catch (_) {}

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── AUTH ─────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!verifyDashboardPassword(password)) return res.status(401).json({ error: 'Wrong password' });
  const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '24h' });
  res.json({ token });
});

const auth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(header.replace('Bearer ', ''), SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

app.put('/api/account/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'Sandi baru minimal 6 karakter' });
  }
  if (!verifyDashboardPassword(currentPassword)) {
    return res.status(401).json({ error: 'Sandi saat ini salah' });
  }
  try {
    saveDashboardPassword(newPassword);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Gagal menyimpan sandi' });
  }
});

// ── HELPERS ──────────────────────────────────────────────────
const runAs = (cmd) => {
  try {
    return execSync(`sudo -u ${APP_USER} bash -c "source ~/.nvm/nvm.sh && ${cmd}"`, { encoding: 'utf8' }).trim();
  } catch (e) { return e.stdout?.trim() || ''; }
};

const run = (cmd) => {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); }
  catch (e) { return e.stdout?.trim() || ''; }
};

/** Safe single-quoted fragment for bash -c "… cd '…' && …" */
const shSingleQuote = (s) => `'${String(s).replace(/'/g, `'\"'\"'`)}'`;

/** Nilai untuk baris .env yang di-`source` bash: bungkus "..." agar &, =, +, dll. tidak memecah perintah. */
const envQuotedForSource = (v) => {
  const s = String(v);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
};

/** Baca nilai dari .env (dukung "quoted" atau tanpa kutip). */
const parseEnvFileValue = (raw) => {
  const v = String(raw).trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(.)/g, (_, c) => {
      if (c === 'n') return '\n';
      if (c === 'r') return '\r';
      if (c === 't') return '\t';
      return c;
    });
  }
  return v;
};

const parseEnvLine = (line) => {
  const idx = line.indexOf('=');
  if (idx <= 0) return null;
  const key = line.slice(0, idx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return { key, value: parseEnvFileValue(line.slice(idx + 1)) };
};

const runAsThrow = (cmd) => {
  try {
    execSync(`sudo -u ${APP_USER} bash -c "source ~/.nvm/nvm.sh && ${cmd}"`, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    const stdout = e.stdout ? e.stdout.toString() : '';
    const msg = (stderr || stdout || e.message || 'Command failed').trim();
    throw new Error(msg.slice(0, 8000));
  }
};

const resolveProjectDir = (name) => {
  const dir = path.resolve(APP_DIR, name);
  const base = path.resolve(APP_DIR) + path.sep;
  if (!dir.startsWith(base)) return null;
  return dir;
};

/** PM2 menyimpan env di dump; tanpa ini perubahan .env (mis. PROD_DATABASE_URL) tidak terbaca. Muat .env lalu --update-env. */
const pm2RestartWithEnvFromProject = (name) => {
  const dir = resolveProjectDir(name);
  if (!dir || !fs.existsSync(path.join(dir, '.env'))) {
    runAs(`pm2 restart ${name} --update-env`);
    return;
  }
  const dirQ = shSingleQuote(dir);
  runAs(`cd ${dirQ} && set -a && . ./.env && set +a && pm2 restart ${name} --update-env`);
};

const readPackageJson = (projectDir) => {
  try {
    const raw = fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const PNPM_COREPACK_VERSION = '9.15.9';

const projectUsesPnpm = (projectDir) => {
  if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return true;
  if (fs.existsSync(path.join(projectDir, 'pnpm-workspace.yaml'))) return true;
  const pkg = readPackageJson(projectDir);
  return !!(pkg && typeof pkg.packageManager === 'string' && pkg.packageManager.startsWith('pnpm@'));
};

const projectRunPrefix = (projectDir) => (projectUsesPnpm(projectDir) ? 'pnpm' : 'npm');

const preparePnpmShell = `corepack enable >/dev/null 2>&1; corepack prepare pnpm@${PNPM_COREPACK_VERSION} --activate >/dev/null 2>&1`;

const runProjectDepsInstall = (projectDir) => {
  const dirQ = shSingleQuote(projectDir);
  if (projectUsesPnpm(projectDir)) {
    runAsThrow(`cd ${dirQ} && ${preparePnpmShell} && pnpm install`);
    return;
  }
  runAsThrow(`cd ${dirQ} && npm install`);
};

/** Urutan: build → web+server → salah satu (monorepo / fullstack Node umum). */
const resolveNpmBuildCommand = (projectDir) => {
  const pkg = readPackageJson(projectDir);
  if (!pkg || !pkg.scripts) return null;
  const s = pkg.scripts;
  const pm = projectRunPrefix(projectDir);
  if (typeof s.build === 'string' && s.build.trim()) return `${pm} run build`;
  const hasWeb = typeof s['web:build'] === 'string' && s['web:build'].trim();
  const hasServer = typeof s['server:build'] === 'string' && s['server:build'].trim();
  if (hasWeb && hasServer) return `${pm} run web:build && ${pm} run server:build`;
  if (hasWeb) return `${pm} run web:build`;
  if (hasServer) return `${pm} run server:build`;
  return null;
};

const runProjectBuildIfAny = (projectDir) => {
  const cmd = resolveNpmBuildCommand(projectDir);
  if (!cmd) return;
  const dirQ = shSingleQuote(projectDir);
  runAsThrow(`cd ${dirQ} && ${cmd}`);
};

const sanitizePm2ProcessName = (name) => {
  const n = String(name);
  const safe = n.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe || safe !== n) {
    throw new Error('Nama project tidak valid untuk PM2 (gunakan huruf, angka, titik, garis bawah, atau tanda hubung).');
  }
  return safe;
};

/** Perintah yang di-`exec` setelah cd + muat .env (tanpa pembungkus bash tambahan). */
const resolvePm2StartInnerCommand = (projectDir) => {
  const pkg = readPackageJson(projectDir);
  if (!pkg) return null;
  const s = pkg.scripts || {};
  const pm = projectRunPrefix(projectDir);
  if (typeof s.start === 'string' && s.start.trim()) return `${pm} start`;
  if (typeof s['server:prod'] === 'string' && s['server:prod'].trim()) return `${pm} run server:prod`;
  if (typeof s.prod === 'string' && s.prod.trim()) return `${pm} run prod`;
  const main = typeof pkg.main === 'string' ? pkg.main.trim() : '';
  if (main && fs.existsSync(path.join(projectDir, main))) return `node ${main}`;
  const apiServerCjs = path.join(projectDir, 'artifacts', 'api-server', 'dist', 'index.cjs');
  if (fs.existsSync(apiServerCjs)) return 'node artifacts/api-server/dist/index.cjs';
  if (fs.existsSync(path.join(projectDir, 'dist', 'index.cjs'))) return 'node dist/index.cjs';
  if (fs.existsSync(path.join(projectDir, 'dist', 'index.js'))) return 'node dist/index.js';
  if (fs.existsSync(path.join(projectDir, 'server_dist', 'index.js'))) return 'node server_dist/index.js';
  if (fs.existsSync(path.join(projectDir, 'index.js'))) return 'node index.js';
  return null;
};

const pm2StarterDir = () => path.join('/home', APP_USER, '.vps-manager-starters');

const writePm2StarterScript = (safeName, projectDir, innerCommand) => {
  const dir = pm2StarterDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(dir, `${safeName}.sh`);
  const cdPath = shSingleQuote(projectDir);
  const pnpmBootstrap = projectUsesPnpm(projectDir) ? `${preparePnpmShell}\n` : '';
  const body = `#!/usr/bin/env bash
set -e
export HOME=${shSingleQuote(path.join('/home', APP_USER))}
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd ${cdPath}
set -a
[ -f .env ] && . ./.env
set +a
${pnpmBootstrap}exec ${innerCommand}
`;
  fs.writeFileSync(scriptPath, body, { mode: 0o700 });
  run(`chown ${APP_USER}:${APP_USER} ${shSingleQuote(scriptPath)}`);
  return scriptPath;
};

const pm2StartProject = (name, projectDir) => {
  const safeName = sanitizePm2ProcessName(name);
  const inner = resolvePm2StartInnerCommand(projectDir);
  if (!inner) {
    throw new Error(
      'Tidak ada cara start yang dikenali. Tambahkan script "start" di package.json, atau berkas dist/index.cjs, server_dist/index.js, atau index.js di root.',
    );
  }
  const scriptPath = writePm2StarterScript(safeName, projectDir, inner);
  const sq = shSingleQuote(scriptPath);
  runAs(
    `(pm2 describe ${safeName} >/dev/null 2>&1 && pm2 delete ${safeName} || true) && pm2 start ${sq} --name ${safeName} --interpreter bash && pm2 save`,
  );
};

/** Panggil setelah deploy/build agar isi starter (npm start vs node …) mengikuti package.json terbaru. */
const refreshPm2StarterScript = (name, projectDir) => {
  const safeName = sanitizePm2ProcessName(name);
  const inner = resolvePm2StartInnerCommand(projectDir);
  if (!inner) {
    throw new Error(
      'Tidak ada cara start yang dikenali setelah build. Periksa script "start" atau output build (dist/ / server_dist/).',
    );
  }
  writePm2StarterScript(safeName, projectDir, inner);
};

const getProjects = () => {
  if (!fs.existsSync(APP_DIR)) return [];
  return fs.readdirSync(APP_DIR).filter(f => {
    const stat = fs.statSync(path.join(APP_DIR, f));
    return stat.isDirectory();
  });
};

const readMeta = (app) => {
  const metaFile = path.join(APP_DIR, app, '.vps-meta');
  if (!fs.existsSync(metaFile)) return {};
  return Object.fromEntries(
    fs.readFileSync(metaFile, 'utf8').split('\n')
      .filter(l => l.includes('=')).map(l => l.split('='))
      .map(([k, ...v]) => [k, v.join('=')])
  );
};

const normalizeDeployLogTimestamp = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const isoLike = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(isoLike) ? isoLike : `${isoLike}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
};

const readLastDeployLogUpdate = (projectDir) => {
  const deployLog = path.join(projectDir, '.deploy.log');
  if (!fs.existsSync(deployLog)) return null;
  try {
    const lines = fs.readFileSync(deployLog, 'utf8').trim().split('\n').reverse();
    for (const line of lines) {
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+Deploy SUCCESS\b/);
      if (m) return { at: normalizeDeployLogTimestamp(m[1]), by: 'ci/cd', commit: '' };
    }
  } catch (_) {}
  return null;
};

const getProjectUpdatedInfo = (projectDir, meta) => {
  const at = meta.UPDATED_AT || meta.LAST_UPDATED_AT || meta.DEPLOYED_AT || '';
  if (at) {
    return {
      at: normalizeDeployLogTimestamp(at),
      by: meta.UPDATED_BY || meta.LAST_UPDATED_BY || '',
      commit: meta.UPDATED_COMMIT || meta.LAST_UPDATED_COMMIT || '',
    };
  }
  return readLastDeployLogUpdate(projectDir) || { at: '', by: '', commit: '' };
};

const getProjectGitCommit = (projectDir) => {
  try {
    return execSync(`git -C ${shSingleQuote(projectDir)} rev-parse HEAD`, { encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
};

const recordProjectUpdated = (projectDir, source) => {
  const updatedAt = new Date().toISOString();
  const commit = getProjectGitCommit(projectDir);
  updateVpsMetaInDir(projectDir, {
    UPDATED_AT: updatedAt,
    UPDATED_BY: source,
    UPDATED_COMMIT: commit,
  });
  return { updatedAt, commit };
};

/** Template GitHub Actions (disalin ke project sebagai .github/workflows/deploy.yml). */
const CICD_TEMPLATE_PATH = path.join(__dirname, 'cicd.yml');

const projectHasCicdWorkflow = (projectDir) => {
  if (!projectDir) return false;
  return fs.existsSync(path.join(projectDir, '.github', 'workflows', 'deploy.yml'));
};

const readEnv = (app) => {
  const envFile = path.join(APP_DIR, app, '.env');
  if (!fs.existsSync(envFile)) return {};
  return Object.fromEntries(
    fs.readFileSync(envFile, 'utf8').split('\n')
      .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
      .map(l => l.split('='))
      .map(([k, ...v]) => [k.trim(), v.join('=').trim()])
  );
};

const getPm2Status = () => {
  try {
    const raw = runAs('pm2 jlist');
    return JSON.parse(raw || '[]');
  } catch { return []; }
};

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const assertProjectOnlineAfterDeploy = (name, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'not_found';
  let sawOnline = false;
  while (Date.now() < deadline) {
    const proc = getPm2Status().find((p) => p.name === name);
    lastStatus = proc?.pm2_env?.status || 'not_found';
    if (lastStatus === 'online') {
      if (sawOnline) return;
      sawOnline = true;
    } else {
      sawOnline = false;
    }
    sleepSync(sawOnline ? 2000 : 1000);
  }
  throw new Error(`PM2 process '${name}' is not online after deploy (status: ${lastStatus})`);
};

// ── DOMAINS STORE & NGINX / SSL (kelola dari panel) ─────────────────
const DOMAINS_DB = path.join(__dirname, 'domains.json');

const loadDomainsDb = () => {
  try {
    const raw = fs.readFileSync(DOMAINS_DB, 'utf8');
    const j = JSON.parse(raw);
    if (!j.domains || !Array.isArray(j.domains)) j.domains = [];
    if (typeof j.certbotAutoRenew !== 'boolean') j.certbotAutoRenew = true;
    return j;
  } catch {
    return { certbotAutoRenew: true, domains: [] };
  }
};

const saveDomainsDb = (db) => {
  fs.writeFileSync(DOMAINS_DB, JSON.stringify(db, null, 2), 'utf8');
  try {
    run(`chown ${APP_USER}:${APP_USER} ${DOMAINS_DB}`);
  } catch (_) {}
};

const writeSystemFile = (absolutePath, text) => {
  try {
    fs.writeFileSync(absolutePath, text, 'utf8');
    return;
  } catch (_) {}
  const r = spawnSync('sudo', ['-n', 'tee', absolutePath], {
    input: Buffer.from(text, 'utf8'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    const err = (r.stderr && r.stderr.toString()) || '';
    throw new Error(
      err.trim() || 'Gagal menulis berkas sistem. Jalankan VPS Manager sebagai root atau tambahkan NOPASSWD sudo untuk tee.',
    );
  }
};

const sudoRm = (absolutePath) => {
  try {
    if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  } catch (_) {
    spawnSync('sudo', ['-n', 'rm', '-f', absolutePath], { stdio: 'ignore' });
  }
};

const nginxSymlinkEnable = (siteBase) => {
  const avail = `/etc/nginx/sites-available/${siteBase}`;
  const en = `/etc/nginx/sites-enabled/${siteBase}`;
  try {
    fs.symlinkSync(avail, en);
  } catch (_) {
    spawnSync('sudo', ['-n', 'ln', '-sf', avail, en], { stdio: 'ignore' });
  }
};

const nginxProxyHttpOnly = (host, port) => `server {
    listen 80;
    server_name ${host};
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
`;

const validateDomainHost = (host) => {
  const h = String(host || '').trim().toLowerCase();
  if (!h || h.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(h)) return null;
  return h;
};

const resolveDomainTargetPort = (target) => {
  if (!target || typeof target !== 'object') return null;
  if (target.type === 'port') {
    const p = parseInt(String(target.port), 10);
    return p > 0 && p < 65536 ? p : null;
  }
  if (target.type === 'project') {
    const proj = String(target.project || '').trim();
    if (!proj || !resolveProjectDir(proj) || !fs.existsSync(resolveProjectDir(proj))) return null;
    const env = readEnv(proj);
    const meta = readMeta(proj);
    const p = parseInt(String(env.PORT || meta.PORT || ''), 10);
    return p > 0 && p < 65536 ? p : null;
  }
  return null;
};

const domainSiteBase = (id) => `vps-domain-${id}`;

const applyManagedDomainNginx = (rec) => {
  if (rec.externalNginx) return;
  const host = validateDomainHost(rec.host);
  if (!host) throw new Error('Hostname tidak valid');
  const port = resolveDomainTargetPort(rec.target);
  if (!port) throw new Error('Target tidak valid (project harus ada dan punya PORT, atau isi port manual)');
  const base = domainSiteBase(rec.id);
  writeSystemFile(`/etc/nginx/sites-available/${base}`, nginxProxyHttpOnly(host, port));
  nginxSymlinkEnable(base);
  run('sudo -n nginx -t && sudo -n systemctl reload nginx');
};

const removeManagedDomainNginx = (id) => {
  const base = domainSiteBase(id);
  sudoRm(`/etc/nginx/sites-enabled/${base}`);
  sudoRm(`/etc/nginx/sites-available/${base}`);
  run('sudo -n nginx -t && sudo -n systemctl reload nginx 2>/dev/null');
};

/** Potong isi tiap blok `server { ... }` (toleransi nested `{`). */
const extractNginxServerBlocks = (content) => {
  const blocks = [];
  const re = /\bserver\s*\{/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const openBrace = m.index + m[0].length - 1;
    let depth = 1;
    let j = openBrace + 1;
    for (; j < content.length; j++) {
      const c = content[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          blocks.push(content.slice(openBrace + 1, j));
          break;
        }
      }
    }
  }
  return blocks;
};

/** Dari satu file nginx: hostname → port upstream 127.0.0.1 / localhost. */
const parseNginxProxyHostsFromContent = (content) => {
  const hosts = new Map();
  for (const chunk of extractNginxServerBlocks(content)) {
    const sn = chunk.match(/server_name\s+([^;]+);/);
    if (!sn) continue;
    const px =
      chunk.match(/proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)\s*;/) ||
      chunk.match(/proxy_pass\s+http:\/\/localhost:(\d+)\s*;/);
    if (!px) continue;
    const port = parseInt(px[1], 10);
    if (!(port > 0 && port < 65536)) continue;
    for (const raw of sn[1].trim().split(/\s+/)) {
      const name = raw.trim();
      if (!name || name === '_' || name === '*' || /^default$/i.test(name)) continue;
      const vh = validateDomainHost(name);
      if (!vh) continue;
      if (!hosts.has(vh)) hosts.set(vh, port);
    }
  }
  return hosts;
};

const NGINX_SITES_ENABLED = '/etc/nginx/sites-enabled';

/** Host yang sudah ada di nginx (bukan site vps-domain-*) untuk impor ke domains.json. */
const scanExistingNginxProxySites = () => {
  const collected = [];
  if (!fs.existsSync(NGINX_SITES_ENABLED)) return collected;
  let ents;
  try {
    ents = fs.readdirSync(NGINX_SITES_ENABLED);
  } catch {
    return collected;
  }
  for (const ent of ents) {
    if (ent.startsWith('.')) continue;
    const enPath = path.join(NGINX_SITES_ENABLED, ent);
    let realPath;
    try {
      realPath = fs.realpathSync(enPath);
    } catch {
      continue;
    }
    const siteFile = path.basename(realPath);
    if (siteFile.startsWith('vps-domain-')) continue;
    let content;
    try {
      content = fs.readFileSync(realPath, 'utf8');
    } catch {
      continue;
    }
    const hostMap = parseNginxProxyHostsFromContent(content);
    for (const [host, port] of hostMap.entries()) {
      collected.push({ host, port, siteFile });
    }
  }
  const byHost = new Map();
  for (const row of collected) {
    if (!byHost.has(row.host)) byHost.set(row.host, row);
  }
  return [...byHost.values()];
};

const getSslExpiryIso = (host) => {
  const live = `/etc/letsencrypt/live/${host}/fullchain.pem`;
  if (!fs.existsSync(live)) return null;
  try {
    const out = execSync(`openssl x509 -in ${live} -noout -enddate`, { encoding: 'utf8' });
    const m = out.match(/notAfter=(.+)/);
    if (!m) return null;
    const d = new Date(Date.parse(m[1].trim()));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
};

const getServerPublicIpv4 = () => {
  const fromEnv = String(process.env.VPS_PUBLIC_IP || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const out = execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
};

const resolveHostAddresses = async (host) => {
  const ips = new Set();
  for (const resolver of [dns.resolve4, dns.resolve6]) {
    try {
      const rows = await resolver(host);
      for (const row of rows) ips.add(String(row));
    } catch (e) {
      if (e && e.code !== 'ENODATA' && e.code !== 'ENOTFOUND') throw e;
    }
  }
  return [...ips];
};

const assertSslDnsPointsToServer = async (host) => {
  const serverIp = getServerPublicIpv4();
  const addresses = await resolveHostAddresses(host);
  if (!addresses.length) {
    throw new Error(`DNS untuk ${host} belum terpasang (tidak ada record A/AAAA).`);
  }
  if (serverIp && !addresses.includes(serverIp)) {
    throw new Error(
      `DNS ${host} mengarah ke ${addresses.join(', ')}, bukan IP VPS ${serverIp}. `
      + 'Jika memakai Cloudflare, matikan proxied (grey cloud) sampai sertifikat terpasang, lalu aktifkan TLS Full (strict).',
    );
  }
};

const runCertbotNginx = (host) => {
  try {
    execSync(
      `sudo -n certbot --nginx -d ${host} --non-interactive --agree-tos --redirect`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 },
    );
  } catch (e) {
    const detail = String(e.stderr || e.stdout || e.message || e);
    if (/Invalid response from .*acme-challenge/i.test(detail)) {
      throw new Error(
        'Validasi Let\'s Encrypt gagal: respons challenge HTTP bukan dari VPS. '
        + 'Periksa Cloudflare proxy (DNS only saat pasang SSL) dan pastikan Nginx port 80 dapat dijangkau.',
      );
    }
    if (/Some challenges have failed/i.test(detail)) {
      throw new Error(
        'Let\'s Encrypt menolak domain. Pastikan DNS sudah mengarah ke IP VPS (tanpa proxy Cloudflare) sebelum memasang SSL.',
      );
    }
    throw new Error(detail.trim().split('\n').slice(-6).join('\n') || 'certbot gagal');
  }
};

const certbotDeleteCert = (host) => {
  try {
    execSync(`sudo -n certbot delete --cert-name ${host} --non-interactive`, {
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (_) { /* */ }
};

const getCertbotTimerStatus = () => {
  const en = run('systemctl is-enabled certbot.timer 2>/dev/null');
  const ac = run('systemctl is-active certbot.timer 2>/dev/null');
  return {
    timerEnabled: en.includes('enabled'),
    timerActive: ac.includes('active'),
  };
};

const setCertbotTimerEnabled = (enable) => {
  if (enable) {
    execSync('sudo -n systemctl enable certbot.timer && sudo -n systemctl start certbot.timer', {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } else {
    execSync('sudo -n systemctl stop certbot.timer && sudo -n systemctl disable certbot.timer', {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  }
};

const updateVpsMetaInDir = (projectDir, patch) => {
  const metaPath = path.join(projectDir, '.vps-meta');
  if (!fs.existsSync(metaPath)) return;
  const lines = fs.readFileSync(metaPath, 'utf8').split('\n');
  const keys = Object.keys(patch).filter((k) => patch[k] != null);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    if (!line.includes('=')) {
      out.push(line);
      continue;
    }
    const k = line.split('=')[0];
    if (keys.includes(k)) {
      out.push(`${k}=${patch[k]}`);
      seen.add(k);
    } else out.push(line);
  }
  for (const k of keys) {
    if (!seen.has(k)) out.push(`${k}=${patch[k]}`);
  }
  fs.writeFileSync(metaPath, out.join('\n'), 'utf8');
};

const patchDotenvPort = (envPath, portVal) => {
  let text = fs.readFileSync(envPath, 'utf8');
  const line = `PORT=${portVal}`;
  if (/^PORT=/m.test(text)) text = text.replace(/^PORT=.*$/m, line);
  else text = `${text.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(envPath, text, 'utf8');
};

const applyProjectNginxSite = (projectKey, domain, port) => {
  const sitePath = `/etc/nginx/sites-available/${projectKey}`;
  const enabled = `/etc/nginx/sites-enabled/${projectKey}`;
  if (!domain || !String(domain).trim()) {
    sudoRm(enabled);
    sudoRm(sitePath);
    run('sudo -n nginx -t && sudo -n systemctl reload nginx 2>/dev/null');
    return;
  }
  const host = validateDomainHost(domain);
  if (!host) throw new Error('Domain project tidak valid');
  const p = parseInt(String(port), 10);
  if (!(p > 0 && p < 65536)) throw new Error('Port tidak valid');
  writeSystemFile(sitePath, nginxProxyHttpOnly(host, p));
  nginxSymlinkEnable(projectKey);
  run('sudo -n nginx -t && sudo -n systemctl reload nginx');
};

const renameProjectFolder = (oldName, newName) => {
  const oldDir = resolveProjectDir(oldName);
  const newDir = resolveProjectDir(newName);
  if (!oldDir || !fs.existsSync(oldDir)) throw new Error('Project asal tidak ada');
  if (fs.existsSync(newDir)) throw new Error('Folder tujuan sudah ada');
  fs.renameSync(oldDir, newDir);
};

// ── API: PROJECTS ─────────────────────────────────────────────
app.get('/api/projects', auth, (req, res) => {
  const pm2 = getPm2Status();
  const projects = getProjects().map(app => {
    const meta = readMeta(app);
    const proc = pm2.find(p => p.name === app);
    const env = readEnv(app);
    const pdir = resolveProjectDir(app);
    const updated = getProjectUpdatedInfo(pdir, meta);
    return {
      name: app,
      status: proc?.pm2_env?.status || 'stopped',
      port: env.PORT || meta.PORT || '-',
      domain: meta.DOMAIN || '',
      repo: meta.REPO_URL || '',
      branch: meta.BRANCH || 'main',
      installedAt: meta.INSTALLED_AT || '',
      updatedAt: updated.at,
      updatedBy: updated.by,
      updatedCommit: updated.commit,
      uptime: proc?.pm2_env?.pm_uptime || null,
      restarts: proc?.pm2_env?.restart_time || 0,
      memory: proc?.monit?.memory || 0,
      cpu: proc?.monit?.cpu || 0,
      cicdEnabled: projectHasCicdWorkflow(pdir),
    };
  });
  res.json(projects);
});

app.post('/api/projects/install', auth, (req, res) => {
  const { repoUrl, name, port, domain, branch = 'main' } = req.body;
  if (!repoUrl || !name || !port) return res.status(400).json({ error: 'Missing fields' });
  try {
    sanitizePm2ProcessName(name);
  } catch (e) {
    return res.status(400).json({ error: e.message || String(e) });
  }

  const targetDir = resolveProjectDir(name);
  if (!targetDir) return res.status(400).json({ error: 'Invalid project name' });
  if (fs.existsSync(targetDir)) return res.status(400).json({ error: 'Project already exists' });

  exec(`sudo -u ${APP_USER} git clone -b ${branch} ${repoUrl} ${targetDir}`, (err) => {
    if (err) return res.status(500).json({ error: 'Clone failed: ' + err.message });

    try {
      runProjectDepsInstall(targetDir);
    } catch (e) {
      return res.status(500).json({ error: 'Install failed: ' + e.message });
    }

    // Write .env (sebelum build, agar VITE_* / build-time env tersedia)
    const envContent = `NODE_ENV=production\nPORT=${port}\nDATABASE_URL=postgresql://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}\nREDIS_URL=redis://:${REDIS_PASS}@localhost:6379\n`;
    fs.writeFileSync(path.join(targetDir, '.env'), envContent);
    run(`chown ${APP_USER}:${APP_USER} ${targetDir}/.env`);

    // Write .vps-meta
    const metaContent = `APP_NAME=${name}\nREPO_URL=${repoUrl}\nBRANCH=${branch}\nPORT=${port}\nDOMAIN=${domain || ''}\nINSTALLED_AT=${new Date().toISOString()}\n`;
    fs.writeFileSync(path.join(targetDir, '.vps-meta'), metaContent);
    run(`chown ${APP_USER}:${APP_USER} ${targetDir}/.vps-meta`);

    // Setup nginx if domain
    if (domain) {
      try {
        applyProjectNginxSite(name, domain, port);
      } catch (e) {
        return res.status(500).json({ error: 'Nginx gagal: ' + (e.message || String(e)) });
      }
    }

    try {
      runProjectBuildIfAny(targetDir);
      pm2StartProject(name, targetDir);
    } catch (e) {
      return res.status(500).json({ error: 'Build atau start PM2 gagal: ' + e.message });
    }

    res.json({ success: true });
  });
});

app.delete('/api/projects/:name', auth, (req, res) => {
  const { name } = req.params;
  runAs(`pm2 stop ${name} 2>/dev/null; pm2 delete ${name} 2>/dev/null; pm2 save`);
  try {
    const safe = sanitizePm2ProcessName(name);
    const starter = path.join(pm2StarterDir(), `${safe}.sh`);
    if (fs.existsSync(starter)) fs.unlinkSync(starter);
  } catch (_) { /* nama lama tidak valid atau file tidak ada */ }
  run(`rm -f /etc/nginx/sites-enabled/${name} /etc/nginx/sites-available/${name}`);
  run('nginx -t && systemctl reload nginx 2>/dev/null');
  run(`rm -rf ${path.join(APP_DIR, name)}`);
  res.json({ success: true });
});

app.post('/api/projects/:name/deploy', auth, (req, res) => {
  const { name } = req.params;
  const dir = resolveProjectDir(name);
  if (!dir || !fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const meta = readMeta(name);
  const branch = (meta.BRANCH || 'main').replace(/[^a-zA-Z0-9._/-]/g, '') || 'main';
  const dirQ = shSingleQuote(dir);
  exec(`sudo -u ${APP_USER} git -C ${dirQ} fetch --all && sudo -u ${APP_USER} git -C ${dirQ} reset --hard origin/${branch}`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    try {
      runProjectDepsInstall(dir);
      runProjectBuildIfAny(dir);
      refreshPm2StarterScript(name, dir);
      pm2RestartWithEnvFromProject(name);
      assertProjectOnlineAfterDeploy(name);
      const updated = recordProjectUpdated(dir, 'dashboard');
      res.json({ success: true, updatedAt: updated.updatedAt, updatedCommit: updated.commit });
    } catch (e) {
      res.status(500).json({ error: 'Deploy failed: ' + e.message });
    }
  });
});

app.post('/api/projects/:name/restart', auth, (req, res) => {
  pm2RestartWithEnvFromProject(req.params.name);
  res.json({ success: true });
});

app.post('/api/projects/:name/enable-cicd', auth, (req, res) => {
  const { name } = req.params;
  const dir = resolveProjectDir(name);
  if (!dir || !fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return res.status(400).json({ error: 'Folder project bukan git repo (.git tidak ada)' });
  }
  if (projectHasCicdWorkflow(dir)) {
    return res.status(400).json({ error: 'CI/CD sudah aktif (.github/workflows/deploy.yml ada)' });
  }
  if (!fs.existsSync(CICD_TEMPLATE_PATH)) {
    return res.status(500).json({ error: 'Template cicd.yml tidak ada di ' + CICD_TEMPLATE_PATH });
  }
  const wfDir = path.join(dir, '.github', 'workflows');
  try {
    fs.mkdirSync(wfDir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(wfDir, 'deploy.yml'), fs.readFileSync(CICD_TEMPLATE_PATH, 'utf8'), 'utf8');
    run(`chown -R ${APP_USER}:${APP_USER} ${path.join(dir, '.github')}`);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
  const dirQ = shSingleQuote(dir);
  const gitIdent = [
    `GIT_AUTHOR_NAME=${shSingleQuote(MANAGER_GIT_AUTHOR_NAME)}`,
    `GIT_AUTHOR_EMAIL=${shSingleQuote(MANAGER_GIT_AUTHOR_EMAIL)}`,
    `GIT_COMMITTER_NAME=${shSingleQuote(MANAGER_GIT_AUTHOR_NAME)}`,
    `GIT_COMMITTER_EMAIL=${shSingleQuote(MANAGER_GIT_AUTHOR_EMAIL)}`,
  ].join(' ');
  const commitMsg = shSingleQuote('ci: add CI/CD pipeline');
  try {
    runAsThrow(`cd ${dirQ} && git add . && ${gitIdent} git commit -m ${commitMsg} && git push`);
  } catch (e) {
    return res.status(500).json({
      error:
        'Workflow sudah dibuat di .github/workflows/deploy.yml, tetapi git commit/push gagal. '
        + 'Periksa git user, remote, dan SSH/key di server deploy. '
        + (e.message || String(e)),
      partial: true,
    });
  }
  res.json({ success: true });
});

app.post('/api/projects/:name/stop', auth, (req, res) => {
  runAs(`pm2 stop ${req.params.name}`);
  res.json({ success: true });
});

app.get('/api/domains', auth, (req, res) => {
  const db = loadDomainsDb();
  const timer = getCertbotTimerStatus();
  const list = db.domains.map((d) => {
    const exp = getSslExpiryIso(d.host);
    return {
      ...d,
      resolvedPort: resolveDomainTargetPort(d.target),
      sslExpiry: exp,
      sslActive: !!exp,
    };
  });
  res.json({
    domains: list,
    certbotAutoRenew: db.certbotAutoRenew,
    certbotTimer: timer,
  });
});

/** Impor host dari /etc/nginx/sites-enabled (selain vps-domain-*) ke domains.json — tidak menulis ulang nginx. */
app.post('/api/domains/import-existing', auth, (req, res) => {
  const dryRun = !!req.body?.dryRun;
  const db = loadDomainsDb();
  let scanned;
  try {
    scanned = scanExistingNginxProxySites();
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
  const added = [];
  const skipped = [];
  for (const row of scanned) {
    if (db.domains.some((d) => d.host === row.host)) {
      skipped.push({ host: row.host, reason: 'sudah ada di panel' });
      continue;
    }
    const id = crypto.randomBytes(8).toString('hex');
    const sslActive = !!getSslExpiryIso(row.host);
    const rec = {
      id,
      host: row.host,
      target: { type: 'port', port: row.port },
      ssl: sslActive,
      sslAutoRenew: db.certbotAutoRenew !== false,
      externalNginx: true,
      externalSite: row.siteFile,
    };
    if (dryRun) {
      added.push({ host: rec.host, port: row.port, siteFile: row.siteFile });
    } else {
      db.domains.push(rec);
      added.push({ host: rec.host, id: rec.id, siteFile: rec.externalSite });
    }
  }
  if (!dryRun) saveDomainsDb(db);
  res.json({ added, skipped, dryRun, scanned: scanned.length });
});

app.post('/api/domains', auth, (req, res) => {
  const { host, targetType, targetProject, targetPort, ssl, sslAutoRenew } = req.body;
  const h = validateDomainHost(host);
  if (!h) return res.status(400).json({ error: 'Hostname tidak valid' });
  const tt = targetType === 'project' ? 'project' : 'port';
  const target =
    tt === 'project'
      ? { type: 'project', project: String(targetProject || '').trim() }
      : { type: 'port', port: parseInt(String(targetPort), 10) };
  if (tt === 'project' && !target.project) return res.status(400).json({ error: 'Pilih project' });
  if (tt === 'port' && !(target.port > 0 && target.port < 65536)) {
    return res.status(400).json({ error: 'Port tidak valid' });
  }

  const db = loadDomainsDb();
  if (db.domains.some((x) => x.host === h)) return res.status(400).json({ error: 'Domain sudah ada' });
  const id = crypto.randomBytes(8).toString('hex');
  const rec = {
    id,
    host: h,
    target,
    ssl: !!ssl,
    sslAutoRenew: sslAutoRenew !== false,
  };
  try {
    applyManagedDomainNginx(rec);
    if (rec.ssl) runCertbotNginx(h);
  } catch (e) {
    try { removeManagedDomainNginx(id); } catch (_) {}
    return res.status(500).json({ error: e.message || String(e) });
  }
  db.domains.push(rec);
  if (typeof sslAutoRenew === 'boolean') db.certbotAutoRenew = !!sslAutoRenew;
  if (db.certbotAutoRenew) {
    try { setCertbotTimerEnabled(true); } catch (_) {}
  }
  saveDomainsDb(db);
  res.json(rec);
});

app.put('/api/domains/:id', auth, (req, res) => {
  const db = loadDomainsDb();
  const idx = db.domains.findIndex((d) => d.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Tidak ditemukan' });
  const cur = db.domains[idx];
  const { host, targetType, targetProject, targetPort, ssl, sslAutoRenew } = req.body;

  if (host != null && String(host).trim() !== '') {
    const h = validateDomainHost(host);
    if (!h) return res.status(400).json({ error: 'Hostname tidak valid' });
    if (cur.externalNginx && h !== cur.host) {
      return res.status(400).json({
        error:
          'Domain nginx manual (file ' +
          (cur.externalSite || '') +
          '): ubah server_name di server, hapus baris ini di panel, lalu Impor dari nginx lagi.',
      });
    }
    if (h !== cur.host && db.domains.some((x, i) => i !== idx && x.host === h)) {
      return res.status(400).json({ error: 'Domain sudah dipakai' });
    }
    if (h !== cur.host && getSslExpiryIso(cur.host) && !cur.externalNginx) {
      certbotDeleteCert(cur.host);
      cur.ssl = false;
    }
    cur.host = h;
  }

  if (targetType != null) {
    const tt = targetType === 'project' ? 'project' : 'port';
    cur.target =
      tt === 'project'
        ? { type: 'project', project: String(targetProject || '').trim() }
        : { type: 'port', port: parseInt(String(targetPort), 10) };
    if (tt === 'project' && !cur.target.project) {
      return res.status(400).json({ error: 'Pilih project' });
    }
    if (tt === 'port' && !(cur.target.port > 0 && cur.target.port < 65536)) {
      return res.status(400).json({ error: 'Port tidak valid' });
    }
  }

  if (ssl != null) cur.ssl = !!ssl;
  if (sslAutoRenew != null) {
    cur.sslAutoRenew = !!sslAutoRenew;
    db.certbotAutoRenew = !!sslAutoRenew;
  }

  try {
    if (!cur.externalNginx) applyManagedDomainNginx(cur);
    if (cur.ssl) runCertbotNginx(cur.host);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
  if (db.certbotAutoRenew) {
    try { setCertbotTimerEnabled(true); } catch (_) {}
  }
  saveDomainsDb(db);
  res.json(cur);
});

app.delete('/api/domains/:id', auth, (req, res) => {
  const db = loadDomainsDb();
  const idx = db.domains.findIndex((d) => d.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Tidak ditemukan' });
  const old = db.domains[idx];
  if (!old.externalNginx) {
    if (getSslExpiryIso(old.host)) certbotDeleteCert(old.host);
    removeManagedDomainNginx(old.id);
  }
  db.domains.splice(idx, 1);
  saveDomainsDb(db);
  res.json({ success: true });
});

app.post('/api/domains/:id/ssl', auth, async (req, res) => {
  const db = loadDomainsDb();
  const d = db.domains.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'Tidak ditemukan' });
  try {
    await assertSslDnsPointsToServer(d.host);
    if (!d.externalNginx) applyManagedDomainNginx(d);
    runCertbotNginx(d.host);
    d.ssl = true;
    saveDomainsDb(db);
    res.json({ success: true, sslExpiry: getSslExpiryIso(d.host) });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.put('/api/settings/certbot-autorenew', auth, (req, res) => {
  const { enabled } = req.body;
  const db = loadDomainsDb();
  db.certbotAutoRenew = !!enabled;
  saveDomainsDb(db);
  try {
    setCertbotTimerEnabled(!!enabled);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
  res.json({ success: true, ...getCertbotTimerStatus() });
});

app.patch('/api/projects/:name/settings', auth, (req, res) => {
  const oldName = req.params.name;
  let { newName, domain, port } = req.body;
  let folderKey = oldName;

  const dir0 = resolveProjectDir(oldName);
  if (!dir0 || !fs.existsSync(dir0)) return res.status(404).json({ error: 'Project tidak ada' });

  if (newName != null && String(newName).trim() !== '' && newName !== oldName) {
    try {
      sanitizePm2ProcessName(newName);
    } catch (e) {
      return res.status(400).json({ error: e.message || String(e) });
    }
    try {
      runAs(
        `pm2 stop ${shSingleQuote(oldName)} 2>/dev/null; pm2 delete ${shSingleQuote(oldName)} 2>/dev/null; pm2 save`,
      );
    } catch (_) {}
    try {
      const s = sanitizePm2ProcessName(oldName);
      const starterOld = path.join(pm2StarterDir(), `${s}.sh`);
      if (fs.existsSync(starterOld)) fs.unlinkSync(starterOld);
    } catch (_) {}
    try {
      renameProjectFolder(oldName, newName);
    } catch (e) {
      return res.status(400).json({ error: e.message || String(e) });
    }
    folderKey = newName;
    const newDir = resolveProjectDir(newName);
    updateVpsMetaInDir(newDir, { APP_NAME: newName });
    const db = loadDomainsDb();
    let ch = false;
    for (const d of db.domains) {
      if (d.target && d.target.type === 'project' && d.target.project === oldName) {
        d.target.project = newName;
        ch = true;
      }
    }
    if (ch) {
      saveDomainsDb(db);
      for (const d of db.domains) {
        try {
          applyManagedDomainNginx(d);
        } catch (_) {}
      }
    }
    try {
      refreshPm2StarterScript(newName, newDir);
      pm2StartProject(newName, newDir);
    } catch (e) {
      return res.status(500).json({ error: 'Gagal start PM2 setelah rename: ' + e.message });
    }
    sudoRm(`/etc/nginx/sites-enabled/${oldName}`);
    sudoRm(`/etc/nginx/sites-available/${oldName}`);
  }

  const workDir = resolveProjectDir(folderKey);
  const envPath = path.join(workDir, '.env');
  if (port != null && port !== '') {
    const p = parseInt(String(port), 10);
    if (!(p > 0 && p < 65536)) return res.status(400).json({ error: 'Port tidak valid' });
    if (fs.existsSync(envPath)) patchDotenvPort(envPath, p);
    updateVpsMetaInDir(workDir, { PORT: String(p) });
  }
  if (domain !== undefined) {
    updateVpsMetaInDir(workDir, { DOMAIN: String(domain || '').trim() });
  }

  const meta = readMeta(folderKey);
  const env = readEnv(folderKey);
  const finalPort = parseInt(String(env.PORT || meta.PORT || '0'), 10);
  if (meta.DOMAIN && String(meta.DOMAIN).trim()) {
    if (!(finalPort > 0)) {
      return res.status(400).json({ error: 'PORT tidak terbaca; set port di pengaturan' });
    }
    try {
      applyProjectNginxSite(folderKey, meta.DOMAIN, finalPort);
    } catch (e) {
      return res.status(500).json({ error: 'Nginx: ' + e.message });
    }
  } else {
    applyProjectNginxSite(folderKey, '', finalPort);
  }

  const db2 = loadDomainsDb();
  for (const d of db2.domains) {
    if (d.target && d.target.type === 'project' && d.target.project === folderKey) {
      try {
        applyManagedDomainNginx(d);
      } catch (_) {}
    }
  }

  try {
    pm2RestartWithEnvFromProject(folderKey);
  } catch (_) {}

  res.json({ success: true, name: folderKey });
});

// ── API: SECRETS ──────────────────────────────────────────────
app.get('/api/projects/:name/secrets', auth, (req, res) => {
  const envFile = path.join(APP_DIR, req.params.name, '.env');
  if (!fs.existsSync(envFile)) return res.json([]);
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  const secrets = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => parseEnvLine(l))
    .filter(Boolean);
  res.json(secrets);
});

app.put('/api/projects/:name/secrets', auth, (req, res) => {
  const { secrets } = req.body; // [{key, value}]
  const envFile = path.join(APP_DIR, req.params.name, '.env');
  const content = secrets
    .filter((s) => s && typeof s.key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.key))
    .map((s) => `${s.key}=${envQuotedForSource(s.value ?? '')}`)
    .join('\n') + '\n';
  fs.writeFileSync(envFile, content);
  run(`chown ${APP_USER}:${APP_USER} ${envFile}`);
  res.json({ success: true });
});

app.post('/api/projects/:name/secrets', auth, (req, res) => {
  const { key, value } = req.body;
  if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key))) {
    return res.status(400).json({ error: 'Invalid key' });
  }
  const envFile = path.join(APP_DIR, req.params.name, '.env');
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const regex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
  const line = `${key}=${envQuotedForSource(value ?? '')}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content += (content.endsWith('\n') || content.length === 0 ? '' : '\n') + `${line}\n`;
  }
  fs.writeFileSync(envFile, content);
  run(`chown ${APP_USER}:${APP_USER} ${envFile}`);
  res.json({ success: true });
});

app.delete('/api/projects/:name/secrets/:key', auth, (req, res) => {
  const k = req.params.key;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return res.status(400).json({ error: 'Invalid key' });
  const envFile = path.join(APP_DIR, req.params.name, '.env');
  if (!fs.existsSync(envFile)) return res.json({ success: true });
  let content = fs.readFileSync(envFile, 'utf8');
  content = content
    .split('\n')
    .filter((l) => {
      const p = parseEnvLine(l.trim());
      return !p || p.key !== k;
    })
    .join('\n');
  fs.writeFileSync(envFile, content);
  res.json({ success: true });
});

// ── API: LOGS ─────────────────────────────────────────────────
app.get('/api/projects/:name/logs', auth, (req, res) => {
  const lines = req.query.lines || 50;
  const logs = runAs(`pm2 logs ${req.params.name} --lines ${lines} --nostream 2>&1`);
  res.json({ logs });
});

// ── API: SYSTEM ───────────────────────────────────────────────
app.get('/api/system', auth, (req, res) => {
  const cpu = run("top -bn1 | grep 'Cpu(s)' | awk '{print $2 + $4}'");
  const memRaw = run("free -m | awk '/^Mem:/{print $2,$3}'").split(' ');
  const diskRaw = run("df -h / | awk 'NR==2{print $2,$3,$5}'").split(' ');
  res.json({
    cpu: parseFloat(cpu) || 0,
    memTotal: parseInt(memRaw[0]) || 0,
    memUsed: parseInt(memRaw[1]) || 0,
    diskTotal: diskRaw[0] || '-',
    diskUsed: diskRaw[1] || '-',
    diskPercent: diskRaw[2] || '-',
    uptime: run("uptime -p"),
  });
});

// ── DATABASE HELPERS & API ────────────────────────────────────
const safeSqlFilename = (name) => {
  if (!name || typeof name !== 'string') return null;
  const base = path.basename(name);
  if (!/^[a-zA-Z0-9._-]+\.sql$/.test(base)) return null;
  return base;
};

const isPgUrl = (s) =>
  typeof s === 'string' &&
  s.length > 0 &&
  s.length < 4000 &&
  (s.startsWith('postgresql://') || s.startsWith('postgres://'));

/** Strip channel_binding (can confuse some libpq builds); ensure sslmode for Neon hosts. */
const normalizeRemoteUrl = (urlString) => {
  try {
    const raw = urlString.trim();
    const u = new URL(raw);
    u.searchParams.delete('channel_binding');
    if (!u.searchParams.get('sslmode') && /\.neon\.tech$/i.test(u.hostname || '')) {
      u.searchParams.set('sslmode', 'require');
    }
    return u.toString();
  } catch {
    return urlString.trim();
  }
};

const pgDumpToFile = (connectionUrl, outPath, extraArgs = []) =>
  new Promise((resolve, reject) => {
    const args = ['--no-owner', '--no-privileges', '--clean', '--if-exists', '-F', 'p', '-f', outPath, '-d', connectionUrl];
    args.splice(0, 0, ...extraArgs);
    const child = spawn('pg_dump', args, {
      env: { ...process.env, PGSSLMODE: process.env.PGSSLMODE || 'require' },
    });
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `pg_dump exited ${code}`));
    });
    child.on('error', reject);
  });

const runPsqlFile = (dbName, filePath) => {
  execFileSync('psql', [
    '-h', 'localhost',
    '-p', '5432',
    '-U', PG_USER,
    '-d', dbName,
    '-v', 'ON_ERROR_STOP=1',
    '-f', filePath,
  ], {
    env: { ...process.env, PGPASSWORD: PG_PASS },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
};

const runPsqlSql = (dbName, sql) => {
  execFileSync('psql', [
    '-h', 'localhost',
    '-p', '5432',
    '-U', PG_USER,
    '-d', dbName,
    '-v', 'ON_ERROR_STOP=1',
    '-c', sql,
  ], {
    env: { ...process.env, PGPASSWORD: PG_PASS },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
};

// ── POSTGRES READ-ONLY BROWSE (pg driver) ─────────────────────
const isValidPgDbName = (s) => typeof s === 'string' && /^[a-zA-Z0-9_]+$/.test(s);
const isValidPgIdent = (s) => typeof s === 'string' && /^[a-zA-Z0-9_]+$/.test(s);

/** Buat database lokal jika belum ada (butuh CREATEDB pada PG_USER). */
const ensureLocalDatabaseExists = (dbName) => {
  if (!isValidPgDbName(dbName) || !isValidPgDbName(PG_USER)) {
    throw new Error('Invalid database or PG_USER name');
  }
  const exists = execFileSync('psql', [
    '-h', 'localhost',
    '-p', '5432',
    '-U', PG_USER,
    '-d', 'postgres',
    '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`,
  ], {
    env: { ...process.env, PGPASSWORD: PG_PASS },
    encoding: 'utf8',
    maxBuffer: 65536,
  }).trim();
  if (exists === '1') return;
  execFileSync('psql', [
    '-h', 'localhost',
    '-p', '5432',
    '-U', PG_USER,
    '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1',
    '-c', `CREATE DATABASE ${dbName} OWNER ${PG_USER}`,
  ], {
    env: { ...process.env, PGPASSWORD: PG_PASS },
    encoding: 'utf8',
    maxBuffer: 65536,
  });
};

const openBrowsePool = (database) =>
  new Pool({
    host: 'localhost',
    port: 5432,
    user: PG_USER,
    password: PG_PASS,
    database,
    max: 2,
    idleTimeoutMillis: 3000,
    connectionTimeoutMillis: 10000,
  });

async function withBrowsePool(database, fn) {
  if (!isValidPgDbName(database)) throw new Error('Invalid database name');
  const pool = openBrowsePool(database);
  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Daftar DB = yang punya CONNECT untuk PG_USER. Untuk list cluster penuh seperti superuser \\l butuh koneksi/superuser atau sudo -u postgres psql (kebijakan terpisah). */
async function listConnectableDatabases() {
  const candidates = ['postgres', PG_DB];
  for (const db of candidates) {
    if (!isValidPgDbName(db)) continue;
    try {
      return await withBrowsePool(db, async (pool) => {
        const { rows } = await pool.query(`
          SELECT datname
          FROM pg_database
          WHERE NOT datistemplate
            AND has_database_privilege(current_user, oid, 'CONNECT')
          ORDER BY datname
        `);
        return rows.map((r) => r.datname);
      });
    } catch {
      continue;
    }
  }
  return [PG_DB].filter(isValidPgDbName);
}

const quoteIdent = (s) => {
  if (!isValidPgIdent(s)) throw new Error('Invalid schema or table name');
  return `"${s.replace(/"/g, '')}"`;
};

app.get('/api/database/browse/databases', auth, async (req, res) => {
  try {
    const databases = await listConnectableDatabases();
    res.json({ databases, note: 'Hanya database yang role ini punya hak CONNECT. Tanpa akses ke DB postgres, daftar bisa hanya berisi app default.' });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/api/database/browse/:db/schemas', auth, async (req, res) => {
  const { db } = req.params;
  if (!isValidPgDbName(db)) return res.status(400).json({ error: 'Invalid database' });
  try {
    const schemas = await withBrowsePool(db, async (pool) => {
      const { rows } = await pool.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
          AND schema_name NOT LIKE 'pg\\_temp%' ESCAPE '\\'
        ORDER BY schema_name
      `);
      return rows.map((r) => r.schema_name);
    });
    res.json({ schemas });
  } catch (e) {
    const msg = e.message || String(e);
    if (/password|ECONNREFUSED|does not exist/i.test(msg)) return res.status(403).json({ error: msg });
    res.status(500).json({ error: msg });
  }
});

app.get('/api/database/browse/:db/tables', auth, async (req, res) => {
  const { db } = req.params;
  const schema = req.query.schema || 'public';
  if (!isValidPgDbName(db) || !isValidPgIdent(schema)) {
    return res.status(400).json({ error: 'Invalid database or schema' });
  }
  try {
    const tables = await withBrowsePool(db, async (pool) => {
      const { rows } = await pool.query(
        `SELECT c.relname AS table_name,
                COALESCE(c.reltuples::bigint, 0) AS estimate_rows
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'r'
           AND n.nspname = $1
         ORDER BY c.relname`,
        [schema],
      );
      return rows.map((r) => ({ name: r.table_name, estimateRows: r.estimate_rows }));
    });
    res.json({ tables });
  } catch (e) {
    const msg = e.message || String(e);
    if (/password|ECONNREFUSED/i.test(msg)) return res.status(403).json({ error: msg });
    res.status(500).json({ error: msg });
  }
});

app.get('/api/database/browse/:db/rows', auth, async (req, res) => {
  const { db } = req.params;
  const schema = req.query.schema || 'public';
  const table = req.query.table;
  if (!table || !isValidPgDbName(db) || !isValidPgIdent(schema) || !isValidPgIdent(table)) {
    return res.status(400).json({ error: 'Invalid database, schema, or table' });
  }
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
  const offset = Math.min(Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0), 10000);
  try {
    const result = await withBrowsePool(db, async (pool) => {
      const rel = `${quoteIdent(schema)}.${quoteIdent(table)}`;
      const { rows, fields } = await pool.query(
        `SELECT * FROM ${rel} LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      const columns = fields.map((f) => f.name);
      const rowValues = rows.map((row) => columns.map((c) => row[c]));
      return { columns, rows: rowValues, limit, offset };
    });
    res.json(result);
  } catch (e) {
    const msg = e.message || String(e);
    if (/password|ECONNREFUSED/i.test(msg)) return res.status(403).json({ error: msg });
    res.status(500).json({ error: msg });
  }
});

app.get('/api/database/status', auth, (req, res) => {
  res.json({
    dumpDir: DB_DUMP_DIR,
    local: {
      host: 'localhost',
      port: 5432,
      user: PG_USER,
      database: PG_DB,
    },
  });
});

/** Host aman untuk bagian host di connection URL (localhost / hostname / IPv4 sederhana). */
const sanitizeDbConnHost = (h) => {
  if (typeof h !== 'string' || h.length > 253) return 'localhost';
  if (!/^[\w.-]+$/.test(h) || h.includes('..')) return 'localhost';
  return h;
};

/** Connection string untuk app di VPS (default host localhost). Rahasia: hanya untuk client yang sudah login JWT. */
app.get('/api/database/connection-url/:db', auth, (req, res) => {
  const { db } = req.params;
  if (!isValidPgDbName(db)) {
    return res.status(400).json({ error: 'Invalid database name' });
  }
  const host = sanitizeDbConnHost(typeof req.query.host === 'string' ? req.query.host : 'localhost');
  const port = 5432;
  const url = `postgresql://${encodeURIComponent(PG_USER)}:${encodeURIComponent(PG_PASS || '')}@${host}:${port}/${db}`;
  res.json({
    url,
    host,
    database: db,
    user: PG_USER,
    note: 'App di server ini: gunakan host localhost. Dari luar VPS, ganti host (dan pg_hba) sesuai kebijakan Anda.',
  });
});

app.get('/api/database/export', auth, (req, res) => {
  const dbName =
    typeof req.query.database === 'string' && isValidPgDbName(req.query.database)
      ? req.query.database
      : PG_DB;
  const filename = `dump_${dbName}_${Date.now()}.sql`;
  const child = spawn('pg_dump', [
    '-h', 'localhost',
    '-p', '5432',
    '-U', PG_USER,
    '-d', dbName,
    '-F', 'p',
    '--no-owner',
    '--no-privileges',
  ], {
    env: { ...process.env, PGPASSWORD: PG_PASS },
  });
  res.setHeader('Content-Type', 'application/sql; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  child.stdout.pipe(res);
  let errBuf = '';
  child.stderr.on('data', (c) => { errBuf += c.toString(); });
  child.on('close', (code) => {
    if (code !== 0 && !res.headersSent) {
      res.status(500).json({ error: errBuf.trim() || `pg_dump failed (${code})` });
    }
  });
  child.on('error', (e) => {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});

app.get('/api/database/dumps', auth, (req, res) => {
  try {
    const files = fs.readdirSync(DB_DUMP_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => {
        const p = path.join(DB_DUMP_DIR, f);
        const st = fs.statSync(p);
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/database/dumps/download', auth, (req, res) => {
  const name = safeSqlFilename(req.query.name);
  if (!name) return res.status(400).json({ error: 'Invalid file name' });
  const full = path.join(DB_DUMP_DIR, name);
  if (!full.startsWith(DB_DUMP_DIR) || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(full, name);
});

app.post('/api/database/import', auth, jsonLarge, (req, res) => {
  const { sql, targetDatabase } = req.body || {};
  const dbName = typeof targetDatabase === 'string' && /^[a-zA-Z0-9_]+$/.test(targetDatabase)
    ? targetDatabase
    : PG_DB;
  if (!sql || typeof sql !== 'string') {
    return res.status(400).json({ error: 'Body must include sql (string)' });
  }
  const tmp = path.join(DB_DUMP_DIR, `import_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  try {
    ensureLocalDatabaseExists(dbName);
    fs.writeFileSync(tmp, sql, 'utf8');
    runPsqlFile(dbName, tmp);
    res.json({ success: true, database: dbName });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message || String(e) });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

app.post('/api/database/import-file', auth, (req, res) => {
  const name = safeSqlFilename(req.body?.filename);
  const targetDatabase = req.body?.targetDatabase;
  const dbName = typeof targetDatabase === 'string' && /^[a-zA-Z0-9_]+$/.test(targetDatabase)
    ? targetDatabase
    : PG_DB;
  if (!name) return res.status(400).json({ error: 'filename must be a .sql file in dump dir' });
  const full = path.join(DB_DUMP_DIR, name);
  if (!full.startsWith(DB_DUMP_DIR) || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'File not found' });
  }
  try {
    ensureLocalDatabaseExists(dbName);
    runPsqlFile(dbName, full);
    res.json({ success: true, database: dbName });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message || String(e) });
  }
});

app.post('/api/database/create-local', auth, (req, res) => {
  const name = req.body?.database;
  if (!isValidPgDbName(name)) {
    return res.status(400).json({ error: 'Nama database tidak valid (huruf, angka, underscore)' });
  }
  try {
    ensureLocalDatabaseExists(name);
    res.json({ success: true, database: name });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message || String(e) });
  }
});

/**
 * Pull data from a remote DB (e.g. Neon) using a postgres URL, restore into local DB.
 * body: { connectionUrl, targetDatabase?, resetSchema?: bool }
 */
app.post('/api/database/sync-from-url', auth, jsonLarge, async (req, res) => {
  const { connectionUrl, targetDatabase, resetSchema } = req.body || {};
  const dbName = typeof targetDatabase === 'string' && /^[a-zA-Z0-9_]+$/.test(targetDatabase)
    ? targetDatabase
    : PG_DB;
  if (!isPgUrl(connectionUrl)) {
    return res.status(400).json({ error: 'connectionUrl must be a postgresql:// or postgres:// URL' });
  }
  const remoteUrl = normalizeRemoteUrl(connectionUrl);
  const tmp = path.join(DB_DUMP_DIR, `remote_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  try {
    ensureLocalDatabaseExists(dbName);
    await pgDumpToFile(remoteUrl, tmp);
    if (resetSchema === true) {
      runPsqlSql(dbName, 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    }
    runPsqlFile(dbName, tmp);
    res.json({ success: true, database: dbName, resetSchema: !!resetSchema });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

// ── SERVE DASHBOARD ───────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VPS Manager</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
    --border: #30363d; --text: #e6edf3; --muted: #7d8590;
    --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --blue: #58a6ff; --purple: #bc8cff; --accent: #1f6feb;
  }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
  .sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 220px; background: var(--bg2); border-right: 1px solid var(--border); padding: 20px 0; }
  .logo { padding: 0 20px 20px; border-bottom: 1px solid var(--border); }
  .logo h1 { font-size: 16px; font-weight: 600; color: var(--text); }
  .logo p { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .nav a { display: flex; align-items: center; gap: 10px; padding: 10px 20px; color: var(--muted); text-decoration: none; font-size: 13px; transition: all .15s; }
  .nav a:hover, .nav a.active { color: var(--text); background: var(--bg3); }
  .nav a svg { width: 16px; height: 16px; }
  .main { margin-left: 220px; padding: 28px; min-height: 100vh; }
  .page { display: none; }
  .page.active { display: block; }
  h2 { font-size: 20px; font-weight: 600; margin-bottom: 20px; }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .stat-label { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .stat-value { font-size: 24px; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 500; }
  .badge-green { background: rgba(63,185,80,.15); color: var(--green); }
  .badge-red { background: rgba(248,81,73,.15); color: var(--red); }
  .badge-yellow { background: rgba(210,153,34,.15); color: var(--yellow); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 10px 12px; font-size: 12px; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--border); }
  td { padding: 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--bg3); }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg3); color: var(--text); cursor: pointer; font-size: 13px; text-decoration: none; transition: all .15s; }
  .btn:hover { border-color: var(--blue); color: var(--blue); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
  .btn-primary:hover { background: #1a5dcc; color: white; }
  .btn-danger { background: rgba(248,81,73,.1); border-color: var(--red); color: var(--red); }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .btn-group { display: flex; gap: 6px; flex-wrap: wrap; }
  .project-list-card { position: relative; display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 18px 20px; }
  .project-info { min-width: 0; flex: 1 1 auto; }
  .project-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .project-name { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
  .project-meta { font-size: 12px; color: var(--muted); line-height: 1.5; overflow-wrap: anywhere; }
  .project-actions { position: relative; flex: 0 0 auto; margin-left: auto; }
  .project-menu-btn { width: 36px; height: 36px; padding: 0; justify-content: center; font-size: 20px; line-height: 1; }
  .project-menu { display: none; position: absolute; top: calc(100% + 8px); right: 0; min-width: 190px; padding: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); box-shadow: 0 12px 30px rgba(0,0,0,.35); z-index: 30; }
  .project-actions.open .project-menu { display: block; }
  .project-menu-item, .project-menu-note { width: 100%; display: flex; align-items: center; justify-content: flex-start; gap: 8px; padding: 9px 10px; border-radius: 6px; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 13px; text-align: left; text-decoration: none; cursor: pointer; }
  .project-menu-item:hover { background: var(--bg3); color: var(--blue); }
  .project-menu-item.btn-danger { color: var(--red); }
  .project-menu-item.btn-danger:hover { background: rgba(248,81,73,.1); color: var(--red); }
  .project-menu-note { color: var(--muted); cursor: default; }
  input, select, textarea { background: var(--bg3); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 6px; font-size: 13px; width: 100%; outline: none; font-family: inherit; }
  input:focus, select:focus, textarea:focus { border-color: var(--accent); }
  .form-row { margin-bottom: 14px; }
  .form-row label { display: block; margin-bottom: 6px; font-size: 12px; color: var(--muted); }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; font-size: 13px; z-index: 999; animation: fadeIn .2s; max-width: 320px; }
  .toast.success { border-color: var(--green); }
  .toast.error { border-color: var(--red); }
  @keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
  .secret-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .secret-key { flex: 1; font-family: monospace; }
  .secret-val { flex: 2; font-family: monospace; }
  .secret-val.masked { color: var(--muted); }
  .logs-box { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 16px; font-family: monospace; font-size: 12px; line-height: 1.6; max-height: 500px; overflow-y: auto; white-space: pre-wrap; color: #adbac7; }
  .login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .login-card { width: 340px; background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 32px; }
  .progress-bar { height: 4px; background: var(--bg3); border-radius: 2px; overflow: hidden; margin-top: 8px; }
  .progress-fill { height: 100%; background: var(--blue); border-radius: 2px; transition: width .3s; }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
  .tab { padding: 8px 16px; cursor: pointer; color: var(--muted); font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab.active { color: var(--blue); border-bottom-color: var(--blue); }
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 100; display: flex; align-items: center; justify-content: center; }
  .modal { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 28px; width: 520px; max-width: 95vw; max-height: 90vh; overflow-y: auto; }
  .modal h3 { font-size: 16px; margin-bottom: 20px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; background: var(--bg3); border: 1px solid var(--border); border-radius: 20px; padding: 3px 10px; font-size: 11px; color: var(--muted); }
  .db-toolbar { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px; margin-bottom: 20px; }
  .db-toolbar h2 { margin: 0 0 4px 0; font-size: 20px; font-weight: 600; }
  .db-sub { color: var(--muted); font-size: 13px; max-width: 540px; line-height: 1.5; margin: 0; }
  .db-toolbar-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .db-list-table { margin: 0; }
  .db-list-table thead th { background: var(--bg3); font-size: 12px; }
  .db-list-row:hover td { background: var(--bg3); cursor: pointer; }
  .db-row-actions { white-space: nowrap; }
  .db-detail-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  .db-detail-breadcrumb { font-size: 15px; }
  .db-hidden { display: none !important; }
  #page-database .db-tab-strip { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 0; padding-bottom: 0; flex-wrap: wrap; }
  #page-database .db-tab-strip .tab { margin-bottom: -1px; border-radius: 6px 6px 0 0; background: transparent; }
  #page-database .db-tab-strip .tab.active { background: var(--bg2); border: 1px solid var(--border); border-bottom-color: var(--bg2); }
  #page-database .db-panel-stack .card { border-radius: 0 8px 8px 8px; margin-top: -1px; }
  .db-job-status { margin-top: 16px; padding: 14px 16px; background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; font-size: 13px; line-height: 1.55; }
  .db-job-status.db-job-ok { border-color: rgba(63,185,80,.5); background: rgba(63,185,80,.08); }
  .db-job-status.db-job-err { border-color: rgba(248,81,73,.5); background: rgba(248,81,73,.08); }
  .db-job-row { display: flex; align-items: flex-start; gap: 12px; }
  .db-spinner { width: 20px; height: 20px; border: 2px solid var(--border); border-top-color: var(--blue); border-radius: 50%; animation: dbSpin 0.65s linear infinite; flex-shrink: 0; margin-top: 2px; }
  @keyframes dbSpin { to { transform: rotate(360deg); } }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn.is-busy { position: relative; color: transparent !important; pointer-events: none; }
  .btn.is-busy::after { content: ''; position: absolute; inset: 0; margin: auto; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; border-radius: 50%; animation: dbSpin 0.65s linear infinite; }
  .btn:not(.btn-primary):not(.btn-danger).is-busy::after { border-color: rgba(201,209,217,.35); border-top-color: var(--text); }
  .btn-danger.is-busy::after { border-color: rgba(248,81,73,.35); border-top-color: var(--red); }
  .uninstall-verify-code { font-family: monospace; font-size: 22px; font-weight: 600; letter-spacing: 0.25em; background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; text-align: center; color: var(--accent); user-select: all; }
  .sidebar-shell { display: flex; flex-direction: column; height: 100%; }
  .sidebar-footer { margin-top: auto; padding: 16px 20px 0; border-top: 1px solid var(--border); }
  .sidebar-footer .btn { width: 100%; justify-content: center; }
  .mobile-topbar { display: none; position: sticky; top: 0; z-index: 90; align-items: center; gap: 12px; padding: 12px 16px; background: var(--bg2); border-bottom: 1px solid var(--border); }
  .mobile-menu-btn { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg3); color: var(--text); cursor: pointer; }
  .mobile-topbar-title { font-size: 15px; font-weight: 600; }
  .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 95; }
  .table-scroll { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .page-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .page-header h2 { margin: 0; }
  .account-card { max-width: 480px; }
  @media (max-width: 900px) {
    .sidebar { width: min(280px, 86vw); transform: translateX(-100%); transition: transform .2s ease; z-index: 100; box-shadow: 8px 0 24px rgba(0,0,0,.35); }
    .sidebar.open { transform: translateX(0); }
    .sidebar-overlay.open { display: block; }
    .main { margin-left: 0; padding: 16px; }
    .mobile-topbar { display: flex; }
    .form-grid { grid-template-columns: 1fr; }
    .login-card { width: min(340px, calc(100vw - 32px)); padding: 24px; }
    .toast { left: 16px; right: 16px; bottom: 16px; max-width: none; }
    .db-toolbar { flex-direction: column; align-items: stretch; }
    .db-toolbar-actions { width: 100%; }
    .db-toolbar-actions .btn { flex: 1 1 auto; }
    th, td { padding: 10px 8px; font-size: 12px; }
    .btn-group { gap: 4px; }
    .project-list-card { padding: 16px; gap: 10px; }
    .project-menu { min-width: 180px; }
    .modal { padding: 20px; }
  }
</style>
</head>
<body>
<div id="app">
  <div id="login-screen" style="display:none;">
    <div class="login-wrap">
      <div class="login-card">
        <h2 style="text-align:center; margin-bottom:8px;">VPS Manager</h2>
        <p style="text-align:center; color:var(--muted); font-size:13px; margin-bottom:24px;">Dashboard Panel</p>
        <div class="form-row"><label>Password</label><input type="password" id="login-pass" placeholder="Enter password" /></div>
        <button class="btn btn-primary" style="width:100%;" onclick="doLogin(event)">Login</button>
        <div id="login-err" style="color:var(--red); font-size:12px; margin-top:10px; text-align:center;"></div>
      </div>
    </div>
  </div>

  <div id="dashboard" style="display:none;">
    <div class="mobile-topbar">
      <button type="button" class="mobile-menu-btn" onclick="toggleMobileNav()" aria-label="Buka menu">
        <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><path d="M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 2.75zm0 5A.75.75 0 0 1 1.75 7h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 7.75zM1.75 12h12.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5z"/></svg>
      </button>
      <div class="mobile-topbar-title">VPS Manager</div>
    </div>
    <div class="sidebar-overlay" id="sidebar-overlay" onclick="closeMobileNav()"></div>
    <div class="sidebar" id="sidebar">
      <div class="sidebar-shell">
        <div class="logo">
          <h1>⚡ VPS Manager</h1>
          <p id="vps-ip">Loading...</p>
        </div>
        <nav class="nav">
        <a href="#" class="active" onclick="showPage('overview')">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.5A1.5 1.5 0 0 1 1.5 0h2A1.5 1.5 0 0 1 5 1.5v2A1.5 1.5 0 0 1 3.5 5h-2A1.5 1.5 0 0 1 0 3.5v-2zM6.5 0A1.5 1.5 0 0 0 5 1.5v2A1.5 1.5 0 0 0 6.5 5h2A1.5 1.5 0 0 0 10 3.5v-2A1.5 1.5 0 0 0 8.5 0h-2zM11 1.5A1.5 1.5 0 0 1 12.5 0h2A1.5 1.5 0 0 1 16 1.5v2A1.5 1.5 0 0 1 14.5 5h-2A1.5 1.5 0 0 1 11 3.5v-2zM1.5 6a1.5 1.5 0 0 0-1.5 1.5v2A1.5 1.5 0 0 0 1.5 11h2A1.5 1.5 0 0 0 5 9.5v-2A1.5 1.5 0 0 0 3.5 6h-2zM6.5 6A1.5 1.5 0 0 0 5 7.5v2A1.5 1.5 0 0 0 6.5 11h2A1.5 1.5 0 0 0 10 9.5v-2A1.5 1.5 0 0 0 8.5 6h-2zM11 7.5A1.5 1.5 0 0 1 12.5 6h2A1.5 1.5 0 0 1 16 7.5v2A1.5 1.5 0 0 1 14.5 11h-2A1.5 1.5 0 0 1 11 9.5v-2zM1.5 11A1.5 1.5 0 0 0 0 12.5v2A1.5 1.5 0 0 0 1.5 16h2A1.5 1.5 0 0 0 5 14.5v-2A1.5 1.5 0 0 0 3.5 11h-2zM6.5 11A1.5 1.5 0 0 0 5 12.5v2A1.5 1.5 0 0 0 6.5 16h2A1.5 1.5 0 0 0 10 14.5v-2A1.5 1.5 0 0 0 8.5 11h-2zM11 12.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5h-2a1.5 1.5 0 0 1-1.5-1.5v-2z"/></svg>
          Overview
        </a>
        <a href="#" onclick="showPage('projects')">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707l-6.45 6.449a.5.5 0 0 1-.354.147H2.5a.5.5 0 0 1-.5-.5v-5.65a.5.5 0 0 1 .146-.354l6.449-6.45a.5.5 0 0 1 .233-.145z"/></svg>
          Projects
        </a>
        <a href="#" onclick="showPage('domains')">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V4Zm2-1a1 1 0 0 0-1 1v.217l7 4.2 7-4.2V4a1 1 0 0 0-1-1H2Zm13 2.383-4.708 2.825L15 11.105V5.383Zm-.034 6.876-5.64-3.471L8 9.583l-1.326-.795-5.64 3.47A1 1 0 0 0 2 13h12a1 1 0 0 0 .966-.741ZM1 11.105l4.708-2.897L1 5.383v5.722Z"/></svg>
          Domain
        </a>
        <a href="#" onclick="showPage('secrets')">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a2 2 0 0 1 2 2v4H6V3a2 2 0 0 1 2-2zm3 6V3a3 3 0 0 0-6 0v4a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/></svg>
          Secrets
        </a>
        <a href="#" onclick="showPage('database')">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9zM2.5 3a.5.5 0 0 0-.5.5V6h12V3.5a.5.5 0 0 0-.5-.5h-11zm12 4H2v5.5a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5V7z"/></svg>
          Database
        </a>
        <a href="#" onclick="showPage('logs')">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 1a2 2 0 0 0-2 2v1h10V3a2 2 0 0 0-2-2H5zm6 8H5a1 1 0 0 0 0 2h6a1 1 0 0 0 0-2z"/><path d="M0 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1v-1a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v1H2a2 2 0 0 1-2-2V7z"/></svg>
          Logs
        </a>
        <a href="#" onclick="showPage('account')">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4Zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.289 10 8 10c-2.29 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h10Z"/></svg>
          Akun
        </a>
      </nav>
      <div class="sidebar-footer">
        <button type="button" class="btn btn-danger" onclick="doLogout()">Keluar</button>
      </div>
      </div>
    </div>

    <main class="main">
      <!-- OVERVIEW -->
      <div id="page-overview" class="page active">
        <h2>Overview</h2>
        <div class="grid" id="sys-stats"></div>
        <div class="card">
          <h3 style="margin-bottom:16px;font-size:15px;">Running Projects</h3>
          <div class="table-scroll">
          <table><thead><tr><th>App</th><th>Status</th><th>Port</th><th>Domain</th><th>CPU</th><th>RAM</th><th>Actions</th></tr></thead>
          <tbody id="overview-table"><tr><td colspan="7" style="color:var(--muted);text-align:center;">Loading...</td></tr></tbody></table>
          </div>
        </div>
      </div>

      <!-- PROJECTS -->
      <div id="page-projects" class="page">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
          <h2 style="margin:0;">Projects</h2>
          <button class="btn btn-primary" onclick="showInstallModal()">+ Install Project</button>
        </div>
        <div id="projects-list"></div>
      </div>

      <!-- DOMAINS -->
      <div id="page-domains" class="page">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:16px;margin-bottom:20px;">
          <div>
            <h2 style="margin:0 0 8px 0;">Domain &amp; SSL</h2>
            <p style="color:var(--muted);font-size:13px;max-width:560px;line-height:1.5;margin:0;">Kelola hostname nginx terpisah dari nama folder project. Arahkan ke <strong>project</strong> (port dari .env) atau ke <strong>port</strong> tetap. SSL memakai Let&apos;s Encrypt; perpanjangan mengikuti timer <code style="background:var(--bg3);padding:2px 6px;border-radius:4px;">certbot.timer</code>.</p>
          </div>
          <div style="display:flex;flex-direction:column;gap:10px;align-items:flex-end;">
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text);cursor:pointer;">
              <input type="checkbox" id="certbot-autorenew-global" style="width:auto;" onchange="toggleCertbotAutoRenew(event)" />
              Auto-renew SSL (aktifkan timer certbot)
            </label>
            <span id="certbot-timer-status" style="font-size:12px;color:var(--muted);"></span>
            <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;">
              <button type="button" class="btn" onclick="importExistingDomains(event)" title="Baca /etc/nginx/sites-enabled">Impor dari nginx</button>
              <button type="button" class="btn btn-primary" onclick="showDomainModal(null)">+ Tambah domain</button>
            </div>
          </div>
        </div>
        <div class="card" style="padding:0;overflow:hidden;">
          <div class="table-scroll">
          <table style="margin:0;">
            <thead><tr><th style="padding-left:18px;">Host</th><th>Pointing</th><th>Port</th><th>SSL</th><th>Kadaluarsa</th><th style="text-align:right;padding-right:18px;">Aksi</th></tr></thead>
            <tbody id="domains-table-body"><tr><td colspan="6" style="padding:24px;color:var(--muted);text-align:center;">Memuat…</td></tr></tbody>
          </table>
          </div>
        </div>
      </div>

      <!-- SECRETS -->
      <div id="page-secrets" class="page">
        <h2>Secrets / Env Variables</h2>
        <div class="form-row" style="max-width:320px;">
          <label>Pilih Project</label>
          <select id="secrets-project-select" onchange="loadSecrets()">
            <option value="">-- pilih project --</option>
          </select>
        </div>
        <div id="secrets-panel"></div>
      </div>

      <!-- DATABASE -->
      <div id="page-database" class="page">
        <div id="db-view-list">
          <div class="db-toolbar">
            <div>
              <h2>Database</h2>
              <p class="db-sub">PostgreSQL di VPS ini. Pilih database untuk jelajah data, impor, dan cadangan. Daftar mengikuti hak CONNECT role <code style="background:var(--bg3);padding:2px 6px;border-radius:4px;">${PG_USER}</code>; database baru dibuat otomatis saat impor jika role punya CREATEDB.</p>
            </div>
            <div class="db-toolbar-actions">
              <button type="button" class="btn" onclick="showDbImportGoModal()">Impor data</button>
              <button type="button" class="btn btn-primary" onclick="showDbCreateModal()">+ Database</button>
            </div>
          </div>
          <div class="card" id="db-list-status" style="padding:14px 18px;">
            <div style="font-size:13px;color:var(--muted);">Memuat…</div>
          </div>
          <div class="card" style="padding:0;overflow:hidden;">
            <table class="db-list-table">
              <thead><tr><th style="padding-left:18px;">Nama</th><th>Catatan</th><th style="text-align:right;padding-right:18px;width:200px;">Aksi</th></tr></thead>
              <tbody id="db-list-body"><tr><td colspan="3" style="padding:20px;color:var(--muted);text-align:center;">Memuat daftar…</td></tr></tbody>
            </table>
          </div>
        </div>
        <div id="db-view-detail" style="display:none;">
          <div class="db-detail-top">
            <button type="button" class="btn btn-sm" onclick="backToDatabaseList()">← Kembali</button>
            <span class="db-detail-breadcrumb">Database <span style="color:var(--muted);">/</span> <strong id="db-detail-breadcrumb-db"></strong></span>
            <div style="margin-left:auto;" class="btn-group">
              <button type="button" class="btn btn-sm btn-primary" onclick="exportLocalDatabase(dbDetailName)">Export .sql</button>
            </div>
          </div>
          <div class="db-tab-strip">
            <div class="tab active" id="db-tab-browse" onclick="switchDbDetailTab('browse')">Jelajah data</div>
            <div class="tab" id="db-tab-import" onclick="switchDbDetailTab('import')">Impor &amp; sinkron</div>
            <div class="tab" id="db-tab-dumps" onclick="switchDbDetailTab('dumps')">File dump</div>
          </div>
          <div class="db-panel-stack">
            <div id="db-panel-browse" class="card">
              <p style="color:var(--muted);font-size:12px;margin-bottom:14px;">Baca saja — pilih schema dan tabel; maks. 200 baris per halaman. Tanpa SQL bebas.</p>
              <input type="hidden" id="db-browse-db" value="" />
              <div class="form-grid" style="max-width:480px;">
                <div class="form-row">
                  <label>Schema</label>
                  <select id="db-browse-schema" onchange="onBrowseSchemaChange()"><option value="">—</option></select>
                </div>
              </div>
              <div id="db-browse-tables" style="margin:12px 0;font-size:13px;"></div>
              <div id="db-browse-meta" style="color:var(--muted);font-size:12px;margin-bottom:8px;"></div>
              <div style="overflow-x:auto;max-width:100%;border:1px solid var(--border);border-radius:8px;">
                <table id="db-browse-rows-table" style="display:none;width:100%;font-size:12px;"></table>
              </div>
              <div class="btn-group" id="db-browse-pager" style="margin-top:12px;display:none;">
                <button type="button" class="btn btn-sm" onclick="browseRowsPrev()">Sebelumnya</button>
                <button type="button" class="btn btn-sm" onclick="browseRowsNext()">Berikutnya</button>
              </div>
            </div>
            <div id="db-panel-import" class="card db-hidden">
              <p style="color:var(--muted);font-size:12px;margin-bottom:14px;">Target: <code id="db-detail-target-label"></code> · Database kosong akan dibuat otomatis bila perlu.</p>
              <input type="hidden" id="db-import-target" value="" />
              <input type="hidden" id="db-sync-target" value="" />
              <h4 style="font-size:14px;margin-bottom:10px;font-weight:600;">Import dari teks SQL</h4>
              <p style="color:var(--muted);font-size:12px;margin-bottom:10px;">Untuk file sangat besar gunakan SSH + <code style="background:var(--bg3);padding:2px 6px;border-radius:4px;">psql -f</code>.</p>
              <div class="form-row">
                <label>SQL</label>
                <textarea id="db-import-sql" rows="7" placeholder="-- SQL statements"></textarea>
              </div>
              <button type="button" class="btn btn-primary" id="db-btn-import-sql" onclick="importSqlFromText()">Jalankan import</button>
              <hr style="border:none;border-top:1px solid var(--border);margin:22px 0;" />
              <h4 style="font-size:14px;margin-bottom:10px;font-weight:600;">Sinkron dari URL remote (Neon / Postgres)</h4>
              <p style="color:var(--muted);font-size:12px;margin-bottom:10px;">Connection string lengkap, contoh: <code style="background:var(--bg3);padding:2px 6px;border-radius:4px;">postgresql://user:pass@host/db?sslmode=require</code></p>
              <div class="form-row">
                <label>Connection URL</label>
                <input id="db-remote-url" type="password" autocomplete="off" placeholder="postgresql://..." />
              </div>
              <div class="form-row" style="display:flex;align-items:center;gap:8px;">
                <input type="checkbox" id="db-sync-reset" style="width:auto;" />
                <label for="db-sync-reset" style="margin:0;">Reset schema public dulu (DROP SCHEMA … CASCADE — berbahaya)</label>
              </div>
              <button type="button" class="btn btn-primary" id="db-btn-sync-remote" onclick="syncFromRemoteUrl()">Sinkronkan ke database ini</button>
              <div id="db-import-job-status" class="db-job-status db-hidden" role="status" aria-live="polite"></div>
            </div>
            <div id="db-panel-dumps" class="card db-hidden">
              <p style="color:var(--muted);font-size:12px;margin-bottom:12px;">File <code>.sql</code> di folder cadangan server. <strong>Apply</strong> mengeksekusi ke database yang sedang dibuka.</p>
              <button type="button" class="btn btn-sm" onclick="refreshDumpList()" style="margin-bottom:12px;">Refresh daftar</button>
              <div id="db-dumps-list" style="font-size:13px;color:var(--muted);">Memuat…</div>
            </div>
          </div>
        </div>
      </div>

      <!-- LOGS -->
      <div id="page-logs" class="page">
        <h2>Logs</h2>
        <div style="display:flex;gap:12px;margin-bottom:16px;align-items:flex-end;">
          <div style="flex:1;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px;">Project</label>
            <select id="logs-project-select"><option value="">-- pilih project --</option></select></div>
          <div><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px;">Baris</label>
            <select id="logs-lines"><option>50</option><option>100</option><option>200</option></select></div>
          <button class="btn btn-primary" onclick="loadLogs()">Load Logs</button>
        </div>
        <div class="logs-box" id="logs-output">Pilih project dan klik Load Logs.</div>
      </div>

      <!-- ACCOUNT -->
      <div id="page-account" class="page">
        <h2>Pengaturan Akun</h2>
        <div class="card account-card">
          <h3 style="margin-bottom:16px;font-size:15px;">Ubah sandi dashboard</h3>
          <p style="color:var(--muted);font-size:13px;line-height:1.5;margin-bottom:18px;">Sandi baru disimpan di server dan dipakai untuk login berikutnya.</p>
          <div class="form-row"><label>Sandi saat ini</label><input type="password" id="account-current-pass" autocomplete="current-password" /></div>
          <div class="form-row"><label>Sandi baru</label><input type="password" id="account-new-pass" autocomplete="new-password" /></div>
          <div class="form-row"><label>Ulangi sandi baru</label><input type="password" id="account-confirm-pass" autocomplete="new-password" /></div>
          <div id="account-pass-err" style="color:var(--red);font-size:12px;margin-bottom:12px;"></div>
          <button type="button" class="btn btn-primary" onclick="changeAccountPassword(event)">Simpan sandi</button>
        </div>
      </div>
    </main>
  </div>
</div>

<!-- INSTALL MODAL -->
<div id="install-modal" class="modal-bg" style="display:none;" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <h3>Install Project Baru</h3>
    <div class="form-row"><label>GitHub Repo URL *</label><input id="i-repo" placeholder="https://github.com/username/repo.git" /></div>
    <div class="form-grid">
      <div class="form-row"><label>Nama App *</label><input id="i-name" placeholder="my-app" /></div>
      <div class="form-row"><label>Port *</label><input id="i-port" placeholder="3001" type="number" /></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Domain (opsional)</label><input id="i-domain" placeholder="app.domain.com" /></div>
      <div class="form-row"><label>Branch</label><input id="i-branch" placeholder="main" value="main" /></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn" onclick="closeModal()">Batal</button>
      <button class="btn btn-primary" onclick="installProject(event)">Install</button>
    </div>
    <div id="install-progress" style="display:none;margin-top:16px;">
      <div style="color:var(--muted);font-size:12px;">Menginstall...</div>
      <div class="progress-bar"><div class="progress-fill" style="width:60%;"></div></div>
    </div>
  </div>
</div>

<!-- UNINSTALL VERIFY MODAL -->
<div id="uninstall-verify-modal" class="modal-bg" style="display:none;z-index:110;" onclick="if(event.target===this)closeUninstallVerifyModal()">
  <div class="modal" onclick="event.stopPropagation()">
    <h3>Konfirmasi Uninstall</h3>
    <p style="color:var(--muted);font-size:13px;margin-bottom:14px;line-height:1.5;">
      Anda akan menghapus project <strong id="uninstall-verify-project"></strong> beserta datanya. Tindakan ini tidak dapat dibatalkan.
    </p>
    <p style="font-size:13px;margin-bottom:8px;">Ketik <strong>lima angka</strong> berikut untuk melanjutkan:</p>
    <div id="uninstall-verify-chip" class="uninstall-verify-code" style="margin-bottom:16px;"></div>
    <div class="form-row">
      <label>Kode verifikasi</label>
      <input id="uninstall-verify-input" type="text" inputmode="numeric" maxlength="5" placeholder="00000" autocomplete="off" oninput="onUninstallVerifyInput()" />
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">
      <button type="button" class="btn" onclick="closeUninstallVerifyModal()">Batal</button>
      <button type="button" class="btn btn-danger" id="uninstall-confirm-btn" disabled onclick="confirmUninstallProject()">Uninstall</button>
    </div>
  </div>
</div>

<!-- DOMAIN MODAL -->
<div id="domain-modal" class="modal-bg" style="display:none;z-index:105;" onclick="if(event.target===this)closeDomainModal()">
  <div class="modal" onclick="event.stopPropagation()" style="max-width:520px;">
    <h3 id="domain-modal-title">Tambah domain</h3>
    <input type="hidden" id="domain-edit-id" value="" />
    <div class="form-row"><label>Hostname</label><input id="domain-input-host" placeholder="app.example.com" autocomplete="off" /></div>
    <div class="form-row"><label>Pointing</label>
      <select id="domain-input-target-type" onchange="onDomainTargetTypeChange()">
        <option value="project">Ke project (port dari .env)</option>
        <option value="port">Ke port manual</option>
      </select>
    </div>
    <div class="form-row" id="domain-row-project"><label>Project</label><select id="domain-input-project"></select></div>
    <div class="form-row" id="domain-row-port" style="display:none;"><label>Port lokal</label><input id="domain-input-port" type="number" min="1" max="65535" placeholder="3002" /></div>
    <div class="form-row" style="display:flex;align-items:center;gap:8px;">
      <input type="checkbox" id="domain-input-ssl" style="width:auto;" />
      <label for="domain-input-ssl" style="margin:0;">Pasang / perbarui SSL (Let&apos;s Encrypt)</label>
    </div>
    <div class="form-row" style="display:flex;align-items:center;gap:8px;">
      <input type="checkbox" id="domain-input-autorenew" style="width:auto;" checked />
      <label for="domain-input-autorenew" style="margin:0;">Segera aktifkan auto-renew global (certbot.timer)</label>
    </div>
    <p style="font-size:12px;color:var(--muted);line-height:1.5;">DNS A/AAAA host harus sudah mengarah ke VPS sebelum pasang SSL.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
      <button type="button" class="btn" onclick="closeDomainModal()">Batal</button>
      <button type="button" class="btn btn-primary" onclick="saveDomainModal(event)">Simpan</button>
    </div>
  </div>
</div>

<!-- PROJECT SETTINGS MODAL -->
<div id="project-settings-modal" class="modal-bg" style="display:none;z-index:105;" onclick="if(event.target===this)closeProjectSettingsModal()">
  <div class="modal" onclick="event.stopPropagation()" style="max-width:480px;">
    <h3>Pengaturan project</h3>
    <input type="hidden" id="ps-current-name" value="" />
    <div class="form-row"><label>Nama folder / PM2 (ubah hati-hati)</label><input id="ps-new-name" placeholder="nama-baru" autocomplete="off" /></div>
    <p style="font-size:11px;color:var(--muted);margin:-8px 0 12px 0;">Kosongkan untuk tidak mengganti nama. Hanya huruf, angka, <code>.</code> <code>_</code> <code>-</code>.</p>
    <div class="form-row"><label>Domain (nginx project)</label><input id="ps-domain" placeholder="app.example.com" autocomplete="off" /></div>
    <p style="font-size:11px;color:var(--muted);margin:-8px 0 12px 0;">Kosongkan untuk menghapus site nginx project ini. SSL terpasang lewat menu Domain.</p>
    <div class="form-row"><label>Port</label><input id="ps-port" type="number" min="1" max="65535" /></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
      <button type="button" class="btn" onclick="closeProjectSettingsModal()">Batal</button>
      <button type="button" class="btn btn-primary" onclick="saveProjectSettings(event)">Simpan</button>
    </div>
  </div>
</div>

<div id="db-modal-create" class="modal-bg" style="display:none;" onclick="if(event.target===this)closeDbCreateModal()">
  <div class="modal" onclick="event.stopPropagation()">
    <h3>Database baru</h3>
    <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">Nama: huruf, angka, underscore. Owner: <code style="background:var(--bg3);padding:2px 6px;border-radius:4px;">${PG_USER}</code>.</p>
    <div class="form-row">
      <label>Nama database</label>
      <input id="db-create-name" placeholder="financeapp" autocomplete="off" />
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">
      <button type="button" class="btn" onclick="closeDbCreateModal()">Batal</button>
      <button type="button" class="btn btn-primary" onclick="createEmptyLocalDatabase()">Buat</button>
    </div>
  </div>
</div>

<div id="db-modal-import-go" class="modal-bg" style="display:none;" onclick="if(event.target===this)closeDbImportGoModal()">
  <div class="modal" onclick="event.stopPropagation()">
    <h3>Impor data</h3>
    <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">Pilih database lokal sebagai target, lalu isi formulir impor atau URL remote.</p>
    <div class="form-row">
      <label>Database target</label>
      <select id="db-import-go-select"></select>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">
      <button type="button" class="btn" onclick="closeDbImportGoModal()">Batal</button>
      <button type="button" class="btn btn-primary" onclick="confirmDbImportGo()">Lanjut</button>
    </div>
  </div>
</div>

<script>
let token = localStorage.getItem('vps_token');
let projects = [];
let uninstallVerifyCode = '';
let uninstallPendingName = '';

function api(method, path, body) {
  return fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) {
      doLogout(false);
      throw new Error(data.error || 'Sesi berakhir');
    }
    return data;
  });
}

function toggleMobileNav() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}

function closeMobileNav() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

function doLogout(showToast) {
  token = null;
  localStorage.removeItem('vps_token');
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('login-screen').style.display = 'block';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-err').textContent = '';
  closeMobileNav();
  if (showToast !== false) toast('Anda telah keluar');
}

function toast(msg, type='success', ms) {
  const dur = typeof ms === 'number' ? ms : (type === 'error' ? 5000 : 3200);
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), dur);
}

function resolveActionButton(ev) {
  if (!ev) return null;
  const el = ev.target && ev.target.closest ? ev.target.closest('button') : null;
  return el || (ev.currentTarget && ev.currentTarget.tagName === 'BUTTON' ? ev.currentTarget : null);
}

async function withButtonBusy(button, work) {
  if (!button) {
    return work();
  }
  if (button.disabled || button.classList.contains('is-busy')) return;
  button.classList.add('is-busy');
  button.disabled = true;
  try {
    return await work();
  } finally {
    button.classList.remove('is-busy');
    button.disabled = false;
  }
}

function setImportPanelBusy(busy) {
  ['db-btn-import-sql', 'db-btn-sync-remote'].forEach(function(id) {
    var b = document.getElementById(id);
    if (b) b.disabled = !!busy;
  });
  var sql = document.getElementById('db-import-sql');
  var url = document.getElementById('db-remote-url');
  var reset = document.getElementById('db-sync-reset');
  if (sql) sql.disabled = !!busy;
  if (url) url.disabled = !!busy;
  if (reset) reset.disabled = !!busy;
}

function showDbJobIdle() {
  var el = document.getElementById('db-import-job-status');
  if (!el) return;
  el.classList.add('db-hidden');
  el.classList.remove('db-job-ok', 'db-job-err');
  el.innerHTML = '';
}

function showDbJobRunning(htmlInner) {
  var el = document.getElementById('db-import-job-status');
  if (!el) return;
  el.classList.remove('db-hidden', 'db-job-ok', 'db-job-err');
  el.innerHTML = htmlInner;
}

function showDbJobFinished(ok, htmlInner) {
  var el = document.getElementById('db-import-job-status');
  if (!el) return;
  el.classList.remove('db-hidden');
  el.classList.toggle('db-job-ok', !!ok);
  el.classList.toggle('db-job-err', !ok);
  el.innerHTML = htmlInner;
}

async function doLogin(ev) {
  await withButtonBusy(resolveActionButton(ev), async () => {
    const pass = document.getElementById('login-pass').value;
    const res = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:pass}) });
    const data = await res.json();
    if (data.token) {
      token = data.token;
      localStorage.setItem('vps_token', token);
      initDashboard();
    } else {
      document.getElementById('login-err').textContent = 'Password salah!';
    }
  });
}

document.getElementById('login-pass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  const navLink = document.querySelector('.nav a[onclick*="' + name + '"]');
  if (navLink) navLink.classList.add('active');
  closeMobileNav();
  if(name==='projects') loadProjects();
  if(name==='domains') loadDomainsPage();
  if(name==='secrets') loadSecretsPage();
  if(name==='logs') loadLogsPage();
  if(name==='database') loadDatabasePage();
}

async function changeAccountPassword(ev) {
  const errEl = document.getElementById('account-pass-err');
  errEl.textContent = '';
  const currentPassword = document.getElementById('account-current-pass').value;
  const newPassword = document.getElementById('account-new-pass').value;
  const confirmPassword = document.getElementById('account-confirm-pass').value;
  if (!currentPassword || !newPassword) {
    errEl.textContent = 'Isi sandi saat ini dan sandi baru.';
    return;
  }
  if (newPassword.length < 6) {
    errEl.textContent = 'Sandi baru minimal 6 karakter.';
    return;
  }
  if (newPassword !== confirmPassword) {
    errEl.textContent = 'Konfirmasi sandi tidak cocok.';
    return;
  }
  await withButtonBusy(resolveActionButton(ev), async () => {
    const data = await api('PUT', '/account/password', { currentPassword, newPassword });
    if (data.error) {
      errEl.textContent = data.error;
      return;
    }
    document.getElementById('account-current-pass').value = '';
    document.getElementById('account-new-pass').value = '';
    document.getElementById('account-confirm-pass').value = '';
    toast('Sandi berhasil diubah');
  });
}

function statusBadge(s) {
  const map = {online:'badge-green',stopped:'badge-red',errored:'badge-red',stopping:'badge-yellow'};
  return \`<span class="badge \${map[s]||'badge-yellow'}">\${s}</span>\`;
}

function fmtBytes(b) {
  if(!b) return '-';
  return (b/1024/1024).toFixed(1)+' MB';
}

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime())
    ? String(v).slice(0, 16)
    : d.toLocaleString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

function projectDateLine(p) {
  const parts = [];
  if (p.installedAt) parts.push('installed ' + fmtDate(p.installedAt));
  if (p.updatedAt) parts.push('updated ' + fmtDate(p.updatedAt));
  return parts.length ? ' &nbsp;·&nbsp; ' + parts.join(' &nbsp;·&nbsp; ') : '';
}

function closeProjectMenus(except) {
  document.querySelectorAll('.project-actions.open').forEach(function(el) {
    if (!except || el !== except) el.classList.remove('open');
  });
}

function toggleProjectMenu(id, ev) {
  if (ev) ev.stopPropagation();
  const box = document.getElementById(id);
  if (!box) return;
  const willOpen = !box.classList.contains('open');
  closeProjectMenus(box);
  box.classList.toggle('open', willOpen);
}

document.addEventListener('click', function(ev) {
  if (!ev.target.closest || !ev.target.closest('.project-actions')) closeProjectMenus();
});

function projectActionMenu(p, idx) {
  const menuId = 'project-actions-' + idx;
  const nameArg = jsQuoted(p.name);
  const cicdItem = p.cicdEnabled
    ? '<span class="project-menu-note">CI/CD aktif</span>'
    : '<button type="button" class="project-menu-item" onclick="enableProjectCicd(' + nameArg + ', event)">Aktifkan CI/CD</button>';
  return '<div class="project-actions" id="' + menuId + '">' +
    '<button type="button" class="btn project-menu-btn" aria-label="Aksi project ' + escapeHtmlAttr(p.name) + '" onclick="toggleProjectMenu(' + jsQuoted(menuId) + ', event)">...</button>' +
    '<div class="project-menu">' +
      '<button type="button" class="project-menu-item" onclick="showPage(\\'secrets\\');document.getElementById(\\'secrets-project-select\\').value=' + nameArg + ';loadSecrets()">Secrets</button>' +
      '<button type="button" class="project-menu-item" onclick="openProjectSettings(' + nameArg + ')">Pengaturan</button>' +
      cicdItem +
      '<button type="button" class="project-menu-item" onclick="deployApp(' + nameArg + ', event)">Deploy</button>' +
      '<button type="button" class="project-menu-item" onclick="restartApp(' + nameArg + ', event)">Restart</button>' +
      '<button type="button" class="project-menu-item" onclick="showLogs(' + nameArg + ')">Logs</button>' +
      '<button type="button" class="project-menu-item btn-danger" onclick="uninstallApp(' + nameArg + ')">Uninstall</button>' +
    '</div>' +
  '</div>';
}

async function loadOverview() {
  const [sys, projs] = await Promise.all([api('GET','/system'), api('GET','/projects')]);
  projects = projs;

  document.getElementById('vps-ip').textContent = window.location.hostname;

  const onlineCount = projs.filter(p => p.status==='online').length;
  document.getElementById('sys-stats').innerHTML = \`
    <div class="stat"><div class="stat-label">CPU Usage</div><div class="stat-value" style="color:var(--\${sys.cpu>80?'red':sys.cpu>50?'yellow':'green'})">\${Math.round(sys.cpu)}%</div></div>
    <div class="stat"><div class="stat-label">RAM Used</div><div class="stat-value">\${sys.memUsed} <span style="font-size:14px;color:var(--muted)">/ \${sys.memTotal} MB</span></div></div>
    <div class="stat"><div class="stat-label">Disk Used</div><div class="stat-value">\${sys.diskUsed} <span style="font-size:14px;color:var(--muted)">/ \${sys.diskTotal}</span></div></div>
    <div class="stat"><div class="stat-label">Apps Running</div><div class="stat-value" style="color:var(--green)">\${onlineCount} <span style="font-size:14px;color:var(--muted)">/ \${projs.length}</span></div></div>
  \`;

  document.getElementById('overview-table').innerHTML = projs.length === 0
    ? '<tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px;">Belum ada project</td></tr>'
    : projs.map(p => \`<tr>
      <td style="font-weight:500;">\${p.name}</td>
      <td>\${statusBadge(p.status)}</td>
      <td><span class="chip">:\${p.port}</span></td>
      <td style="color:var(--blue);">\${p.domain ? '<a href="http://'+p.domain+'" target="_blank" style="color:var(--blue);text-decoration:none;">'+p.domain+'</a>' : '<span style="color:var(--muted)">-</span>'}</td>
      <td>\${p.cpu.toFixed(1)}%</td>
      <td>\${fmtBytes(p.memory)}</td>
      <td><div class="btn-group">
        <button class="btn btn-sm" onclick="deployApp('\${p.name}', event)">Deploy</button>
        <button class="btn btn-sm" onclick="restartApp('\${p.name}', event)">Restart</button>
      </div></td>
    </tr>\`).join('');
}

async function loadProjects() {
  const projs = await api('GET','/projects');
  projects = projs;
  document.getElementById('projects-list').innerHTML = projs.length === 0
    ? '<div style="color:var(--muted);text-align:center;padding:40px;">Belum ada project. Klik "Install Project" untuk mulai.</div>'
    : projs.map((p, idx) => \`
      <div class="card project-list-card" style="margin-bottom:12px;">
          <div class="project-info">
            <div class="project-title-row">
              <span class="project-name">\${escapeHtmlAttr(p.name)}</span>
              \${statusBadge(p.status)}
              <span class="chip">:\${p.port}</span>
            </div>
            <div class="project-meta">
              \${p.repo ? '<a href="'+p.repo+'" target="_blank" style="color:var(--blue);text-decoration:none;">'+p.repo.replace('https://github.com/','')+'</a>' : '-'}
              \${p.domain ? ' &nbsp;·&nbsp; <a href="http://'+p.domain+'" target="_blank" style="color:var(--blue);text-decoration:none;">'+p.domain+'</a>' : ''}
              \${projectDateLine(p)}
            </div>
          </div>
          \${projectActionMenu(p, idx)}
      </div>
    \`).join('');
}

let domainsListCache = [];

function fillDomainProjectSelect() {
  const sel = document.getElementById('domain-input-project');
  sel.innerHTML = (projects || []).map(p => '<option value="' + escapeHtmlAttr(p.name) + '">' + escapeHtmlAttr(p.name) + ' (:' + escapeHtmlAttr(String(p.port)) + ')</option>').join('');
}

function escapeHtmlAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

function jsQuoted(s) {
  return "'" + String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'") + "'";
}

function onDomainTargetTypeChange() {
  const t = document.getElementById('domain-input-target-type').value;
  document.getElementById('domain-row-project').style.display = t === 'project' ? 'block' : 'none';
  document.getElementById('domain-row-port').style.display = t === 'port' ? 'block' : 'none';
}

function closeDomainModal() {
  document.getElementById('domain-modal').style.display = 'none';
}

function showDomainModal(editId) {
  fillDomainProjectSelect();
  document.getElementById('domain-edit-id').value = editId || '';
  document.getElementById('domain-modal-title').textContent = editId ? 'Ubah domain' : 'Tambah domain';
  if (editId) {
    const d = domainsListCache.find(x => x.id === editId);
    if (!d) { toast('Domain tidak ditemukan','error'); return; }
    document.getElementById('domain-input-host').value = d.host;
    if (d.target && d.target.type === 'project') {
      document.getElementById('domain-input-target-type').value = 'project';
      document.getElementById('domain-input-project').value = d.target.project || '';
    } else {
      document.getElementById('domain-input-target-type').value = 'port';
      document.getElementById('domain-input-port').value = d.target && d.target.port ? d.target.port : '';
    }
    document.getElementById('domain-input-ssl').checked = !!d.ssl;
    document.getElementById('domain-input-autorenew').checked = d.sslAutoRenew !== false;
  } else {
    document.getElementById('domain-input-host').value = '';
    document.getElementById('domain-input-target-type').value = 'project';
    document.getElementById('domain-input-port').value = '';
    document.getElementById('domain-input-ssl').checked = false;
    document.getElementById('domain-input-autorenew').checked = true;
  }
  onDomainTargetTypeChange();
  document.getElementById('domain-modal').style.display = 'flex';
}

async function saveDomainModal(ev) {
  const id = document.getElementById('domain-edit-id').value;
  const host = document.getElementById('domain-input-host').value.trim();
  const tt = document.getElementById('domain-input-target-type').value;
  const body = {
    host,
    targetType: tt,
    targetProject: document.getElementById('domain-input-project').value,
    targetPort: document.getElementById('domain-input-port').value,
    ssl: document.getElementById('domain-input-ssl').checked,
    sslAutoRenew: document.getElementById('domain-input-autorenew').checked,
  };
  await withButtonBusy(resolveActionButton(ev), async () => {
    try {
      if (id) {
        const res = await api('PUT', '/domains/' + encodeURIComponent(id), body);
        if (res.error) { toast(res.error, 'error'); return; }
      } else {
        const res = await api('POST', '/domains', body);
        if (res.error) { toast(res.error, 'error'); return; }
      }
      if (body.sslAutoRenew) {
        await api('PUT', '/settings/certbot-autorenew', { enabled: true });
      }
      toast('Domain disimpan');
      closeDomainModal();
      loadDomainsPage();
    } catch (e) { toast('Gagal simpan domain', 'error'); }
  });
}

async function loadDomainsPage() {
  const data = await api('GET', '/domains');
  domainsListCache = data.domains || [];
  const timer = data.certbotTimer || {};
  document.getElementById('certbot-autorenew-global').checked = !!(data.certbotAutoRenew && timer.timerEnabled);
  document.getElementById('certbot-timer-status').textContent =
    'Timer: ' + (timer.timerEnabled ? 'enabled' : 'disabled') + ' · ' + (timer.timerActive ? 'aktif' : 'tidak aktif');
  const tb = document.getElementById('domains-table-body');
  if (!domainsListCache.length) {
    tb.innerHTML = '<tr><td colspan="6" style="padding:24px;color:var(--muted);text-align:center;">Belum ada domain. Tambahkan untuk pointing & SSL terkelola.</td></tr>';
    return;
  }
  tb.innerHTML = domainsListCache.map(d => {
    const extBadge = d.externalNginx
      ? '<div style="margin-bottom:4px;"><span class="badge badge-yellow" title="Konfigurasi di /etc/nginx/sites-available">nginx: ' + escapeHtmlAttr(d.externalSite || 'manual') + '</span></div>'
      : '';
    const pt = d.target && d.target.type === 'project'
      ? 'Project: <strong>' + escapeHtmlAttr(d.target.project) + '</strong>'
      : 'Port: <strong>:' + (d.target && d.target.port) + '</strong>';
    const exp = d.sslExpiry ? new Date(d.sslExpiry).toLocaleString() : (d.ssl ? '—' : 'HTTP saja');
    const sslLabel = d.sslActive ? '<span class="badge badge-green">HTTPS</span>' : (d.ssl ? '<span class="badge badge-yellow">Belum terpasang</span>' : '<span class="badge badge-yellow">HTTP</span>');
    return '<tr><td style="padding-left:18px;font-weight:500;">' + escapeHtmlAttr(d.host) + '</td><td>' + extBadge + pt + '</td><td><span class="chip">:' + (d.resolvedPort || '?') + '</span></td><td>' + sslLabel + '</td><td style="font-size:12px;color:var(--muted);">' + exp + '</td><td style="text-align:right;padding-right:18px;"><div class="btn-group">' +
      '<button type="button" class="btn btn-sm" onclick="showDomainModal(' + jsQuoted(d.id) + ')">Edit</button>' +
      '<button type="button" class="btn btn-sm btn-primary" onclick="installSslDomain(' + jsQuoted(d.id) + ', event)">SSL</button>' +
      '<button type="button" class="btn btn-sm btn-danger" onclick="deleteDomain(' + jsQuoted(d.id) + ',' + jsQuoted(d.host) + ',' + (d.externalNginx ? 'true' : 'false') + ', event)">Hapus</button>' +
      '</div></td></tr>';
  }).join('');
}

async function importExistingDomains(ev) {
  if (!confirm('Pindai /etc/nginx/sites-enabled dan tambahkan host baru ke daftar?\\n\\nFile site selain vps-domain-* akan ditandai sebagai nginx manual (panel tidak menghapus berkas nginx saat Hapus).')) return;
  await withButtonBusy(resolveActionButton(ev), async () => {
    try {
      const res = await api('POST', '/domains/import-existing', {});
      if (res.error) { toast(res.error, 'error'); return; }
      const n = (res.added || []).length;
      const sk = (res.skipped || []).length;
      toast('Impor: +' + n + ' domain, lewati ' + sk + ' (sudah ada)');
      loadDomainsPage();
    } catch (e) { toast('Impor gagal', 'error'); }
  });
}

async function toggleCertbotAutoRenew(ev) {
  const on = document.getElementById('certbot-autorenew-global').checked;
  const input = ev && ev.target ? ev.target : document.getElementById('certbot-autorenew-global');
  if (input) input.disabled = true;
  try {
    const res = await api('PUT', '/settings/certbot-autorenew', { enabled: on });
    if (res.error) { toast(res.error, 'error'); return; }
    toast(on ? 'Auto-renew diaktifkan' : 'Auto-renew dimatikan');
    loadDomainsPage();
  } catch (e) {
    toast('Gagal ubah timer certbot (perlu sudo)', 'error');
    loadDomainsPage();
  } finally {
    if (input) input.disabled = false;
  }
}

async function installSslDomain(id, ev) {
  await withButtonBusy(resolveActionButton(ev), async () => {
    try {
      const res = await api('POST', '/domains/' + encodeURIComponent(id) + '/ssl');
      if (res.error) { toast(res.error, 'error', 8000); return; }
      toast('SSL terpasang');
      loadDomainsPage();
    } catch (e) { toast(e.message || 'SSL gagal', 'error', 8000); }
  });
}

async function deleteDomain(id, hostHint, externalOnly, ev) {
  const msg = externalOnly
    ? 'Hapus "' + (hostHint || id) + '" dari daftar panel saja? Berkas nginx & sertifikat di server tidak diubah.'
    : 'Hapus domain ' + (hostHint || id) + '? Nginx & sertifikat terkait akan dihapus.';
  if (!confirm(msg)) return;
  await withButtonBusy(resolveActionButton(ev), async () => {
    try {
      await api('DELETE', '/domains/' + encodeURIComponent(id));
      toast('Domain dihapus');
      loadDomainsPage();
    } catch (e) { toast('Gagal hapus', 'error'); }
  });
}

function openProjectSettings(name) {
  const p = (projects || []).find(x => x.name === name);
  if (!p) { toast('Project tidak ditemukan', 'error'); return; }
  document.getElementById('ps-current-name').value = p.name;
  document.getElementById('ps-new-name').value = '';
  document.getElementById('ps-domain').value = p.domain || '';
  document.getElementById('ps-port').value = p.port || '';
  document.getElementById('project-settings-modal').style.display = 'flex';
}

function closeProjectSettingsModal() {
  document.getElementById('project-settings-modal').style.display = 'none';
}

async function saveProjectSettings(ev) {
  const cur = document.getElementById('ps-current-name').value;
  const newName = document.getElementById('ps-new-name').value.trim();
  const domain = document.getElementById('ps-domain').value.trim();
  const port = document.getElementById('ps-port').value;
  const body = { domain, port };
  if (newName) body.newName = newName;
  await withButtonBusy(resolveActionButton(ev), async () => {
    try {
      const res = await api('PATCH', '/projects/' + encodeURIComponent(cur) + '/settings', body);
      if (res.error) { toast(res.error, 'error'); return; }
      toast('Pengaturan disimpan');
      closeProjectSettingsModal();
      if (res.name && res.name !== cur) {
        toast('Nama project sekarang: ' + res.name);
      }
      loadOverview();
      loadProjects();
      loadDomainsPage();
    } catch (e) { toast('Gagal simpan pengaturan', 'error'); }
  });
}

function showInstallModal() {
  document.getElementById('install-modal').style.display = 'flex';
  // Auto-suggest next port
  const ports = projects.map(p => parseInt(p.port)).filter(Boolean);
  const nextPort = ports.length ? Math.max(...ports) + 1 : 3001;
  document.getElementById('i-port').value = nextPort;
}

function closeModal() { document.getElementById('install-modal').style.display = 'none'; }

// Auto-fill name from URL
document.getElementById('i-repo').addEventListener('blur', function() {
  const url = this.value;
  const match = url.match(/\\\/([^\\\/]+?)(\\.git)?$/);
  if(match && !document.getElementById('i-name').value) {
    document.getElementById('i-name').value = match[1].toLowerCase().replace(/[^a-z0-9-]/g,'-');
  }
});

async function installProject(ev) {
  const body = {
    repoUrl: document.getElementById('i-repo').value.trim(),
    name: document.getElementById('i-name').value.trim(),
    port: document.getElementById('i-port').value,
    domain: document.getElementById('i-domain').value.trim(),
    branch: document.getElementById('i-branch').value.trim() || 'main',
  };
  if(!body.repoUrl || !body.name || !body.port) { toast('Isi semua field wajib!','error'); return; }

  await withButtonBusy(resolveActionButton(ev), async () => {
    document.getElementById('install-progress').style.display = 'block';
    try {
      const res = await api('POST','/projects/install', body);
      if(res.error) { toast(res.error,'error'); }
      else { toast('Project berhasil diinstall!'); closeModal(); loadOverview(); loadProjects(); }
    } catch(e) { toast(e.message || 'Install gagal!', 'error'); }
    document.getElementById('install-progress').style.display = 'none';
  });
}

function closeUninstallVerifyModal() {
  document.getElementById('uninstall-verify-modal').style.display = 'none';
  uninstallPendingName = '';
  uninstallVerifyCode = '';
}

function onUninstallVerifyInput() {
  const input = document.getElementById('uninstall-verify-input');
  const digits = input.value.replace(/\\D/g, '').slice(0, 5);
  if (input.value !== digits) input.value = digits;
  document.getElementById('uninstall-confirm-btn').disabled = digits !== uninstallVerifyCode;
}

function uninstallApp(name) {
  uninstallPendingName = name;
  uninstallVerifyCode = String(Math.floor(10000 + Math.random() * 90000));
  document.getElementById('uninstall-verify-project').textContent = name;
  document.getElementById('uninstall-verify-chip').textContent = uninstallVerifyCode;
  const input = document.getElementById('uninstall-verify-input');
  input.value = '';
  document.getElementById('uninstall-confirm-btn').disabled = true;
  document.getElementById('uninstall-verify-modal').style.display = 'flex';
  setTimeout(() => input.focus(), 50);
}

async function confirmUninstallProject() {
  const name = uninstallPendingName;
  const input = document.getElementById('uninstall-verify-input');
  if (!name || !uninstallVerifyCode || input.value.trim() !== uninstallVerifyCode) return;
  const btn = document.getElementById('uninstall-confirm-btn');
  btn.disabled = true;
  try {
    const data = await api('DELETE', '/projects/' + encodeURIComponent(name));
    if (data && data.error) {
      toast(data.error, 'error');
      btn.disabled = false;
      onUninstallVerifyInput();
      return;
    }
    toast(name + ' berhasil diuninstall!');
    closeUninstallVerifyModal();
    loadOverview();
    loadProjects();
  } catch (e) {
    toast('Uninstall gagal!', 'error');
    btn.disabled = false;
    onUninstallVerifyInput();
  }
}

async function deployApp(name, ev) {
  await withButtonBusy(resolveActionButton(ev), async () => {
    const res = await api('POST',\`/projects/\${name}/deploy\`);
    if(res.error) toast(res.error,'error');
    else { toast(\`\${name} berhasil dideploy!\`); loadOverview(); loadProjects(); }
  });
}

async function enableProjectCicd(name, ev) {
  if (!confirm('Membuat .github/workflows/deploy.yml (dari template manager), lalu git add ., commit, dan push ke remote. Lanjut?')) return;
  await withButtonBusy(resolveActionButton(ev), async () => {
    const data = await api('POST', '/projects/' + encodeURIComponent(name) + '/enable-cicd');
    if (data.error) toast(data.error, 'error');
    else { toast('CI/CD diaktifkan; perubahan sudah di-push.'); loadProjects(); }
  });
}

async function restartApp(name, ev) {
  await withButtonBusy(resolveActionButton(ev), async () => {
    await api('POST',\`/projects/\${name}/restart\`);
    toast(\`\${name} direstart!\`);
    loadOverview();
    loadProjects();
  });
}

// SECRETS
async function loadSecretsPage() {
  const projs = await api('GET','/projects');
  const sel = document.getElementById('secrets-project-select');
  sel.innerHTML = '<option value="">-- pilih project --</option>' + projs.map(p => \`<option>\${p.name}</option>\`).join('');
}

async function loadSecrets() {
  const app = document.getElementById('secrets-project-select').value;
  const panel = document.getElementById('secrets-panel');
  if(!app) { panel.innerHTML=''; return; }

  const secrets = await api('GET',\`/projects/\${app}/secrets\`);

  panel.innerHTML = \`
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <span style="font-size:13px;font-weight:500;">Secrets — \${app}</span>
        <button class="btn btn-sm btn-primary" onclick="addSecretRow()">+ Tambah</button>
      </div>
      <div id="secrets-rows">
        \${secrets.map(s => secretRow(s.key, s.value)).join('')}
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;">
        <button class="btn btn-primary" onclick="saveSecrets(true, event)">Simpan & Restart</button>
        <button class="btn" onclick="saveSecrets(false, event)">Simpan (tanpa restart)</button>
      </div>
    </div>
  \`;
}

function secretRow(key='', val='') {
  const isSensitive = /PASS|SECRET|KEY|TOKEN|PWD|PRIVATE/i.test(key);
  return \`<div class="secret-row" id="row-\${key||'new'+Date.now()}">
    <input class="secret-key" placeholder="VARIABLE_NAME" value="\${key}" style="font-family:monospace;" onchange="updateRowId(this)"/>
    <input class="secret-val \${isSensitive?'masked':''}" placeholder="value" value="\${val}" type="\${isSensitive?'password':'text'}" style="font-family:monospace;"/>
    <button class="btn btn-sm btn-danger" onclick="this.closest('.secret-row').remove()">✕</button>
  </div>\`;
}

function addSecretRow() {
  document.getElementById('secrets-rows').insertAdjacentHTML('beforeend', secretRow());
}

async function saveSecrets(restart=true, ev) {
  const app = document.getElementById('secrets-project-select').value;
  const rows = document.querySelectorAll('.secret-row');
  const secrets = [];
  rows.forEach(row => {
    const key = row.querySelector('.secret-key').value.trim();
    const val = row.querySelector('.secret-val').value;
    if(key) secrets.push({key, value: val});
  });
  await withButtonBusy(resolveActionButton(ev), async () => {
    await api('PUT', \`/projects/\${app}/secrets\`, {secrets});
    if(restart) await api('POST', \`/projects/\${app}/restart\`);
    toast('Secrets disimpan!' + (restart?' App direstart!':''));
  });
}

// LOGS
async function loadLogsPage() {
  const projs = await api('GET','/projects');
  const sel = document.getElementById('logs-project-select');
  sel.innerHTML = '<option>-- pilih project --</option>' + projs.map(p => \`<option>\${p.name}</option>\`).join('');
}

function showLogs(name) {
  showPage('logs');
  document.getElementById('logs-project-select').value = name;
  loadLogs();
}

async function loadLogs() {
  const app = document.getElementById('logs-project-select').value;
  const lines = document.getElementById('logs-lines').value;
  if(!app || app.startsWith('--')) return;
  document.getElementById('logs-output').textContent = 'Loading...';
  const res = await api('GET', \`/projects/\${app}/logs?lines=\${lines}\`);
  document.getElementById('logs-output').textContent = res.logs || 'Tidak ada log.';
}

var browseState = { db: '', schema: 'public', table: '', offset: 0, limit: 50 };
var dbDetailName = '';

function escapeHtmlBrowse(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function copyDbConnectionUrl(dbName) {
  const data = await api('GET', '/database/connection-url/' + encodeURIComponent(dbName));
  if (data.error) { toast(data.error, 'error'); return; }
  const url = data.url;
  try {
    await navigator.clipboard.writeText(url);
    toast('DATABASE_URL disalin (host ' + (data.host || 'localhost') + ')', 'success', 4500);
  } catch (e) {
    window.prompt('Salin manual (Ctrl+C):', url);
    toast('URL ditampilkan di dialog', 'success', 4000);
  }
}

function renderDatabaseListRows(st, databases) {
  const tbody = document.getElementById('db-list-body');
  if (!tbody) return;
  const defDb = st.local && st.local.database;
  if (!databases.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="padding:28px;color:var(--muted);text-align:center;">Belum ada database yang terlihat untuk user ini. Klik <strong>+ Database</strong> atau periksa hak CONNECT di PostgreSQL.</td></tr>';
    return;
  }
  tbody.innerHTML = databases.map(function(d) {
    const badge = d === defDb ? '<span class="badge badge-green">Default app</span>' : '<span style="color:var(--muted);">—</span>';
    return '<tr class="db-list-row" onclick="openDatabaseDetail(\\'' + d + '\\')"><td style="padding-left:18px;"><code style="font-size:13px;">' + escapeHtmlBrowse(d) + '</code></td><td>' + badge + '</td><td style="text-align:right;padding-right:18px;" class="db-row-actions" onclick="event.stopPropagation()"><button type="button" class="btn btn-sm" onclick="copyDbConnectionUrl(\\'' + d + '\\')" title="postgresql://… ke clipboard">Salin URL</button> <button type="button" class="btn btn-sm btn-primary" onclick="openDatabaseDetail(\\'' + d + '\\')">Kelola</button> <button type="button" class="btn btn-sm" onclick="exportLocalDatabase(\\'' + d + '\\')">Export</button></td></tr>';
  }).join('');
}

function switchDbDetailTab(tab) {
  ['browse', 'import', 'dumps'].forEach(function(t) {
    const panel = document.getElementById('db-panel-' + t);
    const tabEl = document.getElementById('db-tab-' + t);
    const on = t === tab;
    if (panel) panel.classList.toggle('db-hidden', !on);
    if (tabEl) tabEl.classList.toggle('active', on);
  });
  if (tab === 'dumps') refreshDumpList();
}

function openDatabaseDetail(name) {
  dbDetailName = name;
  const listEl = document.getElementById('db-view-list');
  const detEl = document.getElementById('db-view-detail');
  if (listEl) listEl.style.display = 'none';
  if (detEl) detEl.style.display = 'block';
  const bc = document.getElementById('db-detail-breadcrumb-db');
  if (bc) bc.textContent = name;
  const lab = document.getElementById('db-detail-target-label');
  if (lab) lab.textContent = name;
  const it = document.getElementById('db-import-target');
  if (it) it.value = name;
  const st = document.getElementById('db-sync-target');
  if (st) st.value = name;
  const h = document.getElementById('db-browse-db');
  if (h) h.value = name;
  switchDbDetailTab('browse');
  initBrowseForDatabase(name);
}

async function backToDatabaseList() {
  dbDetailName = '';
  await loadDatabasePage();
}

async function initBrowseForDatabase(name) {
  browseState.db = name;
  browseState.table = '';
  browseState.offset = 0;
  document.getElementById('db-browse-rows-table').style.display = 'none';
  document.getElementById('db-browse-pager').style.display = 'none';
  document.getElementById('db-browse-meta').textContent = '';
  document.getElementById('db-browse-tables').innerHTML = '';
  const data = await api('GET', '/database/browse/' + encodeURIComponent(name) + '/schemas');
  if (data.error) { toast(data.error, 'error'); return; }
  const schemas = data.schemas || [];
  const ss = document.getElementById('db-browse-schema');
  ss.innerHTML = schemas.map(function(s) {
    return '<option value="' + s + '">' + s + '</option>';
  }).join('');
  if (schemas.indexOf('public') >= 0) ss.value = 'public';
  else if (schemas.length) ss.value = schemas[0];
  browseState.schema = ss.value || 'public';
  await onBrowseSchemaChange();
}

function showDbCreateModal() {
  document.getElementById('db-modal-create').style.display = 'flex';
  document.getElementById('db-create-name').focus();
}
function closeDbCreateModal() {
  document.getElementById('db-modal-create').style.display = 'none';
}
async function showDbImportGoModal() {
  const data = await api('GET', '/database/browse/databases');
  if (data.error) { toast(data.error, 'error'); return; }
  const arr = data.databases || [];
  if (!arr.length) { toast('Belum ada database. Buat dulu dengan + Database.', 'error'); return; }
  const sel = document.getElementById('db-import-go-select');
  sel.innerHTML = arr.map(function(d) { return '<option value="' + d + '">' + escapeHtmlBrowse(d) + '</option>'; }).join('');
  document.getElementById('db-modal-import-go').style.display = 'flex';
}
function closeDbImportGoModal() {
  document.getElementById('db-modal-import-go').style.display = 'none';
}
function confirmDbImportGo() {
  const v = document.getElementById('db-import-go-select').value;
  if (!v) { toast('Pilih database', 'error'); return; }
  closeDbImportGoModal();
  openDatabaseDetail(v);
  switchDbDetailTab('import');
}

async function onBrowseSchemaChange() {
  browseState.schema = document.getElementById('db-browse-schema').value;
  browseState.table = '';
  document.getElementById('db-browse-rows-table').style.display = 'none';
  document.getElementById('db-browse-pager').style.display = 'none';
  document.getElementById('db-browse-meta').textContent = '';
  if (!browseState.db || !browseState.schema) return;
  const data = await api('GET', '/database/browse/' + encodeURIComponent(browseState.db) + '/tables?schema=' + encodeURIComponent(browseState.schema));
  const box = document.getElementById('db-browse-tables');
  if (data.error) { box.textContent = data.error; return; }
  const tables = data.tables || [];
  if (tables.length === 0) { box.textContent = 'Tidak ada tabel di schema ini.'; return; }
  box.innerHTML = '<div style="color:var(--muted);margin-bottom:8px;">Klik tabel:</div>' + tables.map(function(t) {
    const n = String(t.name).replace(/"/g, '&quot;');
    return '<button type="button" class="btn btn-sm" style="margin:4px" data-browse-t="' + n + '" onclick="selectBrowseTable(this.getAttribute(\\'data-browse-t\\'))">' + escapeHtmlBrowse(t.name) + '</button>';
  }).join('');
}

function selectBrowseTable(name) {
  browseState.table = name;
  browseState.offset = 0;
  loadBrowseRows();
}

async function loadBrowseRows() {
  if (!browseState.db || !browseState.schema || !browseState.table) return;
  const meta = document.getElementById('db-browse-meta');
  const tbl = document.getElementById('db-browse-rows-table');
  const pager = document.getElementById('db-browse-pager');
  const q = '?schema=' + encodeURIComponent(browseState.schema) + '&table=' + encodeURIComponent(browseState.table) + '&limit=' + browseState.limit + '&offset=' + browseState.offset;
  const data = await api('GET', '/database/browse/' + encodeURIComponent(browseState.db) + '/rows' + q);
  if (data.error) {
    meta.textContent = data.error;
    tbl.style.display = 'none';
    pager.style.display = 'none';
    toast(data.error, 'error');
    return;
  }
  meta.textContent = browseState.db + ' / ' + browseState.schema + ' / ' + browseState.table + ' — offset ' + data.offset + ' (limit ' + data.limit + ')';
  const cols = data.columns || [];
  const rows = data.rows || [];
  if (cols.length === 0) {
    tbl.innerHTML = '<tbody><tr><td style="padding:12px;">(kosong)</td></tr></tbody>';
    tbl.style.display = 'table';
    pager.style.display = 'flex';
    return;
  }
  var html = '<thead><tr>' + cols.map(function(c) { return '<th>' + escapeHtmlBrowse(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
  html += rows.map(function(row) {
    return '<tr>' + row.map(function(cell) {
      var v = cell === null || cell === undefined ? '' : String(cell);
      if (v.length > 200) v = v.slice(0, 200) + '…';
      return '<td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:8px 10px;border-bottom:1px solid var(--border);">' + escapeHtmlBrowse(v) + '</td>';
    }).join('') + '</tr>';
  }).join('');
  html += '</tbody>';
  tbl.innerHTML = html;
  tbl.style.display = 'table';
  pager.style.display = 'flex';
}

function browseRowsPrev() {
  browseState.offset = Math.max(0, browseState.offset - browseState.limit);
  loadBrowseRows();
}

function browseRowsNext() {
  browseState.offset = Math.min(10000, browseState.offset + browseState.limit);
  loadBrowseRows();
}

async function loadDatabasePage() {
  dbDetailName = '';
  const listEl = document.getElementById('db-view-list');
  const detEl = document.getElementById('db-view-detail');
  if (listEl) listEl.style.display = 'block';
  if (detEl) detEl.style.display = 'none';
  const statusCard = document.getElementById('db-list-status');
  const st = await api('GET', '/database/status');
  if (st.error) {
    if (statusCard) statusCard.innerHTML = '<div style="color:var(--red);">' + escapeHtmlBrowse(st.error) + '</div>';
    return;
  }
  if (statusCard) {
    statusCard.innerHTML = '<div style="font-size:13px;line-height:1.65;color:var(--muted);"><strong style="color:var(--text);font-weight:500;">' + escapeHtmlBrowse(st.local.user) + '@' + escapeHtmlBrowse(String(st.local.host)) + ':' + String(st.local.port) + '</strong> · Default aplikasi: <code>' + escapeHtmlBrowse(st.local.database) + '</code> · Folder cadangan: <code>' + escapeHtmlBrowse(st.dumpDir) + '</code></div>';
  }
  const data = await api('GET', '/database/browse/databases');
  const tbody = document.getElementById('db-list-body');
  if (data.error) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="3" style="padding:20px;color:var(--red);">' + escapeHtmlBrowse(data.error) + '</td></tr>';
    return;
  }
  renderDatabaseListRows(st, data.databases || []);
}

async function exportLocalDatabase(forDb) {
  var q = '';
  if (forDb && String(forDb).length) q = '?database=' + encodeURIComponent(forDb);
  const r = await fetch('/api/database/export' + q, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    toast(j.error || 'Export gagal', 'error');
    return;
  }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  var fname = 'dump_' + (forDb || 'local') + '_' + Date.now() + '.sql';
  var cd = r.headers.get('Content-Disposition');
  if (cd && cd.indexOf('filename=') >= 0) {
    var m = cd.match(/filename="([^"]+)"/);
    if (m) fname = m[1];
  }
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Export selesai');
  refreshDumpList();
}

async function createEmptyLocalDatabase() {
  const database = document.getElementById('db-create-name').value.trim();
  if (!database) { toast('Isi nama database', 'error'); return; }
  const data = await api('POST', '/database/create-local', { database });
  if (data.error) toast(data.error, 'error');
  else {
    toast('Database dibuat: ' + data.database);
    closeDbCreateModal();
    document.getElementById('db-create-name').value = '';
    await loadDatabasePage();
  }
}

async function importSqlFromText() {
  const sql = document.getElementById('db-import-sql').value;
  const targetDatabase = document.getElementById('db-import-target').value.trim() || undefined;
  if (!sql.trim()) { toast('Isi SQL', 'error'); return; }
  const tgt = targetDatabase || dbDetailName || 'default';
  setImportPanelBusy(true);
  var t0 = Date.now();
  function importRunningLine() {
    var s = Math.floor((Date.now() - t0) / 1000);
    showDbJobRunning('<div class="db-job-row"><div class="db-spinner"></div><div><strong>Import SQL berjalan</strong> (' + s + ' detik)<br/><span style="font-size:12px;color:var(--muted)">Menjalankan perintah ke database <code>' + escapeHtmlBrowse(String(tgt)) + '</code>. Mohon tunggu.</span></div></div>');
  }
  importRunningLine();
  var tick = setInterval(importRunningLine, 400);
  try {
    const r = await fetch('/api/database/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ sql, targetDatabase }),
    });
    let data;
    try { data = await r.json(); } catch (e) { data = { error: 'Respons server tidak valid (HTTP ' + r.status + ')' }; }
    if (data.error) {
      showDbJobFinished(false, '<strong>Gagal.</strong> ' + escapeHtmlBrowse(String(data.error)));
      toast(data.error, 'error');
    } else {
      var sec = Math.max(1, Math.round((Date.now() - t0) / 1000));
      showDbJobFinished(true, '<strong>Import selesai</strong> dalam ~' + sec + ' detik. Data pada <code>' + escapeHtmlBrowse(String(tgt)) + '</code> sudah diperbarui.');
      toast('Import SQL selesai', 'success', 5500);
      if (dbDetailName) initBrowseForDatabase(dbDetailName);
    }
  } catch (e) {
    showDbJobFinished(false, '<strong>Koneksi terputus.</strong> ' + escapeHtmlBrowse(e.message || String(e)));
    toast('Permintaan gagal — periksa jaringan atau coba lagi', 'error');
  } finally {
    clearInterval(tick);
    setImportPanelBusy(false);
  }
}

async function syncFromRemoteUrl() {
  const connectionUrl = document.getElementById('db-remote-url').value.trim();
  const targetDatabase = document.getElementById('db-sync-target').value.trim() || undefined;
  const resetSchema = document.getElementById('db-sync-reset').checked;
  if (!connectionUrl) { toast('Isi connection URL', 'error'); return; }
  if (resetSchema && !confirm('Ini akan DROP SCHEMA public CASCADE pada database target lokal. Yakin?')) return;
  const tgt = targetDatabase || dbDetailName || 'default';
  setImportPanelBusy(true);
  var t0 = Date.now();
  function syncRunningLine() {
    var s = Math.floor((Date.now() - t0) / 1000);
    var phase = s < 8 ? 'Mengunduh snapshot dari remote (pg_dump)…' : (s < 60 ? 'Memproses dump — database besar butuh waktu lebih lama…' : 'Masih berjalan — mohon tetap di halaman ini…');
    showDbJobRunning('<div class="db-job-row"><div class="db-spinner"></div><div><strong>Sinkronisasi sedang berjalan</strong> (' + s + ' detik)<br/><span style="font-size:12px;color:var(--muted)">' + phase + ' Lalu restore ke <code>' + escapeHtmlBrowse(String(tgt)) + '</code>.</span></div></div>');
  }
  syncRunningLine();
  var tick = setInterval(syncRunningLine, 400);
  try {
    const data = await api('POST', '/database/sync-from-url', { connectionUrl, targetDatabase, resetSchema });
    if (data.error) {
      showDbJobFinished(false, '<strong>Gagal.</strong> ' + escapeHtmlBrowse(String(data.error)));
      toast(data.error, 'error');
    } else {
      var sec = Math.max(1, Math.round((Date.now() - t0) / 1000));
      showDbJobFinished(true, '<strong>Sinkronisasi selesai</strong> dalam ~' + sec + ' detik. Remote sudah di-restore ke <code>' + escapeHtmlBrowse(String(tgt)) + '</code>.' + (resetSchema ? ' Schema public sudah di-reset sesuai opsi.' : ''));
      toast('Sinkronisasi selesai', 'success', 6000);
      refreshDumpList();
      if (dbDetailName) initBrowseForDatabase(dbDetailName);
    }
  } catch (e) {
    showDbJobFinished(false, '<strong>Koneksi terputus atau timeout.</strong> ' + escapeHtmlBrowse(e.message || String(e)));
    toast('Permintaan gagal — proses di server mungkin masih berjalan; cek log atau coba lagi', 'error', 7000);
  } finally {
    clearInterval(tick);
    setImportPanelBusy(false);
  }
}

async function refreshDumpList() {
  const box = document.getElementById('db-dumps-list');
  const data = await api('GET', '/database/dumps');
  if (data.error) { box.textContent = data.error; return; }
  if (!data.files || data.files.length === 0) { box.textContent = 'Belum ada file .sql di folder dump.'; return; }
  box.innerHTML = data.files.map(function(f) {
    const kb = Math.round(f.size / 1024);
    return '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 0;border-bottom:1px solid var(--border);"><span><code>' + f.name + '</code> <span style="color:var(--muted);font-size:12px;">(' + kb + ' KB)</span></span><span class="btn-group"><button type="button" class="btn btn-sm" onclick="downloadDumpFile(\\'' + f.name.replace(/'/g, '') + '\\')">Download</button><button type="button" class="btn btn-sm btn-danger" onclick="applyDumpFile(\\'' + f.name.replace(/'/g, '') + '\\')">Apply ke DB ini</button></span></div>';
  }).join('');
}

async function downloadDumpFile(name) {
  const r = await fetch('/api/database/dumps/download?name=' + encodeURIComponent(name), { headers: { 'Authorization': 'Bearer ' + token } });
  if (!r.ok) { toast('Download gagal', 'error'); return; }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function applyDumpFile(name) {
  const tgt = document.getElementById('db-import-target') && document.getElementById('db-import-target').value.trim();
  const tgtLabel = tgt || '(default)';
  if (!confirm('Jalankan isi ' + name + ' ke database ' + tgtLabel + '?')) return;
  const targetDatabase = tgt || undefined;
  const data = await api('POST', '/database/import-file', { filename: name, targetDatabase });
  if (data.error) toast(data.error, 'error');
  else {
    toast('Import file selesai');
    if (dbDetailName) initBrowseForDatabase(dbDetailName);
  }
}

async function initDashboard() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  await loadOverview();
  setInterval(loadOverview, 10000);
}

// INIT
if(token) { initDashboard().catch(() => { token=null; localStorage.removeItem('vps_token'); document.getElementById('login-screen').style.display='block'; }); }
else { document.getElementById('login-screen').style.display = 'block'; }
</script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`VPS Manager Dashboard running on http://0.0.0.0:${PORT}`);
});
