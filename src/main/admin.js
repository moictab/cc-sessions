'use strict';
// Administrator sessions. The app itself never runs elevated: Windows only starts an elevated
// process after its own (UAC) prompt, and never as a child we could attach a terminal to. So the
// first administrator session of a run starts the helper (admin-host/admin-host.js) through that
// prompt; the helper connects back to us and runs every administrator session in its own ConPTY.
// Later ones, and restarts, reuse it without asking again. It lives as long as the app does.
//
// The helper is the copy an administrator installed in a folder only administrators can write
// (INSTALL_DIR, with its own node.exe): never the one in this repo, which the user can change.
// If it isn't there, administrator sessions don't start. We only tell it which session to open;
// what runs, with which options and environment, it decides itself (see admin-host.js).
//
// spawn() returns an object that behaves like a node-pty IPty (onData, onExit, write, resize,
// kill, pid), so SessionManager treats both kinds of session the same way. Until the helper
// answers it has no pid; onSpawn() says when it has one.
//
// The trade-off, written down in the README: CC Sessions isn't elevated and can type into these
// sessions, so a program running as you could, through it, act as administrator.

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const CONNECT_TIMEOUT_MS = 30000; // from the prompt being accepted to the helper calling back
const INSTALL_DIR = 'C:\\Program Files\\CC Sessions\\admin-host';
const HELPER_VERSION = 2; // the protocol the installed helper must speak
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
// Lets the user see the notice before the UAC prompt dims the screen.
const NOTICE_LEAD_MS = 1500;

/**
 * Everything Node reads from the environment as it starts. An elevated process doesn't inherit
 * ours: Windows builds its environment from the registry, HKCU\Environment included, which the
 * user can write. NODE_OPTIONS=--require … there would run code in the elevated node, a prepared
 * compile cache could slip code in, and others make it write files as administrator. cmd empties
 * them all before starting node. Taken from Node 24's documentation and from the names in its
 * binary; check again when node.exe is updated (install.ps1 does).
 */
