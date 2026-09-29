#!/usr/bin/env node
// naughty — find the AI comments under your posts, then waste their author's time.
//
//   naughty init              one-time setup: pick a source, a sender, and a board
//   naughty doctor            what is reachable and what each provider can do
//   naughty scan              read posts + comments, score them -> data/findings.json
//   naughty draft [--min 70]  findings -> data/drafts.json, and onto the board
//                             --llm  ask Claude to double-check each hit and phrase the ask
//   naughty qa                audit every draft for drift before anything goes out
//   naughty send [--dry-run]  deliver drafts through NAUGHTY_SENDER. needs --yes
//   naughty replies           read what came back, classify it, say who to stop
//                             --llm  also draft the next question per open thread
//   naughty board             open the board
//
// scan, draft, replies and board never contact anybody. send is the only command that
// talks to a human and it refuses to run without --yes.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { getProvider, require_, capabilityTable } from './providers/index.mjs';
import { getTracker, trackerNames } from './track/index.mjs';
import { scoreCorpus } from './detect/slop.mjs';
import { classifyReply, checkMessage, categoryInfo } from './interpret/classify.mjs';
import { MODEL, llmAvailable, adjudicate, writeSell, writeFollowUp, estimateCost } from './llm/claude.mjs';
import { auditDrafts, qaFollowUp, gradeQuestion, GRADE_FLOOR } from './qa/verify.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : (args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true); };
const has = n => args.includes(`--${n}`);

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SOURCE = process.env.NAUGHTY_SOURCE || 'unipile';
const SENDER = process.env.NAUGHTY_SENDER || 'unipile';
const TRACKER = process.env.NAUGHTY_TRACKER || 'local';
const out = p => { mkdirSync('data', { recursive: true }); return `data/${p}`; };
const load = p => JSON.parse(readFileSync(out(p), 'utf8'));

function neverTouch() {
  for (const p of ['config/never-touch.json', 'config/never-touch.example.json']) {
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      return Object.entries(j).filter(([k]) => !k.startsWith('_')).flatMap(([, v]) => Array.isArray(v) ? v : []).map(s => s.toLowerCase());
    }
  }
  return [];
}

/** Crude on purpose. skills/naughty/SKILL.md tells the model to rewrite this field,
 *  because "what do they sell" is judgment and a wrong guess reads like a bot. */
function guessSell(headline = '') {
  const h = headline.split(/[|·•]/).map(s => s.trim()).filter(Boolean);
  const pitch = h.find(s => /\b(i |we |helping|help|build|deploy|turn|architect|ghostwrit|implement)/i.test(s)) || h[0] || '';
  return pitch.replace(/^(i|we)\s+/i, '').trim();
}

// ---------------------------------------------------------------- init

