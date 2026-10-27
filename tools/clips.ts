// fixtures/clips.json (CLAUDE.md rule 7): one entry per clip, saying who is
// in it and their consent. The same rule R2 (tests/M0/R2.test.ts) applies to
// every clip in fixtures/; R2 keeps its own copy, since the M0 tests are
// frozen, so a change here must match it.

export interface ClipEntry {
  id: string;
  file: string;
  people: string[];
  consent: string;
}

// The entries that name a file, keyed by that file (as R2 indexes them).
export function parseClips(json: unknown): Map<string, ClipEntry> {
  const byFile = new Map<string, ClipEntry>();
  const list = (json as { clips?: unknown } | null)?.clips;
  if (!Array.isArray(list)) return byFile;
  list.forEach((entry, i) => {
    const rec = (entry ?? {}) as Record<string, unknown>;
    if (typeof rec.file !== 'string' || !rec.file.trim()) return;
    const file = rec.file.trim().replace(/\\/g, '/');
    byFile.set(file, {
      id: typeof rec.id === 'string' ? rec.id : `#${i}`,
      file,
      people: Array.isArray(rec.people) ? rec.people.filter((p): p is string => typeof p === 'string') : [],
      consent: typeof rec.consent === 'string' ? rec.consent.trim() : '',
    });
  });
  return byFile;
}

// '' when the entry says who is in the clip and has consent noted: "self"
// only when the only person is Qai, otherwise a written-consent date.
export function consentProblem(c: ClipEntry): string {
  if (c.people.length === 0) return `clip ${c.id}: clips.json doesn't say who is in it`;
  if (!c.consent) return `clip ${c.id}: no consent noted in clips.json`;
  const onlyQai = c.people.every((p) => p.trim().toLowerCase() === 'qai');
  const dated = /\d{4}-\d{2}-\d{2}/.test(c.consent);
  if (onlyQai) return c.consent.toLowerCase() === 'self' || dated ? '' : `clip ${c.id}: consent "${c.consent}" is neither "self" nor a date`;
  if (c.consent.toLowerCase() === 'self') return `clip ${c.id}: shows ${c.people.join(', ')} but consent says "self"`;
  return dated ? '' : `clip ${c.id}: consent "${c.consent}" has no written-consent date (YYYY-MM-DD)`;
}

// The entry to add for a clip of Qai alone, as one line to paste.
export function entryFor(id: string): string {
  return `{ "id": "${id}", "file": "fixtures/${id}/clip.mp4", "people": ["Qai"], "consent": "self" }`;
}
