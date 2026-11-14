'use strict';

(() => {
  const api = window.ccsm;
  const i18n = window.ccsmI18n;
  // Fixed for the life of the page: changing the language reloads it.
  const t = i18n.create(api.language);
  const $ = (sel, root = document) => root.querySelector(sel);

  // The xterm WebGL addon (0.19) builds its glyph font as `${italic} ${weight} ${size}px ...`,
  // which starts with a space for non-italic text. This Chromium rejects a font string with
  // leading whitespace and silently keeps "10px sans-serif": every glyph comes out tiny.
  // Trimming the value on assignment fixes it without touching the library.
  for (const Ctx of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D]) {
    const desc = Ctx && Object.getOwnPropertyDescriptor(Ctx.prototype, 'font');
    if (!desc || !desc.set) continue;
    Object.defineProperty(Ctx.prototype, 'font', {
      ...desc,
      set(value) { desc.set.call(this, typeof value === 'string' ? value.trim() : value); },
    });
  }

  const ATTENTION = new Set(['permission', 'input', 'done']);
  // Nerd Fonts first: Claude Code's UI uses glyphs that plain fonts lack.
  const FALLBACK_LIST = ['MesloLGS Nerd Font', 'JetBrainsMono NF', 'JetBrainsMono Nerd Font', 'Cascadia Mono', 'Consolas'];
  const fontStack = (first) => [first, ...FALLBACK_LIST.filter((f) => !first || f.toLowerCase() !== first.toLowerCase())]
    .filter(Boolean).map((f) => `"${f}"`).concat('monospace').join(', ');
  const FALLBACK_FONTS = fontStack(null);
  const TERM_THEME = {
    background: '#0b0d10', foreground: '#d9dde4', cursor: '#d9dde4', cursorAccent: '#0b0d10',
    selectionBackground: 'rgba(143, 179, 255, 0.30)',
    black: '#1c1f26', red: '#f0717a', green: '#7fd49a', yellow: '#e9c46a',
    blue: '#7aa2f7', magenta: '#c79bff', cyan: '#6fd3e6', white: '#c8ced8',
    brightBlack: '#5e6674', brightRed: '#ff8f97', brightGreen: '#9de5b2', brightYellow: '#f5d88a',
    brightBlue: '#9db8ff', brightMagenta: '#d9b8ff', brightCyan: '#94e3f0', brightWhite: '#f2f4f7',
  };

  const ui = {
    sessions: new Map(), // id -> entry { id, view, term, fit, pane, item, unseen, lastSize }
    order: [],
    activeId: null,
    view: 'single',
    ready: false,
    pendingData: new Map(),
    windowsBuild: 0,
    // Terminal font: what the user chose in Settings, or else the Windows Terminal profile's.
    settings: { terminal: { fontFamily: null, fontSize: null }, ui: { animations: true, language: t.lang } },
    settingsLimits: { fontSize: { min: 8, max: 32 } },
    wtFont: null, // { family, sizePx } from the Windows Terminal profile, if any
    font: { family: FALLBACK_FONTS, size: 15 }, // effective, applied to every terminal
    fontList: null, // promise of the installed monospace families, loaded once
    modalOnClose: null,
    dragId: null,
    groups: [], // sidebar groups, in order: [{ id, name, collapsed }]
    listMode: 'groups', // 'groups' | 'status' (Settings)
    stickyId: null, // a session you opened from "Needs you" stays there until you leave it
    heads: new Map(), // section key -> its header row (and 'empty:<group>' placeholders)
    listDirty: false, // a re-render that waited for a drag or a group rename to finish
    editingGroup: false,
    menu: null, // the open context menu
    windowAttended: true,
    messages: [], // newest last, like the main process
    msgOpen: readPref('messagesOpen', false),
    msgFilter: readPref('messagesFilter', 'all'),
    msgUnread: 0,
    msgFresh: new Set(),
    msgExpanded: new Set(),
    inboxOpen: readPref('inboxOpen', false),
    inboxCards: new Map(), // session id -> its card in the inbox (kept, so a half-written answer survives updates)
  };

  const dom = {
    list: $('#session-list'),
    stage: $('#stage'),
    topbar: $('#topbar'),
    welcome: $('#welcome'),
    attn: $('#attn-count'),
    modalRoot: $('#modal-root'),
    tbDot: $('#tb-dot'),
    tbMono: $('#tb-mono'),
    tbAdmin: $('#tb-admin'),
    windDot: $('#wind-dot'),
    tbName: $('#tb-name'),
    tbPath: $('#tb-path'),
    tbStatus: $('#tb-status'),
    external: $('#external'),
    extToggle: $('#ext-toggle'),
    extList: $('#ext-list'),
    extCount: $('#ext-count'),
    msgPanel: $('#msg-panel'),
    msgList: $('#mp-list'),
    msgEmpty: $('#mp-empty'),
    msgBtn: $('#btn-messages'),
    msgUnread: $('#msg-unread'),
    inboxPanel: $('#inbox-panel'),
    inboxBtn: $('#btn-inbox'),
    ibList: $('#ib-list'),
    ibEmpty: $('#ib-empty'),
    ibDone: $('#ib-done'),
    ibDoneToggle: $('#ib-done-toggle'),
    ibDoneList: $('#ib-done-list'),
    ibDoneCount: $('#ib-done-count'),
  };

  translatePage();

  // ---------------------------------------------------------------- helpers

  /** Static text in index.html (data-i18n*), in the interface language. */
  function translatePage() {
    document.documentElement.lang = t.lang;
    for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
    // Our own strings with a little markup (<code>), never text from outside.
    for (const n of document.querySelectorAll('[data-i18n-html]')) n.innerHTML = t(n.dataset.i18nHtml);
    for (const n of document.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
    for (const n of document.querySelectorAll('[data-i18n-aria-label]')) n.setAttribute('aria-label', t(n.dataset.i18nAriaLabel));
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function readPref(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem('ccsm.' + key)); return v ?? fallback; } catch { return fallback; }
  }
  function writePref(key, value) {
    try { localStorage.setItem('ccsm.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }

  function basename(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || ''); }
  function shortPath(p) { return String(p || '').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~'); }
  function oneLine(s, n = 160) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

  function ago(ts) {
    const s = (Date.now() - ts) / 1000;
    if (!Number.isFinite(s) || s < 45) return t('time.now');
    const m = s / 60;
    if (m < 60) return t('time.minutes', { n: Math.round(m) });
    const h = m / 60;
    if (h < 24) return t('time.hours', { n: Math.round(h) });
    return t('time.days', { n: Math.round(h / 24) });
  }

  function permissionText(msg) {
    const m = /needs your permission(?: to use (.+))?$/i.exec(msg || '');
    if (m) return m[1] ? t('status.toUse', { tool: m[1] }) : '';
    return oneLine(msg);
  }

  /** Was working when the app was closed, and hasn't done anything since. */
  function isInterrupted(v) {
    return v.interrupted && (v.status === 'ready' || v.status === 'starting' || v.status === 'done');
  }

  /** Between turns with something it asked you to decide (see findAsks() in sessions.js). */
  function decisionPending(v) {
    return !!(v.asks && v.asks.length) && (v.status === 'done' || v.status === 'ready');
  }

  /** What it asks, in one line: the question, or how many and which ("3 decisions: D5, D6, …"). */
  function asksText(asks) {
    if (asks.length === 1) return oneLine(asks[0].text);
    return t('status.decisionsText', { n: asks.length, list: asks.map((a) => a.label || a.topic || oneLine(a.text, 30)).join(', ') });
  }

  /** An image-guard window waits for your consent (the session itself looks busy meanwhile). */
  function guardOpen(v) {
    return !!v.guard && v.status !== 'exited';
  }

  /**
   * The status the dot and the label are drawn with: an image-guard window looks like a permission
   * prompt, and a pending decision like a question.
   */
  function shown(v) {
    if (guardOpen(v)) return 'permission';
    return decisionPending(v) ? 'input' : v.status;
  }

  function describe(v) {
    if (v.parked) return { label: t('status.notStarted'), text: t('admin.needsApproval') };
    if (isInterrupted(v)) return { label: t('status.interrupted'), text: t('status.interruptedText') };
    if (guardOpen(v)) return { label: t('status.guard'), text: t('status.guardText') };
    if (decisionPending(v)) return { label: t('status.decision'), text: asksText(v.asks) };
    switch (v.status) {
      case 'busy': return { label: t('status.busy'), text: v.lastPrompt ? t('common.quote', { text: oneLine(v.lastPrompt, 120) }) : '' };
      case 'permission': return { label: t('status.permission'), text: permissionText(v.detail) };
      case 'input': return { label: t('status.input'), text: oneLine(v.detail) };
      case 'done': return { label: t('status.done'), text: oneLine(v.lastReply) };
      case 'ready': return { label: t('status.ready'), text: v.lastPrompt ? t('common.quote', { text: oneLine(v.lastPrompt, 100) }) : '' };
      case 'exited': return { label: t('status.exited'), text: oneLine(v.detail) };
      default: return { label: t('status.starting'), text: v.detail || '' }; // e.g. waiting for administrator approval
    }
  }

  function labelled({ label, text }) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('b', null, label));
    if (text) frag.appendChild(document.createTextNode(' · ' + text));
    return frag;
  }

  /** Status line, plus a restart waiting for the turn to end (to switch a plugin). */
  function stateLine(v, { long = false } = {}) {
    const frag = labelled(describe(v));
    if (v.pendingRestart) {
      const change = v.pendingRestart;
      const text = long ? t('status.pendingRestartLong', { change }) : t('status.pendingRestartShort');
      const span = el('span', 'pending-restart', ` · ↻ ${text}`);
      span.title = t('status.pendingRestartTitle', { change });
      frag.appendChild(span);
    }
    return frag;
  }

  function uniqueName(base) {
    const taken = new Set([...ui.sessions.values()].map((e) => e.view.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  }

  // ---------------------------------------------------------------- sessions

  function addSession(view) {
    if (ui.sessions.has(view.id)) return updateSession(view);

    const item = buildItem(view.id);
    const pane = buildPane(view.id);
    const term = new Terminal({
      // Same size as the PTY, so output replayed after a reload (e.g. a change of language)
      // isn't reflowed from xterm's 80x24 by the first fit.
      cols: view.cols > 1 ? view.cols : 80,
      rows: view.rows > 1 ? view.rows : 24,
      fontFamily: ui.font.family,
      fontSize: ui.font.size,
      scrollback: 10000,
      cursorBlink: false,
      theme: TERM_THEME,
      windowsPty: ui.windowsBuild ? { backend: 'conpty', buildNumber: ui.windowsBuild } : undefined,
      linkHandler: { activate: (_ev, uri) => api.openExternal(uri), allowNonHttpProtocols: false },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon.WebLinksAddon((_ev, uri) => api.openExternal(uri)));

    const entry = { id: view.id, view, term, fit, pane, item, unseen: false, lastSize: null };
    ui.sessions.set(view.id, entry);
    ui.order.push(view.id);
    dom.stage.appendChild(pane);

    term.open($('.term-host', pane));
    term.onData((data) => api.write(view.id, data));
    term.attachCustomKeyEventHandler((ev) => terminalKey(ev, entry));

    const pending = ui.pendingData.get(view.id);
    if (pending) { term.write(pending.join('')); ui.pendingData.delete(view.id); }

    render(entry);
    renderSidebar();
    syncPanes();
    layout();
    return entry;
  }

  /**
   * WebGL renderer: sharper text and, above all, box-drawing and block characters drawn by
   * xterm itself, so they join up like in Windows Terminal (the DOM renderer uses the font's
   * glyphs, which leave gaps with fonts that have line spacing, e.g. Claude's logo).
   * Browsers cap WebGL contexts (~16); a terminal that loses its context falls back to DOM.
   * Loaded the first time the terminal is visible: built inside a display:none pane, the glyph
   * atlas comes out with wrong measurements (tiny, spaced-out text).
   */
  function enableWebgl(e) {
    if (e.webgl !== undefined) return;
    e.webgl = null;
    if (!window.WebglAddon) return;
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      e.term.loadAddon(webgl);
      e.webgl = webgl;
    } catch (err) {
      console.warn('WebGL unavailable; using the DOM renderer', err);
    }
  }

  function updateSession(view) {
    const e = ui.sessions.get(view.id);
    if (!e) return addSession(view);
    const prev = e.view.status;
    const renamed = e.view.name !== view.name;
    const regrouped = e.view.group !== view.group;
    e.view = view;
    if (renamed && ui.msgOpen) renderMessages();
    // A turn that a note of ours or another session started ends quietly (unless it asks you something).
    const quiet = view.status === 'done' && view.quietTurn && !(view.asks && view.asks.length);
    if (view.status !== prev && ATTENTION.has(view.status) && !(view.id === ui.activeId && ui.windowAttended) && !quiet) {
      e.unseen = true;
    }
    if (!ATTENTION.has(view.status)) e.unseen = false;
    render(e);
    renderSidebar();
    if (regrouped) syncPanes();
    updateAttention();
    updateWind();
    renderInbox();
    return e;
  }

  function removeSession(id) {
    const e = ui.sessions.get(id);
    if (!e) return;
    e.term.dispose();
    e.pane.remove();
    e.item.remove();
    ui.sessions.delete(id);
    const idx = ui.order.indexOf(id);
    ui.order.splice(idx, 1);
    if (ui.stickyId === id) ui.stickyId = null;
    if (ui.activeId === id) {
      ui.activeId = null;
      const next = ui.order[Math.min(idx, ui.order.length - 1)];
      if (next) setActive(next);
      else api.setUiState({ activeId: null });
    }
    renderSidebar();
    layout();
    updateAttention();
    for (const key of [...ui.inboxCards.keys()]) if (key === id || key.startsWith(id + '|')) ui.inboxCards.delete(key);
    renderInbox();
  }

  function buildItem(id) {
    const li = el('li', 'sess');
    li.dataset.id = id;
    li.draggable = true;
    // [badge] name ............ time (the Ctrl+N number while Ctrl is held)
    //         ● status · detail
    //         path (only when the folder isn't named like the session)
    const row = el('div', 'sess-row');
    row.append(el('span', 'sess-name'), adminMark(), el('span', 'sess-time'), el('kbd', 'sess-key'));
    const status = el('div', 'sess-status');
    status.append(el('span', 'dot'), el('span', 'sess-detail'));
    li.append(el('span', 'mono'), row, status, el('div', 'sess-path'));

    li.addEventListener('click', () => setActive(id));
    li.addEventListener('dblclick', () => { setActive(id); startRename(); });
    li.addEventListener('contextmenu', (ev) => sessionMenu(id, ev));
    li.addEventListener('dragstart', (ev) => {
      ui.dragId = id;
      li.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', id);
    });
    li.addEventListener('dragend', () => {
      ui.dragId = null;
      for (const x of dom.list.children) x.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-into');
      if (ui.listDirty) renderSidebar();
    });
    li.addEventListener('dragover', (ev) => {
      if (!canDropBeside(id)) return;
      ev.preventDefault();
      const r = li.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      li.classList.toggle('drop-after', after);
      li.classList.toggle('drop-before', !after);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const after = li.classList.contains('drop-after');
      li.classList.remove('drop-before', 'drop-after');
      if (canDropBeside(id)) moveSession(ui.dragId, { beside: id, after });
    });
    return li;
  }

  function buildPane(id) {
    const pane = el('section', 'pane');
    pane.dataset.id = id;

    const head = el('div', 'pane-head');
    head.append(el('span', 'dot'), el('span', 'mono'), el('span', 'pane-name'), adminMark(), el('span', 'pane-state'));
    head.addEventListener('click', () => setActive(id));

    const banner = el('div', 'pane-banner');
    banner.hidden = true;
    const bannerText = el('span', null, t('banner.text'));
    const btnContinue = el('button', 'btn-primary', t('banner.continue'));
    const btnDismiss = el('button', 'btn-secondary', t('banner.dismiss'));
    btnContinue.addEventListener('click', () => {
      api.write(id, t('banner.continuePrompt'));
      setTimeout(() => api.write(id, '\r'), 150);
      api.clearInterrupted(id);
      focusActive();
    });
    btnDismiss.addEventListener('click', () => { api.clearInterrupted(id); focusActive(); });
    banner.append(bannerText, btnContinue, btnDismiss);

    // .pane-term carries the padding; .term-host is what the fit addon measures (it must have
    // no padding) and keeps the rows pinned to its bottom edge.
    const host = el('div', 'pane-term');
    host.appendChild(el('div', 'term-host'));
    host.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const e = ui.sessions.get(id);
      if (!e) return;
      if (e.term.hasSelection()) {
        api.writeClipboard(e.term.getSelection());
        e.term.clearSelection();
      } else {
        api.readClipboard().then((t) => { if (t) e.term.paste(t); });
      }
    });

    const exited = el('div', 'pane-exited');
    exited.hidden = true;
    const btnResume = el('button', 'btn-primary', t('exited.resume'));
    const btnRemove = el('button', 'btn-secondary', t('exited.remove'));
    btnResume.addEventListener('click', () => {
      api.restartSession(id);
      ui.sessions.get(id)?.term.focus(); // so you can type straight away
    });
    btnRemove.addEventListener('click', () => api.closeSession(id));
    exited.append(el('span', 'msg'), btnResume, btnRemove);

    pane.append(head, banner, host, exited);
    pane.addEventListener('focusin', () => { if (ui.activeId !== id) setActive(id, { focus: false }); });
    return pane;
  }

  function render(e) {
    const v = e.view;
    const interrupted = isInterrupted(v);

    e.item.dataset.status = shown(v);
    e.item.classList.toggle('unseen', e.unseen);
    e.item.classList.toggle('interrupted', interrupted);
    e.pane.classList.toggle('interrupted', interrupted);
    e.item.title = v.cwd;
    setBadge($('.mono', e.item), v);
    setBadge($('.pane-head .mono', e.pane), v);
    $('.sess-name', e.item).textContent = v.name;
    $('.admin-mark', e.item).hidden = !v.admin;
    $('.pane-head .admin-mark', e.pane).hidden = !v.admin;
    $('.sess-time', e.item).textContent = ago(v.statusSince);
    const path = $('.sess-path', e.item);
    path.textContent = shortPath(v.cwd);
    path.hidden = sameName(v.name, v.cwd);
    $('.sess-detail', e.item).replaceChildren(stateLine(v));

    e.pane.dataset.status = shown(v);
    $('.pane-head .dot', e.pane).dataset.status = shown(v);
    $('.pane-name', e.pane).textContent = v.name;
    $('.pane-state', e.pane).replaceChildren(stateLine(v));

    const banner = $('.pane-banner', e.pane);
    banner.hidden = !(v.interrupted && v.status !== 'exited');
    $('.pane-banner .btn-primary', e.pane).disabled = !(v.status === 'ready' || v.status === 'done');

    const exited = $('.pane-exited', e.pane);
    exited.hidden = v.status !== 'exited';
    $('.msg', exited).textContent = v.parked ? t('admin.parked') : v.detail ? t('status.endedDetail', { detail: v.detail }) : t('status.ended');
    $('.btn-primary', exited).textContent = v.admin ? t('admin.start') : t('exited.resume');

    if (v.id === ui.activeId) renderTopbar();
  }

  function renderTopbar() {
    const e = ui.sessions.get(ui.activeId);
    dom.topbar.hidden = !e;
    if (!e) return;
    const v = e.view;
    dom.tbDot.dataset.status = shown(v);
    dom.tbDot.classList.toggle('interrupted', isInterrupted(v));
    setBadge(dom.tbMono, v);
    dom.tbAdmin.hidden = !v.admin;
    if (!dom.tbName.querySelector('input')) dom.tbName.textContent = v.name;
    dom.tbPath.textContent = shortPath(v.cwd);
    dom.tbPath.title = t('topbar.openPath', { path: v.cwd });
    dom.tbStatus.dataset.status = shown(v);
    dom.tbStatus.replaceChildren(stateLine(v, { long: true }));
  }

  /** Numbers for Ctrl+1…9 follow stableOrder(), so they don't change with the sessions' state. */
  function renumber() {
    stableOrder().forEach((id, i) => {
      const key = $('.sess-key', ui.sessions.get(id).item);
      key.textContent = i < 9 ? String(i + 1) : '';
      key.hidden = i >= 9;
    });
  }

  /** New manual order (ui.order), saved; the list and the grid follow. */
  function applyOrder(order) {
    ui.order = order;
    api.reorder(order);
    renderSidebar();
    syncPanes();
  }

  /** The grid shows the panes in stableOrder(). Moves only what changed. */
  function syncPanes() {
    const panes = stableOrder().map((id) => ui.sessions.get(id).pane);
    panes.forEach((p, i) => { if (dom.stage.children[i] !== p) dom.stage.insertBefore(p, dom.stage.children[i] || null); });
    requestAnimationFrame(fitVisible);
  }

  function updateAttention() {
    let n = 0;
    for (const e of ui.sessions.values()) {
      if (e.view.status === 'permission' || e.view.status === 'input' || e.unseen || decisionPending(e.view) || guardOpen(e.view)) n++;
    }
    dom.attn.hidden = n === 0;
    dom.attn.textContent = String(n);
    document.title = n ? `(${n}) CC Sessions` : 'CC Sessions';
  }

  // ---------------------------------------------------------------- session list: badges, sections, groups

  // Same names and order as COLORS in the main process (sessions.js); the CSS draws them.
  const COLORS = ['blue', 'orange', 'green', 'pink', 'cyan', 'amber', 'violet', 'lime', 'red', 'teal', 'indigo', 'slate'];

  /** Two letters for the badge: the first of the first two words, or the first two letters. */
  function initials(name) {
    const words = String(name || '').split(/[\s\-_.\/\\]+/).filter(Boolean);
    const first = (w) => [...w][0] || '';
    if (words.length >= 2) return (first(words[0]) + first(words[1])).toUpperCase();
    const w = words[0] || '?';
    const caps = w.match(/\p{Lu}/gu); // CamelCase: its capitals
    return (caps && caps.length >= 2 ? caps[0] + caps[1] : [...w].slice(0, 2).join('')).toUpperCase();
  }

  // The letters go in an inner span trimmed to the capitals' height (text-box), so they sit
  // in the optical middle of the badge instead of where the font's ascent/descent put them.
  function setBadge(node, view) {
    if (!node) return;
    const text = initials(view.name);
    const inner = node.firstElementChild || node.appendChild(el('span'));
    if (inner.textContent !== text) inner.textContent = text;
    node.dataset.color = COLORS.includes(view.color) ? view.color : COLORS[0];
  }

  /** The folder is named like the session ("cc-sessions" and "CC Sessions" count as the same). */
  function sameName(name, cwd) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    return norm(name) === norm(String(cwd || '').split(/[\\/]/).filter(Boolean).pop());
  }

  /** The shield next to the name of a session that runs as administrator. */
  function adminMark() {
    const s = el('span', 'admin-mark');
    s.hidden = true;
    s.title = t('admin.badgeTitle');
    s.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.75 3 3.6v3.9c0 3.1 2.1 5.3 5 6.25 2.9-.95 5-3.15 5-6.25V3.6z"/></svg>';
    return s;
  }

  function badge(view) {
    const b = el('span', 'mono');
    setBadge(b, view);
    return b;
  }

  /** The session's group, if it still exists. */
  function groupOf(id) {
    const g = ui.sessions.get(id)?.view.group;
    return g && ui.groups.some((x) => x.id === g) ? g : null;
  }

  /**
   * The order behind the numbers (Ctrl+1…9), Ctrl+Tab and the grid. It doesn't depend on the
   * sessions' state: by group, your groups in order and then the rest; by status, your order.
   */
  function stableOrder() {
    if (ui.listMode !== 'groups' || !ui.groups.length) return ui.order.slice();
    const out = [];
    for (const g of ui.groups) for (const id of ui.order) if (groupOf(id) === g.id) out.push(id);
    for (const id of ui.order) if (!groupOf(id)) out.push(id);
    return out;
  }

  function needsYou(e) {
    const s = e.view.status;
    return s === 'permission' || s === 'input' || (s === 'done' && e.unseen) || decisionPending(e.view) || guardOpen(e.view) || ui.stickyId === e.id;
  }

  /** What the list shows: [{ key, title, ids, collapsible, collapsed, group }]. A null title: no header. */
  function sections() {
    const entries = stableOrder().map((id) => ui.sessions.get(id));
    const top = entries.filter(needsYou);
    const rest = entries.filter((e) => !needsYou(e));
    const ids = (list) => list.map((e) => e.id);
    const working = (e) => e.view.status === 'busy' || e.view.status === 'starting';
    if (ui.listMode === 'status') {
      return [
        { key: 'needs', title: t('list.needsYou'), ids: ids(top) },
        { key: 'working', title: t('list.working'), ids: ids(rest.filter(working)) },
        { key: 'idle', title: t('list.idle'), ids: ids(rest.filter((e) => !working(e))), collapsible: true, collapsed: readPref('idleCollapsed', false) },
      ].filter((s) => s.ids.length);
    }
    const out = [];
    if (top.length) out.push({ key: 'needs', title: t('list.needsYou'), ids: ids(top) });
    for (const g of ui.groups) {
      out.push({ key: 'g:' + g.id, title: g.name, group: g, ids: ids(rest.filter((e) => groupOf(e.id) === g.id)), collapsible: true, collapsed: g.collapsed });
    }
    const loose = ids(rest.filter((e) => !groupOf(e.id)));
    if (loose.length) {
      // With no groups the list needs no heading, unless "Needs you" is above it.
      out.push({ key: 'loose', title: ui.groups.length ? t('list.ungrouped') : top.length ? t('list.others') : null, ids: loose });
    }
    return out;
  }

  /** Lays out the sidebar. Moves only the rows that changed place: re-inserting one restarts its animation. */
  function renderSidebar() {
    // Not under a drag or while a group is being renamed: rows would move under the pointer
    // or the text box would lose focus. Done when that ends.
    if (ui.dragId || ui.editingGroup) { ui.listDirty = true; return; }
    ui.listDirty = false;
    const nodes = [];
    for (const sec of sections()) {
      if (sec.title !== null) nodes.push(sectionHead(sec));
      for (const id of sec.ids) {
        const e = ui.sessions.get(id);
        e.item.dataset.section = sec.key;
        // A folded section still shows the session you're on.
        if (!sec.collapsed || id === ui.activeId) nodes.push(e.item);
      }
      if (sec.group && !sec.ids.length && !sec.collapsed) nodes.push(emptyGroupRow(sec.group));
    }
    const list = dom.list;
    nodes.forEach((n, i) => { if (list.children[i] !== n) list.insertBefore(n, list.children[i] || null); });
    while (list.children.length > nodes.length) list.lastElementChild.remove();
    renumber();
  }

  function sectionHead(sec) {
    let h = ui.heads.get(sec.key);
    if (!h) {
      h = el('li', 'list-head');
      h.dataset.key = sec.key;
      h.append(el('span', 'lh-chev'), el('span', 'lh-title'), el('span', 'lh-count'), el('span', 'lh-dots'));
      h.addEventListener('click', () => toggleSection(sec.key));
      h.addEventListener('dblclick', () => { if (sec.key.startsWith('g:')) renameGroup(sec.key.slice(2)); });
      h.addEventListener('contextmenu', (ev) => { if (sec.key.startsWith('g:')) groupMenu(sec.key.slice(2), ev); });
      dropInto(h, () => (sec.key.startsWith('g:') ? sec.key.slice(2) : sec.key === 'loose' && ui.groups.length ? null : undefined));
      ui.heads.set(sec.key, h);
    }
    h.classList.toggle('collapsible', !!sec.collapsible);
    h.classList.toggle('collapsed', !!sec.collapsed);
    h.classList.toggle('is-group', !!sec.group);
    $('.lh-chev', h).title = sec.collapsible ? t(sec.collapsed ? 'list.expand' : 'list.collapse') : '';
    const title = $('.lh-title', h);
    if (!title.querySelector('input')) title.textContent = sec.title;
    title.title = sec.group ? t('list.renameGroupTitle') : '';
    $('.lh-count', h).textContent = String(sec.ids.length);
    // Folded: one small dot per session, so you still see what they're doing.
    $('.lh-dots', h).replaceChildren(...(sec.collapsed ? sec.ids.map((id) => {
      const d = el('span', 'mini-dot');
      d.dataset.status = shown(ui.sessions.get(id).view);
      return d;
    }) : []));
    return h;
  }

  function emptyGroupRow(g) {
    let row = ui.heads.get('empty:' + g.id);
    if (!row) {
      row = el('li', 'list-empty', t('list.empty'));
      dropInto(row, () => g.id);
      ui.heads.set('empty:' + g.id, row);
    }
    return row;
  }

  function toggleSection(key) {
    if (key === 'idle') writePref('idleCollapsed', !readPref('idleCollapsed', false));
    else if (key.startsWith('g:')) {
      const g = ui.groups.find((x) => x.id === key.slice(2));
      if (!g) return;
      g.collapsed = !g.collapsed;
      api.saveGroups(ui.groups);
    } else return;
    renderSidebar();
  }

  // ---- drag and drop

  /** Dropping next to a session: not into "Needs you", and by status only within the same section. */
  function canDropBeside(id) {
    const dragged = ui.dragId;
    if (!dragged || dragged === id) return false;
    const section = ui.sessions.get(id).item.dataset.section;
    if (section === 'needs') return false;
    return ui.listMode === 'groups' || ui.sessions.get(dragged).item.dataset.section === section;
  }

  /** A header or an empty group that takes a dropped session into a group (undefined: not a target). */
  function dropInto(node, groupFor) {
    node.addEventListener('dragover', (ev) => {
      if (!ui.dragId || ui.listMode !== 'groups' || groupFor() === undefined) return;
      ev.preventDefault();
      node.classList.add('drop-into');
    });
    node.addEventListener('dragleave', () => node.classList.remove('drop-into'));
    node.addEventListener('drop', (ev) => {
      node.classList.remove('drop-into');
      const g = groupFor();
      if (!ui.dragId || g === undefined) return;
      ev.preventDefault();
      moveSession(ui.dragId, { group: g });
    });
  }

  /**
   * Moves a session next to another one (taking its group) or to the end of a group
   * ({ group: id | null }). By status only the group changes: the order is yours.
   */
  function moveSession(id, { beside = null, after = false, group } = {}) {
    const e = ui.sessions.get(id);
    if (!e) return;
    let target = group;
    if (beside && ui.listMode === 'groups') target = groupOf(beside);
    if (target !== undefined && target !== groupOf(id)) {
      e.view = { ...e.view, group: target }; // right away; the main process confirms
      api.setSessionMeta(id, { group: target });
    }
    if (!beside && ui.listMode !== 'groups') { renderSidebar(); return; }
    const order = ui.order.filter((x) => x !== id);
    if (beside) order.splice(order.indexOf(beside) + (after ? 1 : 0), 0, id);
    else {
      const last = order.filter((x) => groupOf(x) === target).pop();
      order.splice(last ? order.indexOf(last) + 1 : order.length, 0, id);
    }
    applyOrder(order);
  }

  // ---- groups

  function saveGroups() {
    api.saveGroups(ui.groups);
    renderSidebar();
    syncPanes();
  }

  /** A new group, optionally with a session in it, and its name ready to type. */
  function createGroup(withSession) {
    const g = { id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: t('group.newName'), collapsed: false };
    ui.groups.push(g);
    api.saveGroups(ui.groups);
    if (ui.listMode !== 'groups') { setListMode('groups'); }
    if (withSession) moveSession(withSession, { group: g.id });
    else renderSidebar();
    renameGroup(g.id);
  }

  function renameGroup(id) {
    const g = ui.groups.find((x) => x.id === id);
    const h = ui.heads.get('g:' + id);
    if (!g || !h || !h.isConnected) return;
    const title = $('.lh-title', h);
    if (title.querySelector('input')) return;
    const input = el('input', 'lh-input');
    input.value = g.name;
    input.maxLength = 60;
    title.replaceChildren(input);
    ui.editingGroup = true;
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      ui.editingGroup = false;
      const name = input.value.trim();
      if (save && name) g.name = name;
      title.textContent = g.name;
      saveGroups();
      focusActive();
    };
    for (const type of ['click', 'dblclick', 'mousedown']) input.addEventListener(type, (ev) => ev.stopPropagation());
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  function moveGroup(id, step) {
    const i = ui.groups.findIndex((g) => g.id === id);
    const j = i + step;
    if (i < 0 || j < 0 || j >= ui.groups.length) return;
    [ui.groups[i], ui.groups[j]] = [ui.groups[j], ui.groups[i]];
    saveGroups();
  }

  /** Its sessions stay, without a group. */
  function deleteGroup(id) {
    ui.groups = ui.groups.filter((g) => g.id !== id);
    for (const e of ui.sessions.values()) {
      if (e.view.group === id) { e.view = { ...e.view, group: null }; api.setSessionMeta(e.id, { group: null }); }
    }
    ui.heads.delete('g:' + id);
    ui.heads.delete('empty:' + id);
    saveGroups();
  }

  async function setListMode(mode) {
    ui.listMode = mode === 'status' ? 'status' : 'groups';
    if (ui.settings.ui.listMode !== ui.listMode) await updateSettings({ ui: { listMode: ui.listMode } });
    renderSidebar();
    syncPanes();
  }

  // ---- context menus

  function closeMenu() {
    if (!ui.menu) return;
    ui.menu.remove();
    ui.menu = null;
  }

  /** A small menu at the pointer; build(menu) fills it. */
  function openMenu(ev, build) {
    ev.preventDefault();
    ev.stopPropagation();
    closeMenu();
    const menu = el('div', 'ctx-menu');
    menu.setAttribute('role', 'menu');
    build(menu);
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(ev.clientX, window.innerWidth - r.width - 6)) + 'px';
    menu.style.top = Math.max(4, Math.min(ev.clientY, window.innerHeight - r.height - 6)) + 'px';
    ui.menu = menu;
  }

  function menuItem(label, action, { checked = false, danger = false } = {}) {
    const b = el('button', 'ctx-item' + (checked ? ' checked' : '') + (danger ? ' danger' : ''), label);
    b.setAttribute('role', checked ? 'menuitemradio' : 'menuitem');
    if (checked) b.setAttribute('aria-checked', 'true');
    b.addEventListener('click', () => { closeMenu(); action(); });
    return b;
  }

  const menuLabel = (text) => el('div', 'ctx-label', text);
  const menuSep = () => el('div', 'ctx-sep');

  document.addEventListener('mousedown', (ev) => { if (ui.menu && !ui.menu.contains(ev.target)) closeMenu(); }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  function sessionMenu(id, ev) {
    const e = ui.sessions.get(id);
    if (!e) return;
    openMenu(ev, (m) => {
      m.append(menuLabel(t('menu.color')));
      const swatches = el('div', 'ctx-swatches');
      for (const c of COLORS) {
        const b = el('button', 'swatch' + (e.view.color === c ? ' on' : ''));
        b.dataset.color = c;
        b.title = t('menu.colorName', { color: t('color.' + c) });
        b.setAttribute('aria-label', b.title);
        b.addEventListener('click', () => { closeMenu(); api.setSessionMeta(id, { color: c }); });
        swatches.appendChild(b);
      }
      m.append(swatches, menuSep(), menuLabel(t('menu.moveTo')));
      const current = groupOf(id);
      for (const g of ui.groups) m.append(menuItem(g.name, () => moveSession(id, { group: g.id }), { checked: current === g.id }));
      if (ui.groups.length) m.append(menuItem(t('menu.noGroup'), () => moveSession(id, { group: null }), { checked: current === null }));
      m.append(menuItem(t('menu.newGroup'), () => createGroup(id)));
      m.append(
        menuSep(),
        menuItem(t('menu.rename'), () => { setActive(id); startRename(); }),
        menuItem(t('menu.runAsAdmin'), () => confirmAdmin(id, !e.view.admin), { checked: !!e.view.admin }),
        menuItem(t('menu.restart'), () => confirmRestart(id)),
        menuItem(t('menu.remove'), () => confirmClose(id), { danger: true }),
      );
    });
  }

  function groupMenu(id, ev) {
    const i = ui.groups.findIndex((g) => g.id === id);
    if (i < 0) return;
    openMenu(ev, (m) => {
      m.append(menuItem(t('menu.renameGroup'), () => renameGroup(id)));
      if (i > 0) m.append(menuItem(t('menu.moveUp'), () => moveGroup(id, -1)));
      if (i < ui.groups.length - 1) m.append(menuItem(t('menu.moveDown'), () => moveGroup(id, 1)));
      m.append(menuSep(), menuItem(t('menu.deleteGroup'), () => deleteGroup(id), { danger: true }));
    });
  }

  // ---- quick switcher (Ctrl+Shift+K)

  const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

  /** How well a query matches a session (0: not at all): name first, then group and folder. */
  function matchScore(q, e) {
    const name = fold(e.view.name);
    const group = fold(ui.groups.find((g) => g.id === groupOf(e.id))?.name);
    let s = 0;
    if (name.startsWith(q)) s = 100;
    else if (fold(initials(e.view.name)) === q) s = 90;
    else if (name.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) s = 80;
    else if (name.includes(q)) s = 60;
    else if (group && group.includes(q)) s = 50;
    else if (fold(e.view.cwd).includes(q)) s = 30;
    else {
      let i = 0;
      for (const c of name) if (c === q[i]) i++;
      if (i === q.length) s = 20; // letters in order: "cgw" -> comfyui-gateway
    }
    return s;
  }

  function openSwitcher() {
    if (!ui.sessions.size) return;
    closeMenu();
    const modal = modalShell('switcher-modal', t('switcher.title'));
    const body = el('div', 'modal-body switcher-body');
    const input = el('input', 'switcher-input');
    input.placeholder = t('switcher.placeholder');
    input.spellcheck = false;
    const list = el('ul', 'switcher-list');
    body.append(input, list, el('div', 'switcher-hint', t('switcher.hint')));
    modal.appendChild(body);

    let results = [];
    let sel = 0;
    const go = (id) => { closeModal(); setActive(id); };
    const mark = () => {
      [...list.children].forEach((c, i) => c.classList.toggle('sel', i === sel));
      list.children[sel]?.scrollIntoView({ block: 'nearest' });
    };
    const row = (e, i) => {
      const li = el('li', 'switcher-row' + (e.id === ui.activeId ? ' current' : ''));
      const dot = el('span', 'dot');
      dot.dataset.status = shown(e.view);
      const groupName = ui.groups.find((g) => g.id === groupOf(e.id))?.name;
      const state = el('span', 'sw-state');
      state.dataset.status = shown(e.view);
      state.appendChild(el('b', null, describe(e.view).label));
      li.append(dot, badge(e.view), el('span', 'sw-name', e.view.name), el('span', 'sw-meta', [groupName, shortPath(e.view.cwd)].filter(Boolean).join(' · ')), state);
      li.addEventListener('mousemove', () => { if (sel !== i) { sel = i; mark(); } });
      li.addEventListener('click', () => go(e.id));
      return li;
    };
    const draw = () => {
      const q = fold(input.value.trim());
      const all = stableOrder().map((id) => ui.sessions.get(id));
      results = q
        ? all.map((e, i) => ({ e, s: matchScore(q, e), i })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).map((r) => r.e)
        : all;
      sel = Math.min(sel, Math.max(0, results.length - 1));
      list.replaceChildren(...(results.length ? results.map(row) : [el('li', 'switcher-empty', t('switcher.none'))]));
      mark();
    };
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (results.length) { sel = (sel + (ev.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length; mark(); }
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (results[sel]) go(results[sel].id);
      }
    });
    openModal(modal);
    draw();
    input.focus();
  }

  // ---------------------------------------------------------------- focus & layout

  function setActive(id, { focus = true } = {}) {
    const e = ui.sessions.get(id);
    if (!e) return;
    // Opened while it needed you: it stays under "Needs you" until you move on, so the row
    // doesn't jump away from under the pointer.
    ui.stickyId = needsYou(e) ? id : null;
    ui.activeId = id;
    for (const x of ui.sessions.values()) {
      const on = x.id === id;
      x.pane.classList.toggle('active', on);
      x.item.classList.toggle('active', on);
    }
    if (e.unseen) { e.unseen = false; render(e); }
    renderSidebar();
    renderTopbar();
    updateAttention();
    if (ui.msgOpen && ui.msgFilter === 'active') renderMessages();
    api.setUiState({ activeId: id });
    requestAnimationFrame(() => {
      fitEntry(e);
      if (focus) e.term.focus();
      e.item.scrollIntoView({ block: 'nearest' });
    });
  }

  function focusActive() {
    const e = ui.sessions.get(ui.activeId);
    if (e) e.term.focus();
  }

  function setView(view, { persist = true } = {}) {
    ui.view = view === 'grid' ? 'grid' : 'single';
    if (persist) api.setUiState({ view: ui.view });
    layout();
    focusActive();
  }

  function gridCols(n) {
    if (n <= 1) return 1;
    if (n <= 4) return 2;
    if (n <= 9) return 3;
    return 4;
  }

  function layout() {
    const n = ui.sessions.size;
    dom.stage.className = 'stage ' + ui.view;
    dom.stage.style.setProperty('--cols', String(gridCols(n)));
    dom.welcome.hidden = n > 0;
    dom.topbar.hidden = n === 0 || !ui.activeId;
    for (const b of document.querySelectorAll('.seg button[data-view]')) b.classList.toggle('on', b.dataset.view === ui.view);
    requestAnimationFrame(fitVisible);
  }

  function fitEntry(e) {
    const host = $('.term-host', e.pane);
    if (!host.clientWidth || !host.clientHeight) return; // hidden
    syncFont(e);
    enableWebgl(e);
    try { e.fit.fit(); } catch { return; }
    const { cols, rows } = e.term;
    if (!e.lastSize || e.lastSize.cols !== cols || e.lastSize.rows !== rows) {
      e.lastSize = { cols, rows };
      api.resize(e.id, cols, rows);
    }
  }

  /**
   * The size a new session's terminal will have: in single view, that of the session on screen.
   * It starts at that size, so Claude doesn't have to catch a resize while it's starting up.
   */
  function newTermSize() {
    const e = ui.view === 'single' && ui.sessions.get(ui.activeId);
    return e && e.lastSize ? { cols: e.lastSize.cols, rows: e.lastSize.rows } : {};
  }

  function fitVisible() {
    for (const e of ui.sessions.values()) fitEntry(e);
  }

  let resizeRaf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(fitVisible);
  }).observe(dom.stage);

  // ---------------------------------------------------------------- terminal font

  function computeFont() {
    const term = ui.settings.terminal;
    const family = term.fontFamily || (ui.wtFont && ui.wtFont.family);
    ui.font = {
      family: fontStack(family),
      size: term.fontSize || (ui.wtFont && ui.wtFont.sizePx) || 15,
    };
  }

  /**
   * Hidden terminals get the font when they're next shown (fitEntry): measured inside a
   * display:none pane, xterm would get the cell size wrong.
   */
  function syncFont(e) {
    if (e.term.options.fontFamily !== ui.font.family) e.term.options.fontFamily = ui.font.family;
    if (e.term.options.fontSize !== ui.font.size) e.term.options.fontSize = ui.font.size;
  }

  function applySettings() {
    computeFont();
    // Windows' "animation effects" switch is ignored on purpose: these indicators are how
    // you see what each session is doing. Settings has its own switch.
    document.body.classList.toggle('no-anim', !ui.settings.ui.animations);
    ui.listMode = ui.settings.ui.listMode === 'status' ? 'status' : 'groups';
    requestAnimationFrame(fitVisible);
  }

  async function updateSettings(patch) {
    ui.settings = await api.updateSettings(patch);
    applySettings();
    return ui.settings;
  }

  const updateTerminalSettings = (patch) => updateSettings({ terminal: patch });

  function clampFontSize(size) {
    const { min, max } = ui.settingsLimits.fontSize;
    return Math.max(min, Math.min(max, Math.round(size)));
  }

  /** null: back to the Windows Terminal size. */
  function setFontSize(size) {
    const next = size === null ? null : clampFontSize(size);
    if (next === ui.settings.terminal.fontSize) return Promise.resolve(ui.settings);
    return updateTerminalSettings({ fontSize: next });
  }

  // Symbol fonts pass the monospace test but have no letters.
  const SYMBOL_FONTS = /^(marlett|webdings|wingdings|symbol$|segoe (mdl2|fluent|ui symbol|ui emoji))/i;

  /** Installed monospace families, alphabetically. Takes a couple of seconds the first time. */
  function loadMonospaceFonts() {
    if (!ui.fontList) {
      ui.fontList = (async () => {
        const fonts = await window.queryLocalFonts();
        const families = [...new Set(fonts.map((f) => f.family.replace(/["\\]/g, '')))];
        const ctx = document.createElement('canvas').getContext('2d');
        const isMono = (family) => {
          ctx.font = `20px "${family}", serif`; // a family the canvas can't use falls back to serif: not mono
          return Math.abs(ctx.measureText('iiiiiiiiii').width - ctx.measureText('WWWWWWWWWW').width) < 0.5;
        };
        return families
          .filter((f) => !SYMBOL_FONTS.test(f) && isMono(f))
          .sort((a, b) => a.localeCompare(b, t.locale, { sensitivity: 'base' }));
      })();
      ui.fontList.catch(() => { ui.fontList = null; }); // try again next time
    }
    return ui.fontList;
  }

  // ---------------------------------------------------------------- keyboard

  function terminalKey(ev, entry) {
    if (ev.type !== 'keydown') return true;
    const key = ev.key.toLowerCase();
    // Ctrl+C copies when there's a selection (otherwise it's Claude's interrupt).
    if (ev.ctrlKey && !ev.altKey && key === 'c' && (ev.shiftKey || entry.term.hasSelection())) {
      if (entry.term.hasSelection()) {
        api.writeClipboard(entry.term.getSelection());
        entry.term.clearSelection();
      }
      ev.preventDefault();
      return false;
    }
    // Ctrl+V pastes text; with no text on the clipboard (an image) pass ^V through so
    // Claude can grab the image itself.
    if (ev.ctrlKey && !ev.altKey && key === 'v') {
      ev.preventDefault();
      api.readClipboard().then((t) => { if (t) entry.term.paste(t); else api.write(entry.id, '\x16'); });
      return false;
    }
    // Shift+Enter: newline inside the prompt instead of sending it.
    if (ev.shiftKey && !ev.ctrlKey && !ev.altKey && ev.key === 'Enter') {
      ev.preventDefault();
      api.write(entry.id, '\x1b\r');
      return false;
    }
    return true;
  }

  function cycle(step) {
    const order = stableOrder();
    if (!order.length) return;
    const i = order.indexOf(ui.activeId);
    setActive(order[(i + step + order.length) % order.length]);
  }

  /** Next session that needs you: permission > question > finished, starting after the current one. */
  function jumpToAttention() {
    const rank = (e) => {
      const st = shown(e.view); // an image-guard window counts as a permission, a decision as a question
      return st === 'permission' ? 0 : st === 'input' ? 1 : e.unseen || st === 'done' ? 2 : 9;
    };
    const order = stableOrder();
    const start = Math.max(0, order.indexOf(ui.activeId));
    const rotated = [...order.slice(start + 1), ...order.slice(0, start + 1)].map((id) => ui.sessions.get(id));
    let best = null;
    for (const e of rotated) if (rank(e) < 9 && (!best || rank(e) < rank(best))) best = e;
    if (best) setActive(best.id);
  }

  window.addEventListener('keydown', (ev) => {
    if (ui.menu) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMenu(); }
      return;
    }
    if (dom.modalRoot.firstChild) {
      if (ev.key === 'Escape') { ev.preventDefault(); closeModal(); }
      return;
    }
    let handled = true;
    const k = ev.key;
    const kl = k.toLowerCase();
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && kl === 'n') openNewSession();
    else if (ev.ctrlKey && ev.shiftKey && !ev.altKey && kl === 'g') setView(ui.view === 'grid' ? 'single' : 'grid');
    else if (ev.ctrlKey && ev.shiftKey && !ev.altKey && kl === 'j') jumpToAttention();
    else if (ev.ctrlKey && ev.shiftKey && !ev.altKey && kl === 'w') { if (ui.activeId) confirmClose(ui.activeId); }
    else if (ev.ctrlKey && ev.shiftKey && !ev.altKey && kl === 'm') setMessagesOpen(!ui.msgOpen);
    else if (ev.ctrlKey && ev.shiftKey && !ev.altKey && kl === 'i') setInboxOpen(!ui.inboxOpen);
    else if (ev.ctrlKey && ev.shiftKey && !ev.altKey && kl === 'k') openSwitcher();
    else if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && /^[1-9]$/.test(k)) { const id = stableOrder()[Number(k) - 1]; if (id) setActive(id); }
    else if (ev.ctrlKey && k === 'Tab') cycle(ev.shiftKey ? -1 : 1);
    else if (ev.ctrlKey && !ev.altKey && (k === '+' || k === '=')) setFontSize(ui.font.size + 1);
    else if (ev.ctrlKey && !ev.altKey && k === '-') setFontSize(ui.font.size - 1);
    else if (ev.ctrlKey && !ev.altKey && k === '0') setFontSize(null);
    else if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && k === ',') openSettings();
    else if (k === 'F12') api.toggleDevtools();
    else handled = false;
    if (handled) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);

  // Holding Ctrl on its own for a moment shows the Ctrl+1…9 numbers in the list. The delay keeps
  // them from flashing on every Ctrl+C / Ctrl+V; any other key cancels it.
  let keysTimer = null;
  function showKeys(on) {
    clearTimeout(keysTimer);
    keysTimer = null;
    document.body.classList.toggle('show-keys', on);
  }
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Control') { if (keysTimer) showKeys(false); return; }
    if (!ev.repeat && !ev.shiftKey && !ev.altKey && !ev.metaKey) {
      clearTimeout(keysTimer);
      keysTimer = setTimeout(() => { keysTimer = null; document.body.classList.add('show-keys'); }, 450);
    }
  }, true);
  window.addEventListener('keyup', (ev) => { if (ev.key === 'Control') showKeys(false); }, true);
  window.addEventListener('blur', () => showKeys(false));

  api.onWindowAttended((attended) => {
    ui.windowAttended = !!attended;
    const e = ui.sessions.get(ui.activeId);
    if (attended && e && e.unseen) { e.unseen = false; render(e); updateAttention(); }
  });

  // ---------------------------------------------------------------- rename / close

  function startRename() {
    const e = ui.sessions.get(ui.activeId);
    if (!e || dom.tbName.querySelector('input')) return;
    const input = el('input', 'tb-name-input');
    input.value = e.view.name;
    dom.tbName.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      dom.tbName.textContent = e.view.name;
      if (save && name && name !== e.view.name) await api.renameSession(e.id, name);
      focusActive();
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function confirmClose(id) {
    const e = ui.sessions.get(id);
    if (!e) return;
    const working = ['busy', 'permission', 'input'].includes(e.view.status);
    const ok = await confirmModal({
      title: t('close.title', { name: e.view.name }),
      message: working ? t('close.working') : t('close.idle'),
      confirmLabel: t('close.confirm'),
    });
    if (ok) api.closeSession(id);
  }

  /** "Tell the session it was restarted when it's back": remembered between uses. */
  function notifyCheck() {
    const label = el('label', 'set-check restart-notify');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = readPref('restartNotify', true);
    input.addEventListener('change', () => writePref('restartNotify', input.checked));
    label.append(input, el('span', null, t('restart.notify')));
    return { el: label, input };
  }

  async function confirmRestart(id) {
    const e = ui.sessions.get(id);
    if (!e) return;
    const working = ['busy', 'permission', 'input'].includes(e.view.status);
    const notify = notifyCheck();
    const ok = await confirmModal({
      title: t('restart.title', { name: e.view.name }),
      message: (working ? t('restart.working') + ' ' : '') + t('restart.cost'),
      confirmLabel: t('restart.confirm'),
      extra: notify.el,
    });
    if (ok) api.restartSession(id, { notify: notify.input.checked });
  }

  /** Run a session as administrator, or stop doing so: restarts it if it's running. */
  async function confirmAdmin(id, on) {
    const e = ui.sessions.get(id);
    if (!e) return;
    const running = e.view.status !== 'exited';
    const working = ['busy', 'permission', 'input'].includes(e.view.status);
    const notify = running ? notifyCheck() : null;
    const parts = [];
    if (working) parts.push(t('restart.working'));
    if (on) parts.push(t(running ? 'admin.onRestart' : 'admin.onLater'), t('admin.risk'));
    else if (running) parts.push(t('admin.offRestart'));
    if (running) parts.push(t('restart.cost'));
    const ok = await confirmModal({
      title: t(on ? 'admin.onTitle' : 'admin.offTitle', { name: e.view.name }),
      message: parts.join(' '),
      confirmLabel: t(on ? 'admin.onConfirm' : 'admin.offConfirm'),
      extra: notify ? notify.el : undefined,
    });
    if (ok) api.setSessionAdmin(id, on, { notify: !!(notify && notify.input.checked) });
  }

  function pluginStateText(p) {
    const word = (on) => t(on ? 'plugins.on' : 'plugins.off');
    if (p.loaded === null) return t('plugins.stateOnResume', { state: word(p.on) });
    if (p.loaded !== p.on) return t('plugins.stateAfterRestart', { now: word(p.loaded), next: word(p.on) });
    return t(p.on === p.configured ? 'plugins.stateConfigured' : 'plugins.stateSessionOnly', { state: word(p.on) });
  }

  /** Plugins of the active session: switch them on or off for that session only. */
  async function openPlugins() {
    const id = ui.activeId;
    const e = ui.sessions.get(id);
    if (!e) return;
    const state = await api.sessionPlugins(id);
    if (!state || ui.activeId !== id) return;
    const working = ['busy', 'permission', 'input', 'starting'].includes(e.view.status);

    const modal = modalShell('plugins-modal', t('plugins.title', { name: e.view.name }));
    const body = el('div', 'modal-body');
    body.appendChild(el('p', 'plugins-intro', t('plugins.intro')));

    const rows = [];
    for (const p of state.plugins) {
      const row = el('label', 'plugin-row');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = p.on;
      const text = el('div', 'plugin-text');
      text.append(el('b', null, p.label), el('span', null, p.about), el('span', 'plugin-state', pluginStateText(p)));
      row.append(input, text);
      body.appendChild(row);
      rows.push({ p, input });
    }
    if (!rows.length) body.appendChild(el('p', 'plugins-intro', t('plugins.none')));

    if (state.pending) {
      const pend = el('div', 'plugin-pending');
      const cancelPending = el('button', 'btn-secondary', t('plugins.cancelRestart'));
      cancelPending.addEventListener('click', async () => { await api.cancelRestart(id); closeModal(); });
      pend.append(el('span', null, t('plugins.pending', { change: state.pending })), cancelPending);
      body.appendChild(pend);
    }

    const notify = notifyCheck();
    if (state.running && rows.length) body.append(el('p', 'plugins-cost', t('restart.cost')), notify.el);

    const foot = el('div', 'modal-foot');
    const cancel = el('button', 'btn-secondary', t('common.close'));
    const apply = el('button', 'btn-primary', t(!state.running ? 'plugins.save' : working ? 'plugins.applyWhenIdle' : 'plugins.applyRestart'));
    const changes = () => {
      const out = {};
      for (const { p, input } of rows) if (input.checked !== p.on) out[p.key] = input.checked;
      return out;
    };
    const sync = () => { apply.disabled = !Object.keys(changes()).length; };
    for (const { input } of rows) input.addEventListener('change', sync);
    sync();
    cancel.addEventListener('click', closeModal);
    apply.addEventListener('click', async () => {
      const c = changes();
      closeModal();
      if (Object.keys(c).length) await api.setSessionPlugins(id, c, { notify: notify.input.checked });
    });
    foot.append(cancel, apply);
    modal.append(body, foot);
    openModal(modal);
  }

  // ---------------------------------------------------------------- modals

  function openModal(content, { onClose, see = false } = {}) {
    closeModal();
    const backdrop = el('div', see ? 'modal-backdrop see-through' : 'modal-backdrop');
    backdrop.appendChild(content);
    backdrop.addEventListener('mousedown', (ev) => { if (ev.target === backdrop) closeModal(); });
    dom.modalRoot.appendChild(backdrop);
    ui.modalOnClose = onClose || null;
  }

  function closeModal() {
    if (!dom.modalRoot.firstChild) return;
    dom.modalRoot.replaceChildren();
    const cb = ui.modalOnClose;
    ui.modalOnClose = null;
    if (cb) cb();
    focusActive();
  }

  function modalShell(cls, title) {
    const modal = el('div', 'modal ' + cls);
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', title);
    const head = el('div', 'modal-head');
    const close = el('button', 'icon-btn');
    close.title = t('common.closeEsc');
    close.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    close.addEventListener('click', closeModal);
    head.append(el('h2', null, title), close);
    modal.appendChild(head);
    return modal;
  }

  function confirmModal({ title, message, confirmLabel, extra = null }) {
    return new Promise((resolve) => {
      let result = false;
      const modal = modalShell('confirm-modal', title);
      const body = el('div', 'modal-body');
      body.appendChild(el('p', null, message));
      if (extra) body.appendChild(extra);
      const foot = el('div', 'modal-foot');
      const cancel = el('button', 'btn-secondary', t('common.cancel'));
      const ok = el('button', 'btn-primary', confirmLabel);
      cancel.addEventListener('click', closeModal);
      ok.addEventListener('click', () => { result = true; closeModal(); });
      foot.append(cancel, ok);
      modal.append(body, foot);
      openModal(modal, { onClose: () => resolve(result) });
      ok.focus();
    });
  }

  // ---------------------------------------------------------------- restarting the app

  /** The footer button shows a dot while the sessions are being asked to stop; the panel follows them. */
  function updateWind() {
    const on = [...ui.sessions.values()].some((e) => e.view.wind);
    dom.windDot.hidden = !on;
    if (ui.windRender) ui.windRender();
  }

  /**
   * Restart CC Sessions in an orderly way: first every running session is asked to stop its
   * background work (main: windDownAll), and the panel shows how each one is doing and what it
   * answered. Restart (or close) whenever you like; calling it off tells them to carry on.
   */
  function openWindDown() {
    const modal = modalShell('wind-modal', t('winddown.title'));
    const body = el('div', 'modal-body');
    const foot = el('div', 'modal-foot');
    modal.append(body, foot);
    const resume = el('label', 'set-check wind-resume');
    const resumeInput = el('input');
    resumeInput.type = 'checkbox';
    resumeInput.checked = readPref('windResume', true);
    resumeInput.addEventListener('change', () => writePref('windResume', resumeInput.checked));
    resume.append(resumeInput, el('span', null, t('winddown.resumeAfter')));

    const quit = (relaunch, started) => api.quitApp({ relaunch, resumeAfter: started && resumeInput.checked });
    const button = (cls, label, action) => {
      const b = el('button', cls, label);
      b.addEventListener('click', action);
      return b;
    };

    const render = () => {
      const all = stableOrder().map((id) => ui.sessions.get(id));
      const started = all.some((e) => e.view.wind);
      const running = all.filter((e) => e.view.status !== 'exited');
      const pending = all.filter((e) => e.view.wind && e.view.wind !== 'done' && e.view.wind !== 'closed').length;
      const list = el('ul', 'wind-list');
      for (const e of all) {
        const v = e.view;
        const state = started ? v.wind || 'closed' : v.status === 'exited' ? 'closed' : null;
        const li = el('li', 'wind-row');
        li.dataset.state = state || '';
        const text = el('div', 'wind-text');
        const line = el('div', 'wind-line');
        line.append(el('span', 'wind-name', v.name));
        if (state) line.append(el('span', 'wind-state', t('winddown.state.' + state)));
        text.appendChild(line);
        if (state === 'done' && v.lastReply) text.appendChild(el('div', 'wind-reply', oneLine(v.lastReply, 240)));
        li.append(badge(v), text);
        list.appendChild(li);
      }
      const nodes = [];
      if (!started) nodes.push(el('p', 'wind-intro', t('winddown.intro')), el('p', 'wind-how', t('winddown.howItReaches')));
      if (!running.length && !started) nodes.push(el('p', 'wind-how', t('winddown.noneRunning')));
      nodes.push(list, resume);
      if (started) nodes.push(el('p', 'wind-progress' + (pending ? '' : ' done'), pending ? t('winddown.pending', { n: pending }) : t('winddown.allDone')));
      body.replaceChildren(...nodes);
      resume.hidden = !started && !running.length;

      foot.replaceChildren(...(started
        ? [
          button('btn-secondary wind-cancel', t('winddown.cancel'), () => { api.cancelWindDown(); closeModal(); }),
          button('btn-secondary', t('winddown.quit'), () => quit(false, true)),
          button('btn-primary', t('winddown.restartNow'), () => quit(true, true)),
        ]
        : [
          button('btn-secondary', t('common.cancel'), closeModal),
          button(running.length ? 'btn-secondary' : 'btn-primary', t('winddown.restartNow'), () => quit(true, false)),
          ...(running.length ? [button('btn-primary', t('winddown.ask'), () => api.windDown())] : []),
        ]));
    };
    ui.windRender = render;
    render();
    // Closing the panel doesn't call anything off: the footer button brings it back.
    openModal(modal, { onClose: () => { ui.windRender = null; } });
    const primary = foot.querySelector('.btn-primary');
    if (primary) primary.focus();
  }

  function openHelp() {
    const modal = modalShell('help-modal', t('help.title'));
    const body = el('div', 'modal-body');
    const dl = el('dl', 'keys');
    const rows = [
      ['Ctrl+Shift+N', t('help.new')],
      ['Ctrl+Shift+K', t('help.switcher')],
      ['Ctrl+Shift+J', t('help.attention')],
      ['Ctrl+1 … 9', t('help.goTo')],
      ['Ctrl+Tab', t('help.cycle')],
      ['Ctrl+Shift+G', t('help.view')],
      ['Ctrl+Shift+I', t('help.inbox')],
      ['Ctrl+Shift+M', t('help.messages')],
      ['Ctrl+Shift+W', t('help.remove')],
      ['Ctrl+C / Ctrl+V', t('help.copyPaste')],
      [t('help.rightClickKey'), t('help.rightClick')],
      ['Shift+Enter', t('help.newline')],
      ['Ctrl+= / Ctrl+- / Ctrl+0', t('help.fontSize')],
      ['Ctrl+,', t('help.settings')],
      [t('help.renameKey'), t('help.rename')],
      [t('help.reorderKey'), t('help.reorder')],
      [t('help.menuKey'), t('help.menu')],
    ];
    for (const [k, d] of rows) dl.append(el('dt', null, k), el('dd', null, d));
    body.appendChild(dl);
    modal.appendChild(body);
    openModal(modal);
  }

  // ---------------------------------------------------------------- settings

  // The last line is a glyph test (accents included), the same in every language.
  const PREVIEW_TEXT = [
    '✻ Claude Code  ~/repos/cc-sessions',
    '> ' + t('settings.previewPrompt'),
    '● Bash(npm test)  ' + t('settings.previewResult'),
    '0O 1lI |  {}[]() => != -> <= ~ áéíóú ñ',
  ].join('\n');

  /** The whole page is rebuilt in the new language; Settings opens again once it's back. */
  async function setLanguage(code) {
    if (code === t.lang) return;
    await updateSettings({ ui: { language: code } });
    try { sessionStorage.setItem('ccsm.reopenSettings', '1'); } catch { /* storage unavailable */ }
    api.reload(); // location.reload() would be blocked by the main process's will-navigate guard
  }

  /** Settings: terminal font and size, interface. Changes apply to every session as you make them. */
  function openSettings() {
    const modal = modalShell('settings-modal', t('settings.title'));
    const body = el('div', 'modal-body settings-body');
    const wt = ui.wtFont;

    body.appendChild(el('h3', 'set-section', t('settings.terminal')));
    body.appendChild(el('p', 'set-note', t('settings.terminalNote')));

    // Font family
    const fontField = el('div', 'set-field');
    const fontLabel = el('label', 'set-label', t('settings.font'));
    const filter = el('input', 'set-filter');
    filter.placeholder = t('settings.fontSearch');
    filter.spellcheck = false;
    filter.id = 'set-font-filter';
    fontLabel.htmlFor = filter.id;
    const list = el('ul', 'font-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('settings.font'));
    list.appendChild(el('li', 'empty', t('settings.fontLoading')));
    fontField.append(fontLabel, filter, list);

    // Size
    const sizeField = el('div', 'set-field set-size');
    const sizeLabel = el('label', 'set-label', t('settings.size'));
    const stepper = el('div', 'stepper');
    const minus = el('button', 'step-btn', '−');
    minus.title = t('settings.smaller');
    const sizeInput = el('input', 'size-input');
    sizeInput.type = 'number';
    sizeInput.id = 'set-font-size';
    sizeInput.min = ui.settingsLimits.fontSize.min;
    sizeInput.max = ui.settingsLimits.fontSize.max;
    sizeLabel.htmlFor = sizeInput.id;
    const plus = el('button', 'step-btn', '+');
    plus.title = t('settings.larger');
    stepper.append(minus, sizeInput, plus);
    const sizeHint = el('span', 'set-hint');
    const sizeReset = el('button', 'link-btn', t(wt ? 'settings.useWtSize' : 'settings.useDefaultSize'));
    sizeField.append(sizeLabel, stepper, el('span', 'set-unit', 'px'), sizeHint, sizeReset);

    // Preview
    const preview = el('pre', 'font-preview', PREVIEW_TEXT);

    // Interface
    const uiSection = el('h3', 'set-section set-section-gap', t('settings.interface'));
    const langField = el('div', 'set-field set-lang');
    const langSeg = el('div', 'seg');
    langSeg.setAttribute('role', 'group');
    langSeg.setAttribute('aria-label', t('settings.language'));
    for (const { code, name } of i18n.LANGUAGES) {
      const b = el('button', code === t.lang ? 'on' : null, name); // each one in its own language
      b.lang = code;
      b.setAttribute('aria-pressed', String(code === t.lang));
      b.addEventListener('click', () => setLanguage(code));
      langSeg.appendChild(b);
    }
    langField.append(el('span', 'set-label', t('settings.language')), langSeg);
    const animRow = el('label', 'set-check');
    const animBox = el('input');
    animBox.type = 'checkbox';
    animRow.append(animBox, el('span', null, t('settings.animations')));
    animBox.addEventListener('change', () => updateSettings({ ui: { animations: animBox.checked } }));
    const listField = el('div', 'set-field set-lang');
    const listSeg = el('div', 'seg');
    listSeg.setAttribute('role', 'group');
    listSeg.setAttribute('aria-label', t('settings.listMode'));
    for (const [mode, key] of [['groups', 'settings.listGroups'], ['status', 'settings.listStatus']]) {
      const b = el('button', ui.listMode === mode ? 'on' : null, t(key));
      b.setAttribute('aria-pressed', String(ui.listMode === mode));
      b.addEventListener('click', async () => {
        await setListMode(mode);
        for (const x of listSeg.children) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
      });
      listSeg.appendChild(b);
    }
    listField.append(el('span', 'set-label', t('settings.listMode')), listSeg);
    const listNote = el('p', 'set-hint set-list-note', t('settings.listModeNote'));

    // Phone notice (phone-alert.js in the main process)
    const alertSection = el('h3', 'set-section set-section-gap', t('settings.alerts'));
    const alertNote = el('p', 'set-hint set-alert-note', t('settings.alertsNote'));
    const alerts = ui.settings.alerts || { afterMinutes: null, command: null };
    const afterField = el('div', 'set-field set-size');
    const afterLabel = el('label', 'set-label', t('settings.alertsAfter'));
    const afterInput = el('input', 'size-input');
    afterInput.type = 'number';
    afterInput.id = 'set-alert-after';
    afterInput.min = ui.settingsLimits.alertMinutes ? ui.settingsLimits.alertMinutes.min : 1;
    afterInput.max = ui.settingsLimits.alertMinutes ? ui.settingsLimits.alertMinutes.max : 1440;
    afterInput.value = alerts.afterMinutes ? String(alerts.afterMinutes) : '';
    afterLabel.htmlFor = afterInput.id;
    afterField.append(afterLabel, afterInput, el('span', 'set-unit', t('settings.alertsMinutes')));
    afterInput.addEventListener('change', async () => {
      const n = afterInput.value.trim() ? Number(afterInput.value) : null;
      const saved = await updateSettings({ alerts: { afterMinutes: n } });
      afterInput.value = saved.alerts.afterMinutes ? String(saved.alerts.afterMinutes) : '';
    });
    const cmdField = el('div', 'set-field');
    const cmdLabel = el('label', 'set-label', t('settings.alertsCommand'));
    const cmdInput = el('input', 'set-filter set-command');
    cmdInput.id = 'set-alert-command';
    cmdInput.spellcheck = false;
    cmdInput.placeholder = 'ssh.exe -i %USERPROFILE%\\.ssh\\key user@host';
    cmdInput.value = alerts.command || '';
    cmdLabel.htmlFor = cmdInput.id;
    cmdInput.addEventListener('change', () => updateSettings({ alerts: { command: cmdInput.value } }));
    const testRow = el('div', 'set-alert-test');
    const testBtn = el('button', 'btn-secondary', t('settings.alertsTest'));
    const testResult = el('span', 'set-hint');
    testBtn.addEventListener('click', async () => {
      await updateSettings({ alerts: { command: cmdInput.value } });
      testBtn.disabled = true;
      testResult.textContent = t('settings.alertsSending');
      let r = null;
      try { r = await api.testAlert(); } catch { /* reported below */ }
      testBtn.disabled = false;
      testResult.textContent = r && r.ok ? t('settings.alertsSent') : t('settings.alertsFailed', { error: (r && r.error) || '?' });
    });
    testRow.append(testBtn, testResult);
    cmdField.append(cmdLabel, cmdInput, el('span', 'set-hint', t('settings.alertsCommandHint')), testRow);

    body.append(fontField, sizeField, preview, uiSection, langField, listField, listNote, animRow, alertSection, alertNote, afterField, cmdField);
    modal.appendChild(body);

    let families = null;
    const render = () => {
      const term = ui.settings.terminal;
      sizeInput.value = String(ui.font.size);
      sizeHint.textContent = term.fontSize ? '' : t(wt ? 'settings.sizeFromWt' : 'settings.sizeDefault');
      sizeReset.hidden = !term.fontSize;
      minus.disabled = ui.font.size <= ui.settingsLimits.fontSize.min;
      plus.disabled = ui.font.size >= ui.settingsLimits.fontSize.max;
      preview.style.fontFamily = ui.font.family;
      preview.style.fontSize = ui.font.size + 'px';
      animBox.checked = ui.settings.ui.animations;
      renderList();
    };

    const fontItem = (value, name, sub) => {
      const li = el('li', 'font-item');
      li.setAttribute('role', 'option');
      const selected = value === ui.settings.terminal.fontFamily;
      li.setAttribute('aria-selected', String(selected));
      if (selected) li.classList.add('sel');
      const nameEl = el('span', 'f-name', name);
      const family = value || (wt && wt.family);
      if (family) nameEl.style.fontFamily = `"${family}", var(--ui-font)`;
      li.appendChild(nameEl);
      if (sub) li.appendChild(el('span', 'f-sub', sub));
      li.tabIndex = 0;
      const choose = async () => {
        await updateTerminalSettings({ fontFamily: value });
        render();
        list.querySelector('.sel')?.focus();
      };
      li.addEventListener('click', choose);
      li.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(); }
        else if (ev.key === 'ArrowDown') { ev.preventDefault(); li.nextElementSibling?.focus(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); (li.previousElementSibling || filter).focus(); }
      });
      return li;
    };

    let listFailed = false;
    const renderList = () => {
      if (!families) return;
      const q = filter.value.trim().toLowerCase();
      const current = ui.settings.terminal.fontFamily;
      const items = [];
      if (listFailed) items.push(el('li', 'empty', t('settings.fontsFailed')));
      if (!q) items.push(fontItem(null, t(wt ? 'settings.fontLikeWt' : 'settings.fontDefault'), wt ? wt.family : t('settings.fontDefaultList')));
      const names = current && !families.includes(current) ? [current, ...families] : families;
      for (const f of names) {
        if (q && !f.toLowerCase().includes(q)) continue;
        items.push(fontItem(f, f, families.includes(f) || listFailed ? '' : t('settings.fontMissing')));
      }
      if (!items.length) items.push(el('li', 'empty', t('settings.fontNoMatch')));
      list.replaceChildren(...items);
    };

    filter.addEventListener('input', renderList);
    filter.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); list.querySelector('.font-item')?.focus(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); list.querySelector('.font-item')?.click(); }
    });
    minus.addEventListener('click', async () => { await setFontSize(ui.font.size - 1); render(); });
    plus.addEventListener('click', async () => { await setFontSize(ui.font.size + 1); render(); });
    sizeInput.addEventListener('change', async () => {
      const n = Number(sizeInput.value);
      if (Number.isFinite(n) && n > 0) await setFontSize(n);
      render();
    });
    sizeReset.addEventListener('click', async () => { await setFontSize(null); render(); });

    openModal(modal, { see: true });
    render();
    filter.focus();

    loadMonospaceFonts()
      .then((found) => { families = found; render(); list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); })
      .catch((err) => {
        console.warn('Could not read the font list', err);
        families = [];
        listFailed = true;
        render();
      });
  }

  // ---------------------------------------------------------------- new session

  async function openNewSession() {
    const modal = modalShell('new-modal', t('new.title'));
    const grid = el('div', 'new-grid');
    const projCol = el('div', 'proj-col');
    const filter = el('input', 'proj-filter');
    filter.placeholder = t('new.filter');
    filter.spellcheck = false;
    const projList = el('ul', 'proj-list');
    projList.appendChild(el('li', 'empty', t('new.loadingProjects')));
    const projFoot = el('div', 'proj-foot');
    const pick = el('button', 'btn-secondary', t('new.pickFolder'));
    projFoot.appendChild(pick);
    projCol.append(filter, projList, projFoot);
    const convCol = el('div', 'conv-col');
    convCol.appendChild(el('div', 'placeholder', t('new.pickProject')));
    grid.append(projCol, convCol);
    modal.appendChild(grid);
    openModal(modal);
    filter.focus();

    let projects = [];
    let shown = [];
    let sel = 0;
    let current = null;
    let loadToken = 0;
    let nameInput = null;

    const startNew = async () => {
      if (!current) return;
      const name = (nameInput && nameInput.value.trim()) || uniqueName(basename(current.cwd));
      const view = await api.createSession({ cwd: current.cwd, name, ...newTermSize() });
      closeModal();
      addSession(view);
      setActive(view.id);
    };

    const resume = async (c) => {
      if (c.openHere) { closeModal(); setActive(c.openHere); return; }
      if (c.openElsewhere) {
        const ok = await confirmModal({
          title: t('new.elsewhereTitle'),
          message: t('new.elsewhereMessage', { pid: c.openElsewhere.pid }),
          confirmLabel: t('new.openAnyway'),
        });
        if (!ok) return;
      }
      const view = await api.createSession({ cwd: current.cwd, name: uniqueName(c.customTitle || basename(current.cwd)), resumeId: c.id, ...newTermSize() });
      closeModal();
      addSession(view);
      setActive(view.id);
    };

    const renderConversations = async (project) => {
      current = project;
      const token = ++loadToken;
      convCol.replaceChildren();
      const head = el('div', 'conv-head');
      head.append(el('div', 'c-title', project.name || basename(project.cwd)), el('div', 'c-path', project.cwd));
      const row = el('div', 'new-row');
      const label = el('label', null, t('new.name'));
      nameInput = el('input');
      nameInput.value = uniqueName(basename(project.cwd));
      nameInput.spellcheck = false;
      nameInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); startNew(); } });
      const go = el('button', 'btn-primary', t('new.newConversation'));
      go.addEventListener('click', startNew);
      row.append(label, nameInput, go);
      head.appendChild(row);
      const sub = el('div', 'conv-sub', t('new.resumeHeading'));
      const list = el('ul', 'conv-list');
      list.appendChild(el('li', 'empty', t('new.loading')));
      convCol.append(head, sub, list);

      let convs = [];
      try { convs = await api.listConversations(project.cwd); } catch { /* ignore */ }
      if (token !== loadToken) return;
      list.replaceChildren();
      if (!convs.length) list.appendChild(el('li', 'empty', t('new.noConversations')));
      for (const c of convs) {
        const li = el('li');
        const r = el('div', 'c-row');
        r.appendChild(el('span', 'c-name', oneLine(c.title, 120)));
        if (c.openHere) r.appendChild(el('span', 'badge here', t('new.openHere')));
        else if (c.openElsewhere) r.appendChild(el('span', 'badge elsewhere', t('new.openElsewhere')));
        r.appendChild(el('span', 'c-time', ago(c.mtime)));
        li.appendChild(r);
        if (c.lastPrompt && c.lastPrompt !== c.title) li.appendChild(el('div', 'c-prompt', t('new.lastPrompt', { text: oneLine(c.lastPrompt) })));
        li.title = c.id;
        li.addEventListener('click', () => resume(c));
        list.appendChild(li);
      }
    };

    let convTimer = 0;
    const selectIndex = (i, { immediate = false } = {}) => {
      if (!shown.length) return;
      sel = Math.max(0, Math.min(shown.length - 1, i));
      [...projList.children].forEach((li, idx) => li.classList.toggle('sel', idx === sel));
      const li = projList.children[sel];
      if (li) li.scrollIntoView({ block: 'nearest' });
      clearTimeout(convTimer);
      const p = shown[sel];
      if (immediate) renderConversations(p);
      else convTimer = setTimeout(() => renderConversations(p), 160);
    };

    const renderProjects = () => {
      const q = filter.value.trim().toLowerCase();
      shown = projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q));
      projList.replaceChildren();
      if (!shown.length) {
        projList.appendChild(el('li', 'empty', t(projects.length ? 'new.noMatch' : 'new.noProjects')));
        return;
      }
      shown.forEach((p, i) => {
        const li = el('li');
        const r = el('div', 'p-row');
        r.append(el('span', 'p-name', p.name), el('span', 'p-time', ago(p.lastActive)));
        li.append(r, el('div', 'p-path', shortPath(p.cwd)));
        li.title = p.cwd;
        li.addEventListener('click', () => selectIndex(i, { immediate: true }));
        projList.appendChild(li);
      });
      selectIndex(0);
    };

    filter.addEventListener('input', renderProjects);
    filter.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); selectIndex(sel + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); selectIndex(sel - 1); }
      else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (shown[sel] && (!current || current.cwd !== shown[sel].cwd)) {
          clearTimeout(convTimer);
          renderConversations(shown[sel]);
        }
        startNew();
      }
    });
    pick.addEventListener('click', async () => {
      const dir = await api.pickFolder();
      if (!dir) return;
      [...projList.children].forEach((li) => li.classList.remove('sel'));
      renderConversations({ cwd: dir, name: basename(dir) });
    });

    try { projects = await api.listProjects(); } catch { projects = []; }
    // Folders of sessions that are open right now come first if they aren't in history yet.
    for (const e of ui.sessions.values()) {
      if (!projects.some((p) => p.cwd.toLowerCase() === e.view.cwd.toLowerCase())) {
        projects.unshift({ cwd: e.view.cwd, name: basename(e.view.cwd), lastActive: e.view.statusSince });
      }
    }
    if (dom.modalRoot.contains(modal)) renderProjects();
  }

  // ---------------------------------------------------------------- external sessions

  function renderExternal(list) {
    dom.external.hidden = !list.length;
    dom.extCount.textContent = list.length ? `(${list.length})` : '';
    dom.extList.replaceChildren();
    for (const x of list) {
      const li = el('li');
      const dot = el('span', 'dot');
      dot.dataset.status = x.status === 'busy' ? 'busy' : x.status === 'idle' ? 'ready' : 'starting';
      li.append(dot, el('span', 'ext-name', x.name || basename(x.cwd)), el('span', 'ext-path', shortPath(x.cwd || '')));
      li.title = t('external.title', { pid: x.pid });
      dom.extList.appendChild(li);
    }
  }

  // ---------------------------------------------------------------- messages between sessions

  const MSG_STATE = {
    sent: 'messages.sent',
    read: 'messages.read',
    received: 'messages.received',
    failed: 'messages.failed',
  };

  function peerEl(p) {
    const e = p && p.terminalId && ui.sessions.get(p.terminalId);
    if (e) {
      const b = el('button', 'peer', e.view.name);
      b.title = t('messages.goTo', { name: e.view.name });
      b.addEventListener('click', (ev) => { ev.stopPropagation(); setActive(e.id); });
      return b;
    }
    const s = el('span', 'peer', (p && p.name) || '?');
    s.title = t('messages.outside');
    return s;
  }

  function firstLine(text) {
    return oneLine(String(text || '').split(/\r?\n/).find((l) => l.trim()) || '', 140);
  }

  function messageItem(m) {
    const li = el('li', 'msg');
    li.dataset.status = m.status;
    li.classList.toggle('fresh', ui.msgFresh.has(m.id));
    li.classList.toggle('expanded', ui.msgExpanded.has(m.id));

    const route = el('div', 'msg-route');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('viewBox', '0 0 16 16');
    arrow.innerHTML = '<path d="M3 8h10M9 4l4 4-4 4"/>';
    const time = el('span', 'msg-time', ago(m.at));
    time.title = new Date(m.at).toLocaleString(t.locale);
    time.dataset.at = String(m.at);
    route.append(peerEl(m.from), arrow, peerEl(m.to), time);
    li.appendChild(route);

    if (m.summary) li.appendChild(el('div', 'msg-title', m.summary));
    else li.appendChild(el('div', 'msg-title', firstLine(m.body)));
    const body = el('div', 'msg-body', m.body);
    body.title = t('messages.expand');
    body.addEventListener('click', () => {
      if (window.getSelection().toString()) return; // selecting text, not toggling
      if (ui.msgExpanded.has(m.id)) ui.msgExpanded.delete(m.id); else ui.msgExpanded.add(m.id);
      li.classList.toggle('expanded', ui.msgExpanded.has(m.id));
    });
    li.appendChild(body);

    const state = el('span', 'msg-state', MSG_STATE[m.status] ? t(MSG_STATE[m.status]) : m.status);
    if (m.note) state.title = m.note;
    li.appendChild(state);
    return li;
  }

  function renderMessages() {
    if (!ui.msgOpen) return;
    for (const b of document.querySelectorAll('#mp-filter button')) b.classList.toggle('on', b.dataset.filter === ui.msgFilter);
    const active = ui.activeId;
    const shown = ui.messages
      .filter((m) => ui.msgFilter !== 'active' || (active && (m.from.terminalId === active || m.to.terminalId === active)))
      .slice()
      .reverse();
    dom.msgList.replaceChildren(...shown.map(messageItem));
    dom.msgEmpty.hidden = shown.length > 0;
    if (!shown.length) {
      dom.msgEmpty.textContent = t(ui.messages.length ? 'messages.emptySession' : 'messages.empty');
    }
  }

  function updateUnread() {
    dom.msgUnread.hidden = ui.msgUnread === 0;
    dom.msgUnread.textContent = ui.msgUnread > 99 ? '99+' : String(ui.msgUnread);
  }

  function setMessagesOpen(open) {
    if (open && ui.inboxOpen) setInboxOpen(false, { refocus: false }); // one side panel at a time
    ui.msgOpen = !!open;
    writePref('messagesOpen', ui.msgOpen);
    dom.msgPanel.hidden = !ui.msgOpen;
    dom.msgBtn.setAttribute('aria-pressed', String(ui.msgOpen));
    if (ui.msgOpen) {
      ui.msgUnread = 0;
      updateUnread();
      renderMessages();
    } else {
      ui.msgFresh.clear();
      focusActive();
    }
  }

  function upsertMessage(m) {
    const i = ui.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) ui.messages[i] = m;
    else {
      ui.messages.push(m);
      if (ui.messages.length > 500) ui.messages.shift();
      ui.msgFresh.add(m.id);
      if (!ui.msgOpen) { ui.msgUnread++; updateUnread(); }
    }
    renderMessages();
  }

  dom.msgBtn.addEventListener('click', () => setMessagesOpen(!ui.msgOpen));
  $('#mp-close').addEventListener('click', () => setMessagesOpen(false));
  for (const b of document.querySelectorAll('#mp-filter button')) {
    b.addEventListener('click', () => { ui.msgFilter = b.dataset.filter; writePref('messagesFilter', ui.msgFilter); renderMessages(); });
  }
  $('#mp-clear').addEventListener('click', async () => {
    if (!ui.messages.length) return;
    const ok = await confirmModal({
      title: t('messages.clearConfirmTitle'),
      message: t('messages.clearConfirm'),
      confirmLabel: t('messages.clear'),
    });
    if (ok) api.clearMessages();
  });

  dom.extToggle.addEventListener('click', () => {
    const open = dom.extToggle.getAttribute('aria-expanded') !== 'true';
    dom.extToggle.setAttribute('aria-expanded', String(open));
    dom.extList.hidden = !open;
    writePref('externalOpen', open);
  });

  // ---------------------------------------------------------------- inbox: what's waiting for you

  /**
   * What a session waits for from you, and since when: the most pressing thing, or one card per
   * question it asked you to decide. "done" (a finished turn you haven't answered) goes in a
   * folded list of its own.
   */
  function waitingFor(v) {
    if (v.status === 'exited' || v.parked) return [];
    if (guardOpen(v)) return [{ kind: 'guard', since: v.guard.since }];
    if (v.status === 'permission') return [{ kind: 'permission', since: v.statusSince }];
    if (v.status === 'input') return [{ kind: 'input', since: v.statusSince }];
    if (v.asks && v.asks.length) return v.asks.map((ask, i) => ({ kind: 'decision', since: ask.since, ask, first: i === 0 }));
    if (v.waitingSince && (v.status === 'done' || v.status === 'ready')) return [{ kind: 'done', since: v.waitingSince }];
    return [];
  }

  const INBOX_LABEL = {
    guard: 'status.guard', permission: 'status.permission', input: 'status.input', decision: 'status.decision', done: 'status.done',
  };

  function renderInbox() {
    const items = [];
    for (const e of ui.sessions.values()) for (const w of waitingFor(e.view)) items.push({ e, ...w });
    items.sort((a, b) => a.since - b.since); // stable: a session's questions keep their order
    const pressing = items.filter((x) => x.kind !== 'done');
    const done = items.filter((x) => x.kind === 'done');
    if (!ui.inboxOpen) return; // the counter in the header (updateAttention) says how many need you
    syncInboxList(dom.ibList, pressing);
    syncInboxList(dom.ibDoneList, done);
    for (const [id, c] of ui.inboxCards) if (!c.li.isConnected) ui.inboxCards.delete(id);
    dom.ibEmpty.hidden = pressing.length > 0;
    dom.ibEmpty.textContent = pressing.length ? '' : t('inbox.empty');
    dom.ibDone.hidden = done.length === 0;
    dom.ibDoneCount.textContent = String(done.length);
    const open = readPref('inboxDoneOpen', false);
    dom.ibDoneToggle.setAttribute('aria-expanded', String(open));
    dom.ibDoneList.hidden = !open;
  }

  /** Puts the cards in order, moving only those out of place (a moved textarea would lose focus). */
  function syncInboxList(list, items) {
    const nodes = items.map(inboxCard);
    nodes.forEach((n, i) => { if (list.children[i] !== n) list.insertBefore(n, list.children[i] || null); });
    while (list.children.length > nodes.length) list.lastElementChild.remove();
  }

  function inboxCard(x) {
    const v = x.e.view;
    const key = x.ask ? `${v.id}|${x.ask.key}` : v.id;
    let c = ui.inboxCards.get(key);
    if (!c || c.kind !== x.kind) {
      c = buildInboxCard(v.id, x.kind, x.ask ? x.ask.key : null, !!x.first);
      ui.inboxCards.set(key, c);
    }
    fillInboxCard(c, x);
    return c.li;
  }

  /** `askKey`: the question a decision card is about; `first`: the session's first one. */
  function buildInboxCard(id, kind, askKey, first) {
    const c = { id, kind, askKey, li: el('li', 'ib-card') };
    c.li.dataset.kind = kind;
    const head = el('div', 'ib-head');
    c.badge = el('span', 'mono');
    c.name = el('button', 'ib-name');
    c.name.addEventListener('click', () => setActive(id));
    c.time = el('span', 'ib-time');
    head.append(c.badge, c.name, c.time);
    c.label = el('div', 'ib-label');
    c.text = el('div', 'ib-text');
    c.li.append(head, c.label, c.text);

    if (kind === 'decision' || kind === 'done') {
      c.context = el('details', 'ib-context');
      const summary = el('summary', null, t('inbox.context'));
      c.ctx = el('div', 'ib-ctx');
      c.context.append(summary, c.ctx);
      c.context.addEventListener('toggle', () => { if (c.context.open) fillContext(c); });
      // A decision's message is the card the session wrote for you (context, options): open on
      // its first question (the others share it).
      c.context.open = kind === 'decision' && first;
      c.li.appendChild(c.context);
    }
    if (kind === 'decision') {
      const answer = el('div', 'ib-answer');
      c.ta = el('textarea');
      c.ta.rows = 2;
      c.ta.placeholder = t('inbox.placeholder');
      c.ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.isComposing) {
          ev.preventDefault();
          sendInboxReply(c);
        }
      });
      c.note = el('div', 'ib-note', t('inbox.hint'));
      answer.append(c.ta, c.note);
      c.li.appendChild(answer);
    }
    const actions = el('div', 'ib-actions');
    const open = el('button', 'btn-secondary', t('inbox.open'));
    open.addEventListener('click', () => setActive(id));
    actions.appendChild(open);
    if (kind === 'decision' || kind === 'done') {
      const dismiss = el('button', 'btn-secondary', t('inbox.dismiss'));
      dismiss.title = t('inbox.dismissTitle');
      dismiss.addEventListener('click', () => api.dismissWaiting(id, askKey));
      actions.appendChild(dismiss);
    }
    if (kind === 'decision') {
      c.send = el('button', 'btn-primary ib-send', t('inbox.send'));
      c.send.addEventListener('click', () => sendInboxReply(c));
      actions.appendChild(c.send);
    }
    c.li.appendChild(actions);
    return c;
  }

  function fillInboxCard(c, x) {
    const v = x.e.view;
    c.li.dataset.status = x.kind === 'guard' ? 'permission' : x.kind === 'decision' ? 'input' : v.status;
    setBadge(c.badge, v);
    c.name.textContent = v.name;
    c.name.title = v.cwd;
    c.time.textContent = ago(x.since);
    c.time.title = new Date(x.since).toLocaleString(t.locale);
    // The question's label (D5, S1…) as a mark of its own, however the session wrote it ("S1.", "D5:", "S1 —").
    const label = x.ask && x.ask.label;
    c.label.replaceChildren(t(INBOX_LABEL[x.kind]), ...(label ? [el('span', 'ib-mark', label)] : []));
    let text = '';
    if (x.kind === 'guard') text = t('inbox.guardText');
    else if (x.kind === 'permission') text = [permissionText(v.detail), t('inbox.inSession')].filter(Boolean).join(' · ');
    else if (x.kind === 'input') text = [oneLine(v.detail), t('inbox.inSession')].filter(Boolean).join(' · ');
    else if (x.kind === 'decision') text = label ? x.ask.text.replace(/^[A-Z]{1,2}\d{1,2}\s*[:.)—–-]\s*/u, '') : x.ask.text;
    else text = oneLine(v.lastReply, 240);
    if (c.text.textContent !== text) c.text.textContent = text;
    if (c.context && c.context.open) fillContext(c);
    if (c.ta) {
      // While it works your answer waits in its queue; while it starts it would get lost.
      const busy = v.status === 'busy';
      const can = busy || v.status === 'done' || v.status === 'ready';
      c.ta.disabled = !can;
      c.send.disabled = !can;
      const note = !can ? 'inbox.notNow' : busy ? 'inbox.queued' : 'inbox.hint';
      if (c.noteKey !== note) setInboxNote(c, t(note)); // "Sent." stays until the state changes
      c.noteKey = note;
    }
  }

  /**
   * The last message it got and the whole of its answer, as Markdown: what it's about, without
   * opening the session. Fetched when it changes (the view only carries the first 2000 characters).
   */
  async function fillContext(c) {
    const v = ui.sessions.get(c.id)?.view;
    if (!v) return;
    const key = `${v.lastPrompt}\u0000${v.lastReply}`;
    if (c.ctxKey === key) return;
    c.ctxKey = key;
    let ctx = null;
    try { ctx = await api.inboxContext(c.id); } catch { /* falls back to the view */ }
    if (c.ctxKey !== key) return; // changed again meanwhile
    const prompt = ctx ? ctx.prompt : v.lastPrompt;
    const reply = ctx ? ctx.reply : v.lastReply;
    const parts = [];
    if (prompt) parts.push(el('span', 'ib-ctx-who', t('inbox.you')), mdBlock(prompt));
    if (reply) parts.push(el('span', 'ib-ctx-who', t('inbox.it')), mdBlock(reply));
    c.ctx.replaceChildren(...parts);
  }

  function mdBlock(text) {
    const box = el('div', 'ib-ctx-text md');
    box.appendChild(renderMarkdown(text));
    return box;
  }

  // ---- a small Markdown renderer: what sessions write (headings, lists, tables, code, quotes,
  // bold, links). It builds DOM nodes from the text, never HTML, so nothing in it can run.

  const MD_LIST = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;
  const MD_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const MD_BLOCK_START = /^\s*(```|~~~|#{1,6}\s|>|([-*+•]|\d+[.)])\s+)/;

  function renderMarkdown(src) {
    const frag = document.createDocumentFragment();
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
    const isTable = (k) => /^\s*\|/.test(lines[k] || '') && MD_TABLE_SEP.test(lines[k + 1] || '');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = /^\s*(```|~~~)/.exec(line);
      if (fence) {
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
        i++;
        frag.appendChild(el('pre', 'md-code', buf.join('\n')));
        continue;
      }
      if (isTable(i)) {
        const table = el('table', 'md-table');
        const head = el('tr');
        for (const x of cells(line)) { const th = el('th'); th.appendChild(mdInline(x)); head.appendChild(th); }
        const thead = el('thead');
        thead.appendChild(head);
        const tbody = el('tbody');
        i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          const tr = el('tr');
          for (const x of cells(lines[i])) { const td = el('td'); td.appendChild(mdInline(x)); tr.appendChild(td); }
          tbody.appendChild(tr);
          i++;
        }
        table.append(thead, tbody);
        const wrap = el('div', 'md-table-wrap');
        wrap.appendChild(table);
        frag.appendChild(wrap);
        continue;
      }
      const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (h) {
        const n = el('div', 'md-h');
        n.appendChild(mdInline(h[1].replace(/\s+#+\s*$/, '')));
        frag.appendChild(n);
        i++;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        const q = el('blockquote', 'md-quote');
        q.appendChild(renderMarkdown(buf.join('\n')));
        frag.appendChild(q);
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { frag.appendChild(el('hr', 'md-hr')); i++; continue; }
      const first = MD_LIST.exec(line);
      if (first) {
        const ordered = /\d/.test(first[2]);
        const list = el(ordered ? 'ol' : 'ul', 'md-list');
        const start = /^(\d+)/.exec(first[2]);
        if (start && start[1] !== '1') list.start = Number(start[1]);
        while (i < lines.length) {
          const m = MD_LIST.exec(lines[i]);
          // Bullets after numbers (or the other way round) start another list, unless nested.
          if (m && m[1].length < 2 && /\d/.test(m[2]) !== ordered) break;
          if (m) {
            const item = el('li');
            if (m[1].length >= 2) item.classList.add('md-sub');
            item.appendChild(mdInline(m[3]));
            list.appendChild(item);
            i++;
          } else if (/^\s{2,}\S/.test(lines[i]) && list.lastChild) {
            list.lastChild.append(el('br'), mdInline(lines[i].trim())); // an item that goes on
            i++;
          } else {
            break;
          }
        }
        frag.appendChild(list);
        continue;
      }
      const p = el('p', 'md-p');
      let n = 0;
      while (i < lines.length && lines[i].trim() && (n === 0 || (!MD_BLOCK_START.test(lines[i]) && !isTable(i)))) {
        if (n++) p.appendChild(el('br'));
        p.appendChild(mdInline(lines[i++].trim()));
      }
      frag.appendChild(p);
    }
    return frag;
  }

  const MD_INLINE = /(`+)([^`]+?)\1|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s](?:[^*]*?[^*\s])?)\*|(?<![\p{L}\p{N}])_([^_\s](?:[^_]*?[^_\s])?)_(?![\p{L}\p{N}])|\[([^\]]+)\]\(([^)\s]+)\)/gu;

  function mdInline(text) {
    const frag = document.createDocumentFragment();
    const re = new RegExp(MD_INLINE.source, MD_INLINE.flags);
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[2] !== undefined) frag.appendChild(el('code', 'md-inline', m[2]));
      else if (m[3] !== undefined || m[4] !== undefined) { const b = el('strong'); b.appendChild(mdInline(m[3] ?? m[4])); frag.appendChild(b); }
      else if (m[5] !== undefined || m[6] !== undefined) { const e = el('em'); e.appendChild(mdInline(m[5] ?? m[6])); frag.appendChild(e); }
      else {
        const url = m[8];
        const a = el('a', 'md-link');
        a.appendChild(mdInline(m[7]));
        a.title = url;
        if (/^https?:\/\//i.test(url)) {
          a.href = '#';
          a.addEventListener('click', (ev) => { ev.preventDefault(); api.openExternal(url); });
        }
        frag.appendChild(a);
      }
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function setInboxNote(c, text, err = false) {
    c.note.textContent = text;
    c.note.classList.toggle('err', err);
  }

  async function sendInboxReply(c) {
    const text = c.ta.value.trim();
    if (!text || c.send.disabled) return;
    c.send.disabled = true;
    let r = null;
    try { r = await api.replyTo(c.id, text, c.askKey); } catch { /* reported below */ }
    if (r && r.ok) {
      c.ta.value = '';
      setInboxNote(c, t('inbox.sent'));
    } else {
      c.send.disabled = false;
      setInboxNote(c, (r && r.error) || t('inbox.failed'), true);
    }
  }

  function setInboxOpen(open, { refocus = true } = {}) {
    if (open && ui.msgOpen) setMessagesOpen(false); // one side panel at a time
    ui.inboxOpen = !!open;
    writePref('inboxOpen', ui.inboxOpen);
    dom.inboxPanel.hidden = !ui.inboxOpen;
    dom.inboxBtn.setAttribute('aria-pressed', String(ui.inboxOpen));
    if (ui.inboxOpen) {
      renderInbox();
      layout();
    } else {
      layout();
      if (refocus) focusActive();
    }
  }

  dom.inboxBtn.addEventListener('click', () => setInboxOpen(!ui.inboxOpen));
  dom.attn.addEventListener('click', () => setInboxOpen(true));
  $('#ib-close').addEventListener('click', () => setInboxOpen(false));
  dom.ibDoneToggle.addEventListener('click', () => {
    writePref('inboxDoneOpen', !readPref('inboxDoneOpen', false));
    renderInbox();
  });

  // ---------------------------------------------------------------- wiring

  $('#btn-new').addEventListener('click', openNewSession);
  $('#welcome-new').addEventListener('click', openNewSession);
  $('#btn-help').addEventListener('click', openHelp);
  $('#btn-restart-app').addEventListener('click', openWindDown);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-switch').addEventListener('click', openSwitcher);
  for (const b of document.querySelectorAll('.seg button[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
  $('#tb-restart').addEventListener('click', () => ui.activeId && confirmRestart(ui.activeId));
  $('#tb-plugins').addEventListener('click', openPlugins);
  $('#tb-close').addEventListener('click', () => ui.activeId && confirmClose(ui.activeId));
  dom.tbName.addEventListener('dblclick', startRename);
  dom.tbPath.addEventListener('click', () => { const e = ui.sessions.get(ui.activeId); if (e) api.openFolder(e.view.cwd); });

  api.onData((id, data) => {
    if (!ui.ready) return; // already included in the init snapshot
    const e = ui.sessions.get(id);
    if (e) e.term.write(data);
    else {
      if (!ui.pendingData.has(id)) ui.pendingData.set(id, []);
      ui.pendingData.get(id).push(data);
    }
  });
  api.onReset((id) => {
    const e = ui.sessions.get(id);
    if (!e) return;
    e.term.reset();
    e.lastSize = null;
    requestAnimationFrame(() => fitEntry(e));
  });
  api.onUpdate((view) => { if (ui.ready) updateSession(view); });
  api.onRemoved((id) => { if (ui.ready) removeSession(id); });
  api.onFocusRequest((id) => setActive(id));
  api.onExternal((list) => renderExternal(list || []));
  api.onMessage((m) => { if (ui.ready) upsertMessage(m); });
  api.onMessagesCleared(() => { ui.messages = []; ui.msgUnread = 0; updateUnread(); renderMessages(); });
  // Before the UAC prompt for an administrator session: say it's coming (see admin.js, elevate()).
  api.onAdminNotice((n) => {
    let box = document.getElementById('admin-notice');
    if (!n) { if (box) box.remove(); return; }
    if (!box) {
      box = el('div', 'admin-notice');
      box.id = 'admin-notice';
      box.setAttribute('role', 'alert');
      document.body.appendChild(box);
    }
    box.textContent = n.text;
  });

  setInterval(() => {
    for (const e of ui.sessions.values()) $('.sess-time', e.item).textContent = ago(e.view.statusSince);
    if (ui.msgOpen) for (const n of dom.msgList.querySelectorAll('.msg-time')) n.textContent = ago(Number(n.dataset.at));
    renderInbox(); // its times
  }, 30000);

  (async () => {
    const data = await api.init();
    ui.windowsBuild = data.windowsBuild || 0;
    if (data.terminalFont) {
      ui.wtFont = { family: String(data.terminalFont.family).replace(/["\\]/g, ''), sizePx: data.terminalFont.sizePx };
    }
    if (data.settings) ui.settings = data.settings;
    if (data.settingsLimits) ui.settingsLimits = data.settingsLimits;
    // Ctrl+= / Ctrl+- used to keep the size in localStorage: move it to the settings file.
    const oldSize = readPref('fontSize', null);
    if (oldSize != null) {
      try { localStorage.removeItem('ccsm.fontSize'); } catch { /* storage unavailable */ }
      if (ui.settings.terminal.fontSize == null && Number.isFinite(oldSize)) {
        ui.settings = await api.updateSettings({ terminal: { fontSize: clampFontSize(oldSize) } });
      }
    }
    applySettings();
    ui.view = data.view === 'grid' ? 'grid' : 'single';
    ui.groups = Array.isArray(data.groups) ? data.groups : [];
    for (const v of data.sessions) addSession(v);
    for (const [id, buf] of Object.entries(data.buffers || {})) {
      const e = ui.sessions.get(id);
      if (e && buf) e.term.write(buf);
    }
    ui.ready = true;
    updateWind(); // a reload in the middle of winding down
    $('#welcome-warn').hidden = !!data.claudeFound;
    if (readPref('externalOpen', false)) { dom.extToggle.setAttribute('aria-expanded', 'true'); dom.extList.hidden = false; }
    renderExternal(data.external || []);
    ui.messages = Array.isArray(data.messages) ? data.messages : [];
    setMessagesOpen(ui.msgOpen);
    if (ui.inboxOpen) setInboxOpen(true, { refocus: false });
    layout();
    const first = data.activeId && ui.sessions.has(data.activeId) ? data.activeId : ui.order[0];
    if (first) setActive(first);
    updateAttention();
    // Back from a change of language: Settings was open.
    let reopen = false;
    try { reopen = !!sessionStorage.getItem('ccsm.reopenSettings'); sessionStorage.removeItem('ccsm.reopenSettings'); } catch { /* storage unavailable */ }
    if (reopen) requestAnimationFrame(openSettings); // after setActive() has focused the terminal
    // So Settings opens with the font list ready (reading it takes a couple of seconds).
    setTimeout(() => loadMonospaceFonts().catch(() => {}), 4000);
  })();
})();
