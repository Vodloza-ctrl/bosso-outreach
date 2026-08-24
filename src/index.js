import { handlePartners } from './routes/partners.js';
import { handleContributions, createContribution } from './routes/contributions.js';
import { handleOutreach } from './routes/outreach.js';
import { handleAI } from './routes/ai.js';
import { handleDashboard } from './routes/dashboard.js';
import { handleDiaspora, handlePaynowWebhook } from './routes/diaspora.js';
import { getUserByEmail, json, newId } from './lib/db.js';

// Routes that must work WITHOUT Cloudflare Access login — the public tier page,
// its checkout call, and the Paynow webhook that confirms payment.
const PUBLIC_PREFIXES = ['/api/public/', '/webhooks/paynow'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (PUBLIC_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      return handlePublic(request, env);
    }

    // Everything else sits behind Cloudflare Access — it injects this header
    // once the visitor has authenticated, so there's no password system to build.
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

    return new Response('Not found', { status: 404 });
  },
};

// --- Public, unauthenticated surface: crowdfund tier page checkout + webhook ---
async function handlePublic(request, env) {
  const url = new URL(request.url);
  const method = request.method;

  if (method === 'GET' && url.pathname === '/api/public/tier-caps') {
    const { results } = await env.DB.prepare('SELECT * FROM tier_caps').all();
    return json(results);
  }

  if (method === 'GET' && url.pathname === '/api/public/milestones') {
    // Hand-set by the admin, not derived from a dollar total — never expose a running total publicly.
    const milestone = await env.OUTREACH_KV.get('public_milestone_status', 'json');
    return json(milestone || { current: 'Pre-production' });
  }

  // POST /api/public/checkout  { tier, contributor_name, contributor_phone, amount, city }
  // Stashes the intended order in KV, then hands back a Paynow redirect URL.
  // Paynow itself is initialized here (integration id/key from secrets) — abbreviated for brevity;
  // wire this to your actual Paynow SDK/HTTP call per their docs.
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
    // as the merchant reference so the webhook above can match it back.
    const paynow_url = `https://www.paynow.co.zw/Payment/Link/?reference=${reference}`;

    return json({ paynow_url, reference });
  }

  if (method === 'POST' && url.pathname === '/webhooks/paynow') {
    return handlePaynowWebhook(request, env);
  }

  return json({ error: 'not found' }, { status: 404 });
}
