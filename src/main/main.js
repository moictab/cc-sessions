'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, Notification, shell, Menu, screen, clipboard } = require('electron');
const { Store } = require('./store');
const { startHookServer } = require('./hook-server');
const { SessionManager } = require('./sessions');
const { Registry } = require('./registry');
const { resolveClaude } = require('./claude-env');
const { listProjects, listConversations } = require('./claude-history');
const { MessageLog, socketKey } = require('./messages');
const { readTerminalFont } = require('./terminal-font');
const { Settings, LIMITS: SETTINGS_LIMITS } = require('./settings');
const { createMcpHandler } = require('./mcp');
const { restartNote } = require('./restart-note');
const i18n = require('../shared/i18n');
const { userDataDir } = require('./user-data');

// How Windows identifies the app (taskbar grouping, notifications, Start menu).
const AUMID = 'com.moictab.ccsessions';
// The COM class Windows calls when a toast is clicked. It must match the one on the Start
// menu shortcut; Electron would otherwise pick a random one on every run.
const TOAST_CLSID = '{BCF46518-8493-477A-95C6-86BB944559F2}';
const SHORTCUT_NAME = 'CC Sessions.lnk';
const OLD_SHORTCUT_NAMES = ['CC Sessions (dev).lnk']; // from earlier versions
const ICON_ICO = path.join(__dirname, '..', '..', 'assets', 'icon.ico');
const ICON_PNG = path.join(__dirname, '..', '..', 'assets', 'icon.png');

// A fixed state folder, whatever the product name. CC_SESSIONS_USER_DATA lets tests (or a
// second profile) use a separate one.
app.setPath('userData', process.env.CC_SESSIONS_USER_DATA || userDataDir(app.getPath('appData')));
app.setAppUserModelId(AUMID);
if (process.platform === 'win32') app.setToastActivatorCLSID(TOAST_CLSID);

let win = null;
let store = null;
let settings = null;
let manager = null;
let registry = null;
let hooks = null;
let messages = null;
let activeId = null;
let allowClose = false;
const liveNotifications = new Set();

/** Translates into the language chosen in Settings right now (English until they're loaded). */
function t(key, vars) {
  return i18n.create(settings ? settings.get().ui.language : i18n.DEFAULT_LANGUAGE)(key, vars);
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function externalSessions() {
  if (!registry || !manager) return [];
  return registry.entries
    .filter((e) => e.kind !== 'background' && !manager.ownsRegistryEntry(e))
    .map((e) => ({ pid: e.pid, sessionId: e.sessionId, cwd: e.cwd, name: e.name, status: e.status }));
}

/**
 * Turns a SendMessage address (a peer name, "name [ref]" or "uds:<socket>") into a display
 * name plus the id of our terminal when the session lives in the app.
 */
function resolvePeer(ref) {
  const raw = String(ref || '').trim();
  if (!raw) return { name: '?', terminalId: null };
  const sock = socketKey(raw);
  if (sock) {
    const e = registry && registry.entries.find((x) => socketKey(x.socket) === sock);
    if (!e) return { name: t('session.closedPeer'), terminalId: null };
    const own = manager.ownsRegistryEntry(e);
    return { name: e.name || '?', terminalId: own ? own.id : null };
  }
  const name = raw.replace(/\s*\[[0-9a-f]+\]$/i, '');
  const own = manager.findByName(name);
  return { name, terminalId: own ? own.id : null };
}

function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.toString());
  } catch { /* not a URL */ }
}

const ATTENTION_KEY = {
  permission: 'notify.permission',
  input: 'notify.input',
  done: 'notify.done',
};

// isFocused() alone stays true for a minimized window on Windows.
function windowAttended() {
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
}

function notifyAttention(view) {
  if (!win || win.isDestroyed() || windowAttended()) return; // the sidebar already shows it
  win.flashFrame(true);
  if (!Notification.isSupported()) return;
  const body = view.detail || (view.status === 'done' && view.lastReply) || view.cwd;
  const n = new Notification({
    title: `${view.name} · ${ATTENTION_KEY[view.status] ? t(ATTENTION_KEY[view.status]) : view.status}`,
    body: String(body).replace(/\s+/g, ' ').slice(0, 180),
    icon: ICON_PNG,
  });
  liveNotifications.add(n);
  const forget = () => liveNotifications.delete(n);
  n.on('click', () => {
    forget();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    send('ui:focus', view.id);
  });
  n.on('close', forget);
  n.on('failed', (_e, err) => { forget(); console.error('[notification] failed:', err); });
  n.on('show', fixToastActivator);
  n.show();
}