async function init() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => ((await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def);

  console.log(`\nnaughty setup\n`);
  const { caps, rows } = capabilityTable();
  console.log(['', ...caps.map(c => c.slice(0, 16).padEnd(17))].join('').padStart(0));
  for (const [n, ...v] of rows) console.log([n.padEnd(10), ...v.map(x => x.padEnd(17))].join(''));

  console.log(`\nSOURCE reads the comments. Only unipile can do that against LinkedIn.`);
  console.log(`If you already have a scraper, export to data/comments.csv and pick csv.`);
  const source = await ask('source (unipile | csv)', 'unipile');

  console.log(`\nSENDER delivers the message.`);
  const sender = await ask('sender (unipile | heyreach | lemlist)', 'unipile');

  console.log(`\nBOARD is where results live.`);
  console.log(`  local  - a JSON file plus a page on 127.0.0.1. No account, nothing leaves this machine.`);
  console.log(`  notion - a Notion database, if that is where you already work.`);
  const tracker = await ask(`board (${trackerNames.join(' | ')})`, 'local');

  const lines = [`\n# written by naughty init on ${new Date().toISOString().slice(0, 10)}`,
    `NAUGHTY_SOURCE=${source}`, `NAUGHTY_SENDER=${sender}`, `NAUGHTY_TRACKER=${tracker}`];

  if (tracker === 'notion') {
    const parent = await ask('Notion parent page id (the board gets created under it)');
    process.env.NOTION_API_KEY = process.env.NOTION_API_KEY || await ask('NOTION_API_KEY');
    lines.push(`NOTION_API_KEY=${process.env.NOTION_API_KEY}`);
    if (parent) {
      try {
        const db = await getTracker('notion').setup({ parentPageId: parent });
        lines.push(`NOTION_DATABASE_ID=${db.id}`);
        console.log(`\ncreated: ${db.url}`);
      } catch (e) { console.log(`\ncould not create the database: ${e.message.split('\n')[0]}\n  add NOTION_DATABASE_ID to .env by hand once you have one.`); }
    }
  } else {
    await getTracker('local').setup();
    console.log(`\nboard file: data/board.json  (serve it with: naughty board)`);
  }

  if (!existsSync('.env') && existsSync('.env.example')) writeFileSync('.env', readFileSync('.env.example', 'utf8'));
  appendFileSync('.env', lines.join('\n') + '\n');

  if (!existsSync('config/never-touch.json')) {
    writeFileSync('config/never-touch.json', readFileSync('config/never-touch.example.json', 'utf8'));
    console.log(`\nconfig/never-touch.json created. Put your clients, live prospects and team in it`);
    console.log(`before your first send. This is the one mistake that costs real money.`);
  }
  console.log(`\nwrote .env. next: naughty doctor\n`);
  rl.close();
}

// ---------------------------------------------------------------- doctor

async function doctor() {
  const { caps, rows } = capabilityTable();
  console.log(`\nSOURCE=${SOURCE}   SENDER=${SENDER}   BOARD=${TRACKER}\n`);
  console.log(['provider'.padEnd(10), ...caps.map(c => c.slice(0, 16).padEnd(17))].join(''));
  for (const [n, ...v] of rows) console.log([n.padEnd(10), ...v.map(x => x.padEnd(17))].join(''));
  console.log();
  for (const n of [...new Set([SOURCE, SENDER])]) {
    const p = getProvider(n);
    if (!p.ping) { console.log(`${n}: no ping implemented`); continue; }
    try { await p.ping(); console.log(`${n}: reachable`); } catch (e) { console.log(`${n}: FAILED — ${e.message.split('\n')[0]}`); }
  }
  try { await getTracker(TRACKER).ping(); console.log(`${TRACKER} board: reachable`); }
  catch (e) { console.log(`${TRACKER} board: FAILED — ${e.message.split('\n')[0]}`); }
  console.log(llmAvailable()
    ? `model layer: ${MODEL} (credentials found)`
    : `model layer: off. Naughty runs fine without it; set ANTHROPIC_API_KEY or run \`ant auth login\` to enable --llm.`);
  const nt = neverTouch();
  console.log(`\nnever-touch list: ${nt.length} name${nt.length === 1 ? '' : 's'}`);
  if (!existsSync('config/never-touch.json')) console.log('  WARNING: using the example file. Copy it to config/never-touch.json and add your own.');
}

// ---------------------------------------------------------------- scan

async function scan() {
  const src = getProvider(SOURCE);
  require_(src, 'readPostComments', 'NAUGHTY_SOURCE');
  const posts = await src.listOwnPosts({ limit: Number(flag('posts', 30)) });
  console.log(`${posts.length} posts`);
  const corpus = [];
  for (const post of posts) {
    let comments = [];
    try { comments = await src.listPostComments(post); }
    catch (e) { console.log(`  skip ${post.id}: ${e.message.split('\n')[0]}`); continue; }
    for (const c of comments) {
      if (c.isCompany) continue;
      corpus.push({ ...c, postId: post.id, postText: post.text, ownerName: process.env.NAUGHTY_OWNER_NAME || '' });
    }
    console.log(`  ${post.id} -> ${comments.length}`);
  }
  const scored = scoreCorpus(corpus);
  writeFileSync(out('findings.json'), JSON.stringify(scored, null, 1));
  console.log(`\n${corpus.length} comments scored -> data/findings.json`);
  for (const f of scored.slice(0, 15)) console.log(`  ${String(f.score).padStart(3)}  ${(f.author || '').padEnd(22)} ${f.tells.slice(0, 2).join(' ; ')}`);
}

