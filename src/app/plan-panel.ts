// The plan panel (SPEC §6 app/, §10 W3): one row per planned stroke, every
// plan field one tap from changed. A field that was tapped shows a dot, and
// tapping the dot hands it back to the plan. Wonder's one-line reason sits
// under each row; when the rule stood in, its note sits on top.
import type { Anchor, BrushId } from '../types/effect.ts';
import { BRUSH_IDS } from '../types/effect.ts';
import { OVERRIDE_FIELDS, type OverrideField } from './overrides.ts';

export interface PanelRow {
  id: number;
  color: string; // the stroke's number color in the frame Wonder saw
  reason: string;
  values: Record<OverrideField, unknown>;
  overridden: Set<OverrideField>;
}

export interface PanelEvents {
  set(id: number, field: OverrideField, value: unknown): void;
  reset(id: number, field: OverrideField): void;
}

const CONCEPTS = ['person', 'head', 'face', 'hand', 'back'];
const ANGLES: [number, string][] = [
  [0, 'chest'],
  [90, 'his right'],
  [180, 'back'],
  [270, 'his left'],
];
const BRUSH_NAMES: Record<BrushId, string> = {
  ink: 'Ink',
  textured: 'Textured',
  'fine-ink': 'Fine ink',
  'fine-textured': 'Fine textured',
  'neon-straight': 'Neon, flat',
  'neon-round': 'Neon, round',
  electric: 'Electric',
  blade: 'Blade',
  trail: 'Trail',
};

export function renderPlanPanel(panel: HTMLElement, rows: PanelRow[], note: string | null, source: string, on: PanelEvents, rootOf: (id: number) => { time: number; xy: [number, number] }) {
  panel.replaceChildren();
  const head = el('p', 'plan-head', source === 'wonder' ? 'Wonder read your drawing. Tap anything to change it.' : 'Nearest-mask plan.');
  panel.append(head);
  if (note) panel.append(el('p', 'plan-note', note));
  for (const row of rows) {
    const box = el('section', 'plan-row');
    const title = el('h3', '', `Stroke ${row.id}`);
    title.style.setProperty('--stroke', row.color);
    box.append(title);
    for (const field of OVERRIDE_FIELDS) box.append(control(row, field, on, rootOf));
    box.append(el('p', 'plan-reason', row.reason));
    panel.append(box);
  }
  panel.hidden = false;
}

function control(row: PanelRow, field: OverrideField, on: PanelEvents, rootOf: (id: number) => { time: number; xy: [number, number] }): HTMLElement {
  const label = el('label', 'plan-field');
  label.append(el('span', '', field === 'bodyAngle' ? 'side' : field));
  const value = row.values[field];
  const set = (v: unknown) => on.set(row.id, field, v);
  switch (field) {
    case 'kind':
    case 'layer': {
      const [a, b] = field === 'kind' ? ['strand', 'rigid'] : ['front', 'behind'];
      const button = el('button', '', String(value));
      button.type = 'button';
      button.addEventListener('click', () => set(value === a ? b : a));
      label.append(button);
      break;
    }
    case 'stiffness':
    case 'wobble': {
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '1';
      range.step = '0.05';
      range.value = String(value);
      range.addEventListener('change', () => set(Number(range.value)));
      label.append(range);
      break;
    }
    case 'bodyAngle':
      label.append(select(ANGLES.map(([deg, name]) => [String(deg), name]), String(value), (v) => set(Number(v))));
      break;
    case 'brush':
      label.append(select(BRUSH_IDS.map((id) => [id, BRUSH_NAMES[id]]), String(value ?? 'ink'), set));
      break;
    case 'anchor': {
      const a = value as Anchor;
      const current = a.type === 'concept' ? a.prompt : a.type;
      const options = [...new Set([...CONCEPTS, current])].map((c): [string, string] => [c, c === 'point' ? 'this point' : c]);
      if (!options.some(([v]) => v === 'point')) options.push(['point', 'this point']);
      label.append(select(options, current, (v) => set(v === 'point' ? { type: 'point', ...rootOf(row.id) } : v === 'ground' ? a : { type: 'concept', prompt: v })));
      break;
    }
  }
  if (row.overridden.has(field)) {
    const dot = el('button', 'plan-dot', '•');
    dot.type = 'button';
    dot.title = 'Changed by you. Tap to go back to the plan.';
    dot.addEventListener('click', () => on.reset(row.id, field));
    label.append(dot);
  }
  return label;
}

function select(options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = document.createElement('select');
  for (const [v, text] of options) s.append(new Option(text, v, false, v === value));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}
