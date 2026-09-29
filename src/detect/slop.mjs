// The detector. Deterministic pre-filter — it narrows 170 comments to a shortlist,
// then a human (or an LLM) makes the call on the shortlist.
//
// Every tell here came out of a real run over 171 comments on 20 posts.
//
// Weighting principle. Two structural tells are damning on their own and are weighted to
// clear the default threshold (70) by themselves: a repeated template, and the same
// sentence from two unrelated accounts. A shared headline is strong but not conclusive
// (40), so it needs one corroborating tell to shortlist someone. The lexical tells are
// corroboration only and never enough alone, because bland is not the same as botted.
// The two strongest are structural, not lexical: the same person running one
// template repeatedly, and two unrelated accounts posting the same sentence.

const CADENCE = [
  /\bis the real insight here\b/i,
  /\bthe real unlock (here )?is\b/i,
  /\bis the real test\b/i,
  /\b(this|that) point is key\b/i,
  /\bthe key is having a clear process\b/i,
  /\breminds us that\b/i,
  /\bcreates a stronger foundation\b/i,
  /\bis the ultimate proof\b/i,
  /\bthe biggest takeaway for me\b/i,
  /\bstrong (validation|proof) of the model\b/i,
  /\bespecially (powerful|interesting)\b/i,
  /\bimpressive (proof of concept|execution)\b/i,
  /\bthe expensive failure mode\b/i,
  /\bthis is a great (example|reminder)\b/i,
  /\bcouldn't agree more\b/i,
  /\bspot on\b/i,
];

// Bold mathematical unicode. Not a LinkedIn feature — it is what a comment
// automation tool applies to force its closing CTA to stand out.
const FANCY_BOLD = /[\u{1D400}-\u{1D7FF}\u{1D5D4}-\u{1D607}]/u;

const STOP = new Set(('a an the and or but so if then than that this these those of to in on for with at by from as is are was were be been being it its you your i my we our they their he she his her not no do does did have has had will would can could should about into over under more most very just only also'
).split(' '));

/** Skeleton fingerprint: drop content words, keep the grammar. Two comments with
 *  the same skeleton were almost certainly produced by the same generator. */
export function skeleton(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && STOP.has(w))
    .join(' ')
    .slice(0, 160);
}

/** Cheap token-overlap similarity, 0..1. Good enough to catch two accounts
 *  posting the same generated sentence; we are not doing plagiarism forensics. */
export function similarity(a, b) {
  const t = s => new Set((s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)));
  const A = t(a), B = t(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

function numbersIn(text) {
  return (text || '').match(/\$?\d[\d,.]*\s?(%|k|m|x|\+)?/gi)?.map(s => s.trim().toLowerCase()) ?? [];
}

/**
 * Score one comment. `peers` is every comment in the corpus (needed for the
 * structural tells, which cannot be seen one comment at a time).
 * Returns { score 0..100, tells: string[] }.
 */
export function scoreComment(c, peers = []) {
  const tells = [];
  let score = 0;
  const text = (c.text || '').trim();
  if (!text) return { score: 0, tells: ['empty'] };

  const words = text.split(/\s+/).length;

  // --- structural, strongest ---
  // Which known cadence phrases this comment uses. Reused below: the same author
  // reaching for the same phrase on different posts is a template, not a habit.
  const myCadence = CADENCE.filter(rx => rx.test(text));

  const mine = peers.filter(p => p.authorId === c.authorId && p.text && p.text !== text);

  // A template repeat needs the SHAPE to match, not the words. Exact equality on a
  // function-word skeleton is too brittle (one stray "from" breaks it), so compare
  // skeletons by overlap and accept a shared cadence phrase as independent evidence.
  const sk = skeleton(text);
  const templateTwins = mine.filter(p => {
    const sameShape = sk.length > 12 && similarity(sk, skeleton(p.text)) >= 0.6;
    const sameCadence = myCadence.length > 0 && myCadence.some(rx => rx.test(p.text));
    return sameShape || sameCadence;
  });

  if (templateTwins.length >= 1) {
    const n = templateTwins.length + 1;
    score += 40 + Math.min(20, templateTwins.length * 8);
    tells.push(`ran the same template on ${n} of your posts`);
  } else if (mine.length >= 3) {
    score += 10;
    tells.push(`${mine.length + 1} comments from this account across your posts`);
  }

  const twins = peers.filter(p => p.authorId !== c.authorId && p.postId === c.postId && similarity(p.text, text) >= 0.6);
  if (twins.length) {
    score += 55;
    tells.push(`near-identical to ${twins.map(t => t.author).join(', ')} on the same post`);
  }

  const headlineTwins = peers.filter(p => p.authorId !== c.authorId && p.headline && c.headline && p.headline.trim() === c.headline.trim());
  if (headlineTwins.length) {
    score += 40;
    tells.push(`headline is identical to ${headlineTwins.map(t => t.author).join(', ')}`);
  }

  // --- lexical / formatting ---
  if (FANCY_BOLD.test(text)) { score += 30; tells.push('closing line in bold unicode (comment-tool CTA styling)'); }

  const hits = myCadence;
  if (hits.length) { score += 12 * Math.min(hits.length, 3); tells.push(`LLM cadence: ${hits.length} known phrase${hits.length > 1 ? 's' : ''}`); }

  // restate + question, the pattern most people recognise
  const asksQuestion = /\?\s*$/.test(text) || /\?\s/.test(text);
  const echoesPost = c.postText ? similarity(c.postText, text) >= 0.22 : false;
  if (echoesPost && asksQuestion) { score += 22; tells.push('restates the post, then attaches a question'); }
  else if (echoesPost) { score += 12; tells.push('restates the post back at you'); }

  // numbers lifted straight out of the post
  if (c.postText) {
    const pn = new Set(numbersIn(c.postText));
    const lifted = numbersIn(text).filter(n => pn.has(n));
    if (lifted.length >= 2) { score += 10; tells.push(`quotes your own numbers back (${lifted.slice(0, 3).join(', ')})`); }
  }

  // the @mention parked at the end of a line, where a tool drops it
  if (c.ownerName && new RegExp(`${c.ownerName}\\s*$`, 'i').test(text)) {
    score += 8; tells.push('your name appended at the end, not typed inline');
  }

  // a two-line fragment stack under 45 words is the house style of several tools
  if (words < 45 && (text.match(/\n/g) || []).length >= 1 && !asksQuestion) { score += 6; tells.push('short fragment stack'); }

  // --- credits: signs of an actual human ---
  if (/\bi (tried|built|ran|had|got|made|saw|hated|stopped)\b/i.test(text)) { score -= 18; tells.push('CREDIT: first-person specific experience'); }
  if (/\b(disagree|wrong|not sure|doubt|but i|actually no)\b/i.test(text)) { score -= 14; tells.push('CREDIT: pushes back'); }
  if (words > 90) { score -= 6; tells.push('CREDIT: long enough to be effortful'); }
  if (/(http|\.com|\.io|\.ai)/i.test(text) && /\bwe('| a)?(ve)?\b/i.test(text)) { tells.push('NOTE: pitches their own product'); score += 6; }

  return { score: Math.max(0, Math.min(100, Math.round(score))), tells };
}

/** Score a whole corpus at once so the structural tells can see their peers. */
export function scoreCorpus(comments) {
  return comments
    .map(c => ({ ...c, ...scoreComment(c, comments) }))
    .sort((a, b) => b.score - a.score);
}
