// ============================================================
//  VPS Manager — Web Dashboard API Server
//  Simpan sebagai: /opt/vps-manager/server.js
//  Jalankan: pm2 start server.js --name vps-manager
// ============================================================

const express = require('express');
const { execSync, exec, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');
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
const DB_DUMP_DIR = process.env.VPS_MANAGER_DUMPS || path.join(os.homedir(), '.vps-manager-dumps');
const jsonLarge = express.json({ limit: '100mb' });

try {
  fs.mkdirSync(DB_DUMP_DIR, { recursive: true, mode: 0o700 });
} catch (_) {}

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── AUTH ─────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password !== DASHBOARD_PASS) return res.status(401).json({ error: 'Wrong password' });
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

const hasBuildScript = (projectDir) => {
  try {
    const raw = fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return !!(pkg.scripts && typeof pkg.scripts.build === 'string' && pkg.scripts.build.trim());
  } catch {
    return false;
  }
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

// ── API: PROJECTS ─────────────────────────────────────────────
app.get('/api/projects', auth, (req, res) => {
  const pm2 = getPm2Status();
  const projects = getProjects().map(app => {
    const meta = readMeta(app);
    const proc = pm2.find(p => p.name === app);
    const env = readEnv(app);
    return {
      name: app,
      status: proc?.pm2_env?.status || 'stopped',
      port: env.PORT || meta.PORT || '-',
      domain: meta.DOMAIN || '',
      repo: meta.REPO_URL || '',
      branch: meta.BRANCH || 'main',
      installedAt: meta.INSTALLED_AT || '',
      uptime: proc?.pm2_env?.pm_uptime || null,
      restarts: proc?.pm2_env?.restart_time || 0,
      memory: proc?.monit?.memory || 0,
      cpu: proc?.monit?.cpu || 0,
    };
  });
  res.json(projects);
});

app.post('/api/projects/install', auth, (req, res) => {
  const { repoUrl, name, port, domain, branch = 'main' } = req.body;
  if (!repoUrl || !name || !port) return res.status(400).json({ error: 'Missing fields' });

  const targetDir = resolveProjectDir(name);
  if (!targetDir) return res.status(400).json({ error: 'Invalid project name' });
  if (fs.existsSync(targetDir)) return res.status(400).json({ error: 'Project already exists' });

  exec(`sudo -u ${APP_USER} git clone -b ${branch} ${repoUrl} ${targetDir}`, (err) => {
    if (err) return res.status(500).json({ error: 'Clone failed: ' + err.message });

    try {
      runAsThrow(`cd ${shSingleQuote(targetDir)} && npm install`);
      if (hasBuildScript(targetDir)) {
        runAsThrow(`cd ${shSingleQuote(targetDir)} && npm run build`);
      }
    } catch (e) {
      return res.status(500).json({ error: 'Install/build failed: ' + e.message });
    }

    // Write .env
    const envContent = `NODE_ENV=production\nPORT=${port}\nDATABASE_URL=postgresql://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}\nREDIS_URL=redis://:${REDIS_PASS}@localhost:6379\n`;
    fs.writeFileSync(path.join(targetDir, '.env'), envContent);
    run(`chown ${APP_USER}:${APP_USER} ${targetDir}/.env`);

    // Write .vps-meta
    const metaContent = `APP_NAME=${name}\nREPO_URL=${repoUrl}\nBRANCH=${branch}\nPORT=${port}\nDOMAIN=${domain || ''}\nINSTALLED_AT=${new Date().toISOString()}\n`;
    fs.writeFileSync(path.join(targetDir, '.vps-meta'), metaContent);
    run(`chown ${APP_USER}:${APP_USER} ${targetDir}/.vps-meta`);

    // Setup nginx if domain
    if (domain) {
      const nginx = `server {\n    listen 80;\n    server_name ${domain};\n    location / {\n        proxy_pass http://127.0.0.1:${port};\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection 'upgrade';\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_cache_bypass $http_upgrade;\n    }\n}\n`;
      fs.writeFileSync(`/etc/nginx/sites-available/${name}`, nginx);
      run(`ln -sf /etc/nginx/sites-available/${name} /etc/nginx/sites-enabled/${name}`);
      run('nginx -t && systemctl reload nginx');
    }

    // Start PM2
    runAs(`cd ${targetDir} && (grep -q '"start"' package.json && pm2 start npm --name ${name} -- start || pm2 start index.js --name ${name}) && pm2 save`);

    res.json({ success: true });
  });
});

app.delete('/api/projects/:name', auth, (req, res) => {
  const { name } = req.params;
  runAs(`pm2 stop ${name} 2>/dev/null; pm2 delete ${name} 2>/dev/null; pm2 save`);
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
      // Full install (not --only=production) so devDependencies (tsx, vite, etc.) exist for build
      runAsThrow(`cd ${dirQ} && npm install`);
      if (hasBuildScript(dir)) {
        runAsThrow(`cd ${dirQ} && npm run build`);
      }
      pm2RestartWithEnvFromProject(name);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Deploy failed: ' + e.message });
    }
  });
});

