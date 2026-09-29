// csv — SOURCE ONLY. The escape hatch for people who do not have Unipile.
//
// Export the comments however you like (Phantombuster, Apify, a browser extension,
// copy and paste) into data/comments.csv with this header:
//
//   author,authorId,headline,profileUrl,text,postId,postText
//
// Naughty scores it exactly the same way. Detection quality does not depend on where the
// rows came from, only on having the comment text and the headline.
export const name = 'csv';
export const capabilities = {
  readPostComments: true, readProfile: false, sendInvite: false, sendMessage: false, readReplies: false,
};

import { readFileSync } from 'node:fs';

/** Small RFC4180-ish parser. Handles quoted fields and embedded newlines. */
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v !== ''));
}

export async function listOwnPosts() {
  return [{ id: 'csv', socialId: 'csv', text: '' }];
}

export async function listPostComments(_post, { path = 'data/comments.csv' } = {}) {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const head = rows.shift().map(h => h.trim());
  return rows.map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return { ...o, authorId: o.authorId || o.profileUrl || o.author, isCompany: false };
  });
}
