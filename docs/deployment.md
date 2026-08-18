# Deploying Companion

Three pieces, deployed differently because they have different shapes:

| Piece | Where it runs | Why |
|---|---|---|
| **Relay** | Render (web service) | Long-lived process holding WebSocket connections + in-memory routing state |
| **Web app** | Vercel | Static PWA build — nothing to run |
| **Daemon** | Your own machine | It owns your Claude Code sessions; it was never going to be hosted |

## Why the relay can't be serverless

It needs three things serverless platforms structurally don't provide:

1. **Persistent WebSocket connections.** The daemon stays connected for hours. Vercel/Netlify/Lambda functions can't host a WebSocket server — there's no process alive between requests to hold the socket.
2. **Exactly one instance.** `InMemoryPubSub`, `pendingCommandAcks`, and `pendingRpcRequests` all live in process memory. Two instances means your phone can land on instance A while your daemon is on instance B, and they never see each other — commands vanish, events never arrive, intermittently, with no error anywhere. `numInstances: 1` in `render.yaml` is load-bearing. Scaling out requires a shared pub/sub backend (Redis) first.
3. **Always listening.** It must receive a daemon event and fire a push while your phone is asleep.

Cloudflare Workers + Durable Objects could do it, but only after rewriting the relay off Node's `ws` and Express.

## Order matters

There's a circular dependency: the relay needs the web app's origin for CORS, and the web app needs the relay's URL baked into its build. Deploy the relay first with CORS unset, then the web app, then come back and set CORS. Steps 1-6 below do that in the right order.

---

## 1. Generate the push keys

**Run this in your own terminal** — the private key is a real credential and shouldn't pass through a chat window:

```bash
npm run generate:vapid -- mailto:your@email.com
```

Keep the output open; you'll paste all three values into Render in step 3.

Without all three, the relay starts, logs one warning, and serves `404` from `/push/vapid-public-key` — so the browser can't subscribe and **no notification is ever delivered**. This is the single most common reason a deployment that looks fine never notifies anyone.

Generate once. Rotating the keypair invalidates every existing browser subscription.

## 2. Push this branch to GitHub

Both platforms deploy from a repo. If `origin` isn't set up yet, create an empty **private** repo and push.

## 3. Deploy the relay to Render

1. Render dashboard → **New** → **Blueprint** → select this repo. It reads `render.yaml` and creates the `companion-relay` service with the right build/start commands, health check, and single-instance pin.
2. Render prompts for the secrets marked `sync: false`. Set:
   - `DATABASE_URL` — your Neon connection string (the same one the relay uses locally; the schema already exists there, and migrations run on boot)
   - `CLERK_SECRET_KEY` — from your Clerk dashboard
   - the three `COMPANION_RELAY_VAPID_*` values from step 1
   - `COMPANION_RELAY_CORS_ORIGIN` — **leave blank for now**, you don't know the web origin yet
3. Deploy. Note the URL, e.g. `https://companion-relay.onrender.com`.
4. Confirm it's alive: `curl https://companion-relay.onrender.com/health` → `{"status":"ok"}`.

`NODE_ENV=production` and `COMPANION_RELAY_TRUST_PROXY=1` are already set in the blueprint. The trust-proxy value matters: Render terminates TLS and forwards over one hop, and without it every IP-keyed rate limiter collapses into one shared bucket for the whole internet.

## 4. Deploy the web app to Vercel

1. Vercel → **Add New Project** → import the repo. `vercel.json` supplies the build command, output directory, and SPA rewrite.
2. Add environment variables (**Production**):
   - `VITE_CLERK_PUBLISHABLE_KEY` — your Clerk publishable key
   - `VITE_RELAY_HTTP_URL` — the Render URL from step 3, no trailing slash
3. Deploy. Note the URL, e.g. `https://companion-web.vercel.app`.

These are baked in at **build** time, not read at runtime — changing them later needs a redeploy, not a restart.

You don't need to set the WebSocket URL: `config.ts` derives `wss://` from `https://` automatically. That default exists because setting only the HTTP URL used to leave the socket on `ws://localhost`, which an HTTPS page blocks as mixed content — presenting as an app stuck on "reconnecting…" forever with nothing explaining why.

## 5. Close the CORS loop

Back in Render → the service → **Environment** → set:

```
COMPANION_RELAY_CORS_ORIGIN = https://companion-web.vercel.app
```

Exact origin. No trailing slash, no path. Save; Render redeploys. Until this is set, the browser refuses every request to the relay.

## 6. Point your daemon at the deployed relay

On your own machine:

```bash
COMPANION_RELAY_URL=https://companion-relay.onrender.com
```

Then re-pair: the device token you have is bound to the local relay's database. Open the web app on your phone, get a pairing code, and pair the daemon against the deployed relay.

---

## Verify it actually works

The only test that counts, in order:

1. Open the web app **on your phone** and sign in.
2. Allow notifications when prompted. If no prompt appears, push is misconfigured — check `/push/vapid-public-key` returns a key, not 404.
3. Pair your daemon and start a session.
4. Put the phone down, screen off.
5. Let Claude finish a turn.
6. **A notification should arrive.** Tapping it should open that session — that's the SPA rewrite in `vercel.json` doing its job; without it, the deep link 404s.

## Known trade-off: Render's free tier sleeps

Free services spin down after ~15 minutes idle. When that happens your daemon's socket drops, it buffers events instead of discarding them, retries with backoff, wakes the relay on reconnect, and replays everything.

**Practical effect:** a notification can be late by roughly one cold start (~30-60s). Nothing is lost — you get the event, just delayed. Before the reliable-transport work, those events would simply have been destroyed.

If the delay becomes annoying, move the relay to an always-on host (Oracle Cloud's Always Free ARM VM is the natural next step — permanently free, no sleep). The relay itself needs no changes; only where it runs.

## When something doesn't work

| Symptom | Cause |
|---|---|
| Browser requests all fail | `COMPANION_RELAY_CORS_ORIGIN` missing or doesn't match the web origin exactly |
| Stuck on "reconnecting…" forever | Relay asleep (wait ~60s) or `VITE_RELAY_HTTP_URL` wrong — it's baked in at build time |
| No notification permission prompt | VAPID keys unset — `/push/vapid-public-key` returns 404 |
| Notification arrives, tapping it 404s | SPA rewrite missing from `vercel.json` |
| Rate limits trip for everyone at once | `COMPANION_RELAY_TRUST_PROXY` not set to 1 |
| Relay won't start | `NODE_ENV` unset with no trust-proxy value — deliberate, there's no safe default |
