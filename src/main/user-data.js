'use strict';
// Where the app keeps its state (%APPDATA%\cc-sessions), and the move from the folder that
// earlier versions used.

const fs = require('fs');
const path = require('path');

const FOLDER = 'cc-sessions';
const OLD_FOLDERS = ['cc-session-manager']; // before the project was renamed

function userDataDir(appData) {
  const dir = path.join(appData, FOLDER);
  if (fs.existsSync(dir)) return dir;
  for (const name of OLD_FOLDERS) {
    const old = path.join(appData, name);
    if (!fs.existsSync(old)) continue;
    try {
      fs.renameSync(old, dir);
      return dir;
    } catch {
      return old; // in use (a copy of the app still running): keep it and try again next time
    }
  }
  return dir;
}

module.exports = { userDataDir };
