// Where a blocked agent left off, kept on THIS machine only.
//
// When a hook turns a tool-permission prompt into a PingRoom question, the
// thing that will eventually need to resume — the Claude Code session, its
// working directory, its transcript — is local. The server never needs to know
// any of it: the question already carries `correlation_id = session_id`, which
// is enough to match an answer back to a row here.
//
// That is deliberate, not incidental. A question's `data` object is echoed into
// every room member's push payload AND into the room's outgoing webhook, so a
// `cwd` put there would publish a local filesystem path to everyone in the room
// and to whatever URL the room forwards to. Keeping the record local leaks
// nothing and needs no wire contract.
//
// Nothing consumes this yet. It exists so that resuming an ended session is a
// matter of writing the consumer, not of changing the protocol — and until that
// consumer exists, PingRoom only claims to block an agent that is still running.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pingroomHome, readJsonFile } from './config.js';

/** Enough for any plausible backlog of open questions on one machine. */
const MAX_ENTRIES = 100;
/** A question cannot outlive its TTL by this much; anything older is dead. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function continuationsPath() { return join(pingroomHome(), 'continuations.json'); }

/**
 * Atomic write that REPORTS failure instead of exiting.
 *
 * config.js's writeJsonFile calls fail() — correct when a human ran `config
 * set` and needs to know it didn't take, fatal here: this is called from the
 * hook, which must never break the agent it is advising. A full disk loses a
 * resume hint; it must not kill the session.
 */
function writeQuietly(path, value) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    const created = mkdirSync(pingroomHome(), { recursive: true, mode: 0o700 });
    if (created !== undefined) chmodSync(pingroomHome(), 0o700);
    fd = openSync(tmp, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    return true;
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
    try { unlinkSync(tmp); } catch { /* never created */ }
    return false;
  }
}

function load() {
  const stored = readJsonFile(continuationsPath());
  const entries = stored && typeof stored.entries === 'object' && !Array.isArray(stored.entries)
    ? stored.entries
    : {};
  return entries;
}

/** Drop expired rows, then the oldest ones, so the file cannot grow forever. */
function bound(entries, now) {
  const live = Object.entries(entries).filter(([, e]) => {
    const at = Date.parse(e && e.recorded_at);
    return Number.isFinite(at) && now - at < MAX_AGE_MS;
  });
  live.sort((a, b) => Date.parse(a[1].recorded_at) - Date.parse(b[1].recorded_at));
  return Object.fromEntries(live.slice(-MAX_ENTRIES));
}

/**
 * Remember where to come back to for one question. Best-effort by design: the
 * caller is a hook that has already decided the agent proceeds either way.
 */
export function recordContinuation(questionId, { sessionId, cwd, transcriptPath } = {}) {
  if (!questionId || typeof questionId !== 'string') return false;
  const now = Date.now();
  const entries = bound(load(), now);
  entries[questionId] = {
    recorded_at: new Date(now).toISOString(),
    ...(sessionId ? { session_id: String(sessionId) } : {}),
    ...(cwd ? { cwd: String(cwd) } : {}),
    ...(transcriptPath ? { transcript_path: String(transcriptPath) } : {}),
  };
  return writeQuietly(continuationsPath(), { version: 1, entries: bound(entries, now) });
}

/** The record for one question, or null. */
export function readContinuation(questionId) {
  return load()[questionId] ?? null;
}

/** Forget one question once it has resolved — the hint has done its job. */
export function forgetContinuation(questionId) {
  const entries = load();
  if (!(questionId in entries)) return false;
  delete entries[questionId];
  return writeQuietly(continuationsPath(), { version: 1, entries: bound(entries, Date.now()) });
}
