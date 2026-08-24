// No WhatsApp Business API — by decision. This module only prepares content
// for a human to copy and send manually from their own WhatsApp number.
//
// Flow: the UI calls prepareWhatsAppDraft(), which returns
//   { text, attachmentUrls }
// The team member taps "Copy message", opens WhatsApp themselves, sends it,
// then the UI calls markOutreachSent() to log it — same outreach_log record
// either way, just without an API in the middle.

import { newId } from './db.js';

export async function prepareWhatsAppDraft(env, { partnerId, templateId, filledBody, attachmentIds = [] }) {
  const attachmentUrls = [];
  for (const assetId of attachmentIds) {
    const asset = await env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(assetId).first();
    if (!asset) continue;
    // R2 public bucket URL, or swap for a signed URL if the bucket is private
    attachmentUrls.push({
      name: asset.name,
      url: `https://assets.yourdomain.co.zw/${asset.file_key}`,
    });
  }
  return { text: filledBody, attachmentUrls };
}

export async function markOutreachSent(env, { partnerId, templateId, finalBody, attachmentIds, sentBy }) {
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
