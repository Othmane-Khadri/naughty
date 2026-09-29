// Local tracker. A JSON file and a page on 127.0.0.1. No account, nothing leaves the box.
// This is the default on purpose: the board holds real people's names and comments.
export const name = 'local';

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';

const FILE = 'data/board.json';

function read() {
  if (!existsSync(FILE)) return { rows: [] };
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { rows: [] }; }
}
function write(db) { mkdirSync('data', { recursive: true }); writeFileSync(FILE, JSON.stringify(db, null, 1)); }

export async function ping() { return { ok: true, file: FILE }; }
export async function setup() { const db = read(); write(db); return { file: FILE }; }

export async function upsert(row) {
  const db = read();
  const key = row.profileUrl || row.author;
  const i = db.rows.findIndex(r => (r.profileUrl || r.author) === key);
  const merged = { ...(i >= 0 ? db.rows[i] : {}), ...row, updated: new Date().toISOString() };
  if (i >= 0) db.rows[i] = merged; else db.rows.push(merged);
  write(db);
  return merged;
}

export async function all() { return read().rows; }

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(rows) {
  const CAT = {
    hostile: '#dc2626', probe: '#dc2626', injection: '#dc2626', declined_to_guess: '#b45309',
    substantive: '#0369a1', asked_back: '#0369a1', calendar: '#15803d',
    pitch_template: '#7c3aed', vague: '#6b7280', logistics: '#6b7280', new: '#6b7280', '': '#6b7280',
  };
  const stopCats = new Set(['hostile', 'probe', 'injection', 'declined_to_guess']);
  const sorted = [...rows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const stopped = sorted.filter(r => stopCats.has(r.category)).length;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Naughty — Hunt Board</title><style>
:root{--bg:#fbfaf8;--fg:#18181b;--mut:#71717a;--line:#e4e4e7;--card:#fff;color-scheme:light}
@media(prefers-color-scheme:dark){:root{--bg:#0f0f11;--fg:#f4f4f5;--mut:#a1a1aa;--line:#27272a;--card:#18181b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:19px;margin:0 0 2px;letter-spacing:-.01em}.sub{color:var(--mut);font-size:13px;margin:0 0 20px}
.stats{display:flex;gap:22px;flex-wrap:wrap;margin:0 0 20px;padding:14px 16px;background:var(--card);border:1px solid var(--line);border-radius:10px}
.stat b{display:block;font-size:21px;font-variant-numeric:tabular-nums}.stat span{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;min-width:900px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);font-weight:600;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.sc{font-variant-numeric:tabular-nums;font-weight:600}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;color:#fff;white-space:nowrap}
.stop{outline:2px solid #dc2626;outline-offset:-2px}
.who{font-weight:600}.hl{color:var(--mut);font-size:12px;max-width:260px}
.said{color:var(--mut);font-size:12px;max-width:320px}
.msg{font-size:12px;max-width:300px}
a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.empty{padding:40px;text-align:center;color:var(--mut)}
</style><div class="wrap">
<h1>Naughty — Hunt Board</h1>
<p class="sub">Served from 127.0.0.1. Nothing on this page has left your machine.</p>
<div class="stats">
<div class="stat"><b>${rows.length}</b><span>on the board</span></div>
<div class="stat"><b>${rows.filter(r => r.status === 'Sent' || r.status === 'Replied').length}</b><span>contacted</span></div>
<div class="stat"><b>${rows.filter(r => r.status === 'Replied').length}</b><span>replied</span></div>
<div class="stat"><b style="color:#dc2626">${stopped}</b><span>must stop</span></div>
</div>
${rows.length ? `<div class="scroll"><table><thead><tr>
<th>Score</th><th>Who</th><th>Category</th><th>Status</th><th>They said</th><th>You sent</th>
</tr></thead><tbody>
${sorted.map(r => `<tr${stopCats.has(r.category) ? ' class="stop"' : ''}>
<td class="sc">${r.score ?? ''}</td>
<td><div class="who">${r.profileUrl ? `<a href="${esc(r.profileUrl)}" target="_blank" rel="noopener">${esc(r.author)}</a>` : esc(r.author)}</div><div class="hl">${esc((r.headline || '').slice(0, 90))}</div></td>
<td><span class="pill" style="background:${CAT[r.category] || CAT['']}">${esc(r.category || 'new')}</span>${stopCats.has(r.category) ? '<div class="hl" style="margin-top:4px">do not continue</div>' : ''}</td>
<td>${esc(r.status || 'New')}${r.rounds ? `<div class="hl">${r.rounds} round${r.rounds > 1 ? 's' : ''}</div>` : ''}</td>
<td class="said">${esc((r.theirComment || '').slice(0, 200))}</td>
<td class="msg">${esc((r.message || '').slice(0, 200))}</td>
</tr>`).join('')}
</tbody></table></div>` : '<div class="empty">Nothing yet. Run <code>naughty scan</code> then <code>naughty draft</code>.</div>'}
</div>`;
}

export function serve({ port = 4321 } = {}) {
  const srv = createServer(async (req, res) => {
    if (req.url === '/board.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(read()));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(await all()));
  });
  // 127.0.0.1 explicitly, never 0.0.0.0. This board should not be reachable from the network.
  srv.listen(port, '127.0.0.1', () => console.log(`board: http://127.0.0.1:${port}  (ctrl-c to stop)`));
  return srv;
}
