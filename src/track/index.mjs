// Where the board lives. Chosen once, during `naughty init`.
//
//   local  — a JSON file plus a page served on 127.0.0.1. No account, no API key,
//            nothing leaves the machine. Default, because the board holds the names
//            of real people and most people should not ship that to a SaaS.
//   notion — a Notion database, if you already run your work there.
import * as local from './local.mjs';
import * as notion from './notion.mjs';

const TRACKERS = { local, notion };

export function getTracker(name = 'local') {
  const t = TRACKERS[name];
  if (!t) throw new Error(`Unknown tracker "${name}". Available: ${Object.keys(TRACKERS).join(', ')}`);
  return t;
}
export const trackerNames = Object.keys(TRACKERS);
