// The impact engine's one random source (impact design §11). Every draw is
// rng(seed, stream, ...ints): mulberry32, seeded by FNV-1a over its arguments,
// so the same arguments give the same numbers on every run and every device.
// Nothing here reads Math.random or a clock.

export type Rng = () => number; // uniform in [0, 1)

// The streams the design names. Keep to them, so two layers never share one.
export type Stream =
  | 'arc' | 'pulse' | 'pop' | 'beam' | 'splash' | 'burst'
  | 'if1' | 'if2' | 'if3' | 'if4' | 'if5' | 'if6' | 'if7'
  | 'fire' | 'cluster' | 'dust' | 'wisp' | 'chunk' | 'debris' | 'spark' | 'ember' | 'bolt' | 'flood'
  | 'shake' | 'hud';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const scratch = new DataView(new ArrayBuffer(8));

// FNV-1a, 32 bits, over the parts. Each part is tagged and sized, so ('ab', 'c')
// and ('a', 'bc') differ, and so do 1 and '1':
//   - an integer in the int32 range: its 4 bytes, little end first;
//   - any other number: its 8 float64 bytes, little end first;
//   - a string: its length, then its UTF-16 code units.
export function fnv1a32(...parts: readonly (number | string)[]): number {
  let h = FNV_OFFSET;
  const byte = (b: number) => {
    h = Math.imul(h ^ (b & 0xff), FNV_PRIME) >>> 0;
  };
  const word = (n: number) => {
    for (let i = 0; i < 4; i++) byte(n >>> (8 * i));
  };
  for (const part of parts) {
    if (typeof part === 'string') {
      byte(0x73);
      word(part.length);
      for (let i = 0; i < part.length; i++) {
        const c = part.charCodeAt(i);
        byte(c);
        byte(c >>> 8);
      }
    } else if (Number.isInteger(part) && part >= -0x80000000 && part <= 0x7fffffff) {
      byte(0x69);
      word(part | 0);
    } else {
      byte(0x66);
      scratch.setFloat64(0, part, true);
      for (let i = 0; i < 8; i++) byte(scratch.getUint8(i));
    }
  }
  return h;
}

// mulberry32: a 32-bit state, one add and a few multiplies per number.
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rng(seed: number, stream: string, ...ints: number[]): Rng {
  return mulberry32(fnv1a32(seed, stream, ...ints));
}

// ---- Helpers ------------------------------------------------------------------------

export function uniform(r: Rng, lo = 0, hi = 1): number {
  return lo + (hi - lo) * r();
}

// A whole number from lo to hi, both included.
export function int(r: Rng, lo: number, hi: number): number {
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) throw new Error(`int needs whole numbers lo ≤ hi (got ${lo}, ${hi})`);
  return lo + Math.floor(r() * (hi - lo + 1));
}

// Box–Muller: one normal draw from two uniforms.
export function normal(r: Rng, mean = 0, sd = 1): number {
  const u = 1 - r(); // (0, 1], so the log is finite
  const v = r();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function pick<T>(r: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick needs at least one item');
  return items[Math.floor(r() * items.length)];
}
