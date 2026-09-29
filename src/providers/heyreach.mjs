// HeyReach — SENDER ONLY.
//
// It has no scraping or profile-search endpoint, so it cannot find the slop for you.
// Pair it with NAUGHTY_SOURCE=unipile or NAUGHTY_SOURCE=csv.
//
// It also does not send directly. You enqueue a lead into a campaign whose first step
// is a connection request, and the campaign sends on its own schedule with its own
// rate limits. So "sent" here means "queued", and that is a real behavioural difference
// from unipile: you will not get a message id back, and delivery is minutes to hours.
//
// Endpoint paths below come from HeyReach's public API docs, not from a live call
// against a key we hold. Run `naughty doctor` first — it will tell you immediately if a
// path has moved.
export const name = 'heyreach';
export const capabilities = {
  readPostComments: false, readProfile: false, sendInvite: true, sendMessage: true, readReplies: true,
};

const BASE = 'https://api.heyreach.io/api/public';

async function api(path, init = {}) {
  const key = process.env.HEYREACH_API_KEY;
  if (!key) throw new Error('HEYREACH_API_KEY is not set.');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'X-API-KEY': key, accept: 'application/json', 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`heyreach ${res.status} on ${path}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : {};
}

export async function ping() { return api('/auth/CheckApiKey'); }

/**
 * Queues the invite by adding the lead to the campaign's list with the note carried
 * as a personalization variable. Your campaign's connection step must reference that
 * variable, otherwise the note is dropped and the invite goes out bare.
 */
export async function sendInvite({ profileUrl, note, firstName, lastName }) {
  const listId = process.env.HEYREACH_LIST_ID;
  const campaignId = process.env.HEYREACH_CAMPAIGN_ID;
  if (!listId) throw new Error('HEYREACH_LIST_ID is not set (the lead list your campaign runs on).');
  if (!campaignId) throw new Error('HEYREACH_CAMPAIGN_ID is not set.');
  const r = await api('/list/AddLeadsToListV2', {
    method: 'POST',
    body: JSON.stringify({
      listId: Number(listId),
      leads: [{
        linkedInUrl: profileUrl, firstName: firstName || '', lastName: lastName || '',
        // HeyReach campaigns read these as {{customField}} in the sequence copy.
        customUserFields: [{ name: 'naughtyNote', value: note }],
      }],
    }),
  });
  return { queued: true, campaignId, listId, raw: r };
}

export async function sendMessage({ conversationId, text }) {
  return api('/inbox/SendMessage', { method: 'POST', body: JSON.stringify({ conversationId, message: text }) });
}

export async function readReplies() {
  const r = await api('/inbox/GetConversationsV2', { method: 'POST', body: JSON.stringify({ filters: { seen: false }, offset: 0, limit: 50 }) });
  return (r.items || []).map(c => ({
    chatId: c.id,
    messages: (c.messages || []).map(m => ({ text: m.body || m.text, at: m.createdAt, fromMe: !!m.isFromMe })),
  }));
}