/**
 * On the first notification of each run, Electron registers the COM class Windows starts when
 * a toast is clicked after the app has closed, with the bare exe as its command: electron.exe
 * without our folder, which would open Electron's default window. So we add the folder.
 * Electron writes the key twice, the second time just after the toast shows, hence the delay.
 */
let toastActivatorTimer = null;
function fixToastActivator() {
  if (process.platform !== 'win32' || toastActivatorTimer) return;
  toastActivatorTimer = setTimeout(() => {
    toastActivatorTimer = null;
    const key = `HKCU\\Software\\Classes\\CLSID\\${TOAST_CLSID}\\LocalServer32`;
    const command = `"${process.execPath}" "${app.getAppPath()}"`;
    execFile('reg.exe', ['add', key, '/ve', '/d', command, '/f'], { windowsHide: true }, (err) => {
      if (err) console.error('[notification] could not register the toast activator', err);
    });
  }, 2000);
}

function readShortcut(lnk) {
  try { return shell.readShortcutLink(lnk); } catch { return null; }
}

const sameText = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** Writes the shortcut unless it already has every field in `wanted`. Returns true if written. */
function writeShortcut(lnk, wanted) {
  const current = readShortcut(lnk);
  if (current && Object.keys(wanted).every((k) => sameText(current[k], wanted[k]))) return false;
  if (current) fs.rmSync(lnk, { force: true }); // 'replace' fails on a hidden file
  if (!shell.writeShortcutLink(lnk, 'create', wanted)) throw new Error(`could not write ${lnk}`);
  return true;
}

/**
 * Windows only shows toasts from an app with a Start menu shortcut carrying its
 * AppUserModelID, and it takes the app's name and icon from that shortcut.
 *
 * The first time an app shows a notification, Electron writes its own shortcut to Start
 * Menu\Programs, named after the exe's product name: "Electron.lnk". It does this even when
 * another shortcut already carries the same ID (it only rewrites the file if the ID is
 * different), and the Start menu would then list the app as "Electron". So we write that
 * file ourselves, already valid so Electron leaves it alone, and hidden so the Start menu
 * ignores it.
 */
function ensureStartMenuShortcuts() {
  if (process.platform !== 'win32' || process.env.CC_SESSIONS_NO_SHORTCUT) return;
  const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const ids = { target: process.execPath, appUserModelId: AUMID, toastActivatorClsid: TOAST_CLSID };
  try {
    const appDir = app.getAppPath();
    for (const name of OLD_SHORTCUT_NAMES) {
      const old = path.join(dir, name);
      const current = readShortcut(old);
      if (current && sameText(current.target, process.execPath)) fs.rmSync(old, { force: true });
    }
    writeShortcut(path.join(dir, SHORTCUT_NAME), {
      ...ids,
      args: `"${appDir}"`,
      cwd: appDir,
      icon: ICON_ICO,
      iconIndex: 0,
      description: t('app.description'),
    });
    const electronLnk = path.join(dir, 'Electron.lnk');
    writeShortcut(electronLnk, ids);
    execFile('attrib.exe', ['+h', electronLnk], { windowsHide: true }, (err) => {
      if (err) console.error('[shortcut] could not hide Electron.lnk', err);
    });
  } catch (err) {
    console.error('[shortcut] could not set up the Start menu shortcut', err);
  }
}

function visibleBounds(b) {
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.x)) return null;
  const ok = screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width - 80 && b.x + b.width > w.x + 80 && b.y >= w.y - 20 && b.y < w.y + w.height - 80);
  return ok ? b : null;
}

