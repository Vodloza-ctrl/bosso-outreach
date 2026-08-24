// Cached dashboard summary — recomputed on any write to money-moving tables,
// read from cache on every dashboard view so the console/UI stays fast.

export async function refreshDashboardCache(env) {
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

export async function getCachedDashboard(env) {
  const cached = await env.OUTREACH_KV.get('dashboard_summary', 'json');
  return cached || refreshDashboardCache(env);
}
