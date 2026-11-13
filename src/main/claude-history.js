'use strict';
// Reads Claude Code's on-disk history (~/.claude/projects) to offer recent projects and
// conversations to resume. Transcripts can be several MB, so we only read their tail:
// Claude periodically re-appends metadata lines (ai-title, custom-title, last-prompt).

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { projectDirFor } = require('./claude-env');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 64 * 1024;

const metaCache = new Map(); // file -> { mtimeMs, size, meta }

async function readSlice(file, start, length) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

function* jsonLines(text, dropFirst) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift(); // probably cut in half
  for (const line of lines) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* partial or corrupt line */ }
  }
}

function userText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain || !entry.message) return null;
  const c = entry.message.content;
  let text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((p) => p.type === 'text') || {}).text : null;
  if (!text) return null;
  text = text.trim();
  if (!text || text.startsWith('<command-') || text.startsWith('<local-command') || text.startsWith('Caveat:')) return null;
  return text;
}

async function conversationMeta(file) {
  const st = await fsp.stat(file);
  const cached = metaCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.meta;

  const meta = { id: path.basename(file, '.jsonl'), mtime: st.mtimeMs, size: st.size };
  const start = Math.max(0, st.size - TAIL_BYTES);
  const tail = await readSlice(file, start, Math.min(TAIL_BYTES, st.size));
  for (const e of jsonLines(tail, start > 0)) {
    if (e.type === 'custom-title' && e.customTitle) meta.customTitle = e.customTitle;
    else if (e.type === 'ai-title' && e.aiTitle) meta.aiTitle = e.aiTitle;
    else if (e.type === 'last-prompt' && e.lastPrompt) meta.lastPrompt = e.lastPrompt;
    if (e.cwd) meta.cwd = e.cwd;
    const t = userText(e);
    if (t) meta.lastUserText = t;
  }
  if (!meta.cwd || !(meta.customTitle || meta.aiTitle || meta.lastPrompt || meta.lastUserText)) {
    const head = await readSlice(file, 0, Math.min(HEAD_BYTES, st.size));
    for (const e of jsonLines(head, false)) {
      if (!meta.cwd && e.cwd) meta.cwd = e.cwd;
      if (!meta.firstPrompt) meta.firstPrompt = userText(e) || undefined;
      if (meta.cwd && meta.firstPrompt) break;
    }
  }
  meta.title = meta.customTitle || meta.aiTitle || meta.firstPrompt || meta.lastPrompt || meta.lastUserText || null;
  meta.lastPrompt = meta.lastPrompt || meta.lastUserText || null;
  delete meta.lastUserText;

  metaCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, meta });
  return meta;
}

async function transcriptFiles(dir) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }
  const files = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (st.isFile() && st.size > 0) files.push({ file: full, mtime: st.mtimeMs });
    } catch { /* deleted meanwhile */ }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

function isTempPath(p) {
  const tmp = os.tmpdir().toLowerCase();
  return p.toLowerCase().startsWith(tmp);
}

async function listProjects(limit = 40) {
  let dirs;
  try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return []; }
  const projects = [];
  await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => {
    const files = await transcriptFiles(path.join(PROJECTS_DIR, d.name));
    if (!files.length) return;
    // The newest transcript may be a stub without cwd; try a couple.
    let cwd = null;
    for (const f of files.slice(0, 3)) {
      try { cwd = (await conversationMeta(f.file)).cwd; } catch { /* ignore */ }
      if (cwd) break;
    }
    if (!cwd || isTempPath(cwd) || !fs.existsSync(cwd)) return;
    projects.push({ cwd, name: path.basename(cwd) || cwd, lastActive: files[0].mtime, conversations: files.length });
  }));
  // Several dirs can map to the same cwd (case differences); keep the most recent.
  const byCwd = new Map();
  for (const p of projects) {
    const key = p.cwd.toLowerCase();
    const prev = byCwd.get(key);
    if (!prev || prev.lastActive < p.lastActive) byCwd.set(key, p);
  }
  return [...byCwd.values()].sort((a, b) => b.lastActive - a.lastActive).slice(0, limit);
}

async function listConversations(cwd, limit = 30) {
  const files = await transcriptFiles(projectDirFor(cwd));
  const out = [];
  for (const f of files.slice(0, limit)) {
    try {
      const meta = await conversationMeta(f.file);
      if (meta.title) out.push(meta);
    } catch { /* ignore unreadable transcript */ }
  }
  return out;
}

const REPLIES_BYTES = 1024 * 1024;

/**
 * What a session has said since the user last wrote to it: its messages ({ text, at } with `at` in
 * ms), oldest first, from the end of its transcript, only those written after `after` (ms). CC Sessions' notes and
 * other sessions' messages don't count as the user writing. Lets the app find a decision the
 * session asked for in the middle of a turn, or before the app could see it.
 */
async function repliesSinceUser(cwd, sessionId, after = 0) {
  if (!cwd || !sessionId) return [];
  const file = path.join(projectDirFor(cwd), sessionId + '.jsonl');
  let st;
  try { st = await fsp.stat(file); } catch { return []; }
  const start = Math.max(0, st.size - REPLIES_BYTES);
  const tail = await readSlice(file, start, Math.min(REPLIES_BYTES, st.size));
  let out = [];
  for (const e of jsonLines(tail, start > 0)) {
    const u = userText(e);
    if (u !== null) {
      if (!u.startsWith('[CC Sessions]') && !u.includes('<cross-session-message')) out = []; // the user wrote
      continue;
    }
    if (e.type !== 'assistant' || e.isSidechain || !e.message || !Array.isArray(e.message.content)) continue;
    const at = Date.parse(e.timestamp);
    if (!(at > after)) continue;
    const text = e.message.content.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('\n');
    if (text) out.push({ text, at });
  }
  return out;
}

module.exports = { listProjects, listConversations, repliesSinceUser };