const NODE_STARTUP_VARS = [
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'NODE_COMPILE_CACHE_PORTABLE', 'NODE_DISABLE_COMPILE_CACHE',
  'NODE_REDIRECT_WARNINGS', 'NODE_V8_COVERAGE', 'NODE_ICU_DATA', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA',
  'NODE_USE_ENV_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_PRESERVE_SYMLINKS', 'NODE_PRESERVE_SYMLINKS_MAIN',
  'NODE_REPL_EXTERNAL_MODULE', 'NODE_REPL_HISTORY', 'NODE_REPL_HISTORY_SIZE', 'NODE_REPL_MODE', 'NODE_DEBUG',
  'NODE_DEBUG_NATIVE', 'NODE_DEBUG_ENABLED', 'NODE_INSPECT_RESUME_ON_START', 'NODE_NO_WARNINGS',
  'NODE_PENDING_DEPRECATION', 'NODE_PENDING_PIPE_INSTANCES', 'NODE_SKIP_PLATFORM_CHECK', 'NODE_TEST_CONTEXT',
  'NODE_TEST_WORKER_ID', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID',
  'NODE_CLUSTER_SCHED_POLICY', 'NODE_DISABLE_COLORS', 'NODE_NO_READLINE', 'NODE_RUN_PACKAGE_JSON_PATH',
  'NODE_RUN_SCRIPT_NAME', 'NODE_SEA_BLOB', 'NODE_OPENSSL_CONF_NAME',
  'OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'UV_THREADPOOL_SIZE', 'UV_USE_IO_URING', 'FORCE_COLOR', 'NO_COLOR', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

/** cmd's command line: /d skips its AutoRun (also in HKCU), then the variables are emptied and node runs. */
function launchLine(dir, port, token) {
  const clear = NODE_STARTUP_VARS.map((v) => `set ${v}=`).join('&& ');
  return `/d /s /c "${clear}&& "${path.join(dir, 'node.exe')}" "${path.join(dir, 'admin-host.js')}" ${port} ${token}"`;
}

class AdminHost {
  /**
   * `hooks`: the hook server ({ port, token, guardToken }), which the helper's sessions report to.
   * `notice(text | null)`: shows (or takes down) a word for the user before the UAC prompt.
   * `noElevate`: tests only, runs the helper without the prompt (and so without administrator
   * rights); only then can `dir` point somewhere other than the installed copy.
   */
  constructor({ hooks, notice = () => {}, noElevate = false, dir = null } = {}) {
    this.hooks = hooks;
    this.notice = notice;
    this.noElevate = noElevate;
    this.dir = noElevate && dir ? dir : INSTALL_DIR;
    this.conn = null; // net.Socket to the helper, once it said hello
    this.info = null; // { pid, user, elevated }
    this.connecting = null;
    this.ptys = new Map(); // key -> RemotePty
    this.nextKey = 1;
  }

  /**
   * A session in the helper, started as soon as the helper is there. `req`: { terminalId,
   * sessionId, name, cwd } (which session: the helper decides how it runs); `opts`: { cols, rows }.
   */
  spawn(req, opts) {
    const rp = new RemotePty(this, `p${this.nextKey++}`, opts);
    this.ptys.set(rp.key, rp);
    this.ensure(req.name).then(() => {
      if (rp.exited) return;
      rp.sent = true;
      this.send({
        t: 'spawn', k: rp.key, terminalId: req.terminalId, sessionId: req.sessionId, name: req.name, cwd: req.cwd,
        cols: rp.cols, rows: rp.rows, hookPort: this.hooks.port, hookToken: this.hooks.token, guardToken: this.hooks.guardToken,
      });
    }, (err) => rp.finish({ exitCode: null, error: err.reason || { key: 'admin.failed', vars: { error: err.message } } }));
    return rp;
  }

  /** The helper's connection, starting it (and so the prompt) if there isn't one. */
  ensure(name) {
    if (this.conn) return Promise.resolve(this.conn);
    if (!this.connecting) this.connecting = this.launch(name).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** Whether the installed helper is there (its own node.exe and script). */
  installed() {
    return fs.existsSync(path.join(this.dir, 'node.exe')) && fs.existsSync(path.join(this.dir, 'admin-host.js'));
  }

  async launch(name) {
    // No falling back on the copy in the repo: without the installed one, no administrator sessions.
    if (!this.installed()) throw Object.assign(new Error('not installed'), { reason: { key: 'admin.notInstalled', vars: { dir: this.dir } } });
    const token = crypto.randomBytes(16).toString('hex');
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const hello = new Promise((resolve, reject) => {
        server.on('connection', (sock) => {
          sock.setEncoding('utf8');
          sock.setNoDelay(true);
          let buf = '';
          const onData = (chunk) => {
            buf += chunk;
            const i = buf.indexOf('\n');
            if (i < 0) { if (buf.length > 4096) sock.destroy(); return; }
            sock.off('data', onData);
            let msg = null;
            try { msg = JSON.parse(buf.slice(0, i)); } catch { /* not ours */ }
            // Only the process we started knows the token; anything else is turned away.
            if (!msg || msg.t !== 'hello' || msg.token !== token) { sock.destroy(); return; }
            if (msg.user && msg.user.toLowerCase() !== os.userInfo().username.toLowerCase()) {
              // The prompt was answered with another account's password: its sessions would use
              // that account's profile, not yours (another Claude login, other settings).
              sock.destroy();
              reject(Object.assign(new Error('other user'), { reason: { key: 'admin.otherUser', vars: { user: msg.user } } }));
              return;
            }
            if (!msg.elevated && !this.noElevate) {
              sock.destroy();
              reject(Object.assign(new Error('not elevated'), { reason: { key: 'admin.notElevated' } }));
              return;
            }
            if (msg.version !== HELPER_VERSION) {
              sock.destroy();
              reject(Object.assign(new Error('old helper'), { reason: { key: 'admin.oldHelper', vars: { dir: this.dir } } }));
              return;
            }
            resolve({ sock, rest: buf.slice(i + 1), info: { pid: msg.pid, user: msg.user, elevated: !!msg.elevated } });
          };
          sock.on('data', onData);
          sock.on('error', () => {});
        });
      });
      hello.catch(() => {}); // handled below; keeps an early rejection from being "unhandled"
      try {
        await this.elevate(server.address().port, token, name);
        const { sock, rest, info } = await Promise.race([
          hello,
          new Promise((_r, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { reason: { key: 'admin.noAnswer' } })), CONNECT_TIMEOUT_MS)),
        ]);
        this.attach(sock, rest, info);
        return sock;
      } finally {
        this.notice(null);
      }
    } finally {
      server.close();
    }
  }

  /**
   * Starts the helper through Start-Process -Verb RunAs, which shows the prompt and returns once
   * it's answered. The prompt will say "Windows Command Processor" (cmd empties Node's variables
   * first, see launchLine), as it would for anything asking for an elevated cmd: so the app says
   * beforehand that one is coming, and for which session. A prompt without that notice is a
   * warning sign.
   */
  async elevate(port, token, name) {
    if (!this.noElevate) {
      this.notice({ name: name || '' });
      await new Promise((r) => setTimeout(r, NOTICE_LEAD_MS));
    }
    const cmdLine = launchLine(this.dir, port, token);
    const q = (s) => s.replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      `  Start-Process -FilePath '${q(CMD)}' -ArgumentList '${q(cmdLine)}' -WindowStyle Hidden${this.noElevate ? '' : ' -Verb RunAs'}`,
      '  exit 0',
      '} catch {',
      '  $e = $_.Exception; $code = 0',
      '  while ($e) { if ($e.NativeErrorCode) { $code = $e.NativeErrorCode }; $e = $e.InnerException }',
      '  [Console]::Error.WriteLine($_.Exception.Message)',
      '  if ($code -eq 1223) { exit 3 } else { exit 1 }', // 1223: the prompt was declined
      '}',
    ].join('\n');
    return new Promise((resolve, reject) => {
      let stderr = '';
      const ps = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      ps.stderr.setEncoding('utf8');
      ps.stderr.on('data', (d) => { stderr += d; });
      ps.on('error', (err) => reject(Object.assign(err, { reason: { key: 'admin.failed', vars: { error: err.message } } })));
      ps.on('exit', (code) => {
        if (code === 0) resolve();
        else if (code === 3) reject(Object.assign(new Error('declined'), { reason: { key: 'admin.declined' } }));
        else reject(Object.assign(new Error(stderr.trim() || `exit ${code}`), { reason: { key: 'admin.failed', vars: { error: stderr.trim().split(/\r?\n/)[0] || `exit ${code}` } } }));
      });
    });
  }

  attach(sock, rest, info) {
    this.conn = sock;
    this.info = info;
    let buf = rest;
    const onLine = (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.t === 'log') { console.error('[admin-host]', m.message); return; }
      const rp = this.ptys.get(m.k);
      if (!rp) return;
      if (m.t === 'spawned') rp.started(m.pid, info);
      else if (m.t === 'data') rp.emitData(m.data);
      else if (m.t === 'exit') rp.finish({ exitCode: m.exitCode, error: m.error ? { key: 'admin.failed', vars: { error: m.error } } : null });
    };
    const drain = () => {
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine(line); }
    };
    sock.on('data', (chunk) => { buf += chunk; drain(); });
    sock.on('close', () => {
      if (this.conn !== sock) return;
      this.conn = null;
      this.info = null;
      for (const rp of [...this.ptys.values()]) rp.finish({ exitCode: null, error: { key: 'admin.hostClosed' } });
    });
    drain();
  }

  send(msg) {
    if (this.conn && !this.conn.destroyed) this.conn.write(JSON.stringify(msg) + '\n');
  }

  /** On quit: the helper closes whatever is left and exits. */
  close() {
    if (this.conn) this.conn.end();
  }
}

