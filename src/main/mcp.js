'use strict';
// A small MCP server that CC Sessions offers to each of its sessions (Streamable HTTP, plain
// JSON responses, no streaming). Its tools let a session ask the app for things only the app
// can do: putting a decision in the user's inbox (ask_user, resolve_decision), or switching a
// plugin on just for itself, which needs a restart (set_plugin).
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
  'CC Sessions is the desktop app hosting this Claude Code session. With ask_user you put a decision in the ' +
  "user's inbox, as a card with one button per option; it returns at once, and the answer comes later as a prompt " +
  'such as "D4: Yes". resolve_decision takes one of yours off the inbox when it is no longer needed. With set_plugin ' +
  'you can turn a plugin (for example Playwright, an isolated browser) on or off for this session only; applying it ' +
  'requires restarting the session when the turn ends, and the restart closes background tasks.';

const LIMITS = { question: 300, summary: 800, option: 60, fallback: 400, context: 5000 };

const ASK_USER = {
  name: 'ask_user',
  title: "Put a decision in the user's inbox",
  description: [
    "Puts a decision in the user's inbox in CC Sessions: a card with your question, a summary, one button per option",
    'and the context. It returns at once with its label (D1, D2…); it does not wait for the answer.',
    'The user juggles many sessions and may not have followed this one, so write it to make sense on its own, in the',
    'language you use with them. At most three new decisions per turn: if there are more, raise the most important first.',
    "Meanwhile, carry on with whatever doesn't depend on the answer. When you end your turn, name it in one plain line of",
    'your message (for example "D4 is in your inbox: <the question>"), so it can be followed from the conversation too,',
    'without writing the card out again.',
    'The answer comes as a prompt from the user, like "D4: Yes" (a button) or in their own words; it closes the card.',
    'To change an open decision, call ask_user again with its label.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: 'Optional. Its number, like "D4": number the decisions in this conversation D1, D2… ' +
          'Leave it out and CC Sessions gives it the next number. An open decision with the same label is replaced.',
      },
      question: { type: 'string', description: `The question, on one line (up to ${LIMITS.question} characters).` },
      summary: { type: 'string', description: `About 50 words: what is being decided and what changes with each answer (up to ${LIMITS.summary} characters).` },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: 6,
        description: `Two to six short answers (up to ${LIMITS.option} characters each), one button each; a button types ` +
          '"<label>: <option>" into this session. For a yes or no: Yes | No; to approve something: Accept | Reject.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The answer, as the button shows it.' },
            recommended: { type: 'boolean', description: 'true for the one you recommend (at most one).' },
          },
          required: ['label'],
          additionalProperties: false,
        },
      },
      if_no_answer: { type: 'string', description: `What you will do meanwhile, and whether it can be undone (up to ${LIMITS.fallback} characters).` },
      context: {
        type: 'string',
        description: 'A few paragraphs of plain text (about 250 words) for someone who has not followed the conversation: ' +
          'what is going on, why it needs deciding, what each option implies and its risks. ' +
          `Don't paste the conversation or command output (up to ${LIMITS.context} characters).`,
      },
    },
    required: ['question', 'summary', 'options', 'if_no_answer', 'context'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

const RESOLVE_DECISION = {
  name: 'resolve_decision',
  title: "Take a decision off the user's inbox",
  description: "Takes one of this session's open decisions off the user's inbox when it is no longer needed: you found " +
    'the answer yourself, the user settled it some other way, or events overtook it. Not needed once the user answers it: ' +
    'their answer closes it.',
  inputSchema: {
    type: 'object',
    properties: { label: { type: 'string', description: 'Its label, like "D4".' } },
    required: ['label'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/**
 * ask_user's arguments, checked against the schema (the model may still send anything): { value }
 * or { error } listing everything to fix, so that one more call gets it right.
 */
function checkDecision(a) {
  const text = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '');
  const line = (v) => text(v).replace(/\s+/g, ' ');
  const problems = [];
  const need = (name, value, max) => {
    if (!value) problems.push(`${name} is required`);
    else if (value.length > max) problems.push(`${name} has ${value.length} characters, at most ${max}`);
    return value;
  };
  const label = line(a.label).toUpperCase();
  if (label && !/^[A-Z]{1,2}\d{1,2}$/.test(label)) problems.push('label must look like "D4" (or be left out)');
  const question = need('question', line(a.question), LIMITS.question);
  const summary = need('summary', line(a.summary), LIMITS.summary);
  const fallback = need('if_no_answer', line(a.if_no_answer), LIMITS.fallback);
  const context = need('context', text(a.context), LIMITS.context);
  let options = [];
  if (!Array.isArray(a.options) || a.options.length < 2 || a.options.length > 6) {
    problems.push('options must be a list of two to six answers');
  } else {
    options = a.options
      .map((o) => (typeof o === 'string' ? { label: o } : o && typeof o === 'object' ? o : {}))
      .map((o) => ({ label: line(o.label), recommended: o.recommended === true }));
    if (options.some((o) => !o.label)) problems.push('every option needs a label');
    const long = options.find((o) => o.label.length > LIMITS.option);
    if (long) problems.push(`option "${long.label.slice(0, 30)}…" is longer than ${LIMITS.option} characters`);
    if (new Set(options.map((o) => o.label.toLowerCase())).size !== options.length) problems.push('two options say the same');
    if (options.filter((o) => o.recommended).length > 1) problems.push('at most one option can be recommended');
  }
  if (problems.length) return { error: `Not registered. Fix this and call ask_user again: ${problems.join('; ')}.` };
  return { value: { label, question, summary, options, fallback, context } };
}

const openList = (open) => (open.length ? open.join(', ') : 'none');

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
    if (!keys.length) return [ASK_USER, RESOLVE_DECISION];
    return [ASK_USER, RESOLVE_DECISION, {
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

  function callAskUser(id, args) {
    const d = checkDecision(args);
    if (d.error) return toolError(d.error);
    const r = manager.askFromTool(id, d.value);
    if (!r.ok) return toolError(r.error);
    return toolText(`${r.updated ? 'Updated' : 'Registered'}: ${r.label} is in the user's inbox. ` +
      `When you end your turn, name it in one line of your message (for example "${r.label} is in your inbox: <the question>"). ` +
      `Their answer will come as a prompt, like "${r.label}: ${d.value.options[0].label}". Open decisions in this session: ${openList(r.open)}.`);
  }

  function callResolve(id, args) {
    const label = typeof args.label === 'string' ? args.label.trim() : '';
    if (!label) return toolError('Invalid parameters: label (like "D4") is required.');
    const r = manager.resolveAsk(id, label);
    if (r.error) return toolError(r.error);
    if (!r.ok) return toolError(`There is no open decision ${label.toUpperCase()} in this session. Open ones: ${openList(r.open)}.`);
    return toolText(`${label.toUpperCase()} is off the user's inbox. Still open: ${openList(r.open)}.`);
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
          const given = msg.params && msg.params.arguments;
          const args = given && typeof given === 'object' && !Array.isArray(given) ? given : {};
          if (name === 'ask_user') return rpcResult(msg.id, callAskUser(id, args));
          if (name === 'resolve_decision') return rpcResult(msg.id, callResolve(id, args));
          if (name === 'set_plugin') return rpcResult(msg.id, callSetPlugin(id, args));
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
