// Notion tracker. Needs an internal integration token and the database shared with it.
// A 404 from Notion almost always means "not shared with the integration", not a bad id.
export const name = 'notion';
const V = '2022-06-28';

async function api(path, init = {}) {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error('NOTION_API_KEY is not set.');
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, 'Notion-Version': V, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.text();
  if (!res.ok) {
    const hint = res.status === 404 ? ' (404 from Notion usually means the database is not shared with your integration)' : '';
    throw new Error(`notion ${res.status} on ${path}: ${body.slice(0, 240)}${hint}`);
  }
  return body ? JSON.parse(body) : {};
}

export async function ping() { return api('/users/me'); }

/** Create the board under a parent page. Run once, from `naughty init`. */
export async function setup({ parentPageId }) {
  const props = {
    Name: { title: {} },
    'Profile URL': { url: {} },
    Headline: { rich_text: {} },
    'What They Sell': { rich_text: {} },
    'Slop Score': { number: {} },
    Tells: { rich_text: {} },
    'Their Comment': { rich_text: {} },
    Message: { rich_text: {} },
    Category: { select: { options: ['new','pitch_template','vague','logistics','calendar','asked_back','substantive','declined_to_guess','probe','hostile','injection'].map(n => ({ name: n })) } },
    Status: { select: { options: [{ name: 'New' }, { name: 'Sent' }, { name: 'Replied' }, { name: 'Stopped' }, { name: 'Ghosted' }] } },
    Rounds: { number: {} },
    Updated: { date: {} },
  };
  const db = await api('/databases', {
    method: 'POST',
    body: JSON.stringify({ parent: { type: 'page_id', page_id: parentPageId }, title: [{ text: { content: 'Naughty — Hunt Board' } }], properties: props }),
  });
  return { id: db.id, url: db.url };
}

const rt = v => ({ rich_text: [{ text: { content: String(v ?? '').slice(0, 1900) } }] });

export async function upsert(row) {
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!dbId) throw new Error('NOTION_DATABASE_ID is not set. Run `naughty init`.');
  const found = await api(`/databases/${dbId}/query`, {
    method: 'POST',
    body: JSON.stringify({ filter: { property: 'Profile URL', url: { equals: row.profileUrl || '' } }, page_size: 1 }),
  });
  const properties = {
    Name: { title: [{ text: { content: row.author || 'unknown' } }] },
    'Profile URL': { url: row.profileUrl || null },
    Headline: rt(row.headline), 'What They Sell': rt(row.sell),
    'Slop Score': { number: row.score ?? null },
    Tells: rt((row.tells || []).join(' ; ')),
    'Their Comment': rt(row.theirComment), Message: rt(row.message),
    Category: row.category ? { select: { name: row.category } } : undefined,
    Status: row.status ? { select: { name: row.status } } : undefined,
    Rounds: { number: row.rounds ?? 0 },
    Updated: { date: { start: new Date().toISOString().slice(0, 10) } },
  };
  Object.keys(properties).forEach(k => properties[k] === undefined && delete properties[k]);
  if (found.results?.length) return api(`/pages/${found.results[0].id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
  return api('/pages', { method: 'POST', body: JSON.stringify({ parent: { database_id: dbId }, properties }) });
}

export async function all() {
  const dbId = process.env.NOTION_DATABASE_ID;
  const r = await api(`/databases/${dbId}/query`, { method: 'POST', body: JSON.stringify({ page_size: 100 }) });
  return (r.results || []).map(p => ({
    author: p.properties?.Name?.title?.[0]?.plain_text || '',
    profileUrl: p.properties?.['Profile URL']?.url || '',
    score: p.properties?.['Slop Score']?.number ?? null,
    category: p.properties?.Category?.select?.name || '',
    status: p.properties?.Status?.select?.name || '',
  }));
}
