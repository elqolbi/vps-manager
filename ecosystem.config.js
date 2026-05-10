// ecosystem.config.js
// Simpan di root folder setiap project
// Dibaca oleh PM2 saat deploy

module.exports = {
  apps: [
    {
      // ── Ganti APP_NAME dengan nama project ──
      name: 'APP_NAME',

      // Entry point — sesuaikan dengan project kamu
      script: 'index.js',       // atau 'server.js', 'app.js', 'src/index.js'
      // script: 'npm',          // uncomment ini jika pakai npm start
      // args: 'start',          // uncomment ini jika pakai npm start

      // ── Environment ──────────────────────────
      node_args: '--max-old-space-size=512',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },

      // ── Clustering ───────────────────────────
      // 'max' = gunakan semua CPU core
      // angka = jumlah instance
      instances: 1,              // ganti ke 'max' untuk multi-core
      exec_mode: 'cluster',      // 'fork' untuk single, 'cluster' untuk multi

      // ── Zero-downtime restart ─────────────────
      // PM2 akan tunggu app listen sebelum membunuh instance lama
      wait_ready: true,           // app harus emit process.send('ready')
      listen_timeout: 10000,      // max tunggu ready signal (ms)
      kill_timeout: 5000,         // tunggu sebelum force kill (ms)

      // ── Auto-restart ──────────────────────────
      autorestart: true,
      watch: false,               // jangan watch di production
      max_memory_restart: '512M', // restart jika RAM > 512MB
      restart_delay: 1000,

      // ── Logging ───────────────────────────────
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      log_type: 'json',

      // ── Health check ──────────────────────────
      // Pastikan app ini ada di kode kamu untuk zero-downtime:
      // process.on('SIGINT', () => { server.close(() => process.exit(0)); });
      // server.listen(PORT, () => { if(process.send) process.send('ready'); });
    },
  ],
};
