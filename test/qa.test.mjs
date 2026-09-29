// The QA gate. These are the failures that cannot be taken back once sent, so each one
// gets a test: wrong person, invented offer, desynced fields, duplicate target, double
// text, repeated question, a question about a conversation that never happened.
import assert from 'node:assert/strict';
import { qaDraft, qaFollowUp, auditDrafts, anchorTerms } from '../src/qa/verify.mjs';

let pass = 0; const fail = [];
const t = (n, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${n}: ${e.message}`); } };

const base = {
  author: 'FarmA Case', profileUrl: 'https://linkedin.com/in/farma-case',
  headline: 'Sales teams lose 15+ hours a week on prospecting, outreach and follow-up. I deploy AI Agents that cover it at a fraction of an SDR.',
  sell: 'someone to deploy AI agents on our prospecting and follow-up',
  score: 79, tells: ['headline is identical to FarmB Case'],
  message: "Hey FarmA, i really liked your thinking on my post. I'm actually looking to hire someone to deploy AI agents on our prospecting and follow-up, can you tell me more?",
};
const held = (d, ctx) => qaDraft(d, { siblings: [d], ...ctx });

t('a clean draft passes', () => assert.equal(held(base).pass, true, JSON.stringify(held(base).blockers)));

t('greeting the wrong person is blocked', () => {
  const r = held({ ...base, message: base.message.replace('Hey FarmA', 'Hey FarmB') });
  assert.equal(r.pass, false);
  assert.match(r.blockers.join(' '), /greets "FarmB" but the target is FarmA/);
});
t('an offer they do not sell is blocked', () => {
  const r = held({ ...base, sell: 'a wedding photographer', message: "Hey FarmA, i really liked your thinking on my post. I'm actually looking to hire a wedding photographer, can you tell me more?" });
  assert.equal(r.pass, false);
  assert.match(r.blockers.join(' '), /invented offer/);
});
t('sell and message out of sync is blocked', () => {
  const r = held({ ...base, message: base.message.replace(base.sell, 'an Attio implementation') });
  assert.equal(r.pass, false);
  assert.match(r.blockers.join(' '), /does not contain the sell/);
});
t('missing profile URL is blocked', () => assert.match(held({ ...base, profileUrl: '' }).blockers.join(' '), /no profile URL/));
t('never-touch is re-checked at QA time', () => {
  assert.match(qaDraft(base, { siblings: [base], neverTouch: ['farma'] }).blockers.join(' '), /never-touch/);
});
t('a person the model called human is blocked', () => assert.match(held({ ...base, verdict: 'human' }).blockers.join(' '), /judged this person human/));
t('two drafts aimed at one person are blocked', () => {
  const a = auditDrafts([base, { ...base }], {});
  assert.equal(a.cleared.length, 0);
  assert.match(a.held[0].blockers.join(' '), /target the same person/);
});
t('a partly-related offer warns without blocking', () => {
  // "sales" is in their headline, "coaching" is not. Related enough to send, loose enough
  // that a human should read it first.
  const r = held({ ...base, sell: 'sales coaching for the team', message: "Hey FarmA, i really liked your thinking on my post. I'm actually looking to hire sales coaching for the team, can you tell me more?" });
  assert.equal(r.pass, true, JSON.stringify(r.blockers));
  assert.ok(r.warnings.some(w => /overlap/.test(w)), JSON.stringify(r.warnings));
});
t('a common verb does not count as an anchor', () => {
  assert.deepEqual(anchorTerms('what do you think about this', 'what do you think about that'), []);
  assert.deepEqual(anchorTerms('sounds great, really interesting stuff', 'sounds really interesting'), []);
});

// ---- follow-ups --------------------------------------------------------------
const thread = { chatId: 'c1', messages: [
  { text: 'Hey FarmA, looking to hire someone to deploy AI agents on our prospecting, can you tell me more?', fromMe: true },
  { text: "We've built ORBIT, an AI sales agent that orchestrates your full sales motion across channels. Prospecting, outreach, replies, meeting booking, CRM sync. Unconditional 14-day free trial.", fromMe: false },
] };
const fu = (message, over = {}) => qaFollowUp({ message, thread, target: { author: 'FarmA Case' }, category: 'pitch_template', ...over });

t('a question anchored on their product name passes', () => assert.equal(fu('does ORBIT write the replies itself or queue them for a human?').pass, true));
t('a question anchored on their number passes', () => assert.equal(fu('what happens to the agents after the 14-day trial ends?').pass, true));
t('a question about a different conversation is blocked', () => {
  assert.match(fu('what did you think of the Attio migration?').blockers.join(' '), /does not reference anything in their last message/);
});
t('a generic question is blocked as unanchored', () => assert.match(fu('what are your rates?').blockers.join(' '), /does not reference anything/));
t('repeating something you already sent is blocked', () => {
  assert.match(fu('Hey FarmA, looking to hire someone to deploy AI agents on our prospecting, can you tell me more?').blockers.join(' '), /near-repeat/);
});
t('double-texting is blocked', () => {
  const t2 = { ...thread, messages: [...thread.messages, { text: 'any update?', fromMe: true }] };
  assert.match(qaFollowUp({ message: 'does ORBIT handle CRM sync itself?', thread: t2, target: { author: 'FarmA Case' }, category: 'pitch_template' }).blockers.join(' '), /double-text/);
});
t('a thread with no reply is blocked', () => {
  const t3 = { chatId: 'c2', messages: [{ text: 'Hey FarmA, ...', fromMe: true }] };
  assert.match(qaFollowUp({ message: 'does ORBIT do CRM sync?', thread: t3, target: { author: 'FarmA Case' } }).blockers.join(' '), /have not replied/);
});
for (const cat of ['hostile', 'probe', 'injection', 'declined_to_guess']) {
  t(`a "${cat}" thread cannot be followed up`, () => {
    assert.match(fu('does ORBIT write the replies itself?', { category: cat }).blockers.join(' '), new RegExp(`"${cat}"`));
  });
}
t('the round cap holds', () => {
  const many = { chatId: 'c4', messages: [] };
  for (let i = 0; i < 4; i++) { many.messages.push({ text: `q${i} about ORBIT`, fromMe: true }); many.messages.push({ text: 'ORBIT replies here', fromMe: false }); }
  assert.match(qaFollowUp({ message: 'and does ORBIT log to the CRM?', thread: many, target: { author: 'C' }, maxRounds: 4 }).blockers.join(' '), /cap is 4/);
});

// ---- anchoring ---------------------------------------------------------------
t('anchorTerms catches a short product name', () => assert.ok(anchorTerms('We built ORBIT for this', 'does ORBIT do that?').includes('orbit')));
t('anchorTerms catches a number', () => assert.ok(anchorTerms('a 14-day free trial', 'what happens after the 14-day trial?').includes('14-day')));


console.log(`\n${pass} passed, ${fail.length} failed`);
for (const f of fail) console.log(`  FAIL ${f}`);
process.exit(fail.length ? 1 : 0);
