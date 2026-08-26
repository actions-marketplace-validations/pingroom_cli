const MAX_JSON_BYTES = 1024 * 1024;

export function parseJsonStrict(raw, label = 'JSON') {
  if (typeof raw !== 'string') throw new Error(`${label} must be UTF-8 JSON`);
  rejectDuplicateKeys(raw, label);
  return JSON.parse(raw);
}

export async function readStrictJsonResponse(response, label = 'response') {
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} exceeded ${MAX_JSON_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  const bytes = Buffer.concat(chunks);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(`${label} was not valid UTF-8`); }
  return { text, json: text ? parseJsonStrict(text, label) : null };
}

function rejectDuplicateKeys(raw, label) {
  let index = 0;
  const invalid = () => { throw new Error(`${label} is not valid JSON`); };
  const whitespace = () => { while (/\s/u.test(raw[index] ?? '')) index += 1; };
  const string = () => {
    if (raw[index] !== '"') invalid();
    const start = index++;
    while (index < raw.length) {
      if (raw[index] === '\\') { index += 2; continue; }
      if (raw[index] === '"') {
        index += 1;
        try { return JSON.parse(raw.slice(start, index)); } catch { invalid(); }
      }
      index += 1;
    }
    invalid();
  };
  const value = () => {
    whitespace();
    if (raw[index] === '{') return object();
    if (raw[index] === '[') return array();
    if (raw[index] === '"') { string(); return; }
    const start = index;
    while (index < raw.length && !/[\s,\]}]/u.test(raw[index])) index += 1;
    if (index === start) invalid();
  };
  const object = () => {
    index += 1;
    whitespace();
    const keys = new Set();
    if (raw[index] === '}') { index += 1; return; }
    for (;;) {
      whitespace();
      const key = string();
      if (keys.has(key)) throw new Error(`${label} contains a duplicate object key`);
      keys.add(key);
      whitespace();
      if (raw[index] !== ':') invalid();
      index += 1;
      value();
      whitespace();
      if (raw[index] === '}') { index += 1; return; }
      if (raw[index] !== ',') invalid();
      index += 1;
    }
  };
  const array = () => {
    index += 1;
    whitespace();
    if (raw[index] === ']') { index += 1; return; }
    for (;;) {
      value();
      whitespace();
      if (raw[index] === ']') { index += 1; return; }
      if (raw[index] !== ',') invalid();
      index += 1;
    }
  };
  whitespace();
  value();
  whitespace();
  if (index !== raw.length) invalid();
}