/** The IPty-shaped stand-in for a session running in the helper. */
class RemotePty {
  constructor(host, key, opts) {
    this.host = host;
    this.key = key;
    this.pid = undefined;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.sent = false; // the helper was asked to start it
    this.ready = false; // ...and did
    this.killWhenStarted = false;
    this.exited = false;
    this.queue = []; // input typed before the helper started the process
    this.listeners = { data: new Set(), exit: new Set(), spawn: new Set() };
  }

  on(kind, cb) {
    this.listeners[kind].add(cb);
    return { dispose: () => this.listeners[kind].delete(cb) };
  }

  onData(cb) { return this.on('data', cb); }
  onExit(cb) { return this.on('exit', cb); }
  /** cb({ pid, elevated }) once the process exists. */
  onSpawn(cb) { return this.on('spawn', cb); }

  started(pid, info) {
    if (this.exited) return;
    this.pid = pid;
    this.ready = true;
    if (this.killWhenStarted) { this.host.send({ t: 'kill', k: this.key }); return; }
    for (const cb of this.listeners.spawn) cb({ pid, elevated: !!(info && info.elevated) });
    for (const data of this.queue.splice(0)) this.host.send({ t: 'write', k: this.key, data });
  }

  emitData(data) {
    if (!this.exited) for (const cb of this.listeners.data) cb(data);
  }

