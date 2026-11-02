// WP15: the SPEC patch for the impact (SPEC-impact.diff, which Qai commits with [qai-approved]). The diff lives
// outside the repo, so the SPEC checks run only when INKWELL_SPEC_DIFF names it. They apply it in memory to
// docs/SPEC.md (or, once it's committed, take it back off to get the base) and check what the patch promises:
// - the `type BrushId = ...` line B1 and B3 parse lists the ten ids of BRUSH_IDS, and B1 says "ten";
// - no §10 threshold moves except S2, S3, S5 and B1 (plus B2's appended limb clause and the 3D lift's T5),
//   and no milestone row moves except M3's build line and M5;
// - S6, T6 and I1–I9 are there, and §8.9 names c628565's three reversals;
// - the §8.7 rows the physics tests (specPhysics) and B2 (spec87) parse read exactly as before.
// The in-memory applier itself is tested on a synthetic diff, so this file always runs something. Once Qai has
// committed the diff (the BrushId line lists 'limb'), a last block checks the committed SPEC with no env var.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { BRUSH_IDS } from '../../src/types/effect.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DIFF = process.env.INKWELL_SPEC_DIFF;
const lf = (text: string) => text.replace(/\r\n/g, '\n');

// ---- A unified-diff applier: exact context, no fuzz ---------------------------------------------

interface Hunk {
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
}

function parseDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const counts: [number, number][] = [];
  let h: Hunk | undefined;
  for (const line of lf(diff).split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      h = { oldStart: Number(m[1]), oldLines: [], newStart: Number(m[3]), newLines: [] };
      hunks.push(h);
      counts.push([Number(m[2] ?? 1), Number(m[4] ?? 1)]);
      continue;
    }
    if (!h || line.startsWith('\\')) continue;
    const body = line.slice(1);
    if (line.startsWith(' ')) {
      h.oldLines.push(body);
      h.newLines.push(body);
    } else if (line.startsWith('-')) h.oldLines.push(body);
    else if (line.startsWith('+')) h.newLines.push(body);
  }
  hunks.forEach((x, i) => {
    const [o, n] = counts[i]!;
    if (x.oldLines.length !== o || x.newLines.length !== n) throw new Error(`hunk ${i + 1} has ${x.oldLines.length}/${x.newLines.length} lines, its header says ${o}/${n}`);
  });
  return hunks;
}

/** The text with every hunk applied (or taken back off), or undefined when any hunk's lines don't match exactly. */
function applyHunks(text: string, hunks: Hunk[], reverse = false): string | undefined {
  const lines = lf(text).split('\n');
  const out: string[] = [];
  let at = 0;
  for (const h of hunks) {
    const [from, to, start] = reverse ? [h.newLines, h.oldLines, h.newStart] : [h.oldLines, h.newLines, h.oldStart];
    const i = from.length === 0 ? start : start - 1;
    if (i < at || lines.slice(i, i + from.length).join('\n') !== from.join('\n')) return undefined;
    out.push(...lines.slice(at, i), ...to);
    at = i + from.length;
  }
  return [...out, ...lines.slice(at)].join('\n');
}

function patchPair(spec: string, diff: string): { base: string; patched: string; committed: boolean } {
  const hunks = parseDiff(diff);
  const forward = applyHunks(spec, hunks);
  if (forward !== undefined) return { base: lf(spec), patched: forward, committed: false };
  const back = applyHunks(spec, hunks, true);
  if (back !== undefined) return { base: back, patched: lf(spec), committed: true };
  throw new Error('the diff neither applies to docs/SPEC.md nor comes off it');
}

// ---- Reading the SPEC the way its tests do ------------------------------------------------------

function section(text: string, from: string, to: string): string {
  const s = text.indexOf(from);
  if (s < 0) throw new Error(`no "${from}"`);
  const e = text.indexOf(to, s + from.length);
  return text.slice(s, e < 0 ? undefined : e);
}

/** Table rows by their first cell. Later rows with the same first cell (the "ID" headers) replace earlier ones. */
function rows(sec: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of sec.split('\n')) {
    if (!line.startsWith('|') || /^\|\s*-/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    out.set(cells[0]!, cells);
  }
  return out;
}

