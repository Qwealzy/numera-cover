# Numera live host: engine + keeper on one small VPS

What this gives you: the Quote API at `https://api.numeralabs.xyz` and the keeper, always on, restarting by
themselves, on one cheap Linux server, **testnet only** (HyperEVM chain 998). No inbound port is opened: a
Cloudflare Tunnel carries the traffic. The trader app lives separately on Cloudflare Pages
(`https://app.numeralabs.xyz`, step 9).

```
judge's browser --https--> Cloudflare --tunnel (outbound from the server)--> cloudflared --> engine 127.0.0.1:8000
app.numeralabs.xyz (Cloudflare Pages) calls api.numeralabs.xyz (CORS allows only that origin)
keeper (same server) --> HyperEVM testnet RPC
```

Cost: server about 4 to 6 EUR a month (Hetzner CX22: 2 vCPU, 4 GB; check today's price), Cloudflare Tunnel and
Pages free, the domain you already own. Roughly 5 EUR a month in total.

You need: a Hetzner (or any Ubuntu 24.04) account, the Cloudflare account that holds numeralabs.xyz, the two testnet
private keys (quote signer, keeper) and testnet HYPE on the keeper address for gas. Secrets are typed on the server
only. They are never in the repo and no script here prints them.

## Steps

1. **Buy the server.** Hetzner Cloud, location of your choice, image Ubuntu 24.04, type CX22 (any 2 GB+ x86 plan works),
   add your SSH public key, create. Note the IPv4 address.
2. **Make sure the public repo is current.** The server clones `https://github.com/Qwealzy/numera-cover` (public, no
   login). It must contain the engine and the current `deployments/testnet-v2.json`; run the public export and push it
   first if you changed anything. (To deploy another branch or tag later: `NUMERA_REF=<name>`.)
3. **Copy the kit and run setup.** From the repo root on your laptop:
   `scp -r deploy/vps root@<server-ip>:/root/numera-vps`, then `ssh root@<server-ip>`, then
   `bash /root/numera-vps/setup.sh`. About 3 minutes. It installs Python, git and cloudflared, creates the user
   `numera`, installs the engine into `/opt/numera`, installs the systemd units, creates `/etc/numera/numera.env`
   (mode 600) and turns on a firewall that allows SSH only. It starts nothing.
4. **Type the secrets.** `sudo nano /etc/numera/numera.env`, fill `QUOTE_SIGNER_KEY=` and `KEEPER_KEY=` (the lines
   are empty), save. Leave everything else as it is (every variable is explained in the file). The signer's address
   must be the `quoteSigner` of the pools.
5. **Log the server in to Cloudflare:** `sudo -u numera -H cloudflared tunnel login`. It prints a URL: open it in your
   browser, choose `numeralabs.xyz`, authorize.
6. **Create the tunnel and the DNS record:**
   `sudo -u numera -H cloudflared tunnel create numera-api`, then
   `sudo -u numera -H cloudflared tunnel route dns numera-api api.numeralabs.xyz`.
7. **Write the tunnel config:** `sudo numera-tunnel-config`. Then remove the login certificate, it can change your
   Cloudflare account and the running tunnel does not need it: `sudo rm /home/numera/.cloudflared/cert.pem`.
8. **Start everything and check:**
   `sudo systemctl start numera-engine numera-keeper numera-tunnel`, then `numera-status` (all three `active`, the
   health JSON shows `"chainId":998` and the signer address), then from your laptop
   `curl https://api.numeralabs.xyz/health`.
9. **Deploy the app** (from the repo root on your laptop, after `npx wrangler login` and `npm --prefix app ci`):
   `node scripts/deploy-app.mjs --create-project --yes`, then `node scripts/deploy-app.mjs --prod --yes`
   (the plan prints first; the app is built with `VITE_ENGINE_URL=https://api.numeralabs.xyz`). In the Cloudflare
   dashboard open Workers & Pages > numera-app > Custom domains > add `app.numeralabs.xyz`. The app sends
   `X-Robots-Tag: noindex, nofollow`, has the robots meta tag, and is linked nowhere (D31): give the address only to the
   judges, in the Colosseum form.
10. **Try it:** open `https://app.numeralabs.xyz`, connect a testnet wallet, get a quote.

## Day to day

| Task | Command (on the server) |
| --- | --- |
| State of all services and the last log lines | `numera-status` |
| Follow logs live | `sudo journalctl -u numera-engine -f` (also `numera-keeper`, `numera-tunnel`) |
| Update code and pool addresses (after you pushed the public repo) | `sudo numera-update` |
| Stop everything | `sudo systemctl stop numera-tunnel numera-engine numera-keeper` |
| Start again | `sudo systemctl start numera-engine numera-keeper numera-tunnel` |
| Stop the keeper only (the engine keeps quoting) | `sudo systemctl stop numera-keeper` |
| Take the API offline but keep the server | `sudo systemctl stop numera-tunnel` |

**After a pool redeploy** the engine and keeper read the addresses from `deployments/testnet-v2.json` in the checkout
at start. Push the new file to the public repo, run `sudo numera-update` (pulls, restarts, waits for `/health`), and
redeploy the app (`node scripts/deploy-app.mjs --prod --yes`, its addresses are built in from the same file via
`npm --prefix app run sync`, committed first). `/health` should list the new pool.

**Rotate a key.** Quote signer: set the new `QUOTE_SIGNER_KEY` in `/etc/numera/numera.env`, restart the engine
(`sudo systemctl restart numera-engine`), and make the pools accept the new signer address with the owner's
`queueSetQuoteSigner` (then apply after the config delay; contracts, founder-run); until then quotes revert on chain. Keeper: set the new `KEEPER_KEY`,
fund its address with testnet HYPE, `sudo systemctl restart numera-keeper`. If a key may have leaked, treat the old
one as dead on the pools first. Never paste a key into a terminal command line or a chat: it lands in history. Edit
the file with `nano`.

**Rotate the tunnel.** `sudo -u numera -H cloudflared tunnel login` again, create a new tunnel, `route dns --overwrite-dns`,
`sudo numera-tunnel-config`, restart `numera-tunnel`, then `cloudflared tunnel delete` the old one.

## How the safety rules are met

- Testnet only: `numera-engine` and `numera-keeper` run `preflight.sh` first and refuse to start unless
  `NUMERA_CHAIN_ID=998` and `NUMERA_ENV=testnet`; the engine also refuses when the RPC answers another chain id, the
  keeper never runs on 999.
- Rate limit per real visitor: uvicorn runs with `--no-proxy-headers`; the engine trusts only `127.0.0.1`/`::1`
  (cloudflared on the same host) and then keys on `CF-Connecting-IP`. With `NUMERA_PROXY_MODE=proxy` and no trusted
  proxy, or a client-IP header without one, the engine refuses to start (audit M1).
- CORS: only `https://app.numeralabs.xyz` (plus the local Vite dev origins).
- Key separation: the engine unit unsets `KEEPER_KEY`, the keeper unit unsets `QUOTE_SIGNER_KEY`; both run as the
  unprivileged `numera` user with a read-only system view.
- Pools are never typed anywhere: `NUMERA_POOLS` stays empty (preflight refuses it otherwise), so the engine signs only
  for the v2 pools of the deployments file and the keeper (`NUMERA_KEEPER_POOL_VERSION=v2`) watches the same ones.

## What can go wrong

- **`/health` answers locally but not at api.numeralabs.xyz.** `sudo journalctl -u numera-tunnel -n 30`. Usual causes:
  step 6 DNS record missing (an old `api` record exists: delete it in the Cloudflare DNS page and rerun `route dns`),
  or `numera-tunnel-config` not run.
- **Engine will not start.** `sudo journalctl -u numera-engine -n 30`. `numera preflight` names the variable. A
  `RateLimitProxyError` means `NUMERA_TRUSTED_PROXIES` or the proxy mode was edited wrongly; `ChainIdMismatchError`
  means an RPC answers another chain.
- **The app says the quote failed with a CORS error.** The origin in the browser address bar must equal
  `NUMERA_CORS_ORIGINS` exactly (no trailing slash, https). Restart the engine after editing.
- **`/quote` answers 500 and the browser says "Failed to fetch"; the log says `Read-only file system ... .cache`.** The
  units run with `ProtectSystem=strict`, so `/opt` is read-only and the candle cache cannot live in the checkout.
  Fixed: the units set `CacheDirectory=numera` (systemd creates `/var/cache/numera`, writable) and
  `NUMERA_CACHE_DIR=/var/cache/numera`. A cache write failure is now only a log WARNING (`candle cache disabled`),
  and any unhandled error returns a JSON 500 with the CORS header. On a server hot-fixed earlier with a drop-in
  (`ReadWritePaths=/opt/numera/engine/.cache` under `/etc/systemd/system/numera-*.service.d/`), `sudo numera-update`
  reinstalls the units and removes `cache.conf` / `cache-rw.conf` from those folders; a drop-in with another file
  name is harmless (an extra writable path) and can be deleted by hand, then `sudo systemctl daemon-reload`.
  The old `/opt/numera/engine/.cache` directory is unused and may be removed.
- **Quotes work but `buyCover` reverts.** The signer address in `/health` is not the pool's `quoteSigner`, or the pools
  were redeployed and the engine still holds the old file: `sudo numera-update`.
- **Everyone gets 429.** The real client address is not recognised: check the engine log for the
  `X-Forwarded-For` warning and confirm `NUMERA_CLIENT_IP_HEADER=CF-Connecting-IP`.
- **Keeper stops sending.** `numera-status` shows its log; "balance low" means the keeper address needs testnet HYPE.
  An RPC rate limit is handled by failover; the log names the RPC in use.
- **Server reboots.** The three units are enabled; they come back by themselves. Test once with `sudo reboot`.
- **Locked out of SSH.** The firewall only allows SSH (port 22). Use the Hetzner web console to repair it
  (`ufw status`). Do not open the engine port: the tunnel does not need it.
- **cert.pem left behind.** It can create tunnels and DNS records in your Cloudflare account: step 7 removes it.
- **A new Ubuntu release or another provider.** Written for Ubuntu 24.04 with systemd 255; other versions may need
  small changes in `setup.sh`.
