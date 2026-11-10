'use strict';
// Log of messages exchanged between Claude Code sessions (the SendMessage tool).
//
// Two vantage points, both from hooks of sessions running inside the app:
//   - sender:   PostToolUse of SendMessage -> { to, message, summary } + { success, msg_id }
//   - receiver: UserPromptSubmit whose prompt is
//               <cross-session-message from="uds:<socket>" from-name="x" from-mode="...">body</...>
// When both ends live in the app, the two observations are merged into one record that
// goes from "sent" (in the recipient's inbox) to "read" (its Claude got it as a prompt).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MAX_RECORDS = 500;
const MAX_BODY = 20000;
const MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

const ENVELOPE_RX = /<cross-session-message\s+([^>]*)>\r?\n?([\s\S]*?)\r?\n?<\/cross-session-message>/g;

function parseEnvelopes(prompt) {
  if (typeof prompt !== 'string' || !prompt.includes('<cross-session-message')) return [];
  const out = [];
  for (const m of prompt.matchAll(ENVELOPE_RX)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    out.push({ fromName: attrs['from-name'] || null, fromAddress: attrs.from || null, body: m[2].trim() });
  }
  return out;
}

/** Stable key for a session's messaging socket, whatever prefix/escaping it comes with. */
function socketKey(s) {
  const m = /cc-msg-[0-9a-f]+/i.exec(String(s || ''));
  return m ? m[0].toLowerCase() : null;
}

function sameBody(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  return x === y || (x.length > 200 && y.length > 200 && x.slice(0, 200) === y.slice(0, 200));
}

class MessageLog extends EventEmitter {
  /**
   * @param {string} file           where to persist
   * @param {(ref: string) => {name: string, terminalId: string|null}} resolve  maps a name or socket to a session
   * @param {(terminalId: string) => {name: string}|null} self   peer name of one of our sessions
   */
  constructor(file, resolve, self) {
    super();
    this.file = file;
    this.resolve = resolve;
    this.self = self;
    this.records = this.load();
    this.timer = null;
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data) ? data.slice(-MAX_RECORDS) : [];
    } catch {
      return [];
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 500);
  }

  saveNow() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.records));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (err) {
      console.error('[messages] could not save', err);
    }
  }

  list() {
    return this.records;
  }

  clear() {
    this.records = [];
    this.saveNow();
    this.emit('cleared');
  }

  handleHook(terminalId, p) {
    if (!p || typeof p !== 'object') return;
    if (p.hook_event_name === 'PostToolUse' && p.tool_name === 'SendMessage') this.onSent(terminalId, p);
    else if (p.hook_event_name === 'UserPromptSubmit') {
      for (const env of parseEnvelopes(p.prompt)) this.onReceived(terminalId, env);
    }
  }

  onSent(terminalId, p) {
    const input = p.tool_input || {};
    const res = p.tool_response && typeof p.tool_response === 'object' ? p.tool_response : {};
    const body = typeof input.message === 'string' ? input.message : '';
    if (!body.trim()) return; // pure notify_when_idle subscription
    // Only messages between sessions; in-process subagents and teammates stay out.
    const description = `${res.display || ''} ${res.message || ''}`;
    if (input.recipient_kind !== 'session' && !/claude session|session/i.test(description)) return;

    const now = Date.now();
    const from = { name: (this.self(terminalId) || {}).name || '?', terminalId };
    const to = this.resolve(input.to || input.recipient);
    const ok = res.success !== false;

    // The recipient may have reported it first (both live in the app).
    const twin = this.findLast((r) => r.status === 'received' &&
      (r.from.terminalId === terminalId || (!r.from.terminalId && r.from.name === from.name)) &&
      sameBody(r.body, body) && now - r.at < MATCH_WINDOW_MS);
    if (twin) {
      Object.assign(twin, { from, summary: input.summary || null, msgId: res.msg_id || null, status: 'read', sentAt: now });
      return this.changed(twin);
    }
    this.add({
      id: crypto.randomUUID(),
      at: now,
      sentAt: now,
      from,
      to,
      body: body.slice(0, MAX_BODY),
      summary: input.summary || null,
      msgId: res.msg_id || null,
      status: ok ? 'sent' : 'failed',
      note: ok ? null : String(res.message || res.error || '').slice(0, 300),
    });
  }

  onReceived(terminalId, env) {
    const now = Date.now();
    const to = { name: (this.self(terminalId) || {}).name || '?', terminalId };
    const sender = env.fromAddress ? this.resolve(env.fromAddress) : { name: null, terminalId: null };
    const fromName = env.fromName || sender.name || '?';

    const twin = this.findLast((r) => r.status === 'sent' &&
      (r.from.name === fromName || (sender.terminalId && r.from.terminalId === sender.terminalId)) &&
      (!r.to.terminalId || r.to.terminalId === terminalId) &&
      sameBody(r.body, env.body) && now - r.at < MATCH_WINDOW_MS);
    if (twin) {
      Object.assign(twin, { to, status: 'read', readAt: now });
      return this.changed(twin);
    }
    this.add({
      id: crypto.randomUUID(),
      at: now,
      readAt: now,
      from: { name: fromName, terminalId: sender.terminalId },
      to,
      body: env.body.slice(0, MAX_BODY),
      summary: null,
      msgId: null,
      status: 'received',
    });
  }

  findLast(pred) {
    for (let i = this.records.length - 1; i >= 0; i--) if (pred(this.records[i])) return this.records[i];
    return null;
  }

  add(rec) {
    this.records.push(rec);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    this.save();
    this.emit('message', rec);
  }

  changed(rec) {
    this.save();
    this.emit('message', rec);
  }
}

module.exports = { MessageLog, parseEnvelopes, socketKey };
