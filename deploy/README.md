# Deploying sapwood.forgesworn.dev

Sapwood is served two ways. Both build the same static SPA:

| Target | URL | How |
|--------|-----|-----|
| GitHub Pages | `forgesworn.github.io/sapwood/` | `.github/workflows/deploy.yml` |
| Hetzner "routing" box | `sapwood.forgesworn.dev` | `.github/workflows/deploy-hetzner.yml` + this dir |

The custom domain is canonical. HTTPS is **required** — the flasher uses Web Serial,
which only works in a secure context. Caddy issues the cert automatically.

## Box

Shared multi-tenant box `routing` (`95.217.39.110`, Debian 12) — also runs
Phoenixd (Lightning) and trotters routing. **Every change here is additive: never
touch another tenant's dir, unit, or Caddy vhost.** Caddy is systemd and imports
`/etc/caddy/conf.d/*.Caddyfile`. Access: `ssh -i ~/.ssh/id_rsa_thecryptodonkey deploy@95.217.39.110`.

## One-time setup (by hand)

DNS is already in place: `sapwood.forgesworn.dev` → A `95.217.39.110`, grey-cloud
(DNS-only) so Caddy can issue Let's Encrypt.

```bash
KEY=~/.ssh/id_rsa_thecryptodonkey
# 1. Static root
ssh -i "$KEY" deploy@95.217.39.110 'mkdir -p /opt/sapwood'
# 2. Caddy vhost (validate against the FULL config before reloading — a bad
#    block must never take Caddy down for the other tenants)
scp -i "$KEY" deploy/sapwood.Caddyfile deploy@95.217.39.110:/tmp/sapwood.Caddyfile
ssh -i "$KEY" deploy@95.217.39.110 '
  sudo cp /tmp/sapwood.Caddyfile /etc/caddy/conf.d/sapwood.Caddyfile &&
  sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile &&
  sudo systemctl reload caddy'
# 3. First content push (or let CI do it)
rsync -avz --delete -e "ssh -i $KEY" dist/ deploy@95.217.39.110:/opt/sapwood/
# 4. Smoke
curl -sS -o /dev/null -w '%{http_code}\n' https://sapwood.forgesworn.dev/
```

Rollback: `sudo rm /etc/caddy/conf.d/sapwood.Caddyfile && sudo systemctl reload caddy`.

## Firmware (managed separately — important)

The ESP32 binaries under `public/firmware/` are **gitignored** (build artefacts
from heartwood-esp32, populated locally via save-image). So a CI checkout has no
firmware, and **CI deploys exclude `/firmware/`** — otherwise `rsync --delete`
would wipe it. Push firmware to the box by hand whenever it changes:

```bash
npm run build   # copies local public/firmware/* into dist/
rsync -az -e "ssh -i ~/.ssh/id_rsa_thecryptodonkey" \
  dist/firmware/ deploy@95.217.39.110:/opt/sapwood/firmware/
# verify (real app.bin is ~1.8 MB, not the ~1 KB index.html SPA fallback):
curl -s -o /dev/null -w '%{size_download}\n' https://sapwood.forgesworn.dev/firmware/v4/app.bin
```

> For fully-automated firmware deploys, either commit the binaries (drop the
> gitignore line) or add a CI step that fetches them from a heartwood-esp32
> release. Until then firmware is a manual push.

## CI auto-deploy

`deploy-hetzner.yml` builds and rsyncs `dist/` to `/opt/sapwood/` on every push to
`main`. It needs repo secret **`HETZNER_SSH_KEY`** — a private key whose public half
is in the box's `deploy@` `authorized_keys`. Prefer a dedicated per-repo deploy key
over reusing a personal key. Until the secret is set, the workflow no-ops.

```bash
# Generate a dedicated deploy key, authorise it on the box, store it as the secret:
ssh-keygen -t ed25519 -f /tmp/sapwood_deploy -N "" -C "sapwood-ci"
ssh -i ~/.ssh/id_rsa_thecryptodonkey deploy@95.217.39.110 \
  "echo '$(cat /tmp/sapwood_deploy.pub)' >> ~/.ssh/authorized_keys"
gh secret set HETZNER_SSH_KEY < /tmp/sapwood_deploy   # in the sapwood repo
rm /tmp/sapwood_deploy /tmp/sapwood_deploy.pub
```

## Manual deploy (no CI)

```bash
npm run build
rsync -avz --delete -e "ssh -i ~/.ssh/id_rsa_thecryptodonkey" \
  dist/ deploy@95.217.39.110:/opt/sapwood/
```