function createWindow() {
  const b = visibleBounds(store.state.bounds);
  win = new BrowserWindow({
    width: b ? b.width : 1440,
    height: b ? b.height : 900,
    x: b ? b.x : undefined,
    y: b ? b.y : undefined,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#0e1014',
    title: 'CC Sessions',
    icon: ICON_ICO,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (store.state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('focus', () => win.flashFrame(false));
  for (const ev of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide']) {
    win.on(ev, () => setImmediate(() => send('window:attended', windowAttended())));
  }
  win.on('close', onClose);
  win.on('session-end', () => saveAll()); // Windows logoff/shutdown
}

function saveAll() {
  const patch = { sessions: manager.snapshot() };
  if (win && !win.isDestroyed()) {
    patch.bounds = win.getNormalBounds();
    patch.maximized = win.isMaximized();
  }
  store.update(patch);
  store.saveNow();
  if (messages) messages.saveNow();
}

async function onClose(e) {
  if (allowClose) return;
  e.preventDefault();
  const working = manager.list().filter((s) => s.status === 'busy');
  if (working.length) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [t('quit.closeAnyway'), t('common.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'CC Sessions',
      message: working.length === 1 ? t('quit.workingOne') : t('quit.workingMany', { n: working.length }),
      detail: working.map((s) => '• ' + s.name).join('\n') + '\n\n' + t('quit.detail'),
    });
    if (response !== 0) return;
  }
  manager.markInterrupted();
  saveAll();
  allowClose = true; // from here on we're quitting (second-instance won't bring the window back)
  win.hide(); // closing takes a moment: wait for the terminals out of sight
  registry.stop();
  await manager.killAll();
  startExitWatchdog();
  if (!win.isDestroyed()) win.close();
}

/**
 * Last resort: a tiny separate process that force-closes this one if it's still running
 * 10 s after we started quitting. An earlier instance once stayed alive with no window after
 * closing, and a hang in native teardown can't be caught from JavaScript. It only kills a
 * process that started before the watchdog did, so a reused PID is never touched.
 * After a normal exit it simply finds nothing to kill and ends. Not detached: detached and
 * without a console, PowerShell doesn't even run.
 */
function startExitWatchdog() {
  if (process.platform !== 'win32') return;
  const pid = process.pid;
  const name = path.parse(process.execPath).name;
  const script =
    `$t = Get-Date; Start-Sleep -Seconds 10; ` +
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
    `if ($p -and $p.ProcessName -eq '${name.replace(/'/g, "''")}' -and $p.StartTime -lt $t) { Stop-Process -Id ${pid} -Force }`;
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { stdio: 'ignore', windowsHide: true }).unref();
  } catch (err) {
    console.error('[quit] could not start the exit watchdog', err);
  }
}

function registerIpc() {
  ipcMain.handle('init', () => ({
    sessions: manager.list(),
    buffers: manager.buffers(),
    activeId: store.state.activeId,
    view: store.state.view,
    claudeFound: !!manager.claudePath,
    windowsBuild: Number(os.release().split('.')[2]) || 0,
    external: externalSessions(),
    messages: messages.list(),
    terminalFont: readTerminalFont(),
    settings: settings.get(),
    settingsLimits: SETTINGS_LIMITS,
    groups: Array.isArray(store.state.groups) ? store.state.groups : [],
  }));
  ipcMain.handle('messages:clear', () => messages.clear());
  ipcMain.handle('settings:update', (_e, patch) => settings.update(patch));
  // Synchronous so the page can put up its text in the right language before it first paints.
  ipcMain.on('settings:language', (e) => { e.returnValue = settings.get().ui.language; });

  ipcMain.handle('session:create', (_e, opts) => manager.create(opts || {}));
  ipcMain.handle('session:restart', (_e, id, opts) =>
    manager.restart(id, { note: opts && opts.notify ? restartNote(t, { bySession: false }) : '' }));
  ipcMain.handle('session:plugins', (_e, id) => manager.pluginState(id));
  ipcMain.handle('session:set-plugins', (_e, id, changes, opts) =>
    manager.setPlugins(id, changes, { by: 'user', notify: !!(opts && opts.notify) }));
  ipcMain.handle('session:cancel-restart', (_e, id) => manager.cancelPendingRestart(id));
  ipcMain.handle('session:close', (_e, id) => manager.remove(id));
  ipcMain.handle('session:rename', (_e, id, name) => manager.rename(id, name));
  ipcMain.handle('session:clear-interrupted', (_e, id) => manager.clearInterrupted(id));
  ipcMain.on('pty:write', (_e, id, data) => manager.write(id, data));
  ipcMain.on('pty:resize', (_e, id, cols, rows) => manager.resize(id, cols, rows));

  ipcMain.on('ui:state', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return;
    const keep = {};
    if ('activeId' in patch) { activeId = patch.activeId; keep.activeId = patch.activeId; }
    if (patch.view === 'single' || patch.view === 'grid') keep.view = patch.view;
    store.update(keep);
  });
  ipcMain.on('ui:reorder', (_e, ids) => manager.reorder(ids));
  // Sidebar groups, in order: [{ id, name, collapsed }]. Sessions point at them by id.
  ipcMain.on('ui:groups', (_e, groups) => {
    if (!Array.isArray(groups)) return;
    const clean = groups.slice(0, 50)
      .filter((g) => g && typeof g.id === 'string' && g.id && typeof g.name === 'string')
      .map((g) => ({ id: g.id.slice(0, 64), name: g.name.trim().slice(0, 60) || '?', collapsed: !!g.collapsed }));
    store.update({ groups: clean });
  });
  ipcMain.handle('session:set-meta', (_e, id, patch) => manager.setMeta(id, patch));
  ipcMain.on('ui:devtools', () => win.webContents.toggleDevTools());
  // After a change of language. From here because 'will-navigate' (below in createWindow) also
  // blocks a reload started by the page; the terminals come back through 'init'.
  ipcMain.on('ui:reload', () => { if (win && !win.isDestroyed()) win.webContents.reload(); });

  ipcMain.handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: t('new.folderDialog'), properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('history:projects', () => listProjects());
  ipcMain.handle('history:conversations', async (_e, cwd) => {
    const convs = await listConversations(cwd);
    const external = externalSessions();
    return convs.map((c) => {
      const here = manager.list().find((s) => s.claudeSessionId === c.id);
      const elsewhere = external.find((x) => x.sessionId === c.id);
      return { ...c, openHere: here ? here.id : null, openElsewhere: elsewhere ? { pid: elsewhere.pid, name: elsewhere.name } : null };
    });
  });

  ipcMain.handle('shell:open-folder', (_e, dir) => {
    // Folders only: shell.openPath would also open (that is, run) a file.
    try { if (typeof dir === 'string' && fs.statSync(dir).isDirectory()) return shell.openPath(dir); } catch { /* gone */ }
    return null;
  });
  ipcMain.on('shell:open-external', (_e, url) => openExternalSafe(url));
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.on('clipboard:write', (_e, text) => { if (typeof text === 'string') clipboard.writeText(text); });
}

