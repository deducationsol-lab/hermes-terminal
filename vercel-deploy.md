# Vercel deploy checklist

A concise, actionable pre-deploy checklist for deploying this app to Vercel.
The local `npm start` server is unchanged; the Vercel path is additive and
strictly domain-agnostic. See the main [README](README.md) for background on
why the transport differs on Vercel and the known limitations of the SSE path.

## 1. Create an Upstash Redis database and set the env vars

The serverless functions are stateless, so they back their per-channel state
with an external **Upstash Redis** store. **The deploy returns `500` on
`/api/ingest` and `/api/stream` until both env vars below are set** (the
liveness probe in step 3 still works without them).

1. Create an **Upstash Redis** database and copy its **REST URL** and **REST
   token** (the REST credentials, not the native Redis connection string).
2. In **Vercel → Project → Settings → Environment Variables**, add both (see
   [`.env.example`](.env.example)):

   | Variable                   | Description                              |
   | -------------------------- | ---------------------------------------- |
   | `UPSTASH_REDIS_REST_URL`   | REST endpoint URL of the Upstash store.  |
   | `UPSTASH_REDIS_REST_TOKEN` | REST access token for the Upstash store. |

3. Add them to the environments you deploy (Production, and Preview if you use
   preview deployments). Redeploy after changing env vars so they take effect.

## 2. Confirm the project configuration

- **Framework Preset = Other.** This is not a Next.js/framework app; there is
  no framework build step.
- **Functions live in `api/`.** `api/ingest.ts`, `api/stream.ts`, and
  `api/healthz.ts` are the serverless functions. `vercel.json` registers each
  explicitly with non-overlapping patterns.
- **Static assets live in `public/`.** `vercel.json` sets
  `"outputDirectory": "public"` and rewrites `/` to `/index.html`, so the
  dashboard is served from the site root.
- **No build output is required** for the static site; `tsc` type-checks the
  functions (`npm run build` must stay zero-error) but Vercel builds the
  functions from `api/` directly.

## 3. Verify the deploy is healthy

Run these against your deployed URL (replace `your-app.vercel.app`).

1. **Liveness probe** — confirms the deployment is up and routing to the
   functions, independent of Redis:

   ```bash
   curl -s https://your-app.vercel.app/api/healthz
   # => {"status":"ok"}
   ```

   If this fails, the deployment or routing is broken (not a Redis issue).

2. **Post a test event** — confirms ingest and the Upstash env vars are wired:

   ```bash
   curl -s -X POST https://your-app.vercel.app/api/ingest \
     -H 'content-type: application/json' \
     -d '{"channel":"desk","level":"info","message":"hello from curl"}'
   # => the stored event JSON, including server-assigned seq and ts
   ```

   A `500` here almost always means the two `UPSTASH_REDIS_REST_*` env vars are
   missing or wrong (step 1).

3. **Open the dashboard** on that channel and confirm the event appears:

   ```
   https://your-app.vercel.app/?channel=desk
   ```

   The dashboard auto-detects the Vercel host and streams over **SSE**
   (`/api/stream`); allow ~1s for the first poll to surface the event.

## 4. Point the sim-desk demo at the deployed URL

The [`examples/sim-desk/`](examples/sim-desk/README.md) demo streams to the
deployed app over `/api/ingest`. Its client **auto-detects** local vs. hosted
from the base URL (a `*.vercel.app` host, or any remote HTTPS host, uses
`/api/ingest`; `localhost` uses `/ingest`):

```bash
cd examples/sim-desk
python3 sim_desk.py sim --no-ui --duration 30 --channel desk \
  --hermes-url https://your-app.vercel.app
```

If auto-detection ever guesses wrong, force the path explicitly:

```bash
# force the hosted path:
python3 sim_desk.py sim --hermes-url https://your-app.vercel.app --hosted
# or force the local path:
python3 sim_desk.py sim --hermes-url http://localhost:4000 --local
# or set it exactly:
python3 sim_desk.py sim --hermes-url https://your-app.vercel.app --ingest-path /api/ingest
```

Then open `https://your-app.vercel.app/?channel=desk` to watch it stream. The
client is **fail-soft**: a wrong or unreachable endpoint never crashes the sim,
it just logs a local warning.

## 5. Know the SSE limitation

The Vercel dashboard streams over **Server-Sent Events**, which is a
REST-and-polling approximation of the local push-based WebSocket ring buffer,
**not** Redis pub/sub (a connectionless REST client cannot hold a blocking
subscribe). Consequences to be aware of:

- **~1s latency.** The stream re-reads the per-channel list about once per
  second and forwards only newer events, so live events arrive with up to a
  poll interval of delay.
- **Burst loss past the list cap.** The per-channel list is capped (`LIST_CAP`,
  500). If **more than ~500 events are appended to one channel between two
  polls**, the oldest unseen events are trimmed before the client reads them and
  the client sees a seq gap. Channels whose peak exceeds that should raise
  `LIST_CAP` or shorten the poll interval in `api/stream.ts`.

For high-throughput or zero-latency needs, run the local `npm start` server
(WebSocket fan-out) instead.
