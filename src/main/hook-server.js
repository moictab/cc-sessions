'use strict';
// Local HTTP endpoint that Claude Code hooks POST their JSON payload to.
// Each session gets a settings file whose hooks run:
//   curl.exe ... --data-binary "@-" http://127.0.0.1:<port>/hook/<terminalId>
// so we know exactly which terminal an event belongs to.
// The same server answers our MCP server at /mcp/<terminalId> (see mcp.js).

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

function startHookServer(onEvent, { onMcp } = {}) {
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    const mcp = /^\/mcp\/([A-Za-z0-9-]+)$/.exec(req.url || '');
    if (mcp && onMcp && req.headers['x-cc-sessions-token'] === token) return serveMcp(req, res, mcp[1], onMcp);
    const match = /^\/hook\/([A-Za-z0-9-]+)$/.exec(req.url || '');
    if (req.method !== 'POST' || !match || req.headers['x-cc-sessions-token'] !== token) {
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
    req.on('end', () => {
      // The hook prints whatever we answer, and Claude reads a hook's output (as context, for
      // SessionStart and UserPromptSubmit). So: 204 with no body, unless the handler has
      // something for this session to know (it returns the hook's JSON output).
      let payload = null;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignored below */ }
      let out = null;
      if (payload) {
        try { out = onEvent(match[1], payload) || null; } catch (err) { console.error('[hook] handler error', err); }
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
        token,
        close: () => server.close(),
        settingsFor: (terminalId) => buildSettings(port, token, terminalId),
        mcpConfigFor: onMcp ? (terminalId) => buildMcpConfig(port, token, terminalId) : null,
      });
    });
  });
}

/**
 * Streamable HTTP, the simple way: every request gets a plain JSON response, notifications
 * get 202, and there is no server-to-client stream (GET answers 405, as the spec allows).
 */
function serveMcp(req, res, terminalId, onMcp) {
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
        const r = await onMcp(terminalId, msg);
        if (r) out.push(r);
      } catch (err) {
        console.error('[mcp] handler error', err);
      }
    }
    if (!out.length) { res.writeHead(202); res.end(); return; }
    sendJson(res, 200, batch ? out : out[0]);
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
