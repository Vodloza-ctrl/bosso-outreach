// ============================================================================
// THE BOSSO MOVIE — OUTREACH TOOL — UNIVERSAL WORKER (single file)
// ============================================================================
// This is the entire app (routing + lib + all routes) collapsed into one
// file so it can be pasted straight into the Cloudflare dashboard's Worker
// editor — no build step, no npm install, no Wrangler CLI needed.
//
// The only change from the multi-file version: the `mimetext` npm package
// (used to build the outgoing email) has been replaced with a small
// hand-rolled MIME builder near the top, since the dashboard editor can't
// pull in npm dependencies. Everything else is functionally identical.
//
// BEFORE DEPLOYING, set these up in the dashboard on this Worker:
//   Bindings:
//     D1 database         -> binding name: DB              (database: bosso)
//     KV namespace        -> binding name: OUTREACH_KV
//     R2 bucket           -> binding name: ASSET_FILES      (bucket: bosso-outreach-assets)
//                            NOTE: do NOT name this binding "ASSETS" — if you deploy
//                            public/index.html via Cloudflare's static-assets build
//                            (Build output directory = public), that feature claims
//                            the binding name "ASSETS" for itself. Two bindings sharing
//                            one name silently breaks one of them, so this R2 bucket
//                            binding is deliberately named ASSET_FILES instead.
//     Email binding       -> binding name: SEND_EMAIL       (Settings > Email Workers, after verifying your sending domain)
//   Variables (plain text):
//     CAMPAIGN_START = 2026-08-24
//     CAMPAIGN_END   = 2026-10-15
//     DIASPORA_MERCH_CUTOFF = 2026-10-30
//   Variables (encrypted / secret):
//     ANTHROPIC_API_KEY
//     PAYNOW_INTEGRATION_ID
//     PAYNOW_INTEGRATION_KEY
//     CF_ACCOUNT_ID
//     CF_STREAM_API_TOKEN
//     PREMIERE_VIDEO_ID_HARARE
//     PREMIERE_VIDEO_ID_BULAWAYO
//   Cloudflare Access:
//     Put this Worker's route behind Access so it injects the
//     Cf-Access-Authenticated-User-Email header for everything except the
//     /api/public/* and /webhooks/paynow paths (those stay public below).
//   Custom domain / route:
//     Attach outreach.yourdomain.co.zw/* (or your real domain) to this Worker.
// ============================================================================

import { EmailMessage } from 'cloudflare:email';

// ---------------------------------------------------------------------------
// SECTION 1 — small shared helpers (was src/lib/db.js)
// ---------------------------------------------------------------------------

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function getUserByEmail(env, email) {
  return env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
}

async function logActivity(env, { linkedTable, linkedId, userId, type, notes, nextAction, nextActionDate }) {
  await env.DB.prepare(`
    INSERT INTO activities (id, linked_table, linked_id, user_id, type, notes, next_action, next_action_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(newId('act'), linkedTable, linkedId, userId, type, notes || null, nextAction || null, nextActionDate || null).run();
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...(init.headers || {}),
    },
  });
}

// ---------------------------------------------------------------------------
// SECTION 2 — dashboard cache (was src/lib/kv.js)
// ---------------------------------------------------------------------------

async function refreshDashboardCache(env) {
  const [partners, contributions, tickets, merch] = await Promise.all([
    env.DB.prepare(`
      SELECT track, status, SUM(value_actual) AS total, SUM(in_kind_value) AS in_kind, COUNT(*) AS count
      FROM partners GROUP BY track, status
    `).all(),
    env.DB.prepare(`SELECT tier, SUM(amount) AS total, COUNT(*) AS count FROM contributions GROUP BY tier`).all(),
    env.DB.prepare(`SELECT SUM(amount) AS total, SUM(quantity) AS qty FROM ticket_sales`).all(),
    env.DB.prepare(`SELECT SUM(amount) AS total FROM merch_sales`).all(),
  ]);

  const goals = await env.DB.prepare('SELECT * FROM goals').all();

  const summary = {
    partners: partners.results,
    contributions: contributions.results,
    tickets: tickets.results,
    merch: merch.results,
    goals: goals.results,
    computed_at: Date.now(),
  };

  await env.OUTREACH_KV.put('dashboard_summary', JSON.stringify(summary), { expirationTtl: 300 });
  return summary;
}

async function getCachedDashboard(env) {
  const cached = await env.OUTREACH_KV.get('dashboard_summary', 'json');
  return cached || refreshDashboardCache(env);
}

// ---------------------------------------------------------------------------
// SECTION 3 — email (was src/lib/email.js, minus the `mimetext` npm package)
// ---------------------------------------------------------------------------
// Hand-rolled MIME builder: plain text body, optional attachments.
// This replaces `createMimeMessage()` from the `mimetext` package so the
// whole app has zero npm dependencies and can be pasted as one file.

function buildRawMime({ fromName, fromAddr, to, subject, body, attachments = [] }) {
  const boundary = `----bosso-${crypto.randomUUID()}`;
  const headers = [
    `From: "${fromName}" <${fromAddr}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
  ];

  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    return `${headers.join('\r\n')}\r\n\r\n${body}`;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  let raw = `${headers.join('\r\n')}\r\n\r\n`;
  raw += `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}\r\n\r\n`;

  for (const att of attachments) {
    raw += `--${boundary}\r\n`;
    raw += `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n`;
    raw += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
    raw += 'Content-Transfer-Encoding: base64\r\n\r\n';
    // Wrap base64 at 76 chars per line, per MIME convention.
    raw += `${att.base64Data.replace(/(.{76})/g, '$1\r\n')}\r\n\r\n`;
  }
  raw += `--${boundary}--`;
  return raw;
}

