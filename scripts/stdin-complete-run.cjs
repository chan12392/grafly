'use strict';

// Devin's hook transport can keep stdin open after the payload, so waiting on
// 'end' alone stalls: this runner buffers stdin, launches the real hook as soon
// as the input parses as one complete JSON object (with a short fallback for
// hosts that do close), forwards its stdio, and enforces the caller's timeout.
// Usage: node stdin-complete-run.cjs <timeoutMs> <executable> [args...]

const { spawn } = require('node:child_process');

const timeoutMs = Number(process.argv[2]);
const executable = process.argv[3];
const args = process.argv.slice(4);
if (!executable || !Number.isFinite(timeoutMs) || timeoutMs < 1) process.exit(0);

const maxInputBytes = 8 * 1024 * 1024;
let input = Buffer.alloc(0);
let started = false;
const inputTimer = setTimeout(() => process.exit(0), 1200);

function runIfComplete() {
  if (started) return;
  try {
    const value = JSON.parse(input.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  } catch {
    return;
  }

  started = true;
  clearTimeout(inputTimer);
  process.stdin.pause();

  const child = spawn(executable, args, {
    windowsHide: true,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {});
  child.stdin.end(input);

  const childTimer = setTimeout(() => {
    child.kill();
    setTimeout(() => process.exit(0), 300);
  }, timeoutMs);
  child.on('error', () => {
    clearTimeout(childTimer);
    process.exit(0);
  });
  child.on('close', (code) => {
    clearTimeout(childTimer);
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code || 0)));
  });
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (input.length > maxInputBytes) process.exit(0);
  runIfComplete();
});
process.stdin.on('end', () => {
  runIfComplete();
  if (!started) process.exit(0);
});
process.stdin.resume();