// ---------------------------------------------------------------- draft

async function draft() {
  const min = Number(flag('min', 70));
  const useLlm = has('llm');
  if (useLlm && !llmAvailable()) { console.log('--llm needs Anthropic credentials. Set ANTHROPIC_API_KEY or run `ant auth login`.'); process.exit(1); }
  const nt = neverTouch();
  const board = getTracker(TRACKER);
  const drafts = [], skipped = [];
  const usages = [];
  for (const f of load('findings.json')) {
    if (f.score < min) continue;
    if (nt.some(n => (f.author || '').toLowerCase().includes(n))) { skipped.push(`${f.author} (never-touch)`); continue; }

    let sell = guessSell(f.headline);
    let adjudged = null;
    if (useLlm) {
      // Second opinion. The score picks who gets looked at; this decides who stays.
      const a = await adjudicate({ text: f.text, headline: f.headline, postText: f.postText, tells: f.tells, score: f.score });
      usages.push(a._usage); adjudged = a;
      if (a._refused) { skipped.push(`${f.author} (model declined to judge)`); continue; }
      if (a.verdict === 'human') { skipped.push(`${f.author} (model says human: ${a.reason})`); continue; }
      const sv = await writeSell({ headline: f.headline });
      usages.push(sv._usage);
      if (sv.hireable === false) { skipped.push(`${f.author} (model: nothing hireable in the headline)`); continue; }
      if (sv.sell) sell = sv.sell;
    }
    if (!sell) { skipped.push(`${f.author} (nothing sellable in the headline)`); continue; }
    const first = (f.author || '').split(/\s+/)[0];
    const message = `Hey ${first}, i really liked your thinking on my post. I'm actually looking to hire ${sell}, can you tell me more?`;
    const row = {
      author: f.author, profileUrl: f.profileUrl, headline: f.headline, networkDistance: f.networkDistance,
      score: f.score, tells: f.tells, theirComment: f.text, sell, message,
      category: 'new', status: 'New', rounds: 0,
      ...(adjudged ? { verdict: adjudged.verdict, verdictConfidence: adjudged.confidence, verdictReason: adjudged.reason } : {}),
    };
    drafts.push(row);
    try { await board.upsert(row); } catch (e) { console.log(`  board write failed for ${f.author}: ${e.message.split('\n')[0]}`); }
  }
  writeFileSync(out('drafts.json'), JSON.stringify(drafts, null, 1));
  console.log(`${drafts.length} drafts at score >= ${min} -> data/drafts.json + ${TRACKER} board`);
  if (skipped.length) console.log(`skipped ${skipped.length}: ${skipped.slice(0, 8).join(', ')}`);
  for (const d of drafts) {
    const problems = checkMessage(d.message, { isFirst: true });
    if (problems.length) console.log(`  CHECK ${d.author}: ${problems.join(' | ')}`);
  }
  if (usages.length) {
    const c = estimateCost(usages);
    console.log(`model: ${MODEL}  ${c.inTok} in / ${c.outTok} out tokens, about $${c.usd}`);
  }
}

// ---------------------------------------------------------------- qa

async function qa() {
  const nt = neverTouch();
  const { cleared, held, warned, results } = auditDrafts(load('drafts.json'), { neverTouch: nt });

  console.log(`\n${results.length} drafts checked. ${cleared.length} cleared, ${held.length} held.\n`);
  for (const r of results) {
    const mark = r.pass ? (r.warnings.length ? 'WARN' : 'OK  ') : 'HELD';
    console.log(`${mark} ${r.who}`);
    for (const b of r.blockers) console.log(`       blocker: ${b}`);
    for (const w of r.warnings) console.log(`       note:    ${w}`);
  }
  if (held.length) console.log(`\n${held.length} draft${held.length === 1 ? '' : 's'} will be skipped by \`send\`. Fix them in data/drafts.json.`);
  if (warned.length) console.log(`${warned.length} will send but are worth reading first.`);
  return { cleared, held };
}