async function sendEmail(env, { to, subject, body, attachments = [] }) {
  const fromAddr = 'partnerships@yourdomain.co.zw'; // replace with your verified sending address
  const raw = buildRawMime({
    fromName: 'The Bosso Movie',
    fromAddr,
    to,
    subject: subject || 'The Bosso Movie — Partnership',
    body,
    attachments,
  });

  const message = new EmailMessage(fromAddr, to, raw);
  await env.SEND_EMAIL.send(message);
}

async function loadAttachmentFromR2(env, asset) {
  const object = await env.ASSET_FILES.get(asset.file_key);
  if (!object) throw new Error(`Asset not found in R2: ${asset.file_key}`);
  const buf = await object.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64Data = btoa(binary);
  return {
    filename: asset.name,
    mimeType: asset.file_type === 'pdf' ? 'application/pdf' : 'image/jpeg',
    base64Data,
  };
}

// ---------------------------------------------------------------------------
// SECTION 4 — WhatsApp (manual-send pattern) (was src/lib/whatsapp.js)
// ---------------------------------------------------------------------------

async function prepareWhatsAppDraft(env, { attachmentIds = [], filledBody }) {
  const attachmentUrls = [];
  for (const assetId of attachmentIds) {
    const asset = await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(assetId).first();
    if (!asset) continue;
    attachmentUrls.push({ name: asset.name, url: `https://assets.yourdomain.co.zw/${asset.file_key}` });
  }
  return { text: filledBody, attachmentUrls };
}

async function markOutreachSent(env, { partnerId, templateId, finalBody, attachmentIds, sentBy }) {
  const id = newId('out');
  await env.DB.prepare(`
    INSERT INTO outreach_log (id, linked_partner_id, channel, template_id, final_body, attachments, sent_by)
    VALUES (?, ?, 'whatsapp', ?, ?, ?, ?)
  `).bind(id, partnerId, templateId || null, finalBody, JSON.stringify(attachmentIds || []), sentBy).run();

  await env.DB.prepare(`
    INSERT INTO activities (id, linked_table, linked_id, user_id, type, notes)
    VALUES (?, 'partners', ?, ?, 'whatsapp', 'Outreach sent (manual)')
  `).bind(newId('act'), partnerId, sentBy).run();

  return { id };
}

// ---------------------------------------------------------------------------
// SECTION 5 — contributions / tier caps (was src/routes/contributions.js)
// ---------------------------------------------------------------------------

const CAPPED_TIERS = new Set(['siyinqaba', 'boardroom', 'diaspora_host']);

function capKeyFor(tier, city) {
  if (!CAPPED_TIERS.has(tier)) return null;
  if (tier === 'diaspora_host') return `diaspora_host_${city}`;
  return `${tier}_${city}`;
}

const TIER_ITEMS = {
  amahlolanyama: [],
  ezikabosso: ['signed_card'],
  asisozasala: ['signed_card', 't-shirt', 'steel_cup'],
  siyinqaba: ['signed_card', 't-shirt', 'steel_cup', 'premiere_ticket'],
  boardroom: ['signed_card', 't-shirt', 'steel_cup', 'premiere_ticket'],
  diaspora_solo: [],
  diaspora_host: ['bulk_merch_pack'],
};