async function boot() {
  Menu.setApplicationMenu(null);
  settings = new Settings(app.getPath('userData')); // first: the shortcut's description is translated
  ensureStartMenuShortcuts();
  store = new Store(app.getPath('userData'));
  const hookLog = process.env.CC_SESSIONS_HOOK_LOG; // debugging aid: dump every hook payload
  let mcp = null;
  hooks = await startHookServer((terminalId, payload) => {
    if (hookLog) {
      try { fs.appendFileSync(hookLog, JSON.stringify({ at: Date.now(), terminalId, payload }) + '\n'); } catch { /* ignore */ }
    }
    if (manager) manager.handleHook(terminalId, payload);
    if (messages) messages.handleHook(terminalId, payload);
  }, { onMcp: (terminalId, msg) => (mcp ? mcp(terminalId, msg) : null) });
  manager = new SessionManager({
    claudePath: resolveClaude(),
    hooks,
    settingsDir: path.join(app.getPath('userData'), 'session-settings'),
    t,
  });
  mcp = createMcpHandler({ manager, version: app.getVersion() });
  messages = new MessageLog(
    path.join(app.getPath('userData'), 'messages.json'),
    resolvePeer,
    (id) => manager.peerNameOf(id),
  );
  messages.on('message', (rec) => send('messages:update', rec));
  messages.on('cleared', () => send('messages:cleared'));

  manager.on('data', (id, data) => send('pty:data', id, data));
  manager.on('update', (view) => send('session:update', view));
  manager.on('removed', (id) => send('session:removed', id));
  manager.on('reset', (id) => send('pty:reset', id));
  manager.on('persist', () => store.update({ sessions: manager.snapshot() }));
  manager.on('attention', notifyAttention);

  registry = new Registry();
  registry.on('change', (entries) => {
    manager.applyRegistry(entries);
    send('external:update', externalSessions());
  });

  registerIpc();
  createWindow();
  manager.restore(store.state.sessions);
  registry.start();
}

/**
 * Shutting down takes a couple of seconds (closing every ConPTY), and the previous
 * instance holds the single-instance lock until it's gone. Reopening right after closing
 * would make the new instance quit silently, so keep trying for a while. Only the first
 * attempt asks a running instance to come to the front.
 */
async function acquireInstanceLock() {
  for (let attempt = 0; attempt < 16; attempt++) {
    if (app.requestSingleInstanceLock({ attempt })) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

app.on('second-instance', (_e, _argv, _cwd, data) => {
  if (data && data.attempt > 0) return;
  if (!win || win.isDestroyed() || allowClose) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.on('window-all-closed', () => {
  if (hooks) hooks.close();
  app.quit();
});

acquireInstanceLock().then(async (locked) => {
  if (!locked) { app.quit(); return; }
  await app.whenReady();
  await boot();
}).catch((err) => {
  dialog.showErrorBox('CC Sessions', t('app.startFailed', { error: err && err.stack || err }));
  app.quit();
});
