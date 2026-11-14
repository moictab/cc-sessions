'use strict';
// The administrator helper: the only part of CC Sessions that runs elevated.
//
// An administrator installs it, with its own node.exe and node-pty, in a folder only
// administrators can write (C:\Program Files\CC Sessions\admin-host; see install.ps1), and the app
// starts it from there through a UAC prompt. It connects back to the app on 127.0.0.1 (port and
// one-time token on its command line) and runs the app's administrator sessions in its own
// ConPTYs, relaying their output, input and size, one JSON message per line.
//
// It trusts nothing that comes from the app, which runs as the user and so could be anything the
// user's processes made it. The app only says WHICH session to open (ids, name, folder, size,
// and how its hooks reach the app); everything else is decided here, from admin-host.json next to
// this file (admins only):
//   - the program is always config.claudeExe, and only with a valid Authenticode signature from
//     config.claudeSigner, checked before every start;
//   - the command line is fixed: --resume or --session-id, --name, --settings with a file this
//     helper writes, --setting-sources user and --strict-mcp-config;
//   - the environment is built here from a closed list, never inherited (the elevated process got
//     its own from the registry, HKCU\Environment included, which the user can write);
//   - the working folder must be inside config.allowedRoots, and it (with what Claude reads in it)
//     and the folders the session uses must not be writable by anyone but SYSTEM and Administrators.
// Anything else is refused and written to logs\admin-host.log (never the tokens).
//
// Input typed into a session is passed through as it comes: the user accepted that the app,
// which isn't elevated, can type into these sessions.
//
// When the connection goes away (the app quit or crashed) it closes every session and exits:
// nothing keeps running elevated on its own.

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const LOG_FILE = path.join(HERE, 'logs', 'admin-host.log');
const RUN_DIR = path.join(HERE, 'run');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const KEY = /^p\d{1,9}$/;
const NAME = /^(?!-)[\p{L}\p{N} ._-]{1,80}$/u; // not starting with "-", which would read as an option
const LOCAL_ABS = /^[A-Za-z]:\\/;

// Who may write where the session lives: SYSTEM, Administrators, TrustedInstaller, and CREATOR
// OWNER (whoever creates a file inside; only those three can).
const TRUSTED_SIDS = ['S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'];
const CREATOR_OWNER = 'S-1-3-0';
// What Claude reads from its working folder, besides the folder itself.
const SENSITIVE_IN_CWD = ['.claude', '.claude\\settings.json', '.claude\\settings.local.json', '.mcp.json', 'CLAUDE.md', 'CLAUDE.local.md', '.git', '.git\\hooks', '.git\\config'];
// Claude also loads CLAUDE.md and CLAUDE.local.md from every folder above the working one, up to
// the drive's root, and looks for .claude there.
const CLAUDE_ABOVE = [['CLAUDE.md', 'file'], ['CLAUDE.local.md', 'file'], ['.claude', 'dir']];
// Rights on a folder, for whoever isn't SYSTEM, Administrators or TrustedInstaller:
const CREATE_FILES = 0x2; // a CLAUDE.md that isn't there could be put there
const CREATE_FOLDERS = 0x4; // and a .claude
// delete child, delete, write DACL, take ownership, generic all: what's inside (a protected
// folder among it) could be renamed away and replaced in the middle of a session.
const TAKE_OVER = 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x10000000;

const SPAWN_FIELDS = ['t', 'k', 'terminalId', 'sessionId', 'name', 'cwd', 'cols', 'rows', 'hookPort', 'hookToken', 'guardToken'];

// ---------------------------------------------------------------- config

