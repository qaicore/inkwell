// Reads KEY=value files (.env, .dev.vars) inside the calling process. Nothing
// here prints or logs a value, or a line that could hold one.
import { existsSync, readFileSync } from 'node:fs';

export interface EnvFile {
  values: Record<string, string>;
  badLines: number[]; // 1-based: not blank, not a # comment, and not KEY=value
}

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
// A value in matching quotes, then optionally a # comment. The lazy match
// stops at the first closing quote that only a comment can follow.
const QUOTED = /^(['"])(.*?)\1\s*(?:#.*)?$/;

// Handles blank lines, # comments, an optional "export ", and values in
// matching single or double quotes, which a comment may follow. An unquoted
// value ends at " #". A line that doesn't parse (an unclosed quote, a stray
// word, a UTF-16 file read as UTF-8) goes in badLines.
export function parseEnv(text: string): EnvFile {
  const values: Record<string, string> = {};
  const badLines: number[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(LINE);
    const quoted = m && /^['"]/.test(m[2]) ? m[2].match(QUOTED) : undefined;
    if (!m || quoted === null) {
      badLines.push(i + 1);
      continue;
    }
    values[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '').trim();
  }
  return { values, badLines };
}

// UTF-16LE when the file starts with the FF FE byte-order mark (what Windows
// PowerShell 5.1's ">" writes), UTF-8 otherwise.
export function decodeEnv(buf: Buffer): string {
  return buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
}

export function readEnvFile(path: string): EnvFile | null {
  return existsSync(path) ? parseEnv(decodeEnv(readFileSync(path))) : null;
}