const brushIds = (text: string) => [...(text.match(/type\s+BrushId\s*=\s*([^;]+);/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]!);
const b1Count = (text: string) => text.match(/^\|\s*B1\s*\|[^|\n]*each of the (\w+) brushes/im)?.[1];

/** tests/helpers/engine.ts specPhysics: §8.7 up to the next "## ", exact row names. */
function physicsCell(text: string, row: string): string | undefined {
  const start = text.indexOf('### 8.7');
  const end = text.indexOf('\n## ', start);
  const sec = text.slice(start, end < 0 ? undefined : end);
  return sec.match(new RegExp(`^\\|\\s*${row}\\s*\\|([^|\\n]+)\\|`, 'mi'))?.[1]!.trim();
}

/** tests/M2/B2 spec87: §8.7 up to the next "### ", by prefix or by exact row name. */
function brushCell(text: string, row: string, exact: boolean): string | undefined {
  const start = text.indexOf('### 8.7');
  const end = text.indexOf('\n### ', start + 5);
  const sec = text.slice(start, end < 0 ? undefined : end);
  const re = exact ? `^\\|\\s*${row}\\s*\\|([^|\\n]+)\\|` : `^\\|\\s*${row}[^|]*\\|([^|\\n]+)\\|`;
  return sec.match(new RegExp(re, 'mi'))?.[1]!.trim();
}

// ---- The applier, on a synthetic diff -----------------------------------------------------------

describe('the in-memory diff applier', () => {
  const base = ['# Title', '', 'one', 'two', 'three', '', '| B1 | each of the nine brushes |', 'end', ''].join('\n');
  const diff = [
    '--- a/docs/SPEC.md',
    '+++ b/docs/SPEC.md',
    '@@ -2,4 +2,5 @@',
    ' ',
    ' one',
    '-two',
    '+two, revised',
    '+two and a half',
    ' three',
    '@@ -7,2 +8,2 @@',
    '-| B1 | each of the nine brushes |',
    '+| B1 | each of the ten brushes |',
    ' end',
    '',
  ].join('\n');

  it('applies a diff with exact context, and takes it back off', () => {
    const { base: b, patched, committed } = patchPair(base, diff);
    expect(committed).toBe(false);
    expect(b).toBe(base);
    expect(patched).toBe(['# Title', '', 'one', 'two, revised', 'two and a half', 'three', '', '| B1 | each of the ten brushes |', 'end', ''].join('\n'));
    expect(b1Count(patched)).toBe('ten');
    const again = patchPair(patched, diff);
    expect(again.committed).toBe(true);
    expect(again.base).toBe(base);
    expect(again.patched).toBe(patched);
  });

  it('reads CRLF text as LF', () => {
    expect(patchPair(base.replace(/\n/g, '\r\n'), diff.replace(/\n/g, '\r\n')).patched).toBe(patchPair(base, diff).patched);
  });

  it('refuses context that does not match, and a hunk whose header lies', () => {
    expect(() => patchPair(base.replace('three', 'THREE'), diff)).toThrow(/neither applies/);
    expect(() => parseDiff(diff.replace('@@ -2,4 +2,5 @@', '@@ -2,4 +2,6 @@'))).toThrow(/header says/);
  });

  it('reads tables by their first cell', () => {
    const t = rows('| ID | Criterion |\n|---|---|\n| S2 | a | b |\n| S3 | c |\n');
    expect(t.get('S2')).toEqual(['S2', 'a', 'b']);
    expect(t.get('S3')).toEqual(['S3', 'c']);
    expect(t.has('---')).toBe(false);
  });
});

// ---- The SPEC patch -----------------------------------------------------------------------------

describe.skipIf(!DIFF || !existsSync(DIFF))('SPEC-impact.diff on docs/SPEC.md (INKWELL_SPEC_DIFF)', () => {
  let base = '';
  let patched = '';
  beforeAll(() => {
    ({ base, patched } = patchPair(readFileSync(resolve(REPO, 'docs/SPEC.md'), 'utf8'), readFileSync(DIFF!, 'utf8')));
  });
  const s10 = (text: string) => rows(section(text, '## 10. Acceptance criteria', '\n## 11.'));
  const milestones = (text: string) => rows(section(text, '### Milestones', '**M0 checklist:**'));

  it('lists ten brush ids where B1 and B3 read them, the ids of BRUSH_IDS', () => {
    expect(brushIds(base)).toHaveLength(9);
    expect(brushIds(patched)).toEqual([...BRUSH_IDS]);
    expect(brushIds(patched)).toHaveLength(10);
    expect(brushIds(patched).at(-1)).toBe('limb');
  });

  it('has B1 say ten, as its own count parser reads it', () => {
    expect(b1Count(base)).toBe('nine');
    expect(b1Count(patched)).toBe('ten');
  });

  it('moves no §10 threshold except S2, S3, S5 and B1, plus the B2 limb clause and the lift T5', () => {
    const before = s10(base);
    const after = s10(patched);
    const changed: string[] = [];
    for (const [id, cells] of before) {
      const now = after.get(id);
      expect(now, `${id} is still in §10`).toBeDefined();
      if (JSON.stringify(now) !== JSON.stringify(cells)) changed.push(id);
      if (id === 'B1') {
        expect(now![1]).toBe(cells[1]!.replace('each of the nine brushes', 'each of the ten brushes'));
        expect(now!.slice(2)).toEqual(cells.slice(2));
      }
      if (id === 'B2') cells.forEach((c, i) => expect(now![i]!.startsWith(c), `B2 cell ${i} keeps its old text as a prefix`).toBe(true));
      if (id === 'T5') expect(now![1]).toBe('The 3D lift (§8.5)');
    }
    expect(changed.sort()).toEqual(['B1', 'B2', 'S2', 'S3', 'S5', 'T5']);
  });

  it('keeps the criteria the brief leaves alone word for word (A5, A7, S1, S4, T1)', () => {
    const before = s10(base);
    const after = s10(patched);
    for (const id of ['A5', 'A7', 'S1', 'S4', 'T1']) expect(after.get(id), id).toEqual(before.get(id));
  });

  it('adds S6, T6 and I1–I9', () => {
    const after = s10(patched);
    for (const id of ['S6', 'T6', 'I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9']) expect(after.get(id)?.length, `${id} has a criterion and a threshold`).toBe(3);
    expect(after.get('I1')![2]).toMatch(/f84[^|]*\(942, 1061\)[^|]*\(−0\.058, 0\.998\)/);
    expect(after.get('I6')![2]).toMatch(/Full mode: it changes no pixel/);
    expect(after.get('I6')![2]).toMatch(/FlashCheckError/);
    expect(after.get('S6')![2]).toMatch(/within 3 frames of frame 22/);
  });

  it('moves no milestone row except M3 (build) and M5, where A5 gives way to I1–I9', () => {
    const before = milestones(base);
    const after = milestones(patched);
    for (const id of ['M0', 'M1', 'M2', 'M4', 'M6']) expect(after.get(id), id).toEqual(before.get(id));
    const m3b = before.get('M3')!;
    const m3a = after.get('M3')!;
    expect([m3a[0], m3a[1], m3a[3], m3a[4]]).toEqual([m3b[0], m3b[1], m3b[3], m3b[4]]);
    expect(after.get('M5')![3]).toMatch(/I1–I9/);
    expect(after.get('M5')![3]).not.toMatch(/\bA5\b/);
    expect(before.get('M5')![3]).toMatch(/\bA5\b/);
  });

  it('has §8.9 name c628565 and its three reversals, for Qai to approve by committing them', () => {
    const s89 = section(patched, '### 8.9', '\n## 9.');
    expect(s89).toMatch(/c628565/);
    expect(s89).toMatch(/Qai approves them by committing this section with `\[qai-approved\]`/);
    expect(s89).not.toMatch(/Qai approved these/);
    expect(s89).toMatch(/The shockwave ring is dropped/);
    expect(s89).toMatch(/Only `ease\.cracks` is read/);
    expect(s89).toMatch(/No impact tap\.\*\* The contact frame comes from the cached person mask/);
    expect(s89).toMatch(/Wonder and new SAM calls for moments stay parked/);
    expect(section(base, '### 8.9', '\n## 9.')).toMatch(/Qai sets the fist slam by tapping the frame at the impact/);
    expect(patched).not.toMatch(/Qai sets the fist slam by tapping/);
  });

  it('writes the hero facts and the decisions into §8.9, §8.5 and §7', () => {
    const s89 = section(patched, '### 8.9', '\n## 9.');
    expect(s89).toMatch(/P = \(942, 1061\), and d = \(−0\.060, 0\.998\)/);
    expect(s89).toMatch(/limbs on f22, cracks on f84/);
    expect(s89).toMatch(/the limbs land first/);
    expect(s89).toMatch(/Full impact frames are the default/);
    const s85 = section(patched, '### 8.5', '\n### 8.6');
    expect(s85).toMatch(/Nothing is required of him: no tap and no keys/);
    expect(s85).toMatch(/\(f_b \+ n·Δ, \(180° \+ 90°·n\)·s\) for n = −2\.\.2, with Δ = 6 frames/);
    expect(s85).toMatch(/θ = 0 on every frame/);
    expect(s85).toMatch(/within 45° of the hand-measured keys/);
    expect(s85).not.toMatch(/β = acos/);
    const s7 = section(patched, '## 7.', '\n## 8.');
    expect(s7).toMatch(/frames\?: \{ count: 0 \| 7; flash: 'safe' \| 'full' \};\s+\/\/ the impact frames; missing = \{ 7, 'full' \}/);
    expect(s7).toMatch(/turn\?: Turn;/);
    expect(s7).toMatch(/interface EmergeMoment/);
  });

  it('writes the rest of the decisions: two drawings, the turn, flashing, colours, camera, limbs, device gate', () => {
    expect(section(patched, '## 1.', '\n## 2.')).toMatch(/Nothing else is required: no taps, no keys, no extra drawings/);
    const s85 = section(patched, '### 8.5', '\n### 8.6');
    expect(s85).toMatch(/In T1, "Qai's turn keys" means whichever of the keys above drive θ, the pose track's included/);
    const s87 = section(patched, '### 8.7', '\n### 8.8');
    expect(s87).toMatch(/\| limb: radius, taper, root flare \| R0 = 0\.020 S × size\/28;/);
    expect(s87).toMatch(/\| limb: cel bands \| body N·L ≥ −0\.08, lit N·L ≥ 0\.5, core N·H ≥ 0\.9/);
    expect(s87).toMatch(/\| limb: lights \| key norm\(−0\.6, −0\.75, 0\.3\), from the upper left; from j −8 it turns toward P/);
    expect(s87).toMatch(/a glow burst over the root hides the socket/);
    const s88 = section(patched, '### 8.8', '\n### 8.9');
    expect(s88).toMatch(/A glow burst at the root covers the socket/);
    expect(s88).toMatch(/After the pop a low crackle keeps flickering along them/);
    expect(patched).toMatch(/Roll leans and pitch bends the 3D lift's body \(§8\.5\)/);
    const s89 = section(patched, '### 8.9', '\n## 9.');
    expect(s89).toMatch(/\| pinned \| −7\.\.8 \(f77–92\) \|/);
    expect(s89).toMatch(/\| release \| 9 \(f93\) \|/);
    expect(s89).toMatch(/\*\*Reduce flashing\*\* is one toggle/);
    expect(s89).toMatch(/\*\*The flash check runs on every export\.\*\*/);
    expect(s89).toMatch(/\*\*Full \(the default\)\.\*\* The check changes nothing/);
    expect(s89).toMatch(/^ {2}7\. No flash elements at all\./m);
    expect(s89).toMatch(/the export throws `FlashCheckError`/);
    expect(s89).toMatch(/\*\*Wisps\.\*\* Jagged white tongues hug the fire/);
    expect(s89).toMatch(/Reduce flashing keeps the first and the last, ramped over 2 frames and at most 25% of the frame/);
    expect(s89).toMatch(/The limb bodies and the strike are p0/);
    expect(s89).toMatch(/uses a cool discharge set/);
    expect(s89).toMatch(/Fire, smoke and dust keep the measured physical colors/);
    expect(s89).toMatch(/An 8% punch-in on j 0\.\.9 about mix\(frame center, P, 0\.5\)/);
    expect(s89).toMatch(/0\.4 × the reference's envelope along the strike axis: the first jolt goes toward the striker/);
    expect(s89).toMatch(/Until he runs it, the tiers are timed in Node and the gate is pending/);
  });

  it('says in §8.8 that the limb is the one brush that is not a perfect-freehand outline', () => {
    const s88 = section(patched, '### 8.8', '\n### 8.9');
    expect(s88).toMatch(/Nine of the ten brushes are perfect-freehand outlines/);
    expect(s88).toMatch(/The limb is the one brush that isn't a perfect-freehand outline/);
    expect(rows(s88).get('`limb`')?.length).toBe(3);
  });

  it('takes impact frames out of "Not in v1" and the shockwave ring out of the cut order', () => {
    const s15 = section(patched, '## 15. Not in v1', '\n## 16.');
    expect(s15).not.toMatch(/\*\*Effects:\*\* impact frames/);
    expect(section(base, '## 15. Not in v1', '\n## 16.')).toMatch(/\*\*Effects:\*\* impact frames/);
    const cut = section(patched, '### Cut order', '\n## 4.');
    expect(cut).not.toMatch(/shockwave ring/);
    expect(cut).toMatch(/the impact frames, the limbs and the cracks are never cut/);
  });

  it('adds the §14 risks: flashing, P at the frame edge, the fist in the person mask', () => {
    const risks = [...rows(section(patched, '## 14.', '\n## 15.')).keys()];
    for (const r of [/flash too much/, /P sits at the frame edge/, /fist isn't in the person mask/]) expect(risks.some((k) => r.test(k)), String(r)).toBe(true);
  });

  it('leaves the §8.7 rows the physics tests and B2 parse exactly as they were', () => {
    for (const row of ['dt', 'constraint passes', 'damping', 'gravity', 'bend limit', 'shape pull']) {
      expect(physicsCell(base, row), row).toBeDefined();
      expect(physicsCell(patched, row), row).toBe(physicsCell(base, row));
    }
    expect(physicsCell(patched, 'shape pull')).toMatch(/k\s*=\s*(\d+(?:\.\d+)?)\s*·\s*stiffness²/);
    for (const [row, exact] of [['fine-tip size', false], ['grain', false], ['neon glow', false], ['electric', true], ['blade', true], ['trail', true]] as const) {
      expect(brushCell(base, row, exact), row).toBeDefined();
      expect(brushCell(patched, row, exact), row).toBe(brushCell(base, row, exact));
    }
  });
});

// ---- Once Qai has committed it ------------------------------------------------------------------

const SPEC_PATH = resolve(REPO, 'docs/SPEC.md');
const SPEC_NOW = existsSync(SPEC_PATH) ? lf(readFileSync(SPEC_PATH, 'utf8')) : '';

describe.skipIf(!brushIds(SPEC_NOW).includes('limb'))('docs/SPEC.md with the impact committed', () => {
  it('keeps the ten ids of BRUSH_IDS, B1 at ten, S6, T6 and I1–I9, and the c628565 reversals', () => {
    expect(brushIds(SPEC_NOW)).toEqual([...BRUSH_IDS]);
    expect(b1Count(SPEC_NOW)).toBe('ten');
    const s10 = rows(section(SPEC_NOW, '## 10. Acceptance criteria', '\n## 11.'));
    for (const id of ['S6', 'T6', 'I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9']) expect(s10.get(id)?.length, id).toBe(3);
    const s89 = section(SPEC_NOW, '### 8.9', '\n## 9.');
    for (const r of [/c628565/, /The shockwave ring is dropped/, /Only `ease\.cracks` is read/, /No impact tap\./]) expect(s89).toMatch(r);
  });
});