app.post('/api/projects/:name/restart', auth, (req, res) => {
  pm2RestartWithEnvFromProject(req.params.name);
  res.json({ success: true });
});

app.post('/api/projects/:name/stop', auth, (req, res) => {
  runAs(`pm2 stop ${req.params.name}`);
  res.json({ success: true });
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
        <button class="btn btn-primary" style="width:100%;" onclick="doLogin()">Login</button>
        <div id="login-err" style="color:var(--red); font-size:12px; margin-top:10px; text-align:center;"></div>
      </div>
    </div>
  </div>

  <div id="dashboard" style="display:none;">
    <div class="sidebar">
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
      </nav>
    </div>

    <main class="main">
      <!-- OVERVIEW -->
      <div id="page-overview" class="page active">
        <h2>Overview</h2>
        <div class="grid" id="sys-stats"></div>
        <div class="card">
          <h3 style="margin-bottom:16px;font-size:15px;">Running Projects</h3>
          <table><thead><tr><th>App</th><th>Status</th><th>Port</th><th>Domain</th><th>CPU</th><th>RAM</th><th>Actions</th></tr></thead>
          <tbody id="overview-table"><tr><td colspan="7" style="color:var(--muted);text-align:center;">Loading...</td></tr></tbody></table>
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
      <button class="btn btn-primary" onclick="installProject()">Install</button>
    </div>
    <div id="install-progress" style="display:none;margin-top:16px;">
      <div style="color:var(--muted);font-size:12px;">Menginstall...</div>
      <div class="progress-bar"><div class="progress-fill" style="width:60%;"></div></div>
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

function api(method, path, body) {
  return fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined
  }).then(r => r.json());
}

function toast(msg, type='success', ms) {
  const dur = typeof ms === 'number' ? ms : (type === 'error' ? 5000 : 3200);
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), dur);
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

async function doLogin() {
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
}

document.getElementById('login-pass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  const navLink = document.querySelector('.nav a[onclick*="' + name + '"]');
  if (navLink) navLink.classList.add('active');
  if(name==='projects') loadProjects();
  if(name==='secrets') loadSecretsPage();
  if(name==='logs') loadLogsPage();
  if(name==='database') loadDatabasePage();
}

