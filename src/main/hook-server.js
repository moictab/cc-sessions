'use strict';
// Local HTTP endpoint that Claude Code hooks POST their JSON payload to.
// Each session gets a settings file whose hooks run:
//   curl.exe ... --data-binary "@-" http://127.0.0.1:<port>/hook/<terminalId>
// so we know exactly which terminal an event belongs to.
// The same server answers our MCP server at /mcp/<terminalId> (see mcp.js), and image-guard's
// notices at /guard/<terminalId> (see guardEnvFor below).
// Each terminal has a token of its own (tokenFor): a session that reads another's token from its
// settings file could speak for it, but its own token only lets it speak for itself, and the app
// tells who raised or reads a decision by the terminal (see decision-log.js).

const http = require('http');
const crypto = require('crypto');

const HOOK_EVENTS = {
  // event name -> matcher (null = event without matcher)
  SessionStart: null,
  UserPromptSubmit: null,
  PreToolUse: '*', // remembers which tool is about to run, to explain a permission prompt
  PostToolUse: '*',
  Notification: null,
  Stop: null,
};

function startHookServer(onEvent, { onMcp, onGuard } = {}) {
  // Kept in memory only: a terminal's token is derived from it, 32 hex characters (the format the
  // administrator helper checks).
  const secret = crypto.randomBytes(32);
  const tokenFor = (terminalId) => crypto.createHmac('sha256', secret).update(String(terminalId)).digest('hex').slice(0, 32);
  // image-guard's: one of its own per terminal too. It sits in the session's environment, where
  // anything it runs can read it, and all it lets through is that session's window notices.
  const guardTokenFor = (terminalId) => crypto.createHmac('sha256', secret).update(`guard|${terminalId}`).digest('hex').slice(0, 32);
  const same = (given, want) => typeof given === 'string' && given.length === 32 && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
  const tokenOk = (terminalId, given) => same(given, tokenFor(terminalId));

  const server = http.createServer((req, res) => {
    // Which connection it came on, so the app can tell whose process opened it (peer-check.js).
    const peer = { clientPort: req.socket.remotePort, serverPort: req.socket.localPort };
    const mcp = /^\/mcp\/([A-Za-z0-9-]+)$/.exec(req.url || '');
    if (mcp && onMcp && tokenOk(mcp[1], req.headers['x-cc-sessions-token'])) return serveMcp(req, res, mcp[1], onMcp, peer);
    const guard = /^\/guard\/([A-Za-z0-9-]+)$/.exec(req.url || '');
    if (guard && onGuard && req.method === 'POST' && same(req.headers['x-cc-sessions-token'], guardTokenFor(guard[1]))) {
      return serveGuard(req, res, guard[1], onGuard);
    }
    const match = /^\/hook\/([A-Za-z0-9-]+)$/.exec(req.url || '');
    if (req.method !== 'POST' || !match || !tokenOk(match[1], req.headers['x-cc-sessions-token'])) {
      res.writeHead(403);
      res.end();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', async () => {
      // The hook prints whatever we answer, and Claude reads a hook's output (as context, for
      // SessionStart and UserPromptSubmit). So: 204 with no body, unless the handler has
      // something for this session to know (it returns the hook's JSON output, or a promise of it).
      let payload = null;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignored below */ }
      let out = null;
      if (payload) {
        try { out = (await onEvent(match[1], payload, peer)) || null; } catch (err) { console.error('[hook] handler error', err); }
      }
      if (out) return sendJson(res, 200, out);
      res.writeHead(204);
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        tokenFor,
        guardTokenFor,
        close: () => server.close(),
        settingsFor: (terminalId) => buildSettings(port, tokenFor(terminalId), terminalId),
        guardEnvFor: onGuard ? (terminalId) => ({
          CC_SESSIONS_GUARD_URL: `http://127.0.0.1:${port}/guard/${terminalId}`,
          CC_SESSIONS_GUARD_TOKEN: guardTokenFor(terminalId),
        }) : null,
        mcpConfigFor: onMcp ? (terminalId) => buildMcpConfig(port, tokenFor(terminalId), terminalId) : null,
      });
    });
  });
}

/**
 * Streamable HTTP, the simple way: every request gets a plain JSON response, notifications
 * get 202, and there is no server-to-client stream (GET answers 405, as the spec allows).
 */
function serveMcp(req, res, terminalId, onMcp, peer) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1024 * 1024) req.destroy();
    else chunks.push(chunk);
  });
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const batch = Array.isArray(body);
    const out = [];
    for (const msg of batch ? body : [body]) {
      try {
        const r = await onMcp(terminalId, msg, peer);
        if (r) out.push(r);
      } catch (err) {
        console.error('[mcp] handler error', err);
      }
    }
    if (!out.length) { res.writeHead(202); res.end(); return; }
    sendJson(res, 200, batch ? out : out[0]);
  });
}

/**
 * image-guard tells us when its consent window opens and closes in a session, so the inbox can
 * show that the session is waiting for the user: {"event": "open" | "close", "until": ms}, where
 * `until` (optional) is when its hook gives the window up. It sends and doesn't wait, so: answer
 * right away, with nothing in the body.
 */
function serveGuard(req, res, terminalId, onGuard) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 4096) req.destroy();
    else chunks.push(chunk);
  });
  req.on('end', () => {
    res.writeHead(204);
    res.end();
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
    try { onGuard(terminalId, body); } catch (err) { console.error('[guard] handler error', err); }
  });
}

function sendJson(res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length });
  res.end(data);
}

function buildMcpConfig(port, token, terminalId) {
  return {
    mcpServers: {
      'cc-sessions': {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp/${terminalId}`,
        headers: { 'X-CC-Sessions-Token': token },
      },
    },
  };
}

function buildSettings(port, token, terminalId) {
  // Works the same under Git Bash, cmd and PowerShell: curl.exe ships with Windows 10+,
  // "@-" is quoted so PowerShell doesn't read it as splatting, and "|| exit 0" makes sure
  // a closed app never turns into a hook error inside Claude.
  const command =
    `curl.exe -s -m 2 -X POST -H "Content-Type: application/json" -H "X-CC-Sessions-Token: ${token}" ` +
    `--data-binary "@-" http://127.0.0.1:${port}/hook/${terminalId} || exit 0`;
  const hooks = {};
  for (const [event, matcher] of Object.entries(HOOK_EVENTS)) {
    const entry = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (matcher) entry.matcher = matcher;
    hooks[event] = [entry];
  }
  return { hooks };
}

module.exports = { startHookServer };