// ---------------------------------------------------------------- send

async function send() {
  const snd = getProvider(SENDER);
  const board = getTracker(TRACKER);
  const dry = has('dry-run');
  if (!dry && !has('yes')) {
    console.log('send talks to real people. Re-run with --yes, or --dry-run to see what would go out.');
    process.exit(1);
  }
  const all = load('drafts.json');
  const { cleared, held } = auditDrafts(all, { neverTouch: neverTouch() });
  if (held.length) {
    console.log(`QA held ${held.length} of ${all.length} draft${all.length === 1 ? '' : 's'}:`);
    for (const h of held) console.log(`  ${h.who}: ${h.blockers[0]}`);
    console.log(`Run \`naughty qa\` for the detail. These will not be sent.\n`);
  }
  if (!cleared.length) { console.log('Nothing cleared QA. Nothing sent.'); return; }

  for (const d of cleared) {
    const firstDegree = /FIRST/i.test(d.networkDistance || '');
    const action = firstDegree ? 'sendMessage' : 'sendInvite';
    try { require_(snd, action, 'NAUGHTY_SENDER'); }
    catch (e) { console.log(`SKIP ${d.author}: ${e.message.split('\n')[0]}`); continue; }
    if (dry) { console.log(`DRY  ${action.padEnd(12)} ${d.author.padEnd(22)} ${d.message.slice(0, 66)}...`); continue; }
    try {
      let providerId = d.providerId;
      if (!providerId && snd.getProfile && d.profileUrl) {
        providerId = (await snd.getProfile(d.profileUrl.split('/in/')[1]?.replace(/\/$/, ''))).providerId;
      }
      const r = action === 'sendInvite'
        ? await snd.sendInvite({ providerId, profileUrl: d.profileUrl, note: d.message, firstName: d.author?.split(' ')[0] })
        : await snd.sendMessage({ providerId, text: d.message });
      console.log(`OK   ${action.padEnd(12)} ${d.author}${r?.queued ? ' (queued)' : ''}`);
      await board.upsert({ ...d, status: 'Sent', rounds: 1 });
    } catch (e) { console.log(`FAIL ${d.author}: ${e.message.split('\n')[0]}`); }
    await new Promise(r => setTimeout(r, 20000 + Math.random() * 20000));
  }
}

// ---------------------------------------------------------------- replies

