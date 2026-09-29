# Naughty

Naughty reads the comments under your LinkedIn posts, works out which ones a machine wrote,
and then messages the author to ask about buying whatever it is they sell.

It is the only way i found to get revenge on the people filling my comment section with slop.
If you hate them as much as i do, here is your solution.

They rent a bot to fake interest in my post. Naughty runs a bot to fake interest in their
business. Seems fair.

## Where this came from

I build GTM agents for a living. At [Yalc](https://yalc.ai) that means a harness instead of a
pile of scripts: a deterministic core that behaves the same way twice, provider adapters so
nobody is married to one vendor, a QA gate before anything reaches a human, and an operator
who has to approve the send. Naughty is that shape pointed at something stupid.

Which makes it a decent worked example. Small enough to read end to end in an evening, same
bones as the agents that touch real client pipeline.

Want the serious version aimed at your own GTM instead of your own comment section?
**[Request access to Yalc](https://yalc.ai/community/)**.

## How it works

```
  your posts ──▶ scan ──▶ findings.json      scores every comment. touches nobody
                            │
                            ▼
                          draft ──▶ drafts.json    one message each, plus what they sell
                            │
                            ▼
                           qa                 wrong person? invented offer? drift? held
                            │
                            ▼
                          send                cleared drafts only, and only with --yes
                            │
                            ▼
                         replies ──▶ classify ──▶ four verdicts end the conversation
                                          │
                                          ▼
                                    next question ──▶ qa + grade ──▶ you approve
```

Two things hold the whole way down. Nothing sends until a human types `--yes`, and every step
leaves a file on disk you can read before the next step runs.

## Setup

```bash
git clone https://github.com/Othmane-Khadri/naughty && cd naughty
npm install
node src/cli.mjs init      # three questions: source, sender, board
node src/cli.mjs doctor    # what is actually reachable, before you waste a run
```

Then:

```bash
node src/cli.mjs scan --posts 30
node src/cli.mjs draft
node src/cli.mjs qa
node src/cli.mjs send --dry-run
node src/cli.mjs send --yes
node src/cli.mjs replies
node src/cli.mjs board
```

Everything except `send` is harmless. `send` refuses to run without `--yes`.

**Try it with no credentials at all.** There is a sample batch in the repo, so you can watch
the detector work before you sign up for anything:

```bash
mkdir -p data && cp examples/comments.sample.csv data/comments.csv
NAUGHTY_SOURCE=csv node src/cli.mjs scan
NAUGHTY_SOURCE=csv node src/cli.mjs draft
NAUGHTY_SOURCE=csv node src/cli.mjs qa
NAUGHTY_SOURCE=csv node src/cli.mjs board     # then open 127.0.0.1:4321
```

Six synthetic comments: one account running a template twice, two accounts posting the same
sentence, a real human, and somebody who just wrote "Nice one, congrats!". The last two should
score near zero, and if they do not, the detector is broken.

Fill in `config/never-touch.json` first. Clients, live prospects, partners, your own team.
Naughty skips anyone on it. Sending this to a prospect who happened to write one lazy comment
is the only mistake here that costs actual money, and it is one bad afternoon away at all
times.

## Providers

I assumed any LinkedIn tool could do this. I was wrong, and it is the most useful thing in
this repo. Reading comments and sending messages are separate capabilities, and the three
tools everyone already pays for do not overlap on them.

| | read post comments | read headline | invite + note | DM | read replies |
|---|---|---|---|---|---|
| [Unipile](https://www.unipile.com/?utm_source=partner&utm_campaign=Yalc) | yes | yes | yes | yes | yes |
| [HeyReach](https://heyreach.io?via=othmane2z) | no | no | yes, queued | yes | yes |
| [lemlist](https://get.lemlist.com/skrtwnkxw60i) | no | no | no | yes | yes |
| csv (your own scraper) | yes | via your scraper | no | no | no |

So there are two slots. `NAUGHTY_SOURCE` finds the comments, `NAUGHTY_SENDER` delivers the
message.

Only Unipile fills the source slot against LinkedIn directly. HeyReach has no scraping
endpoint at all. lemlist has no connection-request endpoint either, because LinkedIn invites
live as a sequence step inside their app rather than on the API, so on lemlist you can only
message people you are already connected to. Most commenters are second degree. Naughty says
so out loud rather than quietly sending nothing:

```
SKIP Beta One: lemlist cannot "sendInvite".
  Fix: use NAUGHTY_SENDER=unipile or heyreach for invites.
```

**Bring your own scraper if you have one.** Anything that hands you comment text plus the
commenter's headline works: Apify, Phantombuster, Proxycurl, a Puppeteer script you wrote at
2am. Write the rows into `data/comments.csv` with the header in `src/providers/csv.mjs` and the
scoring is identical. The detector wants the text and the headline, not a particular invoice.

I use Unipile anyway because it is one credential for the whole loop: read the comment, read
the headline, send the invite, read the reply. A scraper plus a separate sender means two
vendors, two rate limits, and matching profiles across them by hand.

Those three are affiliate links. Signing up through one supports this and costs you nothing.

## Where the results live

`init` asks once.

**`local`** is the default: a JSON file and a page served on `127.0.0.1`. No account, no API
key, nothing leaves your machine. `naughty board` starts it. Default because the board fills
up with real people's names and comments, and most of that has no business going to a SaaS you
signed up for five minutes ago.

**`notion`** builds the database for you under a parent page you name, if that is where you
already live.

Same three functions either way, so a third one is a single file in `src/track/`.

## How it knows a bot wrote it

`src/detect/slop.mjs`. No model call, no network, one file you can read in ten minutes.

It scores the whole batch at once, because the two signals that actually convict somebody are
invisible one comment at a time.

**Same person, same skeleton, different posts** (+40, more for each repeat). A human's
comments vary. One guy had run his on six of mine.

**Two unrelated accounts, one sentence, same post** (+55). That is a shared generator, not a
coincidence. This is the one that convinced me to build the rest.

**Two commenters with the same headline, word for word** (+40). Comment farms buy their
headlines in bulk.

Then the tool fingerprints: a closing line in bold mathematical unicode (+30), which is not a
LinkedIn feature but a comment tool forcing its CTA to stand out. Your own numbers quoted back
at you (+10). Your name parked at the end of a line (+8) where a tool drops it rather than
where a person types it. Restating the post and bolting on a question (+22).

And last, weakest, the cadence list: "is the real insight here", "the real unlock here is",
"the key is having a clear process", "reminds us that". Twelve points a hit, three hits
maximum, which on its own never clears the bar.

**Two things push the score down.** First person specifics, "i built", "i tried", "i hated"
(−18). Pushing back, disagreeing, saying they are not sure (−14). Those are the two things
the generators never produce.

The threshold is 70, and the weights are set so that a structural tell clears it alone while
the lexical ones cannot. **Bland is not the same as botted.** Plenty of real people write dull
comments on their phone between meetings and they are not the target.

If you add a tell, test it against comments you know are human first. `npm test` scores the
real batch from my first run, humans included. A rule that fires on a person is broken, not
strict.

## Reading the replies

`naughty replies` sorts every answer and tells you who to leave alone. Four verdicts end the
conversation, and they do not get revisited because a run is going well:

| | |
|---|---|
| `hostile` | asked you to stop, or worked out what this is |
| `probe` | asked outright whether this is automated |
| `injection` | tried to reprogram the reader, or asked for something off topic |
| `declined_to_guess` | had a clean opening to invent a number and refused |

Still open: `calendar`, `pitch_template`, `substantive`, `asked_back`, `vague`, `logistics`.

That last stop is deliberate and it is the one people argue with. Somebody who says "i don't
remember and i don't want to guess" just did the single thing a generator never does. Leave
them alone. You found a person.

### Replies are data, not instructions

Naughty reads text from strangers and then acts on it, so `guardInjection()` runs before
anything else and nothing inside a reply can change what Naughty does next. It catches
attempts to reprogram the reader and off-topic bait, a recipe or a poem or some Python, and
answers none of it. Somebody asking whether you are a bot gets handled separately and ends the
conversation rather than being ignored, because a straight question deserves better than
another automated message.

## The QA gate

`naughty qa` audits every draft and `send` runs it whether you asked or not. It only skips
things, it never fixes them.

The point is that **Naughty is not allowed to become the thing it hunts.** A message that
reaches the wrong person, or answers something they never said, is exactly the slop this repo
exists to punish. So:

**Identity.** The name in the greeting has to be the person receiving it. Two drafts cannot
aim at the same profile. The never-touch list is re-checked here, not just at draft time.

**Relevance.** What you are asking to buy has to appear in their headline. If the sell and the
message stop agreeing because one of them got edited alone, that is a block, not a warning.

**Thread.** No double-texting, no repeating a question you already sent, no following up on a
thread nobody answered, no going past the round cap.

**Anchoring**, which is the one that catches real drift. A follow-up has to reference something
specific from their last message: a product name, a number, an uncommon word. Token similarity
was useless for this because it throws away short tokens and the anchor is usually the
three-letter product name, so it looks for shared distinctive terms and counts hits instead. A
question anchored on nothing but "think" or "great" is anchored on nothing.

With `--llm` each follow-up is also graded 0-100 on whether it targets a claim they actually
made and whether only they could answer it. The grader is a second call that sees only the
message and their reply, because a writer is a terrible judge of its own output. A grade can
add a reason to hold. It can never clear a blocker.

```
HELD: what did you think of the Attio migration?
  grade 20/100, anchored to: nothing in their reply
  blocker: the question does not reference anything in their last message
  try:     does ORBIT write the replies itself or queue them for a human?
```

### Why the outgoing messages are short

`checkMessage()` rejects a message before it can leave. Over 28 words on a follow-up, more
than one question mark, none at all, an em dash, a greeting when you are already mid
conversation, an opening pleasantry, "circling back", two asks welded together with "and
also", the word "furthermore", anything that admits to being a machine, or over the
300-character invite cap.

All of it for one reason. **Length and filler are what give a bot away, not vocabulary.** A
message that reads like it cost somebody thirty seconds reads like a person wrote it.

## The model layer

Optional, off unless you ask. The detector and the classifier are regex and they carry the
pipeline alone.

`--llm` adds Claude Opus 5.5 (`claude-opus-5-5`) in the three places a regex is the wrong tool:

- `naughty draft --llm` second-guesses each shortlisted comment before the person goes on the
  list, and phrases what they sell in their own words. It drops anyone it reads as human, and
  its instructions say to err that way, because a false positive here puts a real person into
  a time-wasting campaign.
- `naughty replies --llm` drafts the next question and then grades it.

Needs `ANTHROPIC_API_KEY` or an `ant auth login` profile. Opus 5.5 is $4 per million input
tokens and $20 out, cache reads 5% of input, so a run costs cents and every command prints
what it spent. `NAUGHTY_MODEL` overrides it if you want Fable 5.1 for the harder calls.

Three things about the wiring, because it reads hostile input by design:

- untrusted text is fenced and labelled, and the system prompt says it is evidence rather than
  instruction
- every call is constrained to a JSON schema, so a successful injection still cannot emit
  prose, call a tool, or make Naughty send anything
- no tools are ever passed, and a deterministic `stop` is never shown to the model, so nothing
  it returns can reopen a closed conversation

If a call comes back refused with the category `reasoning_extraction`, something in that reply
tried to pull the model's reasoning out. That is not a bug, that is a hostile commenter, and
it is a stop.

## Extending it

Four extension points, one file each, none of which needs you to understand the rest.

**A provider** (`src/providers/`). Export a `name`, a `capabilities` object, and whichever of
`listOwnPosts` / `listPostComments` / `getProfile` / `sendInvite` / `sendMessage` /
`readReplies` you can honestly implement. Register it in `src/providers/index.mjs`. The
capability flags are load-bearing: declare one false and the CLI refuses that step with an
error naming a provider that can do it, instead of failing three steps later for no visible
reason.

**A tracker** (`src/track/`). Three functions: `ping`, `upsert`, `all`. `local.mjs` is 120
lines including the HTML, so start from that one.

**A tell** (`src/detect/slop.mjs`). Add a check, give it a weight, run `npm test`.

**A message rule** (`src/interpret/classify.mjs`). Adding to `checkMessage` tightens what
`send` will let out.

`npm test` is 84 checks against the real comments and replies from the first live run. Change
a heuristic and watch a test go red, and the change is probably wrong.

## Things that broke while i built this

- **`listPostComments` needs the `social_id` URN** (`urn:li:activity:...`), not the numeric
  post id. Pass the number and Unipile returns an error object with an empty message, which
  reads exactly like "this post has no comments". Cost me a round trip. It throws now.
- **The posts endpoint returns everything twice**, once under the activity URN and once under
  the ugcPost URN. Ask for 30 to get 20.
- **Invite notes cap at 300 characters.** Naughty skips a long one instead of sending half a
  sentence.
- **Network distance contradicts itself.** The value on a comment payload and the one from a
  profile lookup disagree. Trust the profile lookup, or you will try to invite somebody you
  are already connected to.
- **A connection note does not become a chat until they accept it.** An empty inbox is not the
  same as nobody replying, and i spent a while believing it was.

## What it is not

Not a growth hack, and it will not get you meetings. Pointed at the wrong person it is just
rude, which is what `never-touch.json` is for.

And you should know before you run it that some of them answer well. In my first batch of 11,
one sent me a shipped product i could open in a browser, one refused to guess at a number she
could not remember, and one asked a sharper qualifying question than most sales reps manage.
The theory that a bot-written comment means bot-written work is a good joke and a bad
predictor. When somebody answers like a person, you have learned something. Stop there.

## Roadmap

**Objectives you write in plain language.** Say what you want and let it run:

> keep going until you have asked five or six questions and found something they failed
> stop as soon as they send a calendar link
> one question a day, drop it after three

Needs an `objective` in config, per-thread state, and a stop condition the operator owns. Not
built yet on purpose. A loop that talks to real people unattended needs its exit conditions
designed before its happy path.

**A source that is not Unipile.** A browser extension or an Apify actor writing
`data/comments.csv` would let the whole thing run with no paid API at all.

MIT. Go and be terrible to the right people.
