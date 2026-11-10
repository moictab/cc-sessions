'use strict';
// A small MCP server that CC Sessions offers to each of its sessions (Streamable HTTP, plain
// JSON responses, no streaming). Its tools let a session ask the app for things only the app
// can do, such as switching a plugin on just for itself, which needs a restart.
// Transport-agnostic: the HTTP side lives in hook-server.js.
// Everything here is read by the model, not by the user, so it is always in English,
// whatever the interface language.

const plugins = require('./plugins');
const i18n = require('../shared/i18n');
const { lostOnRestart } = require('./restart-note');

const LOST_ON_RESTART = lostOnRestart(i18n.create('en'));

const SERVER_NAME = 'cc-sessions';
const DEFAULT_PROTOCOL = '2025-06-18';

const INSTRUCTIONS =
  'CC Sessions is the desktop app hosting this Claude Code session. With set_plugin you can turn a plugin ' +
  '(for example Playwright, an isolated browser) on or off for this session only; applying it requires restarting ' +
  'the session when the turn ends, and the restart closes background tasks.';

function createMcpHandler({ manager, version }) {
  function describeSetPlugin(id) {
    const state = manager.pluginState(id);
    const now = state.plugins.map((p) => `${p.label} (${p.key}): ${p.on ? 'on' : 'off'}`).join('; ');
    return [
      "Turns a Claude Code plugin on or off for this session only (it does not touch the user's or the project's settings).",
      'To apply it, CC Sessions restarts the session when you end your turn and resumes this same conversation (--resume).',
      `The restart closes the process: background tasks are lost (${LOST_ON_RESTART}) and Remote Control reconnects.`,
      'Before calling it: if the user has not asked you to, ask them; finish or stop your background tasks, or write down in resume_note which ones to relaunch.',
      "After calling it: end your turn right away with a short message (the plugin's tools will not be available until the restart). When you are back, CC Sessions will write to you so you can continue.",
      `Current state in this session: ${now || 'no plugins available'}.`,
    ].join(' ');
  }

  function tools(id) {
    const keys = manager.pluginState(id).plugins.map((p) => p.key);
    if (!keys.length) return [];
    return [{
      name: 'set_plugin',
      title: 'Turn a plugin on or off in this session',
      description: describeSetPlugin(id),
      inputSchema: {
        type: 'object',
        properties: {
          plugin: { type: 'string', enum: keys, description: 'Plugin.' },
          enabled: { type: 'boolean', description: 'true to turn it on in this session, false to turn it off.' },
          resume_note: {
            type: 'string',
            description: 'What you were doing and what you will need to relaunch or do when you are back. CC Sessions will give it back to you after the restart.',
          },
        },
        required: ['plugin', 'enabled'],
        additionalProperties: false,
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }];
  }

  function callSetPlugin(id, args) {
    const p = plugins.byKey(args && args.plugin);
    if (!p || typeof args.enabled !== 'boolean') return toolError('Invalid parameters: plugin (one from the list) and enabled (true/false) are required.');
    const r = manager.setPlugins(id, { [p.key]: args.enabled }, { by: 'session', sessionNote: args.resume_note || '' });
    if (!r.ok) return toolError(r.error);
    const state = args.enabled ? 'on' : 'off';
    switch (r.result) {
      case 'scheduled':
        return toolText(`Done: ${p.label} will be ${state} as soon as you end this turn. CC Sessions will restart the session ` +
          'and write to you so you can continue. End the turn now with a short message for the user.');
      case 'cancelled':
        return toolText(`${p.label} was already ${state} in this session: the pending restart was cancelled.`);
      case 'unchanged':
        return toolText(`${p.label} is already ${state} in this session; no restart needed.`);
      default:
        return toolText(`${p.label} will be ${state} the next time the session starts.`);
    }
  }

  /** Handles one JSON-RPC message. Returns the response, or null for notifications. */
  return function handle(id, msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return rpcError(null, -32600, 'Invalid Request');
    const isRequest = msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
    if (!isRequest) return null; // notifications (initialized, cancelled...) and responses
    if (!manager.get(id)) return rpcError(msg.id, -32001, 'This session no longer exists in CC Sessions');
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = msg.params && msg.params.protocolVersion;
          return rpcResult(msg.id, {
            protocolVersion: typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : DEFAULT_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, title: 'CC Sessions', version: version || '0' },
            instructions: INSTRUCTIONS,
          });
        }
        case 'ping':
          return rpcResult(msg.id, {});
        case 'tools/list':
          return rpcResult(msg.id, { tools: tools(id) });
        case 'tools/call': {
          const name = msg.params && msg.params.name;
          if (name === 'set_plugin') return rpcResult(msg.id, callSetPlugin(id, msg.params.arguments || {}));
          return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        }
        default:
          return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      return rpcError(msg.id, -32603, String(err && err.message || err));
    }
  };
}

const toolText = (text) => ({ content: [{ type: 'text', text }], isError: false });
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

module.exports = { createMcpHandler, SERVER_NAME };
