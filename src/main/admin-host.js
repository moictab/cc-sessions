'use strict';
// The administrator helper. admin.js starts it through a Windows (UAC) prompt, as plain Node:
// Electron's own binary with ELECTRON_RUN_AS_NODE, no window. It is the only part of CC Sessions
// that runs elevated.
//
// It connects back to the app on 127.0.0.1 (port and one-time token on its command line), says
// who it is, and from then on runs the app's administrator sessions in its own ConPTYs, relaying
// their output, input and size over that connection as one JSON message per line.
//
// When the connection goes away (the app quit or crashed) it closes every session and exits:
// nothing keeps running elevated on its own.

const net = require('net');
const os = require('os');
const { execFileSync } = require('child_process');
const pty = require('node-pty');

const [port, token] = process.argv.slice(2);
if (!/^\d+$/.test(port || '') || !/^[0-9a-f]{32,}$/.test(token || '')) process.exit(2);

/** High integrity level (S-1-16-12288) or above: really elevated, not just an admin account. */
function isElevated() {
  try {
    const groups = execFileSync('whoami.exe', ['/groups'], { encoding: 'utf8', windowsHide: true });
    return /S-1-16-(12288|16384)\b/.test(groups);
  } catch { return false; }
}

const ptys = new Map(); // key (from the app) -> IPty
const sock = net.connect(Number(port), '127.0.0.1');
sock.setNoDelay(true);
sock.setEncoding('utf8');

function send(msg) {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n');
}

sock.on('connect', () => {
  send({ t: 'hello', token, pid: process.pid, user: os.userInfo().username, elevated: isElevated() });
});

let buf = '';
sock.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    try { handle(msg); } catch (err) { send({ t: 'log', message: String(err && err.stack || err) }); }
  }
});
sock.on('error', () => { /* 'close' follows */ });
sock.on('close', shutdown);

function handle(m) {
  const p = ptys.get(m.k);
  switch (m.t) {
    case 'spawn': {
      let proc;
      try {
        proc = pty.spawn(m.file, m.args, { name: 'xterm-256color', cols: m.cols, rows: m.rows, cwd: m.cwd, env: m.env, useConpty: true });
      } catch (err) {
        send({ t: 'exit', k: m.k, exitCode: null, error: err.message });
        return;
      }
      ptys.set(m.k, proc);
      send({ t: 'spawned', k: m.k, pid: proc.pid });
      proc.onData((data) => send({ t: 'data', k: m.k, data }));
      proc.onExit(({ exitCode }) => {
        if (ptys.get(m.k) === proc) ptys.delete(m.k);
        send({ t: 'exit', k: m.k, exitCode });
      });
      break;
    }
    case 'write':
      if (p && typeof m.data === 'string') p.write(m.data);
      break;
    case 'resize':
      if (p) { try { p.resize(m.cols, m.rows); } catch { /* exiting */ } }
      break;
    case 'kill':
      if (p) { try { p.kill(); } catch { /* already gone */ } }
      break;
    default:
      break;
  }
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const p of ptys.values()) { try { p.kill(); } catch { /* already gone */ } }
  // ConPTY closes asynchronously; give it a moment, then go.
  const done = () => process.exit(0);
  if (!ptys.size) return done();
  let left = ptys.size;
  for (const p of ptys.values()) p.onExit(() => { if (--left === 0) done(); });
  setTimeout(done, 3000).unref();
}