  finish({ exitCode, error }) {
    if (this.exited) return;
    this.exited = true;
    this.host.ptys.delete(this.key);
    for (const cb of this.listeners.exit) cb({ exitCode, error });
  }

  write(data) {
    if (this.exited) return;
    if (this.ready) this.host.send({ t: 'write', k: this.key, data });
    else if (this.queue.length < 100) this.queue.push(data);
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.ready && !this.exited) this.host.send({ t: 'resize', k: this.key, cols, rows });
  }

  kill() {
    if (this.exited) return;
    if (this.ready) this.host.send({ t: 'kill', k: this.key });
    // Asked for but not started yet: killed as soon as it is, so nothing is left running elevated.
    else if (this.sent) this.killWhenStarted = true;
    // Not even asked for (the prompt is still up): it never will be.
    else this.finish({ exitCode: null, error: null });
  }
}

/**
 * What an administrator session is told when it starts (and on every resume, /clear and
 * compaction), through its SessionStart hook. Model-facing, so in English like mcp.js.
 * `elevated`: the helper really has administrator rights (it hasn't only in tests).
 * `dropped`: it was an administrator session and no longer is.
 */
function adminContext({ elevated = true, dropped = false } = {}) {
  if (dropped) {
    return '[CC Sessions] This session no longer runs as administrator: the user turned off "Run as administrator" for it in CC Sessions. ' +
      'Anything said earlier in this conversation about having administrator rights no longer applies.';
  }
  if (!elevated) {
    return '[CC Sessions] This session is set to run as administrator, but it is running WITHOUT administrator rights ' +
      '(CC Sessions started it in test mode, without the Windows prompt).';
  }
  return '[CC Sessions] This session runs elevated, as Windows administrator: the user turned on "Run as administrator" for it in ' +
    'CC Sessions and accepted the Windows (UAC) prompt. Commands you run have full administrator rights with no further prompts, ' +
    'and programs you start run elevated too, so be deliberate with system-wide changes (services, drivers, the registry, ' +
    'security settings, installing or removing software). Files you create may end up owned by the Administrators group. ' +
    "Windows doesn't let non-elevated sessions connect to your local message pipe, so their messages (SendMessage) reach you " +
    'only through Remote Control, while it is on for this session; your messages to them get through as usual. ' +
    "If you no longer need administrator rights, tell the user: they can turn it off from this session's menu in CC Sessions.";
}

module.exports = { AdminHost, adminContext, launchLine, NODE_STARTUP_VARS, INSTALL_DIR };