async function createContribution(env, data) {
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

async function handleContributions(request, { env }) {
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

// ---------------------------------------------------------------------------
// SECTION 5b — reply guides + pitching hints (previously unwired — reply_guides
// and hints existed in D1 with no route serving them at all)
// ---------------------------------------------------------------------------

async function handleReplyGuides(request, { env }) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/api/reply-guides') {
    return json({ error: 'not found' }, { status: 404 });
  }
  const trigger_status = url.searchParams.get('trigger_status');
  const track = url.searchParams.get('track');
  let query = 'SELECT * FROM reply_guides WHERE 1=1';
  const binds = [];
  if (trigger_status) { query += ' AND trigger_status = ?'; binds.push(trigger_status); }
  if (track) { query += ' AND track = ?'; binds.push(track); }
  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return json(results);
}

async function handleHints(request, { env }) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/api/hints') {
    return json({ error: 'not found' }, { status: 404 });
  }
  const context = url.searchParams.get('context');
  const track = url.searchParams.get('track');
  const tier = url.searchParams.get('tier');
  let query = 'SELECT * FROM hints WHERE 1=1';
  const binds = [];
  if (context) { query += ' AND context = ?'; binds.push(context); }
  if (track) { query += ' AND track = ?'; binds.push(track); }
  if (tier) { query += ' AND tier = ?'; binds.push(tier); }
  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return json(results);
}

// ---------------------------------------------------------------------------
// SECTION 5c — directories: in-kind partners, community reps, contributor
// wall (name + tier only — never amounts, per the "no public running total" rule)
// ---------------------------------------------------------------------------

