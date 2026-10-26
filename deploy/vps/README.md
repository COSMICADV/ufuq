# UFUQ on one server — Oracle Cloud Always Free + Cloudflare

One hosting account, one server, one domain. The whole product runs as one
Docker Compose stack on the server. Cloudflare only handles DNS, proxying
and SSL for `1to1os.com`.

```
Browser → Cloudflare (DNS · proxy · SSL "Full (strict)")
        → Oracle VM :443  caddy (Cloudflare Origin Certificate)
        → app        relay :10000 → Next.js :3000 → /api/v1 → NestJS API :4000 (+ BullMQ jobs)
        → postgres · redis · minio (files, report exports) · mailpit (SMTP sink)
        → backup     daily DB dump + files archive → deploy/vps/backups
```

| URL                         | Serves        |
| --------------------------- | ------------- |
| `https://1to1os.com`        | Public site   |
| `https://1to1os.com/login`  | Login         |
| `https://1to1os.com/admin`  | Admin ERP     |
| `https://1to1os.com/app`    | Employee app  |
| `https://www.1to1os.com/*`  | → redirect to `https://1to1os.com/*` |

## 1. Create the VM (Oracle Cloud console)

**Compute → Instances → Create instance**

| Setting              | Pick                                                              |
| -------------------- | ----------------------------------------------------------------- |
| Name                 | `ufuq`                                                            |
| Placement            | any availability domain (try another if one says "out of capacity") |
| Image                | **Canonical Ubuntu 24.04** (the aarch64 build is picked automatically for Ampere) |
| Shape                | **Ampere → VM.Standard.A1.Flex**, **4 OCPUs**, **24 GB memory**   |
| Networking           | **Create new virtual cloud network** + **new public subnet**, **Assign a public IPv4 address: Yes** |
| SSH keys             | **Generate a key pair for me** → download *both* keys (or paste your own `~/.ssh/id_ed25519.pub`) |
| Boot volume          | **Specify a custom boot volume size: 150 GB** (Always Free allows 200 GB total) |

Every value above stays inside Always Free ("Always Free-eligible" label).

After it is running:

1. **Open ports 80 and 443.** Instance → *Subnet* link → *Security Lists* →
   *Default Security List* → **Add Ingress Rules** (twice):
   - Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port `80`
   - Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port `443`
2. **Keep the IP fixed (recommended).** Instance → *Attached VNICs* → VNIC →
   *IPv4 Addresses* → ⋮ → **Edit** → *Reserved public IP* → create one. Free.
3. **Avoid idle shutdown (optional).** Oracle may reclaim Always Free VMs that
   stay almost idle for 7 days. Upgrading the account to *Pay As You Go*
   removes that rule; you still pay $0 inside the Always Free limits.

Note the **public IP** — it is used below as `<SERVER_IP>`.

## 2. Cloudflare (dashboard for 1to1os.com)

1. **DNS → Records**
   - `A` · name `@` · IPv4 `<SERVER_IP>` · **Proxied** (orange cloud)
   - `CNAME` · name `www` · target `1to1os.com` · **Proxied**
2. **SSL/TLS → Overview** → mode **Full (strict)**.
3. **SSL/TLS → Origin Server → Create Certificate** → RSA, hostnames
   `1to1os.com, *.1to1os.com`, 15 years → copy the **certificate** and the
   **private key** (the key is shown only once).

## 3. Put UFUQ on the server

From the Mac (repository root):

```bash
chmod 600 ~/Downloads/ssh-key-*.key
bash deploy/vps/push-from-mac.sh ubuntu@<SERVER_IP> ~/Downloads/ssh-key-XXXX.key
```

On the server (`ssh -i ~/Downloads/ssh-key-XXXX.key ubuntu@<SERVER_IP>`):

```bash
cd ~/ufuq/deploy/vps
sudo bash setup-server.sh          # Docker + .env with generated secrets
nano certs/origin.pem              # paste the Cloudflare certificate
nano certs/origin.key              # paste the private key
exit                               # log in again so docker works without sudo
```

```bash
cd ~/ufuq/deploy/vps
docker compose up -d --build       # first build takes ~10–15 minutes
docker compose ps                  # all services "healthy"/"running"
docker compose logs -f app         # migrations, seed, "demo company" lines
```

Open `https://1to1os.com`. Demo admin login:
`admin.kadry@demo.ufuq.local` / `123456789` (change it before real use).

## Day-to-day

| Task                    | Command (in `~/ufuq/deploy/vps`)                                  |
| ----------------------- | ----------------------------------------------------------------- |
| Ship new code           | Mac: `push-from-mac.sh …` → server: `docker compose up -d --build` |
| Status / health         | `docker compose ps`                                               |
| Logs                    | `docker compose logs -f app` (or `caddy`, `postgres`, `backup`)   |
| Restart everything      | `docker compose restart`                                          |
| Stop / start            | `docker compose down` / `docker compose up -d` (data is kept)     |
| Backup now              | `docker compose restart backup`                                   |
| Restore                 | `bash restore.sh backups/db/ufuq-….dump backups/files/files-….tar.gz` |
| Read captured mail      | Mac: `ssh -L 8025:127.0.0.1:8025 ubuntu@<SERVER_IP>` → http://localhost:8025 |

- Every container restarts automatically (`restart: unless-stopped`), and
  Docker starts on boot, so the stack comes back after a server reboot.
- Data lives in Docker volumes (`ufuq_postgres-data`, `ufuq_redis-data`,
  `ufuq_minio-data`); `docker compose down` keeps them. Only
  `docker compose down -v` deletes them — never run that on the live server.
- Backups are on the same disk. Copy `backups/` off the server from time to
  time (e.g. `rsync -az ubuntu@<SERVER_IP>:ufuq/deploy/vps/backups/ ~/ufuq-backups/`).

## Notes

- `NODE_ENV=staging` is intentional: in this codebase `production` skips the
  demo company and the `ufuq_app` database-role password (Phase 18), so it
  cannot start this stack. `staging` still uses Secure cookies over HTTPS.
- Mail goes to the in-stack Mailpit sink until real `SMTP_*` values are set in
  `.env` (then `docker compose up -d`).
- Set `DEMO_SEED=false` in `.env` before onboarding real customers.
