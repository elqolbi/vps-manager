# vps-manager

## Membuka blokir login dashboard

Login dashboard akan diblokir permanen setelah 3 kali salah sandi. Untuk
mengaktifkan kembali akses login dari VPS:

```bash
cd /opt/vps-manager
node server.js unlock-login
```

Untuk melihat status blokir:

```bash
cd /opt/vps-manager
node server.js login-lock-status
```
