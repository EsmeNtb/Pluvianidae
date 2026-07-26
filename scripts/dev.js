/**
 * Root dev runner (tasks.md 15.2, design.md > "Scripts npm" > `dev`).
 *
 * Runs the Extension's `watch` (`tsc -watch -p ./`) and the desktop
 * mascot's `mascot:dev` (`desktop-mascot/scripts/dev.js`, itself `tsc
 * --watch` + `electron .`) in parallel, so both pieces can be developed
 * together with a single command. No new npm dependency (e.g.
 * `concurrently`) is added for this — cross-platform parallel execution via
 * shell operators (`&`/`&&`) behaves differently between PowerShell/cmd and
 * POSIX shells, so a small Node script using `child_process` is used
 * instead, matching the same approach as `desktop-mascot/scripts/dev.js`.
 *
 * Stopping this script (Ctrl+C / SIGINT/SIGTERM) terminates both child
 * processes, so neither `tsc --watch` nor the desktop mascot dev runner
 * (and, transitively, the Electron process it launches) is left running in
 * the background.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const repoRoot = __dirname && path.dirname(__dirname);

const npmBinary = 'npm';
const isWindows = process.platform === 'win32';

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

function runNpmScript(scriptName) {
  // On Windows, `npm` resolves to `npm.cmd`, a batch file — `spawn()`
  // cannot execute `.cmd` files directly without `shell: true` (it fails
  // synchronously with `EINVAL`). POSIX platforms don't need a shell here.
  const child = spawn(npmBinary, ['run', scriptName], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: isWindows,
  });
  children.push(child);
  child.on('exit', (code) => {
    // If either side exits (e.g. a `tsc --watch` process crashes), stop the
    // other one too rather than leaving a single half-alive dev session.
    killAll();
    process.exitCode = code === null ? 1 : code;
  });
  return child;
}

runNpmScript('watch');
runNpmScript('mascot:dev');
