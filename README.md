# The Bosso Movie — Outreach & Fundraising Tool

Cloudflare Worker + D1 + KV + R2. Matches the schema already live in your `bosso` D1 database.

## What's built here

- Full API: partners CRUD, contributions with tier-cap enforcement, templates + email
  sending (Cloudflare Email Workers), WhatsApp draft-and-copy (no API automation, by decision),
  AI draft-assist (Anthropic API), dashboard (admin vs. team-member visibility split),
  diaspora streaming tokens + merch shipment tracking, Paynow webhook handling.
- Public tier page (`public/index.html`) in the locked black/white/red palette, wired to
  live slot availability and Paynow checkout.

## One-time setup

1. **Install dependencies**
   ```
   npm install
   ```

2. **Confirm your D1 database ID and KV namespace ID**, then fill them into `wrangler.toml`:
   ```
   wrangler d1 list          # find your "bosso" database id
   wrangler kv namespace create OUTREACH_KV
   ```

3. **Create the R2 bucket** (if not already created):
   ```
   wrangler r2 bucket create bosso-outreach-assets
   ```

4. **Set secrets** (never hardcode these):
   ```
   wrangler secret put ANTHROPIC_API_KEY
   wrangler secret put PAYNOW_INTEGRATION_ID
   wrangler secret put PAYNOW_INTEGRATION_KEY
   ```

5. **Set up Cloudflare Email Workers**: verify your sending domain under
   Email > Email Routing in the dashboard, enable the Email Workers feature,
   then add the `send_email` binding to `wrangler.toml` (see comment in
   `src/lib/email.js` for the exact block). Update the sender address in
   `src/lib/email.js` to match your verified domain.

6. **Set up Cloudflare Access** (Zero Trust) in front of this Worker's routes,
   restricted to your email only, since you're the sole admin for now. This
   replaces any custom login system — the Worker reads the
   `Cf-Access-Authenticated-User-Email` header directly.

7. **Cloudflare Stream**: upload the two premiere recordings (or set up live
   input if streaming live) and note their video IDs — set as
   `PREMIERE_VIDEO_ID_BULAWAYO` / `PREMIERE_VIDEO_ID_HARARE` vars, plus
   `CF_ACCOUNT_ID` and `CF_STREAM_API_TOKEN` as secrets.

8. **Apply the schema** (safe to re-run, everything is `IF NOT EXISTS`):
   ```
   npm run db:migrate
   ```

9. **Deploy**:
   ```
   npm run deploy
   ```

10. **Deploy the public tier page**: `public/index.html` can be served as a
    Cloudflare Pages project, or from this same Worker via a static assets
    binding — either works, just make sure its fetch calls point at your
    deployed Worker's `/api/public/...` routes.

## Interim setup while your domain purchase is pending

You don't need a custom domain to use this today:

1. **Deploy now on the free `*.workers.dev` subdomain** — `wrangler deploy` (or the
   dashboard equivalent) gives you a working URL immediately, e.g.
   `bosso-outreach-tool.yasibomedia.workers.dev`. No domain required.
2. **Cloudflare Access works on that URL too** — set it up restricted to your
   email now; nothing changes when the real domain arrives, you just add it
   as an additional route later.
3. **Email sending is manual until the domain verifies.** Use:
   - `POST /api/outreach/email-draft` — renders the filled subject/body +
     attachment names, ready to paste into Gmail (`yasibomedia@gmail.com`).
     Sends nothing itself.
   - `POST /api/outreach/email-sent` — call this once you've actually sent
     it from Gmail, to log the exact record in `outreach_log`. This produces
     an identical record to the automated flow, so your outreach history
     stays complete and consistent regardless of which mechanism was used.
   - Once Cloudflare Email Workers is verified against your new domain,
     switch corporate outreach back to the automated `POST /api/outreach/send`
     route — no schema or history changes needed, the two paths write to the
     same table in the same shape.
4. Everything else — partners CRUD, templates, AI draft-assist, dashboard,
   pipeline, WhatsApp draft-and-copy — works exactly the same with or
   without a custom domain.

## Notes on decisions already locked in

- **No WhatsApp Business API.** `src/lib/whatsapp.js` only prepares
  copy-ready drafts + attachment links. Sending itself happens manually from
  your own WhatsApp number; call `/api/outreach/whatsapp-sent` afterward to
  log the record.
- **Single admin (you).** The `role` column exists for future team members,
  but there's no permission UI to build right now — just add rows to `users`
  with `role = 'team_member'` when you're ready to bring people on.
- **Diaspora merch cutoff:** hardcoded default of `2026-10-30` via the
  `DIASPORA_MERCH_CUTOFF` var, used as the default `ship_by_date` on new
  shipment records unless overridden per-shipment.
- **Brand palette:** black `#0a0a0a`, white `#ffffff`, red `#c8102e`
  (placeholder — confirm against Highlanders' official brand guide and
  update in `public/index.html`).
- **Campaign name:** never reference "Bosso at 100" or "centenary" anywhere —
  see the hard rule baked into the AI system prompt in `src/routes/ai.js`.
