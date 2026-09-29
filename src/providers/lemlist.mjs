// lemlist — SENDER ONLY, and DM only.
//
// Two hard limits, both confirmed against developer.lemlist.com:
//   1. No endpoint reads LinkedIn post comments or profile headlines.
//   2. No endpoint sends a connection request. LinkedIn invites exist as a SEQUENCE
//      STEP inside the lemlist app, not as an API call, so Naughty cannot trigger one.
//
// That means on lemlist Naughty can only message people you are ALREADY connected to.
// For a first-degree-only run that is fine, and for cold slop-hunting it is not,
// because most commenters are 2nd degree. `naughty send` will refuse rather than
// pretend, and tell you to switch sender.
export const name = 'lemlist';
export const capabilities = {
  readPostComments: false, readProfile: false, sendInvite: false, sendMessage: true, readReplies: true,
};

const BASE = 'https://api.lemlist.com/api';

async function api(path, init = {}) {
  const key = process.env.LEMLIST_API_KEY;
  if (!key) throw new Error('LEMLIST_API_KEY is not set.');
  const auth = Buffer.from(`:${key}`).toString('base64');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Basic ${auth}`, accept: 'application/json', 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`lemlist ${res.status} on ${path}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : {};
}

export async function ping() { return api('/team'); }

export async function sendMessage({ leadId, campaignId, text }) {
  return api('/inbox/linkedin/send', { method: 'POST', body: JSON.stringify({ leadId, campaignId, message: text }) });
}

export async function readReplies({ leadId } = {}) {
  const r = leadId ? await api(`/inbox/contacts/${leadId}/messages`) : await api('/inbox');
  const items = r.items || r || [];
  return (Array.isArray(items) ? items : []).map(c => ({
    chatId: c._id || c.leadId,
    messages: (c.messages || []).map(m => ({ text: m.text || m.body, at: m.date, fromMe: m.type === 'sent' })),
  }));
}