function loadConfig(file) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const abs = (v, what, optional = false) => {
    if (optional && v == null) return null;
    if (typeof v !== 'string' || !LOCAL_ABS.test(v)) throw new Error(`config: ${what} must be an absolute local path`);
    return v.replace(/[\\]+$/, '');
  };
  const cfg = {
    claudeExe: abs(c.claudeExe, 'claudeExe'),
    claudeSigner: typeof c.claudeSigner === 'string' && c.claudeSigner ? c.claudeSigner : 'CN="Anthropic, PBC"',
    windowsDir: abs(c.windowsDir || 'C:\\Windows', 'windowsDir'),
    // Tests only, never elevated: without these, Claude uses the user's profile and ~\.claude.
    configDir: abs(c.configDir, 'configDir', true),
    profileDir: abs(c.profileDir, 'profileDir', true),
    tempDir: abs(c.tempDir, 'tempDir', true),
    allowedRoots: (Array.isArray(c.allowedRoots) ? c.allowedRoots : []).map((r) => abs(r, 'allowedRoots')),
    path: (Array.isArray(c.path) ? c.path : []).map((p) => abs(p, 'path')),
    remoteControl: c.remoteControl !== false,
    checkAcls: c.checkAcls !== false,
  };
  if (!cfg.allowedRoots.length) throw new Error('config: allowedRoots is empty');
  if (!cfg.path.length) throw new Error('config: path is empty');
  return cfg;
}

// ---------------------------------------------------------------- log

function log(event, detail) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail }) + '\n');
  } catch { /* nowhere to write it */ }
}

// ---------------------------------------------------------------- environments

const PROGRAM_FILES = 'C:\\Program Files';
const PROGRAM_FILES_X86 = 'C:\\Program Files (x86)';

/** The base every child gets: system paths fixed, nothing from the registry environment. */
function systemEnv(cfg) {
  const win = cfg.windowsDir;
  return {
    SystemRoot: win,
    windir: win,
    SystemDrive: win.slice(0, 2),
    ComSpec: `${win}\\System32\\cmd.exe`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC',
    PATH: cfg.path.join(';'),
    // Only the system's modules: an elevated PowerShell must not load modules from Documents.
    PSModulePath: `${PROGRAM_FILES}\\WindowsPowerShell\\Modules;${win}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
    ProgramFiles: PROGRAM_FILES,
    'ProgramFiles(x86)': PROGRAM_FILES_X86,
    ProgramW6432: PROGRAM_FILES,
    CommonProgramFiles: `${PROGRAM_FILES}\\Common Files`,
    'CommonProgramFiles(x86)': `${PROGRAM_FILES_X86}\\Common Files`,
    CommonProgramW6432: `${PROGRAM_FILES}\\Common Files`,
    ProgramData: 'C:\\ProgramData',
    ALLUSERSPROFILE: 'C:\\ProgramData',
    PUBLIC: 'C:\\Users\\Public',
    OS: 'Windows_NT',
    PROCESSOR_ARCHITECTURE: os.arch() === 'arm64' ? 'ARM64' : 'AMD64',
    NUMBER_OF_PROCESSORS: String(os.cpus().length || 1),
    USERNAME: os.userInfo().username,
    COMPUTERNAME: os.hostname(),
  };
}

/**
 * Where the session's "home" is. Elevated: folders only administrators can write (config), so
 * Git Bash's .bashrc, git's .gitconfig, npm's settings and the like aren't the user's. In tests
 * (never elevated) these may be left out: then they're the user's.
 */
function profileEnv(cfg) {
  const env = {};
  if (cfg.profileDir) {
    env.USERPROFILE = cfg.profileDir;
    env.HOME = cfg.profileDir;
    env.HOMEDRIVE = cfg.profileDir.slice(0, 2);
    env.HOMEPATH = cfg.profileDir.slice(2);
    env.APPDATA = `${cfg.profileDir}\\AppData\\Roaming`;
    env.LOCALAPPDATA = `${cfg.profileDir}\\AppData\\Local`;
  } else {
    const home = os.userInfo().homedir;
    env.USERPROFILE = home;
    env.HOMEDRIVE = home.slice(0, 2);
    env.HOMEPATH = home.slice(2);
    env.APPDATA = `${home}\\AppData\\Roaming`;
    env.LOCALAPPDATA = `${home}\\AppData\\Local`;
  }
  const temp = cfg.tempDir || `${env.LOCALAPPDATA}\\Temp`;
  env.TEMP = temp;
  env.TMP = temp;
  return env;
}

/**
 * Claude's environment: the base, the profile, its config folder, no updates, and how image-guard
 * reaches the app. `docs`: the user's Documents folder (from the registry, see inspect()).
 */
function claudeEnv(cfg, req, docs) {
  const env = { ...systemEnv(cfg), ...profileEnv(cfg), COLORTERM: 'truecolor' };
  // PowerShell 7 always puts Documents\PowerShell\Modules (from the registry, not the environment)
  // first, unless it's already there: so it goes last, after the system's.
  env.PSModulePath = [
    `${PROGRAM_FILES}\\PowerShell\\Modules`, `${PROGRAM_FILES}\\PowerShell\\7\\Modules`,
    `${PROGRAM_FILES}\\WindowsPowerShell\\Modules`, `${cfg.windowsDir}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
    ...(typeof docs === 'string' && LOCAL_ABS.test(docs) ? [`${docs}\\PowerShell\\Modules`] : []),
  ].join(';');
  env.DISABLE_UPDATES = '1'; // it's updated by an administrator, never by itself
  if (cfg.configDir) env.CLAUDE_CONFIG_DIR = cfg.configDir;
  env.CC_SESSIONS_GUARD_URL = `http://127.0.0.1:${req.hookPort}/guard/${req.terminalId}`;
  env.CC_SESSIONS_GUARD_TOKEN = req.guardToken;
  return env;
}

