// Reads KEY=value files (.env, .dev.vars) into an object, inside the calling
// process. Nothing here prints or logs a value.
import { existsSync, readFileSync } from 'node:fs';

// Handles blank lines, # comments, an optional "export ", and values in
// matching single or double quotes. An unquoted value ends at " #".
export function parseEnv(text) {
  const out = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    out[m[1]] = value;
  }
  return out;
}

export function readEnvFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : null;
}
