# Ghorpadi Gate Alert 🚦

A real-time commute assistant that tells you which route to take to avoid
the Ghorpadi railway level crossing when it's down — before you even leave
the house.

## The problem

Commuting from Amanora to AISSMS College of Engineering (Pune), there are
two routes:
- **Ghorpadi route** — shorter, but blocked whenever the railway level
  crossing gate closes for a passing train.
- **Koregaon Park route** — longer, but unaffected by the gate.

There's no public API that reports a specific level crossing's gate
status. So instead, this project **infers** it: when the gate is down,
traffic backs up on the Ghorpadi route, and that shows up as an inflated
live ETA from Google Maps. By comparing the two routes' live traffic-aware
travel times, the bot can recommend whichever is actually faster right
now — with no manual gate-status data feed needed.

## How it works

```
Telegram message  ─┐
(anyone, anytime)  │
                    ▼
          Cloudflare Worker (webhook)
                    │
       ┌────────────┼─────────────┐
       ▼            ▼             ▼
  Subscriber    Google Maps     Reply
  storage (KV)  Directions API  instantly
                                (< 1 sec)

Cloudflare Cron Trigger (daily, 7:55 AM IST)
                    │
                    ▼
       Broadcasts status to every subscriber
```

- **Instant replies**: message the bot anytime and get the current route
  status back in under a second, via a Telegram webhook running on
  Cloudflare Workers (no polling, no delay).
- **Auto-subscription**: anyone who messages the bot is automatically
  added to the daily 8 AM broadcast list — no manual chat-ID lookup
  needed. Texting "stop" unsubscribes.
- **Live route comparison**: on every check, it pulls live traffic-aware
  ETAs for both routes from the Google Maps Directions API and
  recommends whichever is actually faster — not just whichever is
  "usually" faster.
- **Gate-down detection**: flags when the Ghorpadi route is running
  meaningfully slower than its historical baseline, as a signal the gate
  is likely closed.

## Tech stack

- **Cloudflare Workers** — serverless compute, runs the webhook + daily
  cron job with no server to manage.
- **Cloudflare KV** — stores the subscriber list and message log.
- **Google Maps Directions API** — live, traffic-aware route data.
- **Telegram Bot API** — messaging layer (webhook-based, sub-second
  delivery).

## Project structure

```
.
├── src/
│   └── index.js        # Worker: webhook handler + daily broadcast + route logic
├── wrangler.toml        # Cloudflare Worker config (KV binding, cron schedule)
└── README.md
```

## Setup

1. Install [Node.js](https://nodejs.org) and the Cloudflare CLI:
   ```bash
   npm install -g wrangler
   ```
2. Clone this repo and log in to Cloudflare:
   ```bash
   npx wrangler login
   ```
3. Create the KV namespace and add its ID to `wrangler.toml`:
   ```bash
   npx wrangler kv namespace create SUBSCRIBERS
   ```
4. Add secrets:
   ```bash
   npx wrangler secret put GOOGLE_MAPS_API_KEY
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   ```
5. Deploy:
   ```bash
   npx wrangler deploy
   ```
6. Point your Telegram bot's webhook at the deployed URL:
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=<your-worker-url>
   ```

## Roadmap

- [ ] WhatsApp notifications via Meta's WhatsApp Business API
- [ ] Standalone mobile app (React Native / Flutter)
- [ ] Historical accuracy tracking (👍/👎 feedback loop)
- [ ] Expand to more routes/commuters using Google Places & Geocoding APIs

## Why this project

Built to solve a genuine daily annoyance — deciding between two commute
routes before knowing whether a level crossing gate is down — using a
fully serverless, real-time architecture rather than a fixed schedule or
manual check.
