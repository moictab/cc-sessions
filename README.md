# CC Sessions

**English** · [Español](README.es.md)

All your Claude Code sessions in one window. Each session is a real terminal running `claude`, and the app always knows which one is working, which one needs permission, which one is asking you something and which one has finished. When you close it everything is saved, and when you open it again it picks up right where you left off.

> Unofficial project, not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic. The app relies on some internal Claude Code formats (the session registry and cross-session messages) that may change without notice.

## Install

You need Windows 11, [Node.js](https://nodejs.org/) 20 or later (with npm) and [Claude Code](https://docs.claude.com/en/docs/claude-code) installed, either in `~/.local/bin/claude.exe`, on the PATH, or pointed to with the `CC_SESSIONS_CLAUDE` variable.

```powershell
git clone https://github.com/moictab/cc-sessions.git
cd cc-sessions
npm install
npm start
```

`npm install` downloads Electron, about 100 MB. Nothing gets compiled: the native part (`node-pty`) ships prebuilt binaries for Windows x64.

The first time it starts, the app creates a **CC Sessions** shortcut in the Start menu. From then on you open it from there, like any other application. Windows needs that shortcut to show its notifications.

The interface is in English by default; Spanish is available in Settings → Interface → Language.

### Update

Close the app and run:

```powershell
git pull
npm install
```

The next time you open it you'll have the new version. Your sessions and settings are stored separately, in `%APPDATA%\cc-sessions`, so they're kept. Earlier versions used `%APPDATA%\cc-session-manager`; the app moves that folder by itself the first time.

### Uninstall

Close the app, delete the repo folder and run this in PowerShell:

```powershell
$programs = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
Remove-Item "$programs\CC Sessions.lnk"
Remove-Item -Force "$programs\Electron.lnk"   # hidden (see below); skip it if another Electron app of yours uses it
Remove-Item -Recurse "HKCU:\Software\Classes\CLSID\{BCF46518-8493-477A-95C6-86BB944559F2}"   # notifications
Remove-Item -Recurse "$env:APPDATA\cc-sessions"   # your sessions and settings; optional
```

### The hidden `Electron.lnk` shortcut

When it shows its first notification, Electron creates a Start menu shortcut on its own, named after its executable's product name, `Electron.lnk`, and the Start menu would then show the app as "Electron". To avoid that, the app creates that file itself at startup, already valid so Electron leaves it alone and hidden so the Start menu ignores it. Since the name is the same for every unpackaged Electron app, if you develop other Electron apps the shortcut may end up pointing at whichever one showed a notification last. Electron also registers the command Windows runs when you click an old notification while the app is closed (the `CLSID` key above), but without the app's folder; the app adds it.

## Icon

A `>_` prompt with three status lights (your turn, needs permission, working), in the app's own colors. It's drawn in code in `scripts/build-icon.js`, and `npm run icon` regenerates `assets/icon.ico`, `icon.png`, `icon.svg` and `mark.svg` (the small version in the sidebar). Up to 32 px the drawing snaps to whole pixels so it stays sharp.

## What it does

- **Live status for every session**: Starting, Ready, Working, **Needs permission** (with the exact tool and command), **Asking you** (with the question), **Your turn** (with the start of the answer), Interrupted and Closed. Each status has its own animation in the indicator:

  | Status | Indicator |
  |---|---|
  | Starting | Braille spinner, like a loading terminal |
  | Ready | Still grey dot |
  | Working | The same glyphs as Claude Code's spinner (`· ✢ ✳ ✶ ✻ ✽`), and the word "Working" with a shimmer running across it |
  | Needs permission | Pulsing amber dot, with a ripple |
  | Asking you | A wobbling violet `?`, with a ripple |
  | Your turn | Green dot that pops in with a burst; it glows until you've looked at that session |
  | Interrupted | Amber pause bars |
  | Closed | Hollow ring |

  The animations play even if Windows animation effects are turned off, because here the motion is the information. You can turn them off in Settings → Interface → "Animate the status indicators".
- **Badges**: each session has a colored badge with its initials (CS, PE…) in the list, the top bar and the grid. Colors are handed out so they don't repeat (up to 12); change one with right-click → Color.
- **An organized list**: the sessions that need you (a permission, a question, or a finished turn you haven't looked at) go to the top, under "Needs you". The rest follow your groups: right-click a session → Move to group → New group…, or drag sessions between groups. Click a group's header to fold it (a folded group still shows one dot per session), double-click it to rename it, right-click it to reorder or delete it. Or, in Settings → Interface → Session list → By status: needs you, working, idle.
- **Decisions**: a session that ends its turn with a line `[project] Necesito tu decisión: <question>` is asking you to decide something. It shows "Needs your decision" with the question, and stays under "Needs you" until you answer, even after you've looked at it and across restarts of the app. Only your own prompt counts as an answer: other sessions' messages and the app's notes don't. The line is found anywhere in the message, even with quote marks, bold or a `>` in front, but not inside a code block. (The convention lives in the global `CLAUDE.md`: a session only follows it if told to.)
- **Quick switcher** (`Ctrl+Shift+K`, or the magnifier at the bottom of the sidebar): type part of a name, its initials, a group or a folder, and press Enter.
- **Alerts**: when the window isn't in the foreground you get a Windows notification and the taskbar button flashes. The window title and the badge show how many sessions need you. Clicking the notification takes you to the session.
- **Save and restore**: on close, the open sessions are saved along with their order, the view and the window position. On open, each one is relaunched with `claude --resume <id>`. The state is also saved continuously, so it survives a crash.
- **Interrupted sessions**: if you close while one is working, the app warns you. When you come back, that session shows a notice with an "Ask it to continue" button.
- **Resume conversations**: "New" lists your recent projects (taken from `~/.claude/projects`) and, for each one, its conversations with title, last prompt and date. It marks the ones already open here or in another terminal.
- **Messages between sessions**: the envelope button (`Ctrl+Shift+M`) opens a panel with what your sessions tell each other with `SendMessage`: sender → recipient, the full text and whether it has been read. Names of sessions in the app take you to them. Messages leaving a session in the app and messages reaching one are logged, even when the other end is in another terminal.
- **Sessions outside the app**: at the bottom of the sidebar you'll see the Claude sessions you have open in other terminals.
- **Per-session plugins**: the puzzle-piece button at the top right turns a plugin on or off for that session only, without touching your settings or the project's. For now it handles Playwright, which starts its own server in every session where it's enabled and is best left off when unused. The session itself can also ask for it with the `set_plugin` tool (see "MCP server" below). Applying it requires restarting the session: if it's working, the app waits for the turn to end, showing "↻ restart pending" meanwhile.
- **Restart** (the circular arrow at the top right): resumes the same conversation, but closes the process, so the session's background tasks are lost (commands, monitors, subagents, scheduled reminders) and Remote Control reconnects. The app warns you first and can leave the session a note when it's back, so it tells you if it had anything running. If the session asked for the restart itself, the note asks it to relaunch whatever is needed and carry on.
- **Administrator sessions**: right-click a session → Run as administrator. It restarts on the same conversation after you accept the Windows prompt, and from then on it's a session like any other, marked with a shield. The prompt comes up once per app run: restarts and other administrator sessions reuse the permission. When you reopen the app, administrator sessions wait for you to press "Start as administrator", so the prompt never shows up by itself. **Mind the trade-off**: as administrator, whatever the session runs has full control of the PC, and CC Sessions, which isn't elevated, can type into it, so a program running as you could use the app to act as administrator. That's why Windows Terminal doesn't mix elevated and normal tabs in one window. It only works with your own account: if the prompt is answered with another one, the session doesn't start.
- **Restarting the app** (the power button at the bottom of the sidebar): restarting closes every session's process, and with it its background tasks. So first every open session can be asked to stop them (commands, monitors, scheduled reminders, subagents), not start new ones until told otherwise, and leave unfinished work where it can pick it up. Idle sessions get the request typed in; working ones read it with the result of their next step (their `PostToolUse` hook), so nothing is typed over what they're doing; one waiting for your permission or answer is left alone until you've replied. The panel shows how each one is doing and what it answered. Then restart, or just close the app; when they're back, each one is told to relaunch what it stopped and carry on (a checkbox turns that off, and they wait for you). Calling it off tells them they can carry on.
- **Views**: one session full-size, or all of them in a grid.
- **Settings** (`Ctrl+,` or the sliders button at the bottom of the sidebar): the language (English, the default, or Spanish), the font and size of every terminal, and whether the status indicators are animated. The list shows your installed monospaced fonts, each written in its own typeface, with a search box. Changes show up at once in every session. By default the font and size come from Windows Terminal.

## Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+N` | New session or resume a conversation |
| `Ctrl+Shift+K` | Find a session by name, initials, group or folder |
| `Ctrl+Shift+J` | Go to the next session that needs you (permission > question > finished) |
| `Ctrl+1` … `Ctrl+9` | Go to session N (hold Ctrl for a moment to see the numbers in the list) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous session |
| `Ctrl+Shift+G` | Toggle single / grid |
| `Ctrl+Shift+M` | Messages between sessions |
| `Ctrl+Shift+W` | Remove the current session (the conversation is kept) |
| `Ctrl+C` / `Ctrl+V` | Copy (with a selection) / paste. With no text on the clipboard, `Ctrl+V` goes to Claude so you can paste images |
| Right-click | Copy the selection or paste |
| `Shift+Enter` | New line in the prompt |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Font size (`Ctrl+0`: Windows Terminal's) |
| `Ctrl+,` | Settings |
| `F12` | DevTools |

At the top right of each session: the session's plugins (puzzle piece), restart (circular arrow) and remove (✕).

Right-click a session in the list for its color, group, rename, restart and remove. Double-click the name to rename it; if you rename it from Claude with `/rename`, the app picks that up too. Drag in the list to reorder.

## How it works

- **Terminals**: Electron + [xterm.js](https://xtermjs.org/) with the WebGL renderer + [node-pty](https://github.com/microsoft/node-pty) (ConPTY). Unless you choose otherwise in Settings, the font and size are read from Windows Terminal's default profile, so sessions look the same as there. The font list comes from Chromium's Local Font Access API (`queryLocalFonts`), filtered to monospaced fonts; it loads a few seconds after startup because reading it takes a while. The last line of each terminal always sits 8 px from the bottom edge.
- **Status**: each session is launched with `--settings <file>`, which adds hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`). Each hook runs `curl.exe` against a local HTTP server (`127.0.0.1`, random port and a token) with the terminal's id in the URL. **Your `~/.claude/settings.json` is not modified**: the hooks only exist in the sessions the app launches.
- **Session IDs**: new conversations start with a `--session-id <uuid>` chosen by the app, so it always knows what to resume. If you run `/clear`, the `SessionStart` hook reports the new id.
- **Fallback**: the app also watches `~/.claude/sessions/<pid>.json`, the registry where each Claude session publishes whether it's `busy` or `idle` (and its name). It's used to correct the status if a hook is missed (for example when you deny a permission), to follow `/rename`, and to detect sessions open outside the app. It's an internal Claude Code format, so it's only a secondary signal.
- **Messages**: on the sender's side, the `PostToolUse` hook for `SendMessage` gives the recipient, the text and the delivery confirmation. On the recipient's side, the message arrives as a `UserPromptSubmit` wrapped in `<cross-session-message from-name="…">`. When both ends are in the app, the two observations are merged into one record that goes from "in their inbox" to "read". Replies are usually addressed to the session's socket (`uds:\\.\pipe\…`) rather than its name, so the app resolves them through the session registry. Messages to subagents within the same session aren't logged.
- **MCP server**: the same local server also serves an MCP server (HTTP, `/mcp/<id>`) that the app adds to every session with `--mcp-config`. It doesn't start any process: it's just another route on the app's server. It offers the `set_plugin` tool, which a session uses to turn a plugin on or off for itself only. The app stores the change in that session's `--settings` (`enabledPlugins`, which takes precedence over your settings and the project's). When the turn ends it relaunches the session with `--resume` and types a note so it carries on. To keep a confused session from looping, each one can ask for at most 6 restarts per hour.
- **Administrator sessions**: Windows only starts an elevated process after its own prompt, and never as a child the app could attach a terminal to. So the first administrator session starts a helper (`src/main/admin-host.js`) with `Start-Process -Verb RunAs`: Electron's own binary running as plain Node, with no window. It connects back to the app on `127.0.0.1` with a one-time token and runs those sessions in its own ConPTYs, relaying their output and your typing. Hooks and the MCP server work as in any other session. When the app closes (or crashes) the connection drops, and the helper closes its sessions and exits. The session itself is told it runs as administrator: the app answers its `SessionStart` hook with that as `additionalContext`, so it hears it again on every resume, `/clear` and compaction. (`--append-system-prompt` wouldn't do: Claude reuses a conversation's first system prompt when resuming it.) When you turn it off, the next start tells it it no longer has those rights.
- **Saved data**: `%APPDATA%\cc-sessions\state.json` (sessions with their color, group and plugins, the groups, the view), `settings.json` (Settings; `null` means "the default") and `messages.json` (the last 500 messages). The `CC_SESSIONS_USER_DATA` variable points the app at another folder, for example for tests. `CC_SESSIONS_CLAUDE=<path>` picks the `claude` executable. `CC_SESSIONS_ADMIN_NO_ELEVATE=1` runs administrator sessions through the helper without the prompt (and so without administrator rights), for tests. `CC_SESSIONS_HOOK_LOG=<file>` dumps every hook event as a debugging aid; that file holds your prompts, the commands and the tools' output in plain text, so don't share it.

## Limitations

- Restoring resumes the **conversation**, not unfinished work: whatever a session was running when you closed is cut off, and you have to ask it to continue. Background processes it had started (dev servers, etc.) don't survive either.
- Opening in the app a conversation that's still alive in another terminal creates two processes on the same conversation. The app warns you first.
- When you answer a permission prompt or a question, the status switches to "Working" as soon as you press Enter, because Claude emits no hook at that moment. If you answered "No", the registry corrects it within a few seconds.
- Messages between two sessions that are both outside the app aren't visible.
- Normal sessions can't connect to an administrator session's message pipe (Windows refuses it), so their messages reach it only through Remote Control, while it's on for that session. Its own messages to them get through as usual.
- Only tested on Windows 11.

## License

[MIT](LICENSE).
