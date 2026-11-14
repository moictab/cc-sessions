'use strict';
// Writes admin-host/manifest.json: every file the administrator helper is installed with, where it
// comes from in this repo, where it goes, and its SHA-256. install.ps1 copies them and checks each
// hash in the destination folder, so a file changed in the repo (which the user can write) after
// the commit was reviewed doesn't get installed. node.exe isn't hashed (it changes with every
// Node update): it's checked by its signature instead.
//
//   node admin-host/make-manifest.js      (after npm install, from the repo's root)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PTY = 'node_modules/node-pty';

function files() {
  const list = [
    ['admin-host/admin-host.js', 'admin-host.js'],
    [`${PTY}/package.json`, `${PTY}/package.json`],
    [`${PTY}/prebuilds/win32-x64/conpty.node`, `${PTY}/prebuilds/win32-x64/conpty.node`],
    [`${PTY}/prebuilds/win32-x64/conpty_console_list.node`, `${PTY}/prebuilds/win32-x64/conpty_console_list.node`],
  ];
  // node-pty's JavaScript, without its tests.
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) list.push([rel, rel]);
    }
  };
  walk(`${PTY}/lib`);
  return list.sort((a, b) => a[1].localeCompare(b[1]));
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');

const manifest = {
  version: 2, // the protocol between the app and the helper (HELPER_VERSION in src/main/admin.js)
  nodePty: JSON.parse(fs.readFileSync(path.join(ROOT, PTY, 'package.json'), 'utf8')).version,
  node: { signer: 'CN=OpenJS Foundation', minMajor: 22 },
  files: files().map(([source, target]) => ({ source, target, sha256: sha256(source) })),
};
fs.writeFileSync(path.join(__dirname, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json: ${manifest.files.length} files`);