async function handleDirectories(request, { env }) {
  const url = new URL(request.url);
  const method = request.method;

  if (method === 'GET' && url.pathname === '/api/in-kind-partners') {
    const { results } = await env.DB.prepare('SELECT * FROM in_kind_partners ORDER BY created_at DESC').all();
    return json(results);
  }
  if (method === 'POST' && url.pathname === '/api/in-kind-partners') {
    const b = await request.json();
    const id = newId('inkind');
    await env.DB.prepare(`
      INSERT INTO in_kind_partners (id, name, contribution_type, estimated_value, linked_partner_id, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(id, b.name, b.contribution_type || null, b.estimated_value || null, b.linked_partner_id || null, b.status || 'pledged', b.notes || null).run();
    return json({ id }, { status: 201 });
  }

  if (method === 'GET' && url.pathname === '/api/community-reps') {
    const { results } = await env.DB.prepare('SELECT * FROM community_reps ORDER BY created_at DESC').all();
    return json(results);
  }
  if (method === 'POST' && url.pathname === '/api/community-reps') {
    const b = await request.json();
    const id = newId('rep');
    await env.DB.prepare(`
      INSERT INTO community_reps (id, name, branch_area, phone, role, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, b.name, b.branch_area || null, b.phone || null, b.role || null, b.notes || null).run();
    return json({ id }, { status: 201 });
  }

  // Contributor directory — name + tier only, never amounts. Matches the
  // "no public running totals" rule from the strategy digest.
  if (method === 'GET' && url.pathname === '/api/directories/contributors') {
    const { results } = await env.DB.prepare(`
      SELECT contributor_name, tier, city, created_at
      FROM contributions WHERE show_on_supporter_wall = 1
      ORDER BY created_at DESC
    `).all();
    return json(results);
  }

  return json({ error: 'not found' }, { status: 404 });
}

// ---------------------------------------------------------------------------
// SECTION 5d — PR / social content calendar (content_posts had no route at all)
// ---------------------------------------------------------------------------

async function handleContentPosts(request, { env, user }) {
  const url = new URL(request.url);
  const method = request.method;

  if (method === 'GET' && url.pathname === '/api/content-posts') {
    const status = url.searchParams.get('status');
    const partner_id = url.searchParams.get('partner_id');
    let query = 'SELECT * FROM content_posts WHERE 1=1';
    const binds = [];
    if (status) { query += ' AND status = ?'; binds.push(status); }
    if (partner_id) { query += ' AND linked_partner_id = ?'; binds.push(partner_id); }
    query += ' ORDER BY COALESCE(scheduled_date, posted_date) ASC';
    const { results } = await env.DB.prepare(query).bind(...binds).all();
    return json(results);
  }

  if (method === 'POST' && url.pathname === '/api/content-posts') {
    const b = await request.json();
    const id = newId('post');
    await env.DB.prepare(`
      INSERT INTO content_posts (id, platform, post_type, linked_partner_id, status, scheduled_date, owner_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, b.platform, b.post_type || null, b.linked_partner_id || null, b.status || 'planned', b.scheduled_date || null, user.id, b.notes || null).run();
    return json({ id }, { status: 201 });
  }

  const patchMatch = url.pathname.match(/^\/api\/content-posts\/([\w-]+)$/);
  if (method === 'PATCH' && patchMatch) {
    const id = patchMatch[1];
    const b = await request.json();
    await env.DB.prepare(`
      UPDATE content_posts
      SET status = COALESCE(?, status),
          scheduled_date = COALESCE(?, scheduled_date),
          posted_date = COALESCE(?, posted_date),
          notes = COALESCE(?, notes)
      WHERE id = ?
    `).bind(b.status ?? null, b.scheduled_date ?? null, b.posted_date ?? null, b.notes ?? null, id).run();
    return json({ ok: true });
  }

  return json({ error: 'not found' }, { status: 404 });
}

// ---------------------------------------------------------------------------
// SECTION 5e — team management: admin assigns roles + partner ownership.
// Previously, POST /api/partners silently made the CREATOR the owner —
// meaning two team members could each "claim" the same lead independently,
// with no single source of truth for who's actually working it. Now:
// only an admin can assign or reassign ownership; a non-admin creating a
// partner leaves it unassigned until the admin hands it out.
// ---------------------------------------------------------------------------

async function handleTeam(request, { env, user }) {
  const url = new URL(request.url);
  const method = request.method;

  // GET /api/team — anyone logged in can see the roster (not sensitive)
  if (method === 'GET' && url.pathname === '/api/team') {
    const { results } = await env.DB.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY name').all();
    return json(results);
  }

  // POST /api/team — admin adds a team member row. Cloudflare Access still
  // controls who can actually log in; this just registers them in D1 so the
  // Worker's own lookup (getUserByEmail) recognizes them once they do.
  if (method === 'POST' && url.pathname === '/api/team') {
    if (user.role !== 'admin') return json({ error: 'admin only' }, { status: 403 });
    const b = await request.json();
    const id = newId('user');
    await env.DB.prepare('INSERT INTO users (id, name, email, role) VALUES (?, ?, ?, ?)')
      .bind(id, b.name || null, b.email, b.role || 'team_member').run();
    return json({ id }, { status: 201 });
  }

  // PATCH /api/team/:id — admin changes someone's name/role
  const roleMatch = url.pathname.match(/^\/api\/team\/([\w-]+)$/);
  if (method === 'PATCH' && roleMatch) {
    if (user.role !== 'admin') return json({ error: 'admin only' }, { status: 403 });
    const b = await request.json();
    await env.DB.prepare('UPDATE users SET role = COALESCE(?, role), name = COALESCE(?, name) WHERE id = ?')
      .bind(b.role ?? null, b.name ?? null, roleMatch[1]).run();
    return json({ ok: true });
  }

  return json({ error: 'not found' }, { status: 404 });
}

// ---------------------------------------------------------------------------
// SECTION 6 — partners / pipeline (was src/routes/partners.js)
// ---------------------------------------------------------------------------

async function handlePartners(request, { env, user }) {
  const url = new URL(request.url);
  const method = request.method;

  if (method === 'GET' && url.pathname === '/api/partners') {
    const track = url.searchParams.get('track');
    const status = url.searchParams.get('status');
    const owner = url.searchParams.get('owner'); // a user id, or 'unassigned'
    let query = 'SELECT * FROM partners WHERE 1=1';
    const binds = [];
    if (track) { query += ' AND track = ?'; binds.push(track); }
    if (status) { query += ' AND status = ?'; binds.push(status); }
    if (owner === 'unassigned') {
      query += ' AND owner_id IS NULL';
    } else if (owner) {
      query += ' AND owner_id = ?'; binds.push(owner);
    } else if (user.role !== 'admin') {
      // Team members default to seeing only what's been assigned to them.
      query += ' AND owner_id = ?'; binds.push(user.id);
    }
    query += ' ORDER BY updated_at DESC';
    const { results } = await env.DB.prepare(query).bind(...binds).all();
    return json(results);
  }

  const detailMatch = url.pathname.match(/^\/api\/partners\/([\w-]+)$/);
  if (method === 'GET' && detailMatch) {
    const id = detailMatch[1];
    const partner = await env.DB.prepare('SELECT * FROM partners WHERE id = ?').bind(id).first();
    if (!partner) return json({ error: 'not found' }, { status: 404 });
    const [activities, outreach, scenes] = await Promise.all([
      env.DB.prepare('SELECT * FROM activities WHERE linked_table = ? AND linked_id = ? ORDER BY created_at DESC')
        .bind('partners', id).all(),
      env.DB.prepare('SELECT * FROM outreach_log WHERE linked_partner_id = ? ORDER BY sent_at DESC').bind(id).all(),
      env.DB.prepare('SELECT * FROM placement_scenes WHERE linked_partner_id = ?').bind(id).all(),
    ]);
    return json({ ...partner, activities: activities.results, outreach: outreach.results, placement_scenes: scenes.results });
  }

  if (method === 'POST' && url.pathname === '/api/partners') {
    const body = await request.json();
    const id = newId('partner');
    // Ownership is admin-assigned, not self-claimed — a non-admin adding a
    // lead does NOT automatically become its owner, so two team members
    // can't each end up "owning" the same partner independently. It sits
    // unassigned until an admin hands it out via PATCH /:id/assign.
    const owner_id = user.role === 'admin' ? (body.owner_id || null) : null;
    await env.DB.prepare(`
      INSERT INTO partners (id, name, track, tier, category, contact_name, contact_phone, contact_email, value_target, owner_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, body.name, body.track, body.tier || null, body.category || null,
      body.contact_name || null, body.contact_phone || null, body.contact_email || null,
      body.value_target || 0, owner_id, body.notes || null
    ).run();
    return json({ id }, { status: 201 });
  }

  if (method === 'PATCH' && detailMatch) {
    const id = detailMatch[1];
    const body = await request.json();
    const existing = await env.DB.prepare('SELECT * FROM partners WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'not found' }, { status: 404 });

    await env.DB.prepare(`
      UPDATE partners
      SET status = COALESCE(?, status),
          value_actual = COALESCE(?, value_actual),
          in_kind_value = COALESCE(?, in_kind_value),
          notes = COALESCE(?, notes),
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(body.status ?? null, body.value_actual ?? null, body.in_kind_value ?? null, body.notes ?? null, id).run();

    if (body.status && body.status !== existing.status) {
      await logActivity(env, {
        linkedTable: 'partners', linkedId: id, userId: user.id,
        type: 'status_change', notes: `${existing.status} -> ${body.status}`,
      });
    }
    return json({ ok: true });
  }

  // PATCH /api/partners/:id/assign  { owner_id }  — admin only.
  // The single point where partner ownership actually changes hands.
  const assignMatch = url.pathname.match(/^\/api\/partners\/([\w-]+)\/assign$/);
  if (method === 'PATCH' && assignMatch) {
    if (user.role !== 'admin') return json({ error: 'admin only — only the producer assigns ownership' }, { status: 403 });
    const id = assignMatch[1];
    const b = await request.json();
    await env.DB.prepare("UPDATE partners SET owner_id = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(b.owner_id || null, id).run();
    await logActivity(env, {
      linkedTable: 'partners', linkedId: id, userId: user.id,
      type: 'status_change', notes: b.owner_id ? `Assigned to ${b.owner_id}` : 'Unassigned',
    });
    return json({ ok: true });
  }

  const activityMatch = url.pathname.match(/^\/api\/partners\/([\w-]+)\/activity$/);
  if (method === 'POST' && activityMatch) {
    const id = activityMatch[1];
    const body = await request.json();
    await logActivity(env, {
      linkedTable: 'partners', linkedId: id, userId: user.id,
      type: body.type, notes: body.notes, nextAction: body.next_action, nextActionDate: body.next_action_date,
    });
    return json({ ok: true }, { status: 201 });
  }

  return json({ error: 'not found' }, { status: 404 });
}

// ---------------------------------------------------------------------------
// SECTION 7 — outreach (templates, send, drafts, history) (was src/routes/outreach.js)
// ---------------------------------------------------------------------------

function fillTemplate(body, partner) {
  return (body || '')
    .replaceAll('{{contact_name}}', partner.contact_name || 'there')
    .replaceAll('{{company_name}}', partner.name || '')
    .replaceAll('{{tier}}', partner.tier || '');
}

async function handleOutreach(request, { env, user }) {
  const url = new URL(request.url);
  const method = request.method;

  if (method === 'GET' && url.pathname === '/api/outreach/templates') {
    const channel = url.searchParams.get('channel');
    const track = url.searchParams.get('track');
    let query = 'SELECT * FROM templates WHERE 1=1';
    const binds = [];
    if (channel) { query += ' AND channel = ?'; binds.push(channel); }
    if (track) { query += ' AND track = ?'; binds.push(track); }
    const { results } = await env.DB.prepare(query).bind(...binds).all();
    return json(results);
  }

  if (method === 'POST' && url.pathname === '/api/outreach/templates') {
    const b = await request.json();
    const id = newId('tmpl');
    await env.DB.prepare(`
      INSERT INTO templates (id, name, channel, track, subject, body, is_reviewed, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).bind(id, b.name, b.channel, b.track || null, b.subject || null, b.body, user.id).run();
    return json({ id }, { status: 201 });
  }

  const reviewMatch = url.pathname.match(/^\/api\/outreach\/templates\/([\w-]+)\/review$/);
  if (method === 'PATCH' && reviewMatch) {
    if (user.role !== 'admin') return json({ error: 'admin only' }, { status: 403 });
    await env.DB.prepare("UPDATE templates SET is_reviewed = 1, updated_at = datetime('now') WHERE id = ?")
      .bind(reviewMatch[1]).run();
    return json({ ok: true });
  }

  if (method === 'POST' && url.pathname === '/api/outreach/render') {
    const { partner_id, template_id } = await request.json();
    const [partner, template] = await Promise.all([
      env.DB.prepare('SELECT * FROM partners WHERE id = ?').bind(partner_id).first(),
      env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(template_id).first(),
    ]);
    if (!partner || !template) return json({ error: 'not found' }, { status: 404 });
    return json({
      subject: template.subject ? fillTemplate(template.subject, partner) : null,
      body: fillTemplate(template.body, partner),
      channel: template.channel,
      attachment_ids: template.attachment_ids ? JSON.parse(template.attachment_ids) : [],
    });
  }

  if (method === 'POST' && url.pathname === '/api/outreach/send') {
    const b = await request.json();
    if (b.channel !== 'email') {
      return json({ error: 'Use /api/outreach/whatsapp-draft for WhatsApp — no automated send configured.' }, { status: 400 });
    }

    const partner = await env.DB.prepare('SELECT * FROM partners WHERE id = ?').bind(b.partner_id).first();
    if (!partner || !partner.contact_email) return json({ error: 'partner missing or no email on file' }, { status: 400 });

    const attachments = [];
    for (const assetId of b.attachment_ids || []) {
      const asset = await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(assetId).first();
      if (asset) attachments.push(await loadAttachmentFromR2(env, asset));
    }

    await sendEmail(env, { to: partner.contact_email, subject: b.subject, body: b.final_body, attachments });

    const logId = newId('out');
    await env.DB.prepare(`
      INSERT INTO outreach_log (id, linked_partner_id, channel, template_id, final_body, attachments, sent_by)
      VALUES (?, ?, 'email', ?, ?, ?, ?)
    `).bind(logId, b.partner_id, b.template_id || null, b.final_body, JSON.stringify(b.attachment_ids || []), user.id).run();

    await logActivity(env, { linkedTable: 'partners', linkedId: b.partner_id, userId: user.id, type: 'email', notes: 'Outreach sent' });

    return json({ logId }, { status: 201 });
  }

  if (method === 'POST' && url.pathname === '/api/outreach/whatsapp-draft') {
    const b = await request.json();
    const draft = await prepareWhatsAppDraft(env, { filledBody: b.filled_body, attachmentIds: b.attachment_ids });
    return json(draft);
  }

  if (method === 'POST' && url.pathname === '/api/outreach/whatsapp-sent') {
    const b = await request.json();
    const result = await markOutreachSent(env, {
      partnerId: b.partner_id, templateId: b.template_id,
      finalBody: b.final_body, attachmentIds: b.attachment_ids, sentBy: user.id,
    });
    return json(result, { status: 201 });
  }

  // --- TEMPORARY: manual-email fallback, used until the sending domain is verified ---
  if (method === 'POST' && url.pathname === '/api/outreach/email-draft') {
    const b = await request.json();
    const attachmentLinks = [];
    for (const assetId of b.attachment_ids || []) {
      const asset = await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(assetId).first();
      if (!asset) continue;
      attachmentLinks.push({ name: asset.name, file_key: asset.file_key });
    }
    return json({
      subject: b.filled_subject || null,
      body: b.filled_body,
      attachments: attachmentLinks,
      note: 'Copy this into Gmail (yasibomedia@gmail.com) and send manually. Call /api/outreach/email-sent afterward to log it.',
    });
  }

  if (method === 'POST' && url.pathname === '/api/outreach/email-sent') {
    const b = await request.json();
    const partner = await env.DB.prepare('SELECT * FROM partners WHERE id = ?').bind(b.partner_id).first();
    if (!partner) return json({ error: 'partner not found' }, { status: 404 });

    const logId = newId('out');
    await env.DB.prepare(`
      INSERT INTO outreach_log (id, linked_partner_id, channel, template_id, final_body, attachments, sent_by)
      VALUES (?, ?, 'email', ?, ?, ?, ?)
    `).bind(
      logId, b.partner_id, b.template_id || null,
      b.final_subject ? `Subject: ${b.final_subject}\n\n${b.final_body}` : b.final_body,
      JSON.stringify(b.attachment_ids || []), user.id
    ).run();

    await logActivity(env, {
      linkedTable: 'partners', linkedId: b.partner_id, userId: user.id,
      type: 'email', notes: 'Outreach sent manually via Gmail (domain pending)',
    });

    return json({ logId }, { status: 201 });
  }

  const historyMatch = url.pathname.match(/^\/api\/outreach\/history\/([\w-]+)$/);
  if (method === 'GET' && historyMatch) {
    const { results } = await env.DB.prepare('SELECT * FROM outreach_log WHERE linked_partner_id = ? ORDER BY sent_at DESC')
      .bind(historyMatch[1]).all();
    return json(results);
  }

  return json({ error: 'not found' }, { status: 404 });
}

// ---------------------------------------------------------------------------
// SECTION 8 — AI drafting (was src/routes/ai.js)
// ---------------------------------------------------------------------------

const BRAND_VOICE = `You write outreach copy for "The Bosso Movie" (also called "the Highlanders FC movie") —
a scripted feature film by Ya-Sibo Media (Private) Limited t/a Junza Studios, in an officially licensed
co-production with Highlanders Football Club, with full rights to the club's name, crest, colours and history.

Hard rules:
- NEVER use "Bosso at 100," "centenary," or "100 years" — legal/internal issue, this framing is retired.
- Voice: professional, warm, rooted in Highlanders culture and identity — not a plea for funding.
- Never use donation/charity/fundraising language for crowdfunding copy — frame it as producer credit, access, or belonging.
- Never invent statistics, dollar figures, or promises not given in the brief.`;

async function handleAI(request, { env }) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/api/ai/draft') {
    return json({ error: 'not found' }, { status: 404 });
  }

  const { brief, track, tier, tone, rewrite_of } = await request.json();

  const userContent = rewrite_of
    ? `Rewrite the following for tone "${tone || 'professional'}":\n\n${rewrite_of}\n\nInstruction: ${brief}`
    : brief;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: `${BRAND_VOICE}\n\nTrack: ${track || 'n/a'}. Tier: ${tier || 'n/a'}.`,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!response.ok) {
    return json({ error: 'AI draft failed', detail: await response.text() }, { status: 502 });
  }

  const data = await response.json();
  const draft = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

  return json({ draft, reviewed: false });
}

// ---------------------------------------------------------------------------
// SECTION 9 — dashboard (was src/routes/dashboard.js)
// ---------------------------------------------------------------------------

async function handleDashboard(request, { env, user }) {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    const summary = await getCachedDashboard(env);
    if (user.role !== 'admin') {
      const { partners, contributions, tickets, merch, goals } = summary;
      return json({ partners, contributions, tickets, merch, goals });
    }
    return json(summary);
  }

  if (request.method === 'GET' && url.pathname === '/api/dashboard/followups') {
    const { results } = await env.DB.prepare(`
      SELECT * FROM activities
      WHERE user_id = ? AND next_action_date IS NOT NULL AND next_action_date <= date('now')
      ORDER BY next_action_date ASC
    `).bind(user.id).all();
    return json(results);
  }

  return json({ error: 'not found' }, { status: 404 });
}

