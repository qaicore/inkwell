// DEV ONLY: sets up the Python stand-in tracker the dev server uses when the
// browser can't give the page WebGL 2. Makes .venv (gitignored) and installs
// MediaPipe into it. Run with: npm run standin:setup
import { spawnSync } from 'node:child_process';

const windows = process.platform === 'win32';
const run = (command, args) => spawnSync(command, args, { stdio: 'inherit' }).status === 0;

const made = windows
  ? run('py', ['-3', '-m', 'venv', '.venv']) || run('python', ['-m', 'venv', '.venv'])
  : run('python3', ['-m', 'venv', '.venv']);
if (!made) {
  console.error("Couldn't make .venv. Install Python 3 first.");
  process.exit(1);
}
const python = windows ? '.venv\\Scripts\\python.exe' : '.venv/bin/python';
if (!run(python, ['-m', 'pip', 'install', '--quiet', 'mediapipe==1.1.1', 'numpy'])) process.exit(1);
console.log('The Python stand-in is ready. It also needs ffmpeg 5.1 or newer on your PATH.');
