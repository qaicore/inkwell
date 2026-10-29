// The command line the impact render and sheet scripts share, and the guard
// that keeps their output out of the repo: renders are large and go to the
// session's renders folder, never into the worktree.
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface RenderArgs {
  out?: string; // where the renders go: outside the repo
  clip?: string; // the clip, by path (it's gitignored)
  drawings?: string; // the drawings JSON
  ref?: string; // reference frames, read where they are
  frames?: [number, number]; // first and last output frame, both included
  flash?: 'safe' | 'full'; // 'safe' is Reduce flashing
  tier?: 'full' | 'phone';
  scale?: number; // output size × this
  tap?: number; // the turn tap: the frame his back faces the camera
  portrait: boolean;
  positional: string[]; // everything that isn't an option, in order
}

const VALUED = ['out', 'clip', 'drawings', 'ref', 'frames', 'flash', 'tier', 'scale', 'tap'];
const KNOWN = [...VALUED, 'portrait'].map((k) => `--${k}`).join(', ');

// `argv` is the script's own arguments (process.argv.slice(2)). Options take
// "--name value" or "--name=value"; the last one given wins. Anything wrong
// throws a message that says what was expected.
export function parseArgs(argv: readonly string[]): RenderArgs {
  const args: RenderArgs = { portrait: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args.positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (name === 'portrait') {
      if (eq >= 0) throw new Error('--portrait takes no value');
      args.portrait = true;
      continue;
    }
    if (!VALUED.includes(name)) throw new Error(`unknown option ${arg} (the options are ${KNOWN})`);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) throw new Error(`--${name} needs a value`);
    switch (name) {
      case 'frames': {
        const m = /^(\d+)-(\d+)$/.exec(value);
        if (!m || Number(m[1]) > Number(m[2])) throw new Error(`--frames takes first-last, like 70-130 (got ${value})`);
        args.frames = [Number(m[1]), Number(m[2])];
        break;
      }
      case 'flash':
        if (value !== 'safe' && value !== 'full') throw new Error(`--flash is safe or full (got ${value})`);
        args.flash = value;
        break;
      case 'tier':
        if (value !== 'full' && value !== 'phone') throw new Error(`--tier is full or phone (got ${value})`);
        args.tier = value;
        break;
      case 'scale': {
        const n = Number(value);
        if (!(Number.isFinite(n) && n > 0)) throw new Error(`--scale takes a number above 0, like 0.5 (got ${value})`);
        args.scale = n;
        break;
      }
      case 'tap':
        if (!/^\d+$/.test(value)) throw new Error(`--tap takes a frame number (got ${value})`);
        args.tap = Number(value);
        break;
      default:
        args[name as 'out' | 'clip' | 'drawings' | 'ref'] = value;
    }
  }
  return args;
}

// Throws when `path`, resolved, is the repo or inside it, following junctions
// and symlinks on the part of the path that exists; returns it resolved
// otherwise. Case-blind on Windows.
export function assertOutsideRepo(path: string, repoRoot: string): string {
  const target = resolve(path);
  if (within(realOf(target), realOf(resolve(repoRoot)))) {
    throw new Error(`${target} is inside the repo (${resolve(repoRoot)}). Renders go outside it, in the session's renders folder.`);
  }
  return target;
}

const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

function within(p: string, root: string): boolean {
  const rel = relative(fold(root), fold(p));
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

// The real path of the deepest part of p that exists, with the rest put back.
function realOf(p: string): string {
  const rest: string[] = [];
  let head = p;
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return p;
    rest.unshift(basename(head));
    head = up;
  }
  return join(realpathSync.native(head), ...rest);
}