// ---------------------------------------------------------------------------
// SECTION 10 — diaspora streaming + Paynow webhook (was src/routes/diaspora.js)
// ---------------------------------------------------------------------------

async function generateDiasporaStreamToken(env, { contributionId, premiereCity, validFrom, validUntil, maxConcurrent }) {
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

async function handleDiaspora(request, { env }) {
  const url = new URL(request.url);
  const method = request.method;

  if (method === 'POST' && url.pathname === '/api/diaspora/stream-token') {
    const body = await request.json();
    const result = await generateDiasporaStreamToken(env, body);
    return json(result, { status: 201 });
  }

  if (method === 'GET' && url.pathname === '/api/diaspora/shipments') {
    const { results } = await env.DB.prepare('SELECT * FROM diaspora_merch_shipments ORDER BY ship_by_date ASC').all();
    return json(results);
  }

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

async function handlePaynowWebhook(request, env) {
  const payload = await request.formData();
  const reference = payload.get('reference');
  const status = payload.get('status');
  if (status !== 'Paid') return new Response('ignored');

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

// ---------------------------------------------------------------------------
// SECTION 11 — public (unauthenticated) surface: tier caps, checkout, webhook
// ---------------------------------------------------------------------------

const PUBLIC_PREFIXES = ['/api/public/', '/webhooks/paynow'];

async function handlePublic(request, env) {
  const url = new URL(request.url);
  const method = request.method;

  if (method === 'GET' && url.pathname === '/api/public/tier-caps') {
    const { results } = await env.DB.prepare('SELECT * FROM tier_caps').all();
    return json(results);
  }

  if (method === 'GET' && url.pathname === '/api/public/milestones') {
    const milestone = await env.OUTREACH_KV.get('public_milestone_status', 'json');
    return json(milestone || { current: 'Pre-production' });
  }

  if (method === 'POST' && url.pathname === '/api/public/checkout') {
    const body = await request.json();
    const reference = newId('order');

    await env.OUTREACH_KV.put(
      `pending_payment:${reference}`,
      JSON.stringify({ type: 'contribution', ...body }),
      { expirationTtl: 3600 }
    );

    // Placeholder — replace with a real Paynow initiate-transaction call using
    // env.PAYNOW_INTEGRATION_ID / env.PAYNOW_INTEGRATION_KEY, passing `reference`
    // as the merchant reference so the webhook below can match it back.
    const paynow_url = `https://www.paynow.co.zw/Payment/Link/?reference=${reference}`;

    return json({ paynow_url, reference });
  }

  if (method === 'POST' && url.pathname === '/webhooks/paynow') {
    return handlePaynowWebhook(request, env);
  }

  return json({ error: 'not found' }, { status: 404 });
}

// ---------------------------------------------------------------------------
// SECTION 12 — router (was src/index.js)
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (PUBLIC_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      return handlePublic(request, env);
    }

    const email = request.headers.get('Cf-Access-Authenticated-User-Email');
    if (!email) return new Response('Unauthorized', { status: 401 });

    const user = await getUserByEmail(env, email);
    if (!user) return new Response('Not registered — ask the admin to add you to the users table.', { status: 403 });

    const routeCtx = { env, user, ctx };

    if (url.pathname.startsWith('/api/partners')) return handlePartners(request, routeCtx);
    if (url.pathname.startsWith('/api/contributions') || url.pathname.startsWith('/api/tier-caps')) {
      return handleContributions(request, routeCtx);
    }
    if (url.pathname.startsWith('/api/outreach')) return handleOutreach(request, routeCtx);
    if (url.pathname.startsWith('/api/ai')) return handleAI(request, routeCtx);
    if (url.pathname.startsWith('/api/dashboard')) return handleDashboard(request, routeCtx);
    if (url.pathname.startsWith('/api/diaspora')) return handleDiaspora(request, routeCtx);
    if (url.pathname.startsWith('/api/reply-guides')) return handleReplyGuides(request, routeCtx);
    if (url.pathname.startsWith('/api/hints')) return handleHints(request, routeCtx);
    if (url.pathname.startsWith('/api/in-kind-partners') || url.pathname.startsWith('/api/community-reps') || url.pathname.startsWith('/api/directories')) {
      return handleDirectories(request, routeCtx);
    }
    if (url.pathname.startsWith('/api/content-posts')) return handleContentPosts(request, routeCtx);
    if (url.pathname.startsWith('/api/team')) return handleTeam(request, routeCtx);

    return new Response('Not found', { status: 404 });
  },
};
