import { describe, expect, it } from 'vitest';
import { decodeEnv, parseEnv } from '../../scripts/lib/env.ts';

describe('env files', () => {
  it('reads plain, exported and quoted values, with comments after them', () => {
    const { values, badLines } = parseEnv(
      [
        '# a comment',
        '',
        'PLAIN=abc # note',
        'export EXPORTED=def',
        'DOUBLE="value" # note',
        "SINGLE='value'#note",
        'HASH_INSIDE="a # b"',
        'QUOTE_INSIDE="a"b"',
        'EMPTY=',
      ].join('\r\n'),
    );
    expect(values).toEqual({ PLAIN: 'abc', EXPORTED: 'def', DOUBLE: 'value', SINGLE: 'value', HASH_INSIDE: 'a # b', QUOTE_INSIDE: 'a"b', EMPTY: '' });
    expect(badLines).toEqual([]);
  });

  it('lists the lines that are not KEY=value, by number only', () => {
    const { values, badLines } = parseEnv('OK=1\nUNCLOSED="abc\njust words\nTRAILING="abc" junk\n');
    expect(values).toEqual({ OK: '1' });
    expect(badLines).toEqual([2, 3, 4]);
  });

  it('decodes the UTF-16 file Windows PowerShell 5.1 writes with ">"', () => {
    const text = 'META_API_KEY=abc123456789\r\nDAILY_SPEND_CAP_USD=5\r\n';
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(parseEnv(decodeEnv(utf16))).toEqual({ values: { META_API_KEY: 'abc123456789', DAILY_SPEND_CAP_USD: '5' }, badLines: [] });
    expect(parseEnv(decodeEnv(Buffer.from(`﻿${text}`)))).toEqual(parseEnv(text)); // UTF-8 with a BOM
  });
});