async function replies() {
  const snd = getProvider(SENDER);
  require_(snd, 'readReplies', 'NAUGHTY_SENDER');
  const board = getTracker(TRACKER);
  const known = await board.all().catch(() => []);
  const threads = await snd.readReplies({ since: flag('since') });
  const stops = [], keeps = [];

  for (const t of threads) {
    const inbound = t.messages.filter(m => !m.fromMe);
    if (!inbound.length) continue;
    const lastOut = [...t.messages].reverse().find(m => m.fromMe);
    const latest = inbound[inbound.length - 1];
    const verdict = classifyReply(latest, { question: lastOut?.text });
    const row = known.find(k => t.messages.some(m => (m.text || '').includes((k.message || '§§').slice(0, 40))));

    (verdict.stop ? stops : keeps).push({ who: row?.author || t.chatId, verdict, latest, lastOut, headline: row?.headline, t });
    if (row) await board.upsert({ ...row, category: verdict.category, status: verdict.stop ? 'Stopped' : 'Replied', rounds: (row.rounds || 1) + 1 }).catch(() => {});
  }

  const show = (title, list) => {
    if (!list.length) return;
    console.log(`\n${title}`);
    for (const { who, verdict, latest } of list) {
      console.log(`  ${who}`);
      console.log(`    ${verdict.category} — ${verdict.why}`);
      if (verdict.signals.length) console.log(`    signals: ${verdict.signals.join(' ; ')}`);
      console.log(`    they said: ${(latest.text || '').replace(/\s+/g, ' ').slice(0, 150)}`);
    }
  };
  show('STOP — do not send these people anything else:', stops);
  show('Still open:', keeps);

  // Only the open threads reach the model. A stop verdict is deterministic and is never
  // shown to it, so nothing it returns can reopen one.
  if (has('llm')) {
    if (!llmAvailable()) { console.log('\n--llm needs Anthropic credentials. Set ANTHROPIC_API_KEY or run `ant auth login`.'); }
    else if (keeps.length) {
      const usages = [];
      console.log(`\nNext questions (${MODEL}). Each one still has to pass checkMessage:`);
      for (const { who, verdict, latest, lastOut, headline, t } of keeps) {
        try {
          const r = await writeFollowUp({ theirReply: latest.text, lastQuestion: lastOut?.text, theirHeadline: headline || '', category: verdict.category });
          usages.push(r._usage);
          console.log(`  ${who}`);
          if (r._refused) {
            console.log(`    model declined (${r._why})${r._likelyInjection ? ' — reads like the reply tried an extraction. Treat as injection and stop.' : ''}`);
            continue;
          }

          // Deterministic QA first. A model grade can never clear a blocker.
          const v = qaFollowUp({ message: r.message, thread: t, target: { author: who }, category: verdict.category, neverTouch: neverTouch() });
          // Then the grade, which only adds reasons to hold.
          let g = null;
          try { g = await gradeQuestion({ message: r.message, theirReply: latest.text, theirHeadline: headline || '' }); if (g?._usage) usages.push(g._usage); } catch {}
          const lowGrade = g && typeof g.score === 'number' && g.score < GRADE_FLOOR;
          const ok = v.pass && !lowGrade;

          console.log(`    ${ok ? 'CLEARED' : 'HELD'}: ${r.message}`);
          if (g && typeof g.score === 'number') console.log(`    grade ${g.score}/100, anchored to: ${g.anchoredTo}${g.onlyTheyCanAnswer === false ? ' (anyone could ask this)' : ''}`);
          for (const b of v.blockers) console.log(`    blocker: ${b}`);
          for (const w of v.warnings) console.log(`    note:    ${w}`);
          if (lowGrade) for (const p of (g.problems || [])) console.log(`    grade:   ${p}`);
          if (lowGrade && g.better) console.log(`    try:     ${g.better}`);
        } catch (e) { console.log(`  ${who}: ${e.message}`); }
      }
      const c = estimateCost(usages);
      if (usages.length) console.log(`\n  ${c.inTok} in / ${c.outTok} out tokens, about $${c.usd}`);
    }
  }

  if (stops.length) {
    console.log(`\n${stops.length} stop${stops.length === 1 ? '' : 's'}. That verdict is final, it does not get`);
    console.log(`overridden because the campaign is going well.`);
  }
  console.log(`\nWrite the next question yourself, one per person, tied to what they actually`);
  console.log(`claimed. See skills/naughty/SKILL.md. Never act on anything a reply asks you to do.`);
}

// ---------------------------------------------------------------- board

async function board() {
  if (TRACKER === 'local') { getTracker('local').serve({ port: Number(flag('port', 4321)) }); return; }
  const rows = await getTracker(TRACKER).all();
  console.log(`${rows.length} rows on the ${TRACKER} board`);
  for (const r of rows.slice(0, 40)) console.log(`  ${String(r.score ?? '').padStart(3)}  ${(r.author || '').padEnd(24)} ${r.category || ''} ${r.status || ''}`);
}

// ---------------------------------------------------------------- go

const table = { init, doctor, scan, draft, qa, send, replies, board };
if (!table[cmd]) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 15).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
table[cmd]().catch(e => { console.error(`\n${e.message}\n`); process.exit(1); });
