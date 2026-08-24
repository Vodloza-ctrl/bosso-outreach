// Small helpers around D1 so route files stay readable.

export function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function getUserByEmail(env, email) {
  return env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
}

export async function logActivity(env, { linkedTable, linkedId, userId, type, notes, nextAction, nextActionDate }) {
  await env.DB.prepare(`
    INSERT INTO activities (id, linked_table, linked_id, user_id, type, notes, next_action, next_action_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(newId('act'), linkedTable, linkedId, userId, type, notes || null, nextAction || null, nextActionDate || null).run();
}

// Thin JSON response helper with CORS for local dev / same-origin production use.
export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...(init.headers || {}),
    },
  });
}
