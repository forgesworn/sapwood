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

## Firmware (signed release assets)

The binaries under `public/firmware/` are tracked and deploy with the SPA. Pull
them from an explicit `forgesworn/heartwood-esp32` release tag; the sync script
verifies every downloaded SHA-256 before replacing an app image and carries the
release signatures into the served manifest. Bootloaders and partition tables
remain pinned unless an intentional layout migration uses `--force`.

```bash
npm run sync:firmware -- v0.12.0
npm run build
git add public/firmware
git commit -m "chore: sync signed Heartwood firmware v0.12.0"
```

The Hetzner workflow rsyncs the complete `dist/`, including firmware, on every
push to `main`. Verify the live `version.json`, byte counts, and SHA-256 values
against the committed manifest after deployment.

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
