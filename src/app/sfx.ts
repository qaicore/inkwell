// Generated sound effects for the impact: a whoosh as the strike starts, a
// slam at contact, a quiet crackle while the limbs are alive and a rumble
// after the slam. Everything is synthesized with Web Audio nodes at run time;
// there are no audio files. The timing is the scene's own data (the slam
// moment's frame, the limbs' emerge frame), fired on the frame clock.
import { frameAt } from '../motion/timing';
import { STRIKE_J } from '../impact/strike';
import { jEnd } from '../impact/clock';
import type { Effect, Moment } from '../types/effect';

export type BeatKind = 'whoosh' | 'slam' | 'rumble';
export interface Beat {
  frame: number;
  kind: BeatKind;
}
export interface Beats {
  list: Beat[]; // in frame order
  aliveFrom: number; // the crackle runs on [aliveFrom, aliveTo]
  aliveTo: number;
}

// The beats of an effect, or null without a slam (no impact drawn: silent).
export function beatsOf(effect: Effect, aftermathSeconds = 1.5): Beats | null {
  const moments = effect.moments ?? [];
  const slam = moments.find((m): m is Moment => m.kind === 'slam');
  if (!slam) return null;
  const I = frameAt(slam.at);
  const emerges = moments.filter((m) => m.kind === 'emerge').map((m) => frameAt(m.at));
  const start = Math.max(0, I + STRIKE_J.first);
  return {
    list: [
      { frame: start, kind: 'whoosh' },
      { frame: I, kind: 'slam' },
      { frame: I, kind: 'rumble' },
    ],
    aliveFrom: emerges.length ? Math.min(...emerges, start) : start,
    aliveTo: I + jEnd(aftermathSeconds),
  };
}

export interface Crossed {
  beats: Beat[];
  alive: number; // frames of the alive window passed over
}

// Detects beats by crossing, not equality: a beat fires when the clock goes
// from before its frame to at or after it, once per pass. A clock that
// steps back (the loop's wrap, a replay) starts a new pass.
export class BeatClock {
  private prev = -Infinity;
  reset(): void {
    this.prev = -Infinity;
  }
  // `from` is the frame play starts on: a beat on it fires, ones before it don't.
  start(from: number): void {
    this.prev = from - 1;
  }
  step(cur: number, b: Beats): Crossed {
    if (cur < this.prev) this.prev = -Infinity; // went back: a new pass
    const prev = this.prev;
    this.prev = cur;
    if (prev === -Infinity) return { beats: [], alive: 0 }; // first frame of a pass with no start(): nothing to cross
    const beats = b.list.filter((x) => x.frame > prev && x.frame <= cur);
    const lo = Math.max(prev + 1, b.aliveFrom);
    const hi = Math.min(cur, b.aliveTo);
    return { beats, alive: Math.max(0, hi - lo + 1) };
  }
}

// ---- The voices -------------------------------------------------------------

type Ctx = BaseAudioContext;

function noiseBuffer(ctx: Ctx, seconds: number, seed = 1): AudioBuffer {
  const n = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0; // deterministic, so the export matches
    d[i] = s / 2147483648 - 1;
  }
  return buf;
}

function noise(ctx: Ctx, buf: AudioBuffer, at: number, dur: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.start(at, 0, Math.min(dur, buf.duration));
  return src;
}

// Master: compressor, then a gain that keeps the peak near -6 dB.
export function master(ctx: Ctx): GainNode {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 12;
  comp.ratio.value = 6;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  const out = ctx.createGain();
  out.gain.value = 0.5; // -6 dB
  const input = ctx.createGain();
  input.connect(comp).connect(out).connect(ctx.destination);
  return input;
}

function env(ctx: Ctx, dest: AudioNode, at: number, peak: number, attack: number, dur: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(peak, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  g.connect(dest);
  return g;
}

export interface Bank {
  whoosh(at: number): void;
  slam(at: number): void;
  rumble(at: number): void;
  tick(at: number, r: number): void;
}

export function bank(ctx: Ctx, dest: AudioNode): Bank {
  const buf = noiseBuffer(ctx, 3);
  return {
    whoosh(at) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 1.2;
      f.frequency.setValueAtTime(300, at);
      f.frequency.exponentialRampToValueAtTime(3500, at + 0.28);
      noise(ctx, buf, at, 0.32).connect(f).connect(env(ctx, dest, at, 0.7, 0.2, 0.32));
    },
    slam(at) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, at);
      o.frequency.exponentialRampToValueAtTime(38, at + 0.22);
      o.connect(env(ctx, dest, at, 1, 0.004, 0.32));
      o.start(at);
      o.stop(at + 0.34);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 2500;
      noise(ctx, buf, at, 0.2).connect(f).connect(env(ctx, dest, at, 0.9, 0.002, 0.18));
    },
    rumble(at) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(220, at);
      f.frequency.exponentialRampToValueAtTime(60, at + 1.6);
      noise(ctx, buf, at + 0.02, 1.8).connect(f).connect(env(ctx, dest, at + 0.02, 0.6, 0.05, 1.7));
    },
    tick(at, r) {
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 3000 + r * 3000;
      const start = Math.min(buf.duration - 0.1, 0.2 + r * 2.5);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.start(at, start, 0.02);
      src.connect(f).connect(env(ctx, dest, at, 0.08 + 0.08 * r, 0.001, 0.015 + 0.012 * r));
    },
  };
}

