import { newId, json } from '../lib/db.js';
import { createContribution } from './contributions.js';
import { refreshDashboardCache } from '../lib/kv.js';

// Generates a time-boxed, signed Cloudflare Stream token for a paid diaspora contribution.
export async function generateDiasporaStreamToken(env, { contributionId, premiereCity, validFrom, validUntil, maxConcurrent }) {
  const videoId = premiereCity === 'harare' ? env.PREMIERE_VIDEO_ID_HARARE : env.PREMIERE_VIDEO_ID_BULAWAYO;

  const streamResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/${videoId}/token`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_STREAM_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exp: Math.floor(new Date(validUntil).getTime() / 1000),
        nbf: Math.floor(new Date(validFrom).getTime() / 1000),
      }),
    }
  );
  const { result } = await streamResponse.json();

  const id = newId('stream');
  await env.DB.prepare(`
    INSERT INTO diaspora_streams (id, contribution_id, stream_token, premiere_city, valid_from, valid_until, max_concurrent_views)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, contributionId, result.token, premiereCity, validFrom, validUntil, maxConcurrent || 1).run();

  return { streamUrl: `https://customer-xxxx.cloudflarestream.com/${result.token}/watch` };
}

export async function handleDiaspora(request, { env, user }) {
  const url = new URL(request.url);
  const method = request.method;

  // POST /api/diaspora/stream-token  (admin-triggered, after a diaspora contribution is confirmed)
  if (method === 'POST' && url.pathname === '/api/diaspora/stream-token') {
    const body = await request.json();
    const result = await generateDiasporaStreamToken(env, body);
    return json(result, { status: 201 });
  }

  // GET /api/diaspora/shipments
  if (method === 'GET' && url.pathname === '/api/diaspora/shipments') {
    const { results } = await env.DB.prepare('SELECT * FROM diaspora_merch_shipments ORDER BY ship_by_date ASC').all();
    return json(results);
  }

  // POST /api/diaspora/shipments  { host_contribution_id, destination_country, destination_city, item_counts }
  // ship_by_date defaults to the locked cutoff (30 Oct 2026) unless overridden.
  if (method === 'POST' && url.pathname === '/api/diaspora/shipments') {
    const b = await request.json();
    const id = newId('ship');
    await env.DB.prepare(`
      INSERT INTO diaspora_merch_shipments (id, host_contribution_id, destination_country, destination_city, item_counts, ship_by_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, b.host_contribution_id, b.destination_country, b.destination_city,
      JSON.stringify(b.item_counts || {}), b.ship_by_date || env.DIASPORA_MERCH_CUTOFF).run();
    return json({ id }, { status: 201 });
  }

  return json({ error: 'not found' }, { status: 404 });
}

// Paynow webhook handler — shared entry point for tickets, merch, contributions, diaspora streams.
// Wire this to a public (unauthenticated) route in index.js, e.g. POST /webhooks/paynow
export async function handlePaynowWebhook(request, env) {
  const payload = await request.formData();
  const reference = payload.get('reference');
  const status = payload.get('status');
  if (status !== 'Paid') return new Response('ignored');

  // The pending order was stashed in KV when checkout started (see public checkout flow).
  const pending = await env.OUTREACH_KV.get(`pending_payment:${reference}`, 'json');
  if (!pending) return new Response('unknown reference', { status: 404 });

  if (pending.type === 'contribution') {
    const result = await createContribution(env, { ...pending, payment_ref: reference });
    if (result.error === 'SOLD_OUT') {
      return new Response('sold out — refund required', { status: 409 });
    }
    if (pending.tier?.startsWith('diaspora') && pending.premiere_city) {
      await generateDiasporaStreamToken(env, {
        contributionId: result.id,
        premiereCity: pending.premiere_city,
        validFrom: pending.stream_valid_from,
        validUntil: pending.stream_valid_until,
        maxConcurrent: pending.tier === 'diaspora_host' ? 25 : 1,
      });
    }
  } else if (pending.type === 'ticket') {
    await env.DB.prepare(`
      INSERT INTO ticket_sales (id, buyer_name, buyer_phone, city, quantity, amount, payment_ref, sold_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(newId('ticket'), pending.buyer_name, pending.buyer_phone, pending.city, pending.quantity, pending.amount, reference, 'website').run();
  } else if (pending.type === 'merch') {
    await env.DB.prepare(`
      INSERT INTO merch_sales (id, buyer_name, buyer_phone, item, quantity, amount, payment_ref, sold_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(newId('merch'), pending.buyer_name, pending.buyer_phone, pending.item, pending.quantity, pending.amount, reference, 'website').run();
  }

  await refreshDashboardCache(env);
  await env.OUTREACH_KV.delete(`pending_payment:${reference}`);
  return new Response('ok');
}
