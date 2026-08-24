// Cloudflare Email Workers — outbound send.
//
// Setup required in the Cloudflare dashboard before this works:
//   1. Add and verify your sending domain under Email > Email Routing.
//   2. Enable "Email Workers" (send_email binding) for that domain.
//   3. Add the send_email binding to wrangler.toml, e.g.:
//        [[send_email]]
//        name = "SEND_EMAIL"
//        destination_address = "you@yourdomain.co.zw"  # not required for outbound-only sends
//
// This wraps that binding so the rest of the app just calls sendEmail(env, {...}).

import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage } from 'mimetext';

export async function sendEmail(env, { to, subject, body, attachments = [] }) {
  const msg = createMimeMessage();
  msg.setSender({ name: 'The Bosso Movie', addr: 'partnerships@yourdomain.co.zw' });
  msg.setRecipient(to);
  msg.setSubject(subject || 'The Bosso Movie — Partnership');
  msg.addMessage({ contentType: 'text/plain', data: body });

  for (const att of attachments) {
    // att = { filename, mimeType, base64Data } — fetched from R2 by the caller before this runs
    msg.addAttachment({
      filename: att.filename,
      contentType: att.mimeType,
      data: att.base64Data,
    });
  }

  const message = new EmailMessage('partnerships@yourdomain.co.zw', to, msg.asRaw());
  await env.SEND_EMAIL.send(message);
}

// Pulls an asset's bytes from R2 and base64-encodes it for attaching.
export async function loadAttachmentFromR2(env, asset) {
  const object = await env.ASSETS.get(asset.file_key);
  if (!object) throw new Error(`Asset not found in R2: ${asset.file_key}`);
  const buf = await object.arrayBuffer();
  const base64Data = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return {
    filename: asset.name,
    mimeType: asset.file_type === 'pdf' ? 'application/pdf' : 'image/jpeg',
    base64Data,
  };
}
