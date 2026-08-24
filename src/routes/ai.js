import { json } from '../lib/db.js';

const BRAND_VOICE = `You write outreach copy for "The Bosso Movie" (also called "the Highlanders FC movie") —
a scripted feature film by Ya-Sibo Media (Private) Limited t/a Junza Studios, in an officially licensed
co-production with Highlanders Football Club, with full rights to the club's name, crest, colours and history.

Hard rules:
- NEVER use "Bosso at 100," "centenary," or "100 years" — legal/internal issue, this framing is retired.
- Voice: professional, warm, rooted in Highlanders culture and identity — not a plea for funding.
- Never use donation/charity/fundraising language for crowdfunding copy — frame it as producer credit, access, or belonging.
- Never invent statistics, dollar figures, or promises not given in the brief.`;

export async function handleAI(request, { env, user }) {
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

  // Never auto-saved as a template — the caller decides whether to save it,
  // and any saved template still goes through the is_reviewed admin gate.
  return json({ draft, reviewed: false });
}
