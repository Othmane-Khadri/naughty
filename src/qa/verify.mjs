// The QA gate. Runs before anything is sent, every time.
//
// The failure that matters here is not a bad message, it is a message sent to the wrong
// person, or a message that answers something they never said. Both are easy to produce
// and impossible to take back, and neither one looks wrong in a log line. So every check
// below is a BLOCKER by default: `send` skips the draft rather than guessing.
//
// Three kinds of drift:
//   identity  — the name in the message is not the person receiving it
//   relevance — you are asking to buy something they do not sell
//   thread    — you are answering a message that is not the one in front of you
//
// Everything here is deterministic. gradeQuestion() adds an optional model grade on top,
// and a model grade can only ever DOWNGRADE a pass, never rescue a blocker.

import { similarity } from '../detect/slop.mjs';
import { checkMessage } from '../interpret/classify.mjs';

const ANCHOR_STOP = new Set((
  // Function words.
  'a an the and or but so if then than that this these those of to in on for with at by from as is are was were be been being it its ' +
  'you your yours i my me we our us they their them he she his her not no do does did have has had will would can could should may might must ' +
  'about into over under more most very just only also what which who whom how when why where there here some any each both all every ' +
  // High-frequency content words of five letters or more. A question that "anchors" on
  // "think" or "great" is not anchored to anything, so these must not count as evidence.
  'think thinks thought about would could should there their these those thing things ' +
  'really maybe might looking actually something anything someone people person better ' +
  'still thanks thank happy great sounds sound working works work using used makes make ' +
  'going sorry please tell know want need like more much also well even while after before ' +
  'again always never often usually maybe pretty quite little other others another right ' +
  'sure question questions answer answers talk talking speak first last next time times ' +
  'today week weeks month months year years thing stuff based around given whether either ' +
  'curious interested interesting understand understanding helps help helpful mean means'
).split(/\s+/).filter(Boolean));

/**
 * Does this message actually reference something they said?
 *
 * Token-overlap similarity is the wrong tool here: it drops short tokens, and a product
 * name like "ORBIT" is exactly the short token that carries the anchor. So look for
 * shared DISTINCTIVE terms instead and count hits rather than take a ratio. One shared
 * proper noun, number, or uncommon word is enough to prove the question belongs to this
 * conversation.
 */
export function anchorTerms(theirText, message) {
  const distinctive = t => {
    const out = new Set();
    for (const raw of String(t || '').split(/[^\p{L}\p{N}$%.+-]+/u)) {
      const w = raw.replace(/^[.+-]+|[.+-]+$/g, '');
      if (!w) continue;
      const lower = w.toLowerCase();
      if (ANCHOR_STOP.has(lower)) continue;
      const isNumberish = /\d/.test(w);
      const isProperish = /^[A-Z][A-Za-z0-9]*$/.test(w) || /^[A-Z]{2,}$/.test(w);
      if (isNumberish || isProperish || lower.length >= 5) out.add(lower);
    }
    return out;
  };
  const theirs = distinctive(theirText), mine = distinctive(message);
  const shared = [...mine].filter(w => theirs.has(w));
  return shared;
}

