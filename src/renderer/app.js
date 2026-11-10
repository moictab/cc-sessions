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
    windowAttended: true,
    messages: [], // newest last, like the main process
    msgOpen: readPref('messagesOpen', false),
    msgFilter: readPref('messagesFilter', 'all'),
    msgUnread: 0,
    msgFresh: new Set(),
    msgExpanded: new Set(),
  };

  const dom = {
    list: $('#session-list'),
    stage: $('#stage'),
    topbar: $('#topbar'),
    welcome: $('#welcome'),
    attn: $('#attn-count'),
    modalRoot: $('#modal-root'),
    tbDot: $('#tb-dot'),
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

  function describe(v) {
    if (isInterrupted(v)) return { label: t('status.interrupted'), text: t('status.interruptedText') };
    switch (v.status) {
      case 'busy': return { label: t('status.busy'), text: v.lastPrompt ? t('common.quote', { text: oneLine(v.lastPrompt, 120) }) : '' };
      case 'permission': return { label: t('status.permission'), text: permissionText(v.detail) };
      case 'input': return { label: t('status.input'), text: oneLine(v.detail) };
      case 'done': return { label: t('status.done'), text: oneLine(v.lastReply) };
      case 'ready': return { label: t('status.ready'), text: v.lastPrompt ? t('status.lastPrompt', { text: oneLine(v.lastPrompt, 100) }) : '' };
      case 'exited': return { label: t('status.exited'), text: oneLine(v.detail) };
      default: return { label: t('status.starting'), text: '' };
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
    dom.list.appendChild(item);
    dom.stage.appendChild(pane);

    term.open($('.term-host', pane));
    term.onData((data) => api.write(view.id, data));
    term.attachCustomKeyEventHandler((ev) => terminalKey(ev, entry));

    const pending = ui.pendingData.get(view.id);
    if (pending) { term.write(pending.join('')); ui.pendingData.delete(view.id); }

    render(entry);
    renumber();
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
    e.view = view;
    if (renamed && ui.msgOpen) renderMessages();
    if (view.status !== prev && ATTENTION.has(view.status) && !(view.id === ui.activeId && ui.windowAttended)) {
      e.unseen = true;
    }
    if (!ATTENTION.has(view.status)) e.unseen = false;
    render(e);
    updateAttention();
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
    if (ui.activeId === id) {
      ui.activeId = null;
      const next = ui.order[Math.min(idx, ui.order.length - 1)];
      if (next) setActive(next);
      else api.setUiState({ activeId: null });
    }
    renumber();
    layout();
    updateAttention();
  }

  function buildItem(id) {
    const li = el('li', 'sess');
    li.dataset.id = id;
    li.draggable = true;
    li.appendChild(el('span', 'dot'));
    const main = el('div', 'sess-main');
    const row = el('div', 'sess-row');
    row.append(el('span', 'sess-name'), el('span', 'sess-time'));
    main.append(row, el('div', 'sess-path'), el('div', 'sess-detail'));
    li.append(main, el('kbd', 'sess-key'));

    li.addEventListener('click', () => setActive(id));
    li.addEventListener('dblclick', () => { setActive(id); startRename(); });
    li.addEventListener('dragstart', (ev) => {
      ui.dragId = id;
      li.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      ui.dragId = null;
      for (const x of dom.list.children) x.classList.remove('dragging', 'drop-before', 'drop-after');
    });
    li.addEventListener('dragover', (ev) => {
      if (!ui.dragId || ui.dragId === id) return;
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
      const dragged = ui.dragId;
      if (!dragged || dragged === id) return;
      const order = ui.order.filter((x) => x !== dragged);
      order.splice(order.indexOf(id) + (after ? 1 : 0), 0, dragged);
      applyOrder(order);
    });
    return li;
  }

  function buildPane(id) {
    const pane = el('section', 'pane');
    pane.dataset.id = id;

    const head = el('div', 'pane-head');
    head.append(el('span', 'dot'), el('span', 'pane-name'), el('span', 'pane-state'));
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

    e.item.dataset.status = v.status;
    e.item.classList.toggle('unseen', e.unseen);
    e.item.classList.toggle('interrupted', interrupted);
    e.pane.classList.toggle('interrupted', interrupted);
    e.item.title = v.cwd;
    $('.sess-name', e.item).textContent = v.name;
    $('.sess-time', e.item).textContent = ago(v.statusSince);
    $('.sess-path', e.item).textContent = shortPath(v.cwd);
    $('.sess-detail', e.item).replaceChildren(stateLine(v));

    e.pane.dataset.status = v.status;
    $('.pane-head .dot', e.pane).dataset.status = v.status;
    $('.pane-name', e.pane).textContent = v.name;
    $('.pane-state', e.pane).replaceChildren(stateLine(v));

    const banner = $('.pane-banner', e.pane);
    banner.hidden = !(v.interrupted && v.status !== 'exited');
    $('.pane-banner .btn-primary', e.pane).disabled = !(v.status === 'ready' || v.status === 'done');

    const exited = $('.pane-exited', e.pane);
    exited.hidden = v.status !== 'exited';
    $('.msg', exited).textContent = v.detail ? t('status.endedDetail', { detail: v.detail }) : t('status.ended');

    if (v.id === ui.activeId) renderTopbar();
  }

  function renderTopbar() {
    const e = ui.sessions.get(ui.activeId);
    dom.topbar.hidden = !e;
    if (!e) return;
    const v = e.view;
    dom.tbDot.dataset.status = v.status;
    dom.tbDot.classList.toggle('interrupted', isInterrupted(v));
    if (!dom.tbName.querySelector('input')) dom.tbName.textContent = v.name;
    dom.tbPath.textContent = shortPath(v.cwd);
    dom.tbPath.title = t('topbar.openPath', { path: v.cwd });
    dom.tbStatus.dataset.status = v.status;
    dom.tbStatus.replaceChildren(stateLine(v, { long: true }));
  }

  function renumber() {
    ui.order.forEach((id, i) => {
      const e = ui.sessions.get(id);
      const key = $('.sess-key', e.item);
      key.textContent = i < 9 ? String(i + 1) : '';
      key.hidden = i >= 9;
    });
  }

  function applyOrder(order) {
    ui.order = order;
    for (const id of order) {
      const e = ui.sessions.get(id);
      dom.list.appendChild(e.item);
      dom.stage.appendChild(e.pane);
    }
    renumber();
    api.reorder(order);
    fitVisible();
  }

  function updateAttention() {
    let n = 0;
    for (const e of ui.sessions.values()) {
      if (e.view.status === 'permission' || e.view.status === 'input' || e.unseen) n++;
    }
    dom.attn.hidden = n === 0;
    dom.attn.textContent = String(n);
    document.title = n ? `(${n}) CC Sessions` : 'CC Sessions';
  }

  // ---------------------------------------------------------------- focus & layout

  function setActive(id, { focus = true } = {}) {
    const e = ui.sessions.get(id);
    if (!e) return;
    ui.activeId = id;
    for (const x of ui.sessions.values()) {
      const on = x.id === id;
      x.pane.classList.toggle('active', on);
      x.item.classList.toggle('active', on);
    }
    if (e.unseen) { e.unseen = false; render(e); }
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
    if (!ui.order.length) return;
    const i = ui.order.indexOf(ui.activeId);
    setActive(ui.order[(i + step + ui.order.length) % ui.order.length]);
  }

  /** Next session that needs you: permission > question > finished, starting after the current one. */
  function jumpToAttention() {
    const rank = (e) => (e.view.status === 'permission' ? 0 : e.view.status === 'input' ? 1 : e.unseen || e.view.status === 'done' ? 2 : 9);
    const start = Math.max(0, ui.order.indexOf(ui.activeId));
    const rotated = [...ui.order.slice(start + 1), ...ui.order.slice(0, start + 1)].map((id) => ui.sessions.get(id));
    let best = null;
    for (const e of rotated) if (rank(e) < 9 && (!best || rank(e) < rank(best))) best = e;
    if (best) setActive(best.id);
  }

  window.addEventListener('keydown', (ev) => {
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
    else if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && /^[1-9]$/.test(k)) { const id = ui.order[Number(k) - 1]; if (id) setActive(id); }
    else if (ev.ctrlKey && k === 'Tab') cycle(ev.shiftKey ? -1 : 1);
    else if (ev.ctrlKey && !ev.altKey && (k === '+' || k === '=')) setFontSize(ui.font.size + 1);
    else if (ev.ctrlKey && !ev.altKey && k === '-') setFontSize(ui.font.size - 1);
    else if (ev.ctrlKey && !ev.altKey && k === '0') setFontSize(null);
    else if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && k === ',') openSettings();
    else if (k === 'F12') api.toggleDevtools();
    else handled = false;
    if (handled) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);

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

  function openHelp() {
    const modal = modalShell('help-modal', t('help.title'));
    const body = el('div', 'modal-body');
    const dl = el('dl', 'keys');
    const rows = [
      ['Ctrl+Shift+N', t('help.new')],
      ['Ctrl+Shift+J', t('help.attention')],
      ['Ctrl+1 … 9', t('help.goTo')],
      ['Ctrl+Tab', t('help.cycle')],
      ['Ctrl+Shift+G', t('help.view')],
      ['Ctrl+Shift+M', t('help.messages')],
      ['Ctrl+Shift+W', t('help.remove')],
      ['Ctrl+C / Ctrl+V', t('help.copyPaste')],
      [t('help.rightClickKey'), t('help.rightClick')],
      ['Shift+Enter', t('help.newline')],
      ['Ctrl+= / Ctrl+- / Ctrl+0', t('help.fontSize')],
      ['Ctrl+,', t('help.settings')],
      [t('help.renameKey'), t('help.rename')],
      [t('help.reorderKey'), t('help.reorder')],
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

    body.append(fontField, sizeField, preview, uiSection, langField, animRow);
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
      const view = await api.createSession({ cwd: current.cwd, name });
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
      const view = await api.createSession({ cwd: current.cwd, name: uniqueName(c.customTitle || basename(current.cwd)), resumeId: c.id });
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

  // ---------------------------------------------------------------- wiring

  $('#btn-new').addEventListener('click', openNewSession);
  $('#welcome-new').addEventListener('click', openNewSession);
  $('#btn-help').addEventListener('click', openHelp);
  $('#btn-settings').addEventListener('click', openSettings);
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

  setInterval(() => {
    for (const e of ui.sessions.values()) $('.sess-time', e.item).textContent = ago(e.view.statusSince);
    if (ui.msgOpen) for (const n of dom.msgList.querySelectorAll('.msg-time')) n.textContent = ago(Number(n.dataset.at));
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
    for (const v of data.sessions) addSession(v);
    for (const [id, buf] of Object.entries(data.buffers || {})) {
      const e = ui.sessions.get(id);
      if (e && buf) e.term.write(buf);
    }
    ui.ready = true;
    $('#welcome-warn').hidden = !!data.claudeFound;
    if (readPref('externalOpen', false)) { dom.extToggle.setAttribute('aria-expanded', 'true'); dom.extList.hidden = false; }
    renderExternal(data.external || []);
    ui.messages = Array.isArray(data.messages) ? data.messages : [];
    setMessagesOpen(ui.msgOpen);
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
