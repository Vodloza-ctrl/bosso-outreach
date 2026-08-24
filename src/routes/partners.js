import { newId, json, logActivity } from '../lib/db.js';

export async function handlePartners(request, { env, user }) {
  const url = new URL(request.url);
  const method = request.method;

  // GET /api/partners?track=&status=
  if (method === 'GET' && url.pathname === '/api/partners') {
    const track = url.searchParams.get('track');
    const status = url.searchParams.get('status');
    let query = 'SELECT * FROM partners WHERE 1=1';
    const binds = [];
    if (track) { query += ' AND track = ?'; binds.push(track); }
    if (status) { query += ' AND status = ?'; binds.push(status); }
    if (user.role !== 'admin') { query += ' AND owner_id = ?'; binds.push(user.id); }
    query += ' ORDER BY updated_at DESC';
    const { results } = await env.DB.prepare(query).bind(...binds).all();
    return json(results);
  }

  // GET /api/partners/:id  (full detail incl. outreach history + placement scenes)
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

  // POST /api/partners  { name, track, tier, category, contact_name, contact_phone, contact_email, value_target, notes }
  if (method === 'POST' && url.pathname === '/api/partners') {
    const body = await request.json();
    const id = newId('partner');
    await env.DB.prepare(`
      INSERT INTO partners (id, name, track, tier, category, contact_name, contact_phone, contact_email, value_target, owner_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, body.name, body.track, body.tier || null, body.category || null,
      body.contact_name || null, body.contact_phone || null, body.contact_email || null,
      body.value_target || 0, user.id, body.notes || null
    ).run();
    return json({ id }, { status: 201 });
  }

  // PATCH /api/partners/:id  { status, value_actual, in_kind_value, notes }
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

  // POST /api/partners/:id/activity  { type, notes, next_action, next_action_date }
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
