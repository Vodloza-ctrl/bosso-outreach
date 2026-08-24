import { newId, json, logActivity } from '../lib/db.js';
import { sendEmail, loadAttachmentFromR2 } from '../lib/email.js';
import { prepareWhatsAppDraft, markOutreachSent } from '../lib/whatsapp.js';

function fillTemplate(body, partner) {
  return (body || '')
    .replaceAll('{{contact_name}}', partner.contact_name || 'there')
    .replaceAll('{{company_name}}', partner.name || '')
    .replaceAll('{{tier}}', partner.tier || '');
}

export async function handleOutreach(request, { env, user }) {
  const url = new URL(request.url);
  const method = request.method;

  // GET /api/outreach/templates?channel=&track=
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

  // POST /api/outreach/templates  { name, channel, track, subject, body }
  // New/edited templates start unreviewed until the admin approves them (single-admin setup: that's you).
  if (method === 'POST' && url.pathname === '/api/outreach/templates') {
    const b = await request.json();
    const id = newId('tmpl');
    await env.DB.prepare(`
      INSERT INTO templates (id, name, channel, track, subject, body, is_reviewed, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).bind(id, b.name, b.channel, b.track || null, b.subject || null, b.body, user.id).run();
    return json({ id }, { status: 201 });
  }

  // PATCH /api/outreach/templates/:id/review  -> mark reviewed, makes it selectable by anyone
  const reviewMatch = url.pathname.match(/^\/api\/outreach\/templates\/([\w-]+)\/review$/);
  if (method === 'PATCH' && reviewMatch) {
    if (user.role !== 'admin') return json({ error: 'admin only' }, { status: 403 });
    await env.DB.prepare('UPDATE templates SET is_reviewed = 1, updated_at = datetime(\'now\') WHERE id = ?')
      .bind(reviewMatch[1]).run();
    return json({ ok: true });
  }

  // POST /api/outreach/render  { partner_id, template_id }  -> filled draft, not yet sent
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

  // POST /api/outreach/send  { partner_id, template_id, channel, final_body, subject, attachment_ids }
  // channel='email' actually sends via Cloudflare Email Workers.
  // channel='whatsapp' only prepares a draft + attachment links for manual sending (see /whatsapp-draft below).
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

  // POST /api/outreach/whatsapp-draft  { partner_id, template_id, filled_body, attachment_ids }
  // Returns copy-ready text + attachment links. Does NOT send anything or log it yet.
  if (method === 'POST' && url.pathname === '/api/outreach/whatsapp-draft') {
    const b = await request.json();
    const draft = await prepareWhatsAppDraft(env, {
      partnerId: b.partner_id, templateId: b.template_id,
      filledBody: b.filled_body, attachmentIds: b.attachment_ids,
    });
    return json(draft);
  }

  // POST /api/outreach/whatsapp-sent  { partner_id, template_id, final_body, attachment_ids }
  // Call this once the human has actually sent it from their own WhatsApp, to log the record.
  if (method === 'POST' && url.pathname === '/api/outreach/whatsapp-sent') {
    const b = await request.json();
    const result = await markOutreachSent(env, {
      partnerId: b.partner_id, templateId: b.template_id,
      finalBody: b.final_body, attachmentIds: b.attachment_ids, sentBy: user.id,
    });
    return json(result, { status: 201 });
  }

  // --- TEMPORARY: manual-email fallback, used until the sending domain is verified ---
  // Mirrors the WhatsApp draft-and-copy pattern exactly. Once Cloudflare Email Workers
  // is live, outreach can go back through the automated /api/outreach/send route above —
  // outreach_log records look identical either way, so nothing downstream needs to change.

  // POST /api/outreach/email-draft  { partner_id, template_id, filled_subject, filled_body, attachment_ids }
  // Returns copy-ready subject/body + attachment links for pasting into Gmail. Sends nothing.
  if (method === 'POST' && url.pathname === '/api/outreach/email-draft') {
    const b = await request.json();
    const attachmentLinks = [];
    for (const assetId of b.attachment_ids || []) {
      const asset = await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(assetId).first();
      if (!asset) continue;
      // Until a domain/public bucket URL exists, this is just the R2 key —
      // download it via the dashboard's asset list and attach manually in Gmail.
      attachmentLinks.push({ name: asset.name, file_key: asset.file_key });
    }
    return json({
      subject: b.filled_subject || null,
      body: b.filled_body,
      attachments: attachmentLinks,
      note: 'Copy this into Gmail (yasibomedia@gmail.com) and send manually. Call /api/outreach/email-sent afterward to log it.',
    });
  }

  // POST /api/outreach/email-sent  { partner_id, template_id, final_subject, final_body, attachment_ids }
  // Call once the email has actually been sent manually from Gmail, to keep outreach_log complete.
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

  // GET /api/outreach/history/:partner_id
  const historyMatch = url.pathname.match(/^\/api\/outreach\/history\/([\w-]+)$/);
  if (method === 'GET' && historyMatch) {
    const { results } = await env.DB.prepare('SELECT * FROM outreach_log WHERE linked_partner_id = ? ORDER BY sent_at DESC')
      .bind(historyMatch[1]).all();
    return json(results);
  }

  return json({ error: 'not found' }, { status: 404 });
}
