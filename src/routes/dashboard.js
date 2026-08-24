import { json } from '../lib/db.js';
import { getCachedDashboard } from '../lib/kv.js';

export async function handleDashboard(request, { env, user }) {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    const summary = await getCachedDashboard(env);

    if (user.role !== 'admin') {
      // Team members see track-level progress only, never the underlying revenue-projection model.
      const { partners, contributions, tickets, merch, goals } = summary;
      return json({ partners, contributions, tickets, merch, goals });
    }
    return json(summary);
  }

  // GET /api/dashboard/followups — activities due today or overdue, for the current user
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