/** For the helper's own little children (whoami, PowerShell): the base and the profile, nothing else. */
function toolEnv(cfg) {
  return { ...systemEnv(cfg), ...profileEnv(cfg) };
}

// ---------------------------------------------------------------- checks

function sys(cfg, rel) {
  return `${cfg.windowsDir}\\${rel}`;
}

/** High integrity level (S-1-16-12288) or above: really elevated, not just an admin account. */
function isElevated(cfg) {
  const r = spawnSync(sys(cfg, 'System32\\whoami.exe'), ['/groups'], { encoding: 'utf8', windowsHide: true, env: toolEnv(cfg), timeout: 15000 });
  return r.status === 0 && /S-1-16-(12288|16384)\b/.test(r.stdout || '');
}

/** The working folder: local, absolute, existing, and inside an allowed root once links are resolved. */
function checkCwd(cfg, cwd) {
  if (typeof cwd !== 'string' || cwd.length > 260 || !LOCAL_ABS.test(cwd) || cwd.includes('\0')) throw new Error('cwd is not an absolute local path');
  let real;
  try { real = fs.realpathSync.native(cwd); } catch { throw new Error('cwd does not exist'); }
  if (!LOCAL_ABS.test(real)) throw new Error('cwd resolves to a path that is not local');
  if (!fs.statSync(real).isDirectory()) throw new Error('cwd is not a folder');
  const inside = cfg.allowedRoots.some((root) => {
    let r;
    try { r = fs.realpathSync.native(root); } catch { return false; }
    const rel = path.relative(r.toLowerCase(), real.toLowerCase());
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!inside) throw new Error('cwd is outside the allowed roots');
  return real;
}

/**
 * One PowerShell (5.1, the system's, without a profile, with the closed environment) for what Node
 * can't see: the program's Authenticode signature, the user's Documents folder, and for each path
 * whether it exists, is a folder or a link (reparse point), its owner, who else may write it
 * (any Allow rule with a write-type right, inherited or not), and the rights others have on the
 * object itself (`self`, rules that apply to it, not only to what's inside).
 */
function inspect(cfg, exe, paths) {
  const input = Buffer.from(JSON.stringify({ exe, paths }), 'utf8').toString('base64'); // no quoting to get wrong
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$in = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')) | ConvertFrom-Json`,
    '$s = Get-AuthenticodeSignature -LiteralPath $in.exe',
    '$subject = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { "" }',
    "$out = @{ sig = @{ status = [string]$s.Status; subject = $subject }; docs = [Environment]::GetFolderPath('MyDocuments') }",
    // write data / add file, append / add subfolder, write EA, delete child, write attributes,
    // delete, write DACL, take ownership, generic all, generic write
    '$write = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000',
    `$trusted = @(${TRUSTED_SIDS.map((x) => `'${x}'`).join(', ')})`,
    '$sidType = [System.Security.Principal.SecurityIdentifier]',
    '$inheritOnly = [System.Security.AccessControl.PropagationFlags]::InheritOnly',
    '$out.acl = @(foreach ($p in $in.paths) {',
    '  try {',
    '    if (-not (Test-Path -LiteralPath $p)) { @{ path = $p; exists = $false }; continue }',
    '    $item = Get-Item -LiteralPath $p -Force',
    '    $reparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)',
    '    $a = Get-Acl -LiteralPath $p',
    '    $owner = $a.GetOwner($sidType).Value',
    '    $writers = @(); $self = 0',
    '    foreach ($r in $a.GetAccessRules($true, $true, $sidType)) {',
    "      if ([string]$r.AccessControlType -ne 'Allow') { continue }",
    '      $sid = $r.IdentityReference.Value',
    `      if ($trusted -contains $sid -or $sid -eq '${CREATOR_OWNER}') { continue }`,
    '      $mask = [int]$r.FileSystemRights',
    '      if (($mask -band $write) -ne 0) { $writers += $sid }',
    '      if (($r.PropagationFlags -band $inheritOnly) -eq 0) { $self = $self -bor $mask }',
    '    }',
    '    @{ path = $p; exists = $true; dir = [bool]$item.PSIsContainer; reparse = $reparse; owner = $owner; writers = @($writers | Select-Object -Unique); self = $self }',
    '  } catch {',
    '    @{ path = $p; exists = $true; error = $_.Exception.Message }', // unreadable: not checked, so not trusted
    '  }',
    '})',
    '$out | ConvertTo-Json -Depth 5 -Compress',
  ].join('\n');
  const r = spawnSync(sys(cfg, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, env: toolEnv(cfg), timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`could not check the signature and permissions (${(r.stderr || '').trim().split(/\r?\n/)[0] || `exit ${r.status}`})`);
  const out = JSON.parse(r.stdout);
  out.acl = [].concat(out.acl || []);
  return out;
}

/** Every folder above `p`, up to the drive's root (included). */
function ancestors(p) {
  const out = [];
  let cur = path.dirname(p);
  for (;;) {
    out.push(cur);
    const up = path.dirname(cur);
    if (up === cur) return out;
    cur = up;
  }
}

/**
 * What has to hold before a session starts, as lists of paths:
 *   must       exist, not a link, owned by SYSTEM/Administrators/TrustedInstaller, nobody else may write
 *   optional   the same if it exists (what Claude reads in the working folder); .git must be a folder
 *   above      CLAUDE.md, CLAUDE.local.md and .claude in every folder above the working one: the same
 *              if they exist; if not, nobody else may create them there
 *   ancestors  of everything in `must`: owned as above, and nobody else may delete or rename
 *              what's inside or take the folder over
 */
function plan(cfg, cwd) {
  const must = [...new Set([HERE, cfg.claudeExe, path.dirname(cfg.claudeExe), cwd, ...cfg.path,
    ...[cfg.configDir, cfg.profileDir, cfg.tempDir].filter(Boolean)])];
  const optional = SENSITIVE_IN_CWD.map((p) => path.join(cwd, p));
  const above = [];
  for (const a of ancestors(cwd)) for (const [name, kind] of CLAUDE_ABOVE) above.push({ path: path.join(a, name), kind, parent: a });
  const anc = new Set();
  for (const p of must) for (const a of ancestors(p)) anc.add(a);
  const all = [...new Set([...must, ...optional, ...above.map((x) => x.path), ...anc])];
  return { must, optional, above, ancestors: [...anc], all };
}

/** Checks the inspect() results against the plan: the first thing wrong, or '' if nothing is. */
function judge(acl, pl) {
  const info = new Map(acl.map((a) => [String(a.path).toLowerCase(), a]));
  const get = (p) => info.get(p.toLowerCase()) || { path: p, exists: false };
  const locked = (i) => {
    if (i.error) return `could not read the permissions of ${i.path}: ${i.error}`;
    if (i.reparse) return `${i.path} is a link (reparse point)`;
    if (!TRUSTED_SIDS.includes(i.owner)) return `${i.path} is owned by ${i.owner}`;
    const writers = [].concat(i.writers || []);
    if (writers.length) return `${i.path} can be written by ${writers.join(', ')}`;
    return '';
  };
  for (const p of pl.must) {
    const i = get(p);
    if (!i.exists) return `missing: ${p}`;
    const e = locked(i);
    if (e) return e;
  }
  for (const p of pl.optional) {
    const i = get(p);
    if (!i.exists) continue;
    const e = locked(i);
    if (e) return e;
    if (/\\\.git$/i.test(p) && !i.dir) return `${p} is a file: it could send git's config and hooks elsewhere`;
  }
  for (const x of pl.above) {
    const i = get(x.path);
    if (i.exists) {
      const e = locked(i);
      if (e) return e;
      continue;
    }
    const parent = get(x.parent);
    if (parent.error) return `could not read the permissions of ${x.parent}: ${parent.error}`;
    const right = x.kind === 'file' ? CREATE_FILES : CREATE_FOLDERS;
    if (((parent.self | 0) & right) !== 0) return `others may create ${x.path}, which the session would load`;
  }
  for (const a of pl.ancestors) {
    const i = get(a);
    if (!i.exists) return `missing: ${a}`;
    if (i.error) return `could not read the permissions of ${a}: ${i.error}`;
    if (!TRUSTED_SIDS.includes(i.owner)) return `${a} is owned by ${i.owner}`;
    if (((i.self | 0) & TAKE_OVER) !== 0) return `others may delete or rename what's in ${a}`;
  }
  return '';
}

/** The signature, and (unless tests turned it off) the plan. Returns the user's Documents folder. */
function checkAll(cfg, cwd) {
  const pl = cfg.checkAcls ? plan(cfg, cwd) : null;
  const out = inspect(cfg, cfg.claudeExe, pl ? pl.all : []);
  if (out.sig.status !== 'Valid') throw new Error(`claude.exe signature is ${out.sig.status || 'missing'}`);
  if (!out.sig.subject.startsWith(cfg.claudeSigner)) throw new Error('claude.exe is signed by someone else');
  if (pl) {
    const wrong = judge(out.acl, pl);
    if (wrong) throw new Error(wrong);
  }
  return { docs: out.docs };
}

// ---------------------------------------------------------------- requests

function validSpawn(m) {
  const extra = Object.keys(m).filter((k) => !SPAWN_FIELDS.includes(k));
  if (extra.length) throw new Error(`unexpected fields: ${extra.join(', ')}`);
  if (!KEY.test(m.k || '')) throw new Error('bad key');
  if (!UUID.test(m.terminalId || '')) throw new Error('bad terminalId');
  if (!UUID.test(m.sessionId || '')) throw new Error('bad sessionId');
  if (typeof m.name !== 'string' || !NAME.test(m.name)) throw new Error('bad name');
  if (!Number.isInteger(m.cols) || m.cols < 2 || m.cols > 1000 || !Number.isInteger(m.rows) || m.rows < 2 || m.rows > 500) throw new Error('bad size');
  if (!Number.isInteger(m.hookPort) || m.hookPort < 1024 || m.hookPort > 65535) throw new Error('bad hookPort');
  if (!TOKEN.test(m.hookToken || '') || !TOKEN.test(m.guardToken || '')) throw new Error('bad token');
}

/**
 * What the session is told as it starts (and on every resume, /clear and compaction): written by
 * the helper, not by the app. Model-facing, so in English. Keep it in step with adminContext() in
 * src/main/admin.js, which says the same to sessions the app runs itself.
 */
function startContext(elevated) {
  if (!elevated) {
    return '[CC Sessions] This session is set to run as administrator, but it is running WITHOUT administrator rights ' +
      '(CC Sessions started it in test mode, without the Windows prompt).';
  }
  return '[CC Sessions] This session runs elevated, as Windows administrator: the user turned on "Run as administrator" for it in ' +
    'CC Sessions and accepted the Windows (UAC) prompt. Commands you run have full administrator rights with no further prompts, ' +
    'and programs you start run elevated too, so be deliberate with system-wide changes (services, drivers, the registry, ' +
    'security settings, installing or removing software). Files you create may end up owned by the Administrators group. ' +
    "Windows doesn't let non-elevated sessions connect to your local message pipe, so their messages (SendMessage) reach you " +
    'only through Remote Control, while it is on for this session; your messages to them get through as usual. ' +
    "If you no longer need administrator rights, tell the user: they can turn it off from this session's menu in CC Sessions.";
}

/**
 * The settings file for one session, written here so nobody else can change it. The app's status
 * hooks only report: their answer goes to NUL, so the app, which isn't elevated, can't approve a
 * tool or slip context in unseen. What the session hears as it starts comes from a file of the
 * helper's, read with a second SessionStart hook.
 */
function writeSettings(cfg, req, elevated = true) {
  const curl = sys(cfg, 'System32\\curl.exe').replace(/\\/g, '/'); // a full path every shell takes
  const report = `${curl} -s -m 2 -o NUL -X POST -H "Content-Type: application/json" -H "X-CC-Sessions-Token: ${req.hookToken}" ` +
    `--data-binary "@-" http://127.0.0.1:${req.hookPort}/hook/${req.terminalId} || exit 0`;
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const startFile = path.join(RUN_DIR, `${req.terminalId}.start.json`);
  fs.writeFileSync(startFile, JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: startContext(elevated) } }));
  const tell = `${curl} -s -m 2 "file:///${startFile.replace(/\\/g, '/').replace(/ /g, '%20')}" || exit 0`;
  const hook = (matcher, extra = []) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: report, timeout: 5 }, ...extra] }];
  const settings = {
    hooks: {
      SessionStart: hook(null, [{ type: 'command', command: tell, timeout: 5 }]),
      UserPromptSubmit: hook(), PreToolUse: hook('*'), PostToolUse: hook('*'), Notification: hook(), Stop: hook(),
    },
    disableAgentView: true,
    remoteControlAtStartup: cfg.remoteControl,
  };
  const file = path.join(RUN_DIR, `${req.terminalId}.json`);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

