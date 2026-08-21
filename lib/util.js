// Small primitives every other module leans on: exiting, sleeping, sanitizing
// untrusted text, and the local validations that turn a would-be 422 into a
// usage error.

import { EXIT } from './constants.js';

export function fail(message, code = EXIT.ERROR) {
  process.stderr.write(`pingroom: ${message}\n`);
  process.exit(code);
}

/**
 * True when it is safe to prompt / draw a QR. Both streams must be a TTY: a
 * piped stdin cannot answer a prompt and a piped stdout would capture the QR as
 * garbage.
 *
 * The override is deliberately double-locked (internal-looking name AND
 * NODE_ENV=test) and not documented in --help. A single well-known env var
 * shipping in the published binary is one stray `export` away from making a CI
 * job prompt into the void and poll for the full 15-minute pairing window
 * instead of failing in a second.
 */
export function isInteractive() {
  if (process.env.PINGROOM_INTERNAL_TEST_TTY === '1' && process.env.NODE_ENV === 'test') return true;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Drop C0/C1 control characters before echoing server-supplied text to the
// terminal. Without this an attacker-controlled API base can smuggle ANSI
// escapes into the output and repaint, erase or overwrite the lines around them.
export function stripControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

export function truncate(value, max) {
  const str = String(value ?? '');
  const characters = Array.from(str);
  return characters.length <= max ? str : `${characters.slice(0, max - 1).join('')}…`;
}

/**
 * Reject an over-long field here rather than letting it become a 422.
 *
 * Every bound mirrors a Laravel rule (StoreNotificationRequest,
 * StoreQuestionRequest, LiveStatusRules) and is documented in --help, so a value
 * past it was always going to be refused — locally it reads as the usage error
 * it is, with the limit and the actual length named.
 */
export function requireMaxLength(value, max, flag) {
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (length > max) {
      fail(`${flag} must be at most ${max} characters (got ${length})`, EXIT.USAGE);
    }
  }
}

/**
 * Validate --timeout and resolve the per-poll hold. Called by ask/handoff
 * BEFORE the create POST: the old in-wait check ran only after the question or
 * handoff already existed, so `--timeout -5` put a live question on someone's
 * phone and then exited 2, orphaning it until its TTL.
 */
export function resolveWaitHold(args, { def, cap }) {
  if (args.timeout === undefined) return Math.min(def, cap);
  const hold = Number(args.timeout);
  if (!Number.isFinite(hold) || hold < 0) fail('--timeout must be a non-negative integer', EXIT.USAGE);
  return Math.min(hold, cap);
}

export function numberOption(raw, flag, { min, max, integer = false } = {}) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`${flag} must be a number`, EXIT.USAGE);
  if (integer && !Number.isInteger(value)) fail(`${flag} must be an integer`, EXIT.USAGE);
  if (min !== undefined && value < min) fail(`${flag} must be at least ${min}`, EXIT.USAGE);
  if (max !== undefined && value > max) fail(`${flag} must be at most ${max}`, EXIT.USAGE);
  return value;
}

export function parseDataObject(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail('--data must be valid JSON', EXIT.USAGE);
  }
  if (typeof data !== 'object' || Array.isArray(data) || data === null) {
    fail('--data must be a JSON object', EXIT.USAGE);
  }
  return data;
}

export function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function isNullableString(value) {
  return value === null || typeof value === 'string';
}