// ---- Live playback ----------------------------------------------------------

interface WebkitWindow {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

export class Sfx {
  on = true;
  private ctx: AudioContext | null = null;
  private voices: Bank | null = null;
  private readonly clock = new BeatClock();
  private beats: Beats | null = null;
  readonly log: { frame: number; kind: string; state: string }[] = [];

  // Call inside the Play click handler: iOS only starts audio from a gesture.
  prime(): void {
    try {
      if (!this.ctx) {
        const w = window as unknown as WebkitWindow;
        const C = w.AudioContext ?? w.webkitAudioContext;
        if (!C) return;
        this.ctx = new C();
        this.voices = bank(this.ctx, master(this.ctx));
      }
      if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
      this.voices = null;
    }
  }

  // A play starts on `from` with these beats (null: no impact, silent).
  begin(beats: Beats | null, from: number): void {
    this.beats = beats;
    this.clock.start(from);
  }

  // Called for every frame shown during play, in order.
  frame(cur: number): void {
    if (!this.beats) return;
    const { beats, alive } = this.clock.step(cur, this.beats);
    if (!this.on || !this.ctx || !this.voices) return;
    const now = this.ctx.currentTime;
    for (const b of beats) {
      this.voices[b.kind](now);
      this.log.push({ frame: cur, kind: b.kind, state: this.ctx.state });
    }
    for (let i = 0; i < Math.min(alive, 3); i++) {
      if (Math.random() < 0.45) this.voices.tick(now + Math.random() * 0.03, Math.random());
    }
  }

  // Pause or end: sound stops. Voices are short, so closing the sink is enough.
  stop(): void {
    this.beats = null;
    this.clock.reset();
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => {});
    // Tails already scheduled would ring on resume: drop the context's voices.
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
      this.voices = null;
    }
  }
}

export const sfx = new Sfx();
if (import.meta.env.DEV) (window as unknown as { __sfx: Sfx }).__sfx = sfx; // dev only: the browser check reads the beat log

// ---- The export -------------------------------------------------------------

export interface SfxTrack {
  rate: number;
  data: Float32Array; // mono, from the clip's first frame
}

// The same effects rendered offline for the export. Null where the browser
// has no OfflineAudioContext or the render fails: the export then goes on
// without added sound.
export async function renderSfx(beats: Beats | null, seconds: number, rate = 44100): Promise<SfxTrack | null> {
  if (!beats) return null;
  try {
    const w = window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext };
    const O = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
    if (!O) return null;
    const ctx = new O(1, Math.ceil(seconds * rate), rate);
    const voices = bank(ctx, master(ctx));
    for (const b of beats.list) voices[b.kind](b.frame / 30);
    let s = 12345;
    const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let f = beats.aliveFrom; f <= beats.aliveTo && f / 30 < seconds; f++) {
      for (let i = 0; i < 2; i++) if (rand() < 0.45) voices.tick(f / 30 + rand() / 30, rand());
    }
    const done = await ctx.startRendering();
    return { rate, data: done.getChannelData(0).slice() };
  } catch (err) {
    console.warn("The sound effects couldn't be rendered for the export.", err);
    return null;
  }
}

// Adds the track into planar audio that starts `t` seconds in (the output's
// timeline). Returns how many samples were changed.
export function mixInto(planes: Float32Array[], rate: number, t: number, track: SfxTrack): number {
  const n = planes[0]?.length ?? 0;
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const j = Math.round((t + i / rate) * track.rate);
    if (j < 0 || j >= track.data.length) continue;
    const v = track.data[j] * 0.9;
    if (v === 0) continue;
    hit++;
    for (const p of planes) p[i] = Math.max(-1, Math.min(1, p[i] + v));
  }
  return hit;
}