function claudeArgs(cfg, req, cwd, settingsFile) {
  const configDir = cfg.configDir || path.join(os.userInfo().homedir, '.claude');
  const transcript = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${req.sessionId}.jsonl`);
  const resume = fs.existsSync(transcript);
  return [resume ? '--resume' : '--session-id', req.sessionId, '--name', req.name, '--settings', settingsFile, '--setting-sources', 'user', '--strict-mcp-config'];
}

// ---------------------------------------------------------------- the connection

function main() {
  const [port, token] = process.argv.slice(2);
  if (!/^\d{1,5}$/.test(port || '') || !TOKEN.test(token || '')) process.exit(2);

  let cfg;
  try { cfg = loadConfig(path.join(HERE, 'admin-host.json')); } catch (err) { log('bad-config', { error: err.message }); process.exit(4); }

  // Only what node-pty's own helpers need, should they start a process; the registry gave us the rest.
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, toolEnv(cfg));

  const elevated = isElevated(cfg);
  if (elevated && !cfg.checkAcls) { log('refused', { error: 'checkAcls is off: tests only, never elevated' }); process.exit(5); }

  const pty = require(path.join(HERE, 'node_modules', 'node-pty'));
  const ptys = new Map();
  const sock = net.connect(Number(port), '127.0.0.1');
  sock.setNoDelay(true);
  sock.setEncoding('utf8');
  const send = (msg) => { if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n'); };
  const refuse = (k, error, extra = {}) => {
    log('rejected', { k: KEY.test(k || '') ? k : undefined, error, ...extra });
    if (KEY.test(k || '')) send({ t: 'exit', k, exitCode: null, error: `rejected: ${error}` });
  };

  sock.on('connect', () => {
    log('start', { elevated, user: os.userInfo().username });
    send({ t: 'hello', token, pid: process.pid, user: os.userInfo().username, elevated, version: 3 });
  });

  const spawnSession = (m) => {
    try { validSpawn(m); } catch (err) { refuse(m.k, err.message, { fields: Object.keys(m) }); return; }
    if (ptys.has(m.k)) { refuse(m.k, 'key in use'); return; }
    let cwd;
    let proc;
    try {
      cwd = checkCwd(cfg, m.cwd);
      const { docs } = checkAll(cfg, cwd);
      const settingsFile = writeSettings(cfg, m, elevated);
      const args = claudeArgs(cfg, m, cwd, settingsFile);
      proc = pty.spawn(cfg.claudeExe, args, { name: 'xterm-256color', cols: m.cols, rows: m.rows, cwd, env: claudeEnv(cfg, m, docs), useConpty: true });
      log('spawned', { k: m.k, terminalId: m.terminalId, sessionId: m.sessionId, cwd, resume: args[0] === '--resume', pid: proc.pid });
    } catch (err) {
      refuse(m.k, err.message, { terminalId: m.terminalId, cwd: cwd || undefined });
      return;
    }
    ptys.set(m.k, proc);
    send({ t: 'spawned', k: m.k, pid: proc.pid });
    proc.onData((data) => send({ t: 'data', k: m.k, data }));
    proc.onExit(({ exitCode }) => {
      if (ptys.get(m.k) === proc) ptys.delete(m.k);
      send({ t: 'exit', k: m.k, exitCode });
    });
  };

  const handle = (m) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) { log('rejected', { error: 'not an object' }); return; }
    const p = ptys.get(m.k);
    const only = (keys) => Object.keys(m).every((k) => keys.includes(k));
    switch (m.t) {
      case 'spawn':
        spawnSession(m);
        break;
      case 'write':
        if (!only(['t', 'k', 'data']) || typeof m.data !== 'string' || m.data.length > 65536) { refuse(m.k, 'bad write'); break; }
        if (p) p.write(m.data);
        break;
      case 'resize':
        if (!only(['t', 'k', 'cols', 'rows']) || !Number.isInteger(m.cols) || !Number.isInteger(m.rows) || m.cols < 2 || m.cols > 1000 || m.rows < 2 || m.rows > 500) { refuse(m.k, 'bad resize'); break; }
        if (p) { try { p.resize(m.cols, m.rows); } catch { /* exiting */ } }
        break;
      case 'kill':
        if (!only(['t', 'k'])) { refuse(m.k, 'bad kill'); break; }
        if (p) { try { p.kill(); } catch { /* already gone */ } }
        break;
      default:
        log('rejected', { error: 'unknown message', type: typeof m.t === 'string' ? m.t.slice(0, 20) : typeof m.t });
    }
  };

  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 1024 * 1024) { log('rejected', { error: 'line too long' }); sock.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { log('rejected', { error: 'not JSON' }); continue; }
      try { handle(msg); } catch (err) { log('error', { error: String(err && err.message || err) }); }
    }
  });
  sock.on('error', () => { /* 'close' follows */ });

  let closing = false;
  sock.on('close', () => {
    if (closing) return;
    closing = true;
    log('stop', { sessions: ptys.size });
    for (const p of ptys.values()) { try { p.kill(); } catch { /* already gone */ } }
    // ConPTY closes asynchronously; give it a moment, then go.
    const done = () => process.exit(0);
    if (!ptys.size) return done();
    let left = ptys.size;
    for (const p of ptys.values()) p.onExit(() => { if (--left === 0) done(); });
    setTimeout(done, 3000).unref();
  });
}

if (require.main === module) main();

module.exports = { loadConfig, systemEnv, profileEnv, claudeEnv, toolEnv, checkCwd, validSpawn, claudeArgs, writeSettings, inspect, checkAll, plan, judge, ancestors, startContext };
