// Single-sourced from package.json, which npm always ships inside the tarball,
// so the version can never drift from the package it was published as. The
// GitHub Action pins the same version in action.yml and a test keeps the two
// equal. `hook --print-config` emits this version.

import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
