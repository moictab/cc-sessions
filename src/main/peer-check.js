'use strict';
// Who is on the other end of a connection to the hook server: the process that owns the client's
// socket (GetExtendedTcpTable) and its parents (a process snapshot), up to the top. With that the app
// tells whether a delicate call (ask_user, get_decision, a prompt that closes cards…) comes from the
// session it names, that is, from its claude process or one of its children, and not just from
// something that knows its token.
//
// Node has no way to ask Windows this, so a PowerShell kept running for the purpose does: it
// compiles a small C# class once, then answers one line per question on its standard input:
//   in:  "<client port> <server port>"
//   out: "<pid> <parent> <grandparent> …"  (the owner first), "0" if no such connection, "-1" on error.
// A parent only counts if it started before its child, so a reused process id doesn't join the chain
// (when Windows tells both start times).

const { spawn } = require('child_process');

const SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CcsPeer {
  [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr t, ref int len, bool sort, int af, int cls, uint r);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PE {
    public uint dwSize; public uint cntUsage; public uint pid; public IntPtr heap; public uint module; public uint threads;
    public uint ppid; public int prio; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe;
  }
  static int Port(int v) { return ((v & 0xFF) << 8) | ((v >> 8) & 0xFF); }
  public static int Owner(int local, int remote) {
    for (int attempt = 0; attempt < 3; attempt++) {
      int len = 0;
      GetExtendedTcpTable(IntPtr.Zero, ref len, false, 2, 4, 0); // AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS
      IntPtr buf = Marshal.AllocHGlobal(len + 4096);
      try {
        len += 4096;
        if (GetExtendedTcpTable(buf, ref len, false, 2, 4, 0) != 0) continue;
        int n = Marshal.ReadInt32(buf);
        for (int i = 0; i < n; i++) {
          IntPtr row = new IntPtr(buf.ToInt64() + 4 + i * 24);
          if (Marshal.ReadInt32(row, 4) != 0x0100007F || Marshal.ReadInt32(row, 12) != 0x0100007F) continue;
          if (Port(Marshal.ReadInt32(row, 8)) == local && Port(Marshal.ReadInt32(row, 16)) == remote) return Marshal.ReadInt32(row, 20);
        }
        return 0;
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return -1;
  }
  static long Started(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return -1;
    try { long c, e, k, u; return GetProcessTimes(h, out c, out e, out k, out u) ? c : -1; } finally { CloseHandle(h); }
  }
  public static string Chain(int local, int remote) {
    int owner = Owner(local, remote);
    if (owner <= 0) return owner.ToString();
    var parent = new Dictionary<uint, uint>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == new IntPtr(-1)) return "-1";
    try {
      PE e = new PE(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE));
      if (Process32FirstW(snap, ref e)) do { parent[e.pid] = e.ppid; } while (Process32NextW(snap, ref e));
    } finally { CloseHandle(snap); }
    var chain = new List<string>();
    uint p = (uint)owner;
    long born = Started(p);
    var seen = new HashSet<uint>();
    while (chain.Count < 64 && seen.Add(p)) {
      chain.Add(p.ToString());
      uint up;
      if (!parent.TryGetValue(p, out up) || up == 0) break;
      long upBorn = Started(up);
      // Unknown when a process won't say (some protected ones): then the order can't be checked.
      if (born >= 0 && upBorn >= 0 && upBorn > born) break;
      p = up; born = upBorn;
    }
    return String.Join(" ", chain.ToArray());
  }
}
`;

const SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  `Add-Type -TypeDefinition @'\n${SOURCE}\n'@`,
  '[Console]::Out.WriteLine("ready"); [Console]::Out.Flush()',
  'while ($null -ne ($l = [Console]::In.ReadLine())) {',
  '  $p = $l.Split(" ")',
  '  try { $r = [CcsPeer]::Chain([int]$p[0], [int]$p[1]) } catch { $r = "-1" }',
  '  [Console]::Out.WriteLine($r); [Console]::Out.Flush()',
  '}',
].join('\n');

const TIMEOUT_MS = 3000;

class PeerCheck {
  constructor({ powershell = 'powershell.exe' } = {}) {
    this.powershell = powershell;
    this.proc = null;
    this.ready = null; // a promise: the helper has compiled its class
    this.queue = []; // [{ resolve, timer }], in the order asked
    this.buf = '';
  }

  start() {
    if (this.proc) return this.ready;
    const proc = spawn(this.powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.proc = proc;
    let markReady;
    this.ready = new Promise((r) => { markReady = r; });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line === 'ready') { markReady(true); continue; }
        const q = this.queue.shift();
        if (q) { clearTimeout(q.timer); q.resolve(line); }
      }
    });
    const gone = () => {
      if (this.proc !== proc) return;
      this.proc = null;
      markReady(false);
      for (const q of this.queue.splice(0)) { clearTimeout(q.timer); q.resolve(null); }
    };
    proc.on('exit', gone);
    proc.on('error', gone);
    proc.stdin.on('error', () => {});
    return this.ready;
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc) { try { proc.kill(); } catch { /* gone */ } }
  }

  /**
   * The chain of process ids that owns the client end of a connection from `clientPort` to our
   * `serverPort`, owner first: [] when there is no such connection, null when it can't be told.
   */
  async chain(clientPort, serverPort) {
    if (!Number.isInteger(clientPort) || !Number.isInteger(serverPort)) return null;
    if (!this.proc) this.start();
    const proc = this.proc;
    const ok = await Promise.race([this.ready, new Promise((r) => setTimeout(() => r(false), 15000))]);
    if (!ok || this.proc !== proc) return null;
    const line = await new Promise((resolve) => {
      const q = { resolve, timer: null };
      // Answers come in order: one that times out must still take its place in the queue.
      q.timer = setTimeout(() => { q.resolve = () => {}; resolve(null); }, TIMEOUT_MS);
      this.queue.push(q);
      proc.stdin.write(`${clientPort} ${serverPort}\n`);
    });
    if (line === null || line === '-1') return null;
    if (line === '0') return [];
    const pids = line.split(' ').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    return pids.length ? pids : null;
  }

  /**
   * Whether the connection comes from process `pid` or one of its descendants: 'ok', 'bad' (it
   * comes from somewhere else) or 'unknown' (couldn't tell, or the session has no process).
   */
  async from(peer, pid) {
    if (!peer || !pid) return 'unknown';
    const chain = await this.chain(peer.clientPort, peer.serverPort);
    if (!chain) return 'unknown';
    return chain.includes(pid) ? 'ok' : 'bad';
  }
}

module.exports = { PeerCheck };