const firstName = s => String(s || '').trim().split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, '') || '';
const greetedName = msg => (String(msg || '').match(/^\s*(?:hey|hi|hello)\s+([\p{L}'-]+)/iu)?.[1]) || '';

/** A label for the target that is stable across sources: the profile URL, else the name. */
const identityOf = t => (t?.profileUrl || '').trim().toLowerCase() || `name:${(t?.author || '').toLowerCase()}`;

// ---------------------------------------------------------------- drafts

/**
 * QA one opener before it is sent.
 * @param {object} draft
 * @param {{neverTouch?:string[], siblings?:object[]}} ctx siblings = every other draft in
 *   the batch, so duplicate targets are catchable.
 */
export function qaDraft(draft, { neverTouch = [], siblings = [] } = {}) {
  const blockers = [], warnings = [];
  const who = draft.author || '(no name)';

  // --- identity -------------------------------------------------------------
  if (!draft.profileUrl) blockers.push('no profile URL, so there is no way to confirm who this reaches');
  if (!draft.author) blockers.push('no name on the target');

  const greeted = greetedName(draft.message);
  const expected = firstName(draft.author);
  if (greeted && expected && greeted.toLowerCase() !== expected.toLowerCase()) {
    blockers.push(`message greets "${greeted}" but the target is ${draft.author}`);
  }
  if (!greeted && /^\s*(hey|hi|hello)\b/i.test(draft.message || '')) {
    warnings.push('opens with a greeting but no name could be parsed from it');
  }

  const dupes = siblings.filter(s => s !== draft && identityOf(s) === identityOf(draft));
  if (dupes.length) blockers.push(`${dupes.length + 1} drafts target the same person`);

  if (neverTouch.some(n => (draft.author || '').toLowerCase().includes(n))) {
    blockers.push('on the never-touch list');
  }

  // --- relevance ------------------------------------------------------------
  if (!draft.sell) blockers.push('no "sell" recorded, so the ask has no object');
  else {
    if (!String(draft.message || '').includes(draft.sell)) {
      blockers.push('the message does not contain the sell it was built from, so one of them was edited and they no longer agree');
    }
    // Asking to buy something their headline does not mention is the classic wrong-message
    // drift: the model or the regex invented an offer.
    const overlap = similarity(draft.headline || '', draft.sell);
    if (!draft.headline) warnings.push('no headline captured, relevance cannot be checked');
    else if (overlap < 0.2) {
      blockers.push(`"${draft.sell}" does not appear in their headline (overlap ${overlap.toFixed(2)}), so this may be an invented offer`);
    } else if (overlap < 0.34) {
      warnings.push(`weak overlap between the sell and their headline (${overlap.toFixed(2)}), read it before sending`);
    }
  }

  // --- the message itself ---------------------------------------------------
  for (const p of checkMessage(draft.message || '', { isFirst: true })) blockers.push(`message policy: ${p}`);

  // --- evidence -------------------------------------------------------------
  if (typeof draft.score === 'number' && draft.score < 70) warnings.push(`score is ${draft.score}, below the default threshold`);
  if (!draft.tells?.length) warnings.push('no tells recorded, so there is no evidence trail for this one');
  if (draft.verdict === 'human') blockers.push('the model judged this person human');

  return { who, pass: blockers.length === 0, blockers, warnings };
}

// ---------------------------------------------------------------- follow-ups

const STOP_CATEGORIES = new Set(['hostile', 'probe', 'injection', 'declined_to_guess']);

/**
 * QA a follow-up before it is sent.
 * @param {{message:string, thread:{messages:{text:string,fromMe:boolean}[]}, target:object,
 *          category?:string, neverTouch?:string[], maxRounds?:number}} args
 */
export function qaFollowUp({ message, thread, target = {}, category, neverTouch = [], maxRounds = 4 }) {
  const blockers = [], warnings = [];
  const who = target.author || thread?.chatId || '(unknown)';
  const msgs = thread?.messages || [];
  const inbound = msgs.filter(m => !m.fromMe);
  const outbound = msgs.filter(m => m.fromMe);
  const last = msgs[msgs.length - 1];
  const theirLast = inbound[inbound.length - 1];

  // --- the hard stops -------------------------------------------------------
  if (category && STOP_CATEGORIES.has(category)) blockers.push(`category is "${category}", which ends the conversation`);
  if (neverTouch.some(n => who.toLowerCase().includes(n))) blockers.push('on the never-touch list');

  // --- thread integrity -----------------------------------------------------
  if (!inbound.length) blockers.push('they have not replied, so there is nothing to follow up on');
  if (last && last.fromMe) blockers.push('the last message in this thread is already yours. Sending again is a double-text');
  if (outbound.length >= maxRounds) blockers.push(`${outbound.length} messages sent already, cap is ${maxRounds}`);

  // A follow-up that repeats a question you already asked is the most visible way to look
  // automated, and it happens whenever thread state is read wrong.
  const repeat = outbound.find(m => similarity(m.text, message) >= 0.65);
  if (repeat) blockers.push(`this is a near-repeat of something you already sent: "${(repeat.text || '').slice(0, 60)}"`);

  // --- anti-drift: is it about what they actually said? ---------------------
  if (theirLast) {
    const shared = anchorTerms(theirLast.text, message);
    if (!shared.length) {
      blockers.push('the question does not reference anything in their last message, so it probably belongs to a different conversation');
    } else if (shared.length === 1) {
      warnings.push(`anchored on one term only ("${shared[0]}")`);
    }
  }

  // --- the message itself ---------------------------------------------------
  for (const p of checkMessage(message || '', { isFirst: false })) blockers.push(`message policy: ${p}`);

  return { who, pass: blockers.length === 0, blockers, warnings };
}

// ---------------------------------------------------------------- batch audit

/** QA a whole batch of openers. Returns the ones cleared to send and the ones held. */
export function auditDrafts(drafts, { neverTouch = [] } = {}) {
  const results = drafts.map(d => ({ draft: d, ...qaDraft(d, { neverTouch, siblings: drafts }) }));
  return {
    cleared: results.filter(r => r.pass).map(r => r.draft),
    held: results.filter(r => !r.pass),
    warned: results.filter(r => r.pass && r.warnings.length),
    results,
  };
}

// ---------------------------------------------------------------- model grade

const GRADE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['score', 'anchoredTo', 'onlyTheyCanAnswer', 'problems'],
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    anchoredTo: { type: 'string', maxLength: 160 },
    onlyTheyCanAnswer: { type: 'boolean' },
    problems: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 120 } },
    better: { type: 'string', maxLength: 200 },
  },
};

/**
 * Grade a follow-up with the model. Import lazily so nothing here needs credentials
 * unless it is actually used.
 * A grade never clears a deterministic blocker. It only adds reasons to hold.
 */
export async function gradeQuestion({ message, theirReply, theirHeadline }) {
  const { gradeFollowUp } = await import('../llm/claude.mjs');
  const g = await gradeFollowUp({ message, theirReply, theirHeadline });
  if (g._refused) return { score: null, problems: [`model declined to grade: ${g._why}`], _refused: true };
  return g;
}

/** The bar a graded question has to clear. */
export const GRADE_FLOOR = Number(process.env.NAUGHTY_GRADE_FLOOR || 65);
