<p align="center">
  <img src="assets/icon.png" alt="Manifold" width="128" height="128">
</p>

<h1 align="center">Manifold</h1>

<p align="center">
  A workspace manager for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>. Run multiple sessions in parallel, organize them into collections, monitor everything in grid view, and let an automatic dev journal track what you built.
</p>

<p align="center">
  <a href="https://github.com/MindFabric/manifold/releases/latest">Download for Linux, macOS, or Windows</a>
</p>

---

## Features

**Terminal multiplexing** — Run many Claude Code sessions at once, organized into named collections (one per project, or however you like). Each session gets its own pseudo-terminal with 50k lines of scrollback.

**Grid view** — Press `Ctrl+G` to see every session in the active collection rendered simultaneously. Great for watching a build, tests, and a dev server at the same time.

**Auto-naming** — New tabs get a descriptive name automatically after ~30 seconds of activity. Claude reads the terminal buffer and picks a short label like "auth bug fix" or "api refactor".

**Dev journal** — A background process captures terminal activity across all sessions and summarizes it every 5 minutes into a daily markdown file (`~/Documents/journal/`). Open the built-in journal viewer with `Ctrl+J` to browse past entries by date.

**Conversation tracking** — Manifold detects when Claude Code starts a new conversation and saves the ID. Close a tab, reopen it later, and you can resume exactly where you left off.

**State persistence** — Collections, tabs, working directories, conversation IDs, and UI preferences are saved automatically and restored on launch.

**Cross-platform** — Native builds for Linux (AppImage, deb), macOS (dmg, zip), and Windows (installer, portable). Windows runs Claude Code through WSL.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Super+C` / `Cmd+Shift+C` | Toggle app visibility |
| `Ctrl+T` | New session in active collection |
| `Ctrl+Y` / `Ctrl+P` | New collection (opens folder picker) |
| `Ctrl+W` | Close active session |
| `Ctrl+G` | Toggle grid view |
| `Ctrl+J` | Toggle journal viewer |
| `Alt+1-9` | Jump to session N (global) |
| `Ctrl+1-9` | Jump to session N (within collection) |
| `Escape` | Close overlays |

On macOS, `Cmd` replaces `Ctrl` where applicable.

## Install

Grab the latest build from [Releases](https://github.com/MindFabric/manifold/releases/latest) for your platform.

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and available on your `PATH`
- Windows users: [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) with Claude Code installed inside it

### Linux

```bash
# AppImage
chmod +x Manifold-*.AppImage
./Manifold-*.AppImage

# Or install the .deb
sudo dpkg -i manifold_*.deb
```

### macOS

Open the `.dmg` and drag Manifold to Applications.

### Windows

Run the `.exe` installer, or use the portable `.exe` directly.

## Build from source

```bash
git clone https://github.com/MindFabric/manifold.git
cd manifold
npm install
npm start              # run in development
npm run build:linux    # package for Linux
npm run build:mac      # package for macOS
npm run build:win      # package for Windows
```

Requires Node.js 20+ and npm.

## Configuration

| Environment variable | Default | Description |
|---------------------|---------|-------------|
| `MANIFOLD_CMD` | `claude --dangerously-skip-permissions` | Shell command launched in each terminal session |

## How the journal works

Every terminal's output is captured in a ring buffer (last 400 lines). Every 5 minutes, the accumulated activity is grouped by project and sent to Claude for summarization. The result is appended to `~/Documents/journal/YYYY-MM/YYYY-MM-DD.md` as timestamped bullet points describing what you accomplished — not raw commands, but a readable log of your work.

## Tech stack

- [Electron](https://www.electronjs.org/) — app shell
- [xterm.js](https://xtermjs.org/) — terminal emulation
- [node-pty](https://github.com/microsoft/node-pty) — pseudo-terminal spawning
- [electron-builder](https://www.electron.build/) — packaging and distribution

## License

MIT
