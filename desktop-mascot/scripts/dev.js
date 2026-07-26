/**
 * Dev runner for `desktop-mascot/` (tasks.md 15.1, design.md > "Scripts npm" >
 * `mascot:dev`).
 *
 * Compiles `desktop-mascot/src/**\/*.ts` with `tsc` in watch mode and, once
 * the initial compilation succeeds, launches `electron .` pointed at the
 * compiled `main.js`. No new npm dependency (e.g. `concurrently`) is added
 * for this: a small script using Node's own `child_process` is enough to
 * coordinate the two processes and is easy to reason about.
 *
 * Behavior:
 *   - Spawns `tsc -p . --watch --preserveWatchOutput` and waits for its
 *     first "Watching for file changes" message (or the initial compile
 *     completing without errors) before spawning Electron, so `electron .`
 *     never starts against a stale/missing `dist/`.
 *   - Spawns `electron .` after that first successful compile.
 *   - If the user stops this script (Ctrl+C / SIGINT/SIGTERM), both child
 *     processes are terminated so neither `tsc --watch` nor Electron is
 *     left running in the background.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const packageDir = __dirname && path.dirname(__dirname);
const isWindows = process.platform === 'win32';

const tscBinary = path.join(packageDir, 'node_modules', '.bin', isWindows ? 'tsc.cmd' : 'tsc');
const electronBinary = path.join(packageDir, 'node_modules', '.bin', isWindows ? 'electron.cmd' : 'electron');

const children = [];

function killAll() {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
}

process.on('SIGINT', () => {
  killAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  killAll();
  process.exit(0);
});

const tsc = spawn(tscBinary, ['-p', '.', '--watch', '--preserveWatchOutput'], {
  cwd: packageDir,
  stdio: ['ignore', 'pipe', 'inherit'],
  // `.cmd` files (Windows) cannot be spawned directly without a shell —
  // spawn() fails synchronously with EINVAL otherwise.
  shell: isWindows,
});
children.push(tsc);

let electronStarted = false;

tsc.stdout.on('data', (chunk) => {
  const text = chunk.toString('utf-8');
  process.stdout.write(text);

  if (!electronStarted && /Watching for file changes|Found 0 errors\./i.test(text)) {
    electronStarted = true;
    const electron = spawn(electronBinary, ['.'], {
      cwd: packageDir,
      stdio: 'inherit',
      shell: isWindows,
    });
    children.push(electron);

    electron.on('exit', (code) => {
      killAll();
      process.exit(code === null ? 0 : code);
    });
  }
});

tsc.on('exit', (code) => {
  if (!electronStarted) {
    // tsc's very first (non-watch) compile failed outright before ever
    // reaching a "watching" state — nothing to keep running.
    process.exit(code === null ? 1 : code);
  }
});
