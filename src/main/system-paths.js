'use strict';
// Windows' own programs (reg.exe, powershell.exe) by their full path in System32, never through the
// PATH, where a folder earlier in the list could hold another program with the same name.

const path = require('path');

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

const system32 = (...parts) => path.join(SYSTEM32, ...parts);

module.exports = {
  system32,
  REG: system32('reg.exe'),
  POWERSHELL: system32('WindowsPowerShell', 'v1.0', 'powershell.exe'),
};
