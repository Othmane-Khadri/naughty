// Provider registry.
//
// The thing to understand before you wire anything: reading comments and sending
// messages are DIFFERENT capabilities, and the three tools do not overlap on them.
//
//                     read comments | read headline | invite+note | DM | read replies
//   unipile                 yes            yes           yes       yes      yes
//   heyreach                no             no            yes*      yes      yes
//   lemlist                 no             no            no        yes      yes
//
//   * heyreach sends the invite by enqueueing the lead into a campaign whose first
//     step is a connection request. It is a queue, not a direct send, so delivery is
//     asynchronous and the campaign owns the timing.
//
// So Naughty has two slots. NAUGHTY_SOURCE finds the slop, NAUGHTY_SENDER delivers the
// message. Only unipile can fill the source slot from LinkedIn directly; everyone
// else brings comments in via the csv source.

import * as unipile from './unipile.mjs';
import * as heyreach from './heyreach.mjs';
import * as lemlist from './lemlist.mjs';
import * as csv from './csv.mjs';

const PROVIDERS = { unipile, heyreach, lemlist, csv };

export function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown provider "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
  return p;
}

/** Throw a useful error instead of failing silently three steps later. */
export function require_(provider, capability, slot) {
  if (!provider.capabilities[capability]) {
    const able = Object.entries(PROVIDERS)
      .filter(([, p]) => p.capabilities?.[capability])
      .map(([n]) => n);
    throw new Error(
      `${provider.name} cannot "${capability}".\n` +
      `  ${slot} is set to ${provider.name}.\n` +
      (able.length
        ? `  Providers that can: ${able.join(', ')}.\n`
        : `  No wired provider can do this yet.\n`) +
      (capability === 'readPostComments'
        ? `  Fix: set NAUGHTY_SOURCE=unipile, or export your comments and use NAUGHTY_SOURCE=csv.\n`
        : capability === 'sendInvite'
        ? `  Fix: use NAUGHTY_SENDER=unipile or heyreach for invites. lemlist can only DM people you are already connected to.\n`
        : '')
    );
  }
}

export function capabilityTable() {
  const caps = ['readPostComments', 'readProfile', 'sendInvite', 'sendMessage', 'readReplies'];
  return { caps, rows: Object.entries(PROVIDERS).map(([n, p]) => [n, ...caps.map(c => (p.capabilities?.[c] ? 'yes' : 'no'))]) };
}
