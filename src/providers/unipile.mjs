// Unipile — the only provider that can do the whole job. Hosted LinkedIn API.
// Affiliate: see AFFILIATES.md
export const name = 'unipile';
export const capabilities = {
  readPostComments: true, readProfile: true, sendInvite: true, sendMessage: true, readReplies: true,
};

const base = () => {
  const dsn = process.env.UNIPILE_DSN;
  if (!dsn) throw new Error('UNIPILE_DSN is not set. Copy .env.example to .env.');
  return dsn.replace(/\/$/, '');
};
const acct = () => {
  const a = process.env.UNIPILE_ACCOUNT_ID;
  if (!a) throw new Error('UNIPILE_ACCOUNT_ID is not set.');
  return a;
};

async function api(path, init = {}) {
  const key = process.env.UNIPILE_API_KEY;
  if (!key) throw new Error('UNIPILE_API_KEY is not set.');
  const res = await fetch(`${base()}/api/v1${path}`, {
    ...init,
    headers: { 'X-API-KEY': key, accept: 'application/json', 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`unipile ${res.status} on ${path}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : {};
}

export async function ping() { return api(`/accounts/${acct()}`); }

/** Your own recent posts. NOTE: the endpoint returns each post twice (activity URN
 *  and ugcPost URN), so ask for more than you need and dedupe on the text. */
export async function listOwnPosts({ userId, limit = 30 } = {}) {
  const uid = userId || process.env.UNIPILE_OWN_PROVIDER_ID;
  if (!uid) throw new Error('UNIPILE_OWN_PROVIDER_ID is not set (your LinkedIn member URN, ACoAA...).');
  const r = await api(`/users/${encodeURIComponent(uid)}/posts?account_id=${acct()}&limit=${limit}`);
  const seen = new Set(); const out = [];
  for (const p of r.items || []) {
    const k = (p.text || '').slice(0, 120);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: p.id, socialId: p.social_id || p.share_url || p.id, text: p.text || '' });
  }
  return out;
}

/** GOTCHA: this needs the social_id (urn:li:activity:...), NOT the numeric post id.
 *  Passing the numeric id returns an error object with an empty message, which
 *  reads exactly like "this post has no comments". */
export async function listPostComments(post) {
  const pid = post.socialId || post;
  if (!/^urn:li:/.test(String(pid))) {
    throw new Error(`listPostComments needs the social_id urn (urn:li:activity:...), got "${pid}".`);
  }
  const r = await api(`/posts/${encodeURIComponent(pid)}/comments?account_id=${acct()}&limit=100`);
  return (r.items || []).map(c => {
    const a = c.author_details || {};
    return {
      commentId: c.id,
      author: c.author,
      authorId: a.id || c.author,
      headline: a.headline || '',
      profileUrl: a.profile_url || '',
      isCompany: !!a.is_company,
      networkDistance: a.network_distance,
      text: (c.text || '').trim(),
      date: c.date,
    };
  });
}

/** Resolve a public slug to the provider_id (ACoAA...) that sending requires. */
export async function getProfile(slug) {
  const r = await api(`/users/${encodeURIComponent(slug)}?account_id=${acct()}`);
  return {
    providerId: r.provider_id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    headline: r.headline, networkDistance: r.network_distance,
  };
}

/** Connection request with a note. LinkedIn caps the note at 300 characters. */
export async function sendInvite({ providerId, note }) {
  if (note && note.length > 300) throw new Error(`note is ${note.length} chars, LinkedIn caps invites at 300.`);
  return api('/users/invite', { method: 'POST', body: JSON.stringify({ account_id: acct(), provider_id: providerId, message: note }) });
}

export async function sendMessage({ providerId, text }) {
  return api('/chats', { method: 'POST', body: JSON.stringify({ account_id: acct(), attendees_ids: [providerId], text }) });
}

export async function readReplies({ since } = {}) {
  const q = new URLSearchParams({ account_id: acct(), limit: '50' });
  if (since) q.set('after', since);
  const chats = await api(`/chats?${q}`);
  const out = [];
  for (const ch of chats.items || []) {
    const msgs = await api(`/chats/${ch.id}/messages?limit=15`);
    out.push({
      chatId: ch.id,
      messages: (msgs.items || []).map(m => ({ text: m.text, at: m.timestamp, fromMe: m.is_sender === 1 })),
    });
  }
  return out;
}
