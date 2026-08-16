// The GitHub Actions output file. The CLI owns $GITHUB_OUTPUT end to end: the
// shell in action.yml never parses stdout, never redirects into the file, and
// never gets to name a key.

import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { EXIT } from './constants.js';
import { fail } from './util.js';

/**
 * Append the composite Action's declared outputs without interpreting stdout.
 * Values use GitHub's multiline protocol with a fresh random delimiter. The
 * `fields` a caller passes are a FIXED allowlist built from constants — never
 * from server data — so untrusted answer text can never create a key.
 */
export function writeGitHubOutputs(path, fields) {
  if (typeof path !== 'string' || path.length === 0) {
    fail('--github-output must be a non-empty path', EXIT.USAGE);
  }

  const blocks = fields.map(([name, rawValue]) => {
    const value = String(rawValue ?? '');
    let delimiter;
    do {
      delimiter = `pingroom_${randomBytes(24).toString('hex')}`;
    } while (value.includes(delimiter));
    // Keep the collision check next to serialization: a delimiter must never
    // occur in an untrusted value, even though a 192-bit collision is remote.
    if (value.includes(delimiter)) {
      fail('could not create a safe GitHub output delimiter');
    }
    return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  });

  try {
    appendFileSync(path, blocks.join(''), { encoding: 'utf8' });
  } catch {
    fail('could not write GitHub outputs');
  }
}

/** The handoff half of the Action's output contract. */
export function writeGitHubHandoffOutputs(path, h) {
  const ackerId = h.acked_by && typeof h.acked_by === 'object'
    ? h.acked_by.id
    : h.acked_by;
  const fields = [
    ['handoff-id', h.id ?? ''],
    ['state', h.state ?? ''],
  ];
  if (h.delivery_state != null) fields.push(['delivery-state', h.delivery_state]);
  if (h.state === 'answered') {
    fields.push(['answer', h.answer && (h.answer.value ?? h.answer.text) || '']);
  }
  if (h.state === 'acked') fields.push(['acknowledged-by', ackerId ?? '']);

  writeGitHubOutputs(path, fields);
}

/**
 * The `ask` half. Deliberately narrower than the handoff mapper: a question has
 * no delivery_state and no acker, so the allowlist is exactly question-id,
 * state, and — only once answered — answer.
 */
export function writeGitHubQuestionOutputs(path, q) {
  const fields = [
    ['question-id', q.id ?? ''],
    ['state', q.state ?? ''],
  ];
  if (q.state === 'answered') {
    fields.push(['answer', q.answer && (q.answer.value ?? q.answer.text) || '']);
  }

  writeGitHubOutputs(path, fields);
}
