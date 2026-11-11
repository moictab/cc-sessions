'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const listener = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('ccsm', {
  // Interface language, read before the page builds anything (it reloads when it changes).
  language: ipcRenderer.sendSync('settings:language'),
  init: () => ipcRenderer.invoke('init'),

  createSession: (opts) => ipcRenderer.invoke('session:create', opts),
  restartSession: (id, opts) => ipcRenderer.invoke('session:restart', id, opts),
  sessionPlugins: (id) => ipcRenderer.invoke('session:plugins', id),
  setSessionPlugins: (id, changes, opts) => ipcRenderer.invoke('session:set-plugins', id, changes, opts),
  cancelRestart: (id) => ipcRenderer.invoke('session:cancel-restart', id),
  setSessionAdmin: (id, on, opts) => ipcRenderer.invoke('session:set-admin', id, on, opts),
  windDown: () => ipcRenderer.invoke('app:wind-down'),
  cancelWindDown: () => ipcRenderer.invoke('app:wind-cancel'),
  quitApp: (opts) => ipcRenderer.invoke('app:quit', opts),
  closeSession: (id) => ipcRenderer.invoke('session:close', id),
  renameSession: (id, name) => ipcRenderer.invoke('session:rename', id, name),
  setSessionMeta: (id, patch) => ipcRenderer.invoke('session:set-meta', id, patch),
  saveGroups: (groups) => ipcRenderer.send('ui:groups', groups),
  clearInterrupted: (id) => ipcRenderer.invoke('session:clear-interrupted', id),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),

  setUiState: (patch) => ipcRenderer.send('ui:state', patch),
  reorder: (ids) => ipcRenderer.send('ui:reorder', ids),
  toggleDevtools: () => ipcRenderer.send('ui:devtools'),
  reload: () => ipcRenderer.send('ui:reload'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),

  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  listProjects: () => ipcRenderer.invoke('history:projects'),
  listConversations: (cwd) => ipcRenderer.invoke('history:conversations', cwd),

  openFolder: (dir) => ipcRenderer.invoke('shell:open-folder', dir),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),

  onData: (cb) => on('pty:data', cb),
  onReset: (cb) => on('pty:reset', cb),
  onUpdate: (cb) => on('session:update', cb),
  onRemoved: (cb) => on('session:removed', cb),
  onFocusRequest: (cb) => on('ui:focus', cb),
  onExternal: (cb) => on('external:update', cb),
  onWindowAttended: (cb) => on('window:attended', cb),
  onMessage: (cb) => on('messages:update', cb),
  onMessagesCleared: (cb) => on('messages:cleared', cb),
  clearMessages: () => ipcRenderer.invoke('messages:clear'),
});
