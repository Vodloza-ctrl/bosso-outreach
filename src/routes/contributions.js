import { newId, json } from '../lib/db.js';
import { refreshDashboardCache } from '../lib/kv.js';

// Tiers that draw from a capped slot pool, keyed by city/hub.
// e.g. tier 'siyinqaba' + city 'bulawayo' -> cap key 'siyinqaba_bulawayo'
const CAPPED_TIERS = new Set(['siyinqaba', 'boardroom', 'diaspora_host']);

function capKeyFor(tier, city) {
  if (!CAPPED_TIERS.has(tier)) return null;
  if (tier === 'diaspora_host') {
    // city holds the hub name for diaspora hosts: 'uk' | 'sa' | 'australia'
    return `diaspora_host_${city}`;
  }
  return `${tier}_${city}`; // siyinqaba_bulawayo, boardroom_harare, etc.
}

// Physical rewards seeded per tier — used to auto-create fulfilment rows.
const TIER_ITEMS = {
  amahlolanyama: [],
  ezikabosso: ['signed_card'],
  asisozasala: ['signed_card', 't-shirt', 'steel_cup'],
  siyinqaba: ['signed_card', 't-shirt', 'steel_cup', 'premiere_ticket'],
  boardroom: ['signed_card', 't-shirt', 'steel_cup', 'premiere_ticket'], // x4, handled by quantity below
  diaspora_solo: [],
  diaspora_host: ['bulk_merch_pack'],
};

export async function createContribution(env, data) {
  const capKey = capKeyFor(data.tier, data.city);

  if (capKey) {
    const cap = await env.DB.prepare('SELECT * FROM tier_caps WHERE tier = ?').bind(capKey).first();
    if (!cap) return { error: 'UNKNOWN_TIER_CAP', capKey };
    if (cap.slots_taken >= cap.max_slots) return { error: 'SOLD_OUT', tier: capKey };
  }

  const id = newId('contrib');
  await env.DB.prepare(`
    INSERT INTO contributions (id, contributor_name, contributor_phone, contributor_email, tier, amount, city, payment_ref, source, show_on_supporter_wall)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, data.contributor_name, data.contributor_phone || null, data.contributor_email || null,
    data.tier, data.amount, data.city || null, data.payment_ref || null, data.source || 'website',
    data.show_on_supporter_wall === false ? 0 : 1
  ).run();

  if (capKey) {
    await env.DB.prepare('UPDATE tier_caps SET slots_taken = slots_taken + 1 WHERE tier = ?').bind(capKey).run();
    const updated = await env.DB.prepare('SELECT slots_taken FROM tier_caps WHERE tier = ?').bind(capKey).first();
    await env.DB.prepare('UPDATE contributions SET premiere_slot_number = ? WHERE id = ?').bind(updated.slots_taken, id).run();
  }

  const items = TIER_ITEMS[data.tier] || [];
  for (const item of items) {
    await env.DB.prepare('INSERT INTO contribution_fulfilment (id, contribution_id, item) VALUES (?, ?, ?)')
      .bind(newId('fulfil'), id, item).run();
  }

  await refreshDashboardCache(env);
  return { id };
}

export async function handleContributions(request, { env, user }) {
  const url = new URL(request.url);
  const method = request.method;

  if (method === 'GET' && url.pathname === '/api/contributions') {
    const tier = url.searchParams.get('tier');
    let query = 'SELECT * FROM contributions WHERE 1=1';
    const binds = [];
    if (tier) { query += ' AND tier = ?'; binds.push(tier); }
    query += ' ORDER BY created_at DESC';
    const { results } = await env.DB.prepare(query).bind(...binds).all();
    return json(results);
  }

  // Manual/admin-entered contribution (e.g. logged from a braai cash payment).
  // Real public checkout should go through the Paynow webhook flow instead — see routes/diaspora.js pattern.
  if (method === 'POST' && url.pathname === '/api/contributions') {
    const body = await request.json();
    const result = await createContribution(env, { ...body, source: body.source || 'manual' });
    if (result.error) return json(result, { status: 409 });
    return json(result, { status: 201 });
  }

  if (method === 'GET' && url.pathname === '/api/tier-caps') {
    const { results } = await env.DB.prepare('SELECT * FROM tier_caps').all();
    return json(results);
  }

  return json({ error: 'not found' }, { status: 404 });
}