function statusBadge(s) {
  const map = {online:'badge-green',stopped:'badge-red',errored:'badge-red',stopping:'badge-yellow'};
  return \`<span class="badge \${map[s]||'badge-yellow'}">\${s}</span>\`;
}

function fmtBytes(b) {
  if(!b) return '-';
  return (b/1024/1024).toFixed(1)+' MB';
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
        <button class="btn btn-sm" onclick="deployApp('\${p.name}')">Deploy</button>
        <button class="btn btn-sm" onclick="restartApp('\${p.name}')">Restart</button>
      </div></td>
    </tr>\`).join('');
}

async function loadProjects() {
  const projs = await api('GET','/projects');
  projects = projs;
  document.getElementById('projects-list').innerHTML = projs.length === 0
    ? '<div style="color:var(--muted);text-align:center;padding:40px;">Belum ada project. Klik "Install Project" untuk mulai.</div>'
    : projs.map(p => \`
      <div class="card" style="margin-bottom:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
              <span style="font-size:15px;font-weight:600;">\${p.name}</span>
              \${statusBadge(p.status)}
              <span class="chip">:\${p.port}</span>
            </div>
            <div style="font-size:12px;color:var(--muted);">
              \${p.repo ? '<a href="'+p.repo+'" target="_blank" style="color:var(--blue);text-decoration:none;">'+p.repo.replace('https://github.com/','')+'</a>' : '-'}
              \${p.domain ? ' &nbsp;·&nbsp; <a href="http://'+p.domain+'" target="_blank" style="color:var(--blue);text-decoration:none;">'+p.domain+'</a>' : ''}
              \${p.installedAt ? ' &nbsp;·&nbsp; installed '+new Date(p.installedAt).toLocaleDateString() : ''}
            </div>
          </div>
          <div class="btn-group">
            <button class="btn btn-sm" onclick="showPage('secrets');document.getElementById('secrets-project-select').value='\${p.name}';loadSecrets()" >Secrets</button>
            <button class="btn btn-sm" onclick="deployApp('\${p.name}')">Deploy</button>
            <button class="btn btn-sm" onclick="restartApp('\${p.name}')">Restart</button>
            <button class="btn btn-sm" onclick="showLogs('\${p.name}')">Logs</button>
            <button class="btn btn-sm btn-danger" onclick="uninstallApp('\${p.name}')">Uninstall</button>
          </div>
        </div>
      </div>
    \`).join('');
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

async function installProject() {
  const body = {
    repoUrl: document.getElementById('i-repo').value.trim(),
    name: document.getElementById('i-name').value.trim(),
    port: document.getElementById('i-port').value,
    domain: document.getElementById('i-domain').value.trim(),
    branch: document.getElementById('i-branch').value.trim() || 'main',
  };
  if(!body.repoUrl || !body.name || !body.port) { toast('Isi semua field wajib!','error'); return; }

  document.getElementById('install-progress').style.display = 'block';
  try {
    const res = await api('POST','/projects/install', body);
    if(res.error) { toast(res.error,'error'); }
    else { toast('Project berhasil diinstall!'); closeModal(); loadOverview(); loadProjects(); }
  } catch(e) { toast('Install gagal!','error'); }
  document.getElementById('install-progress').style.display = 'none';
}

async function uninstallApp(name) {
  if(!confirm(\`Yakin uninstall "\${name}"? Data akan hilang permanen!\`)) return;
  await api('DELETE',\`/projects/\${name}\`);
  toast(\`\${name} berhasil diuninstall!\`);
  loadOverview(); loadProjects();
}

async function deployApp(name) {
  toast(\`Deploying \${name}...\`);
  const res = await api('POST',\`/projects/\${name}/deploy\`);
  if(res.error) toast(res.error,'error');
  else { toast(\`\${name} berhasil dideploy!\`); loadOverview(); }
}

async function restartApp(name) {
  await api('POST',\`/projects/\${name}/restart\`);
  toast(\`\${name} direstart!\`);
  loadOverview();
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
        <button class="btn btn-primary" onclick="saveSecrets()">Simpan & Restart</button>
        <button class="btn" onclick="saveSecrets(false)">Simpan (tanpa restart)</button>
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

async function saveSecrets(restart=true) {
  const app = document.getElementById('secrets-project-select').value;
  const rows = document.querySelectorAll('.secret-row');
  const secrets = [];
  rows.forEach(row => {
    const key = row.querySelector('.secret-key').value.trim();
    const val = row.querySelector('.secret-val').value;
    if(key) secrets.push({key, value: val});
  });
  await api('PUT', \`/projects/\${app}/secrets\`, {secrets});
  if(restart) await api('POST', \`/projects/\${app}/restart\`);
  toast('Secrets disimpan!' + (restart?' App direstart!':''));
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
