<p align="center">
  <img src="assets/icon.png" alt="Manifold" width="128" height="128">
</p>

<h1 align="center">Manifold</h1>

<p align="center">
  <strong>Workspace manager for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a></strong><br>
  Run parallel AI coding sessions, organize by project, connect to remotes, and watch it all in grid view.
</p>

<p align="center">
  <img src="screenshots/Screenshot From 2026-02-28 11-12-05.png" alt="Manifold grid view" width="900">
</p>

<p align="center">
  <a href="#getting-started">Getting Started</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#keyboard-shortcuts">Shortcuts</a> &middot;
  <a href="#building">Building</a>
</p>

---

## Getting Started

```bash
git clone https://github.com/MindFabric/manifold.git && cd manifold && npm install && npm start
```

> Requires [Node.js 20+](https://nodejs.org/) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed globally.

## Features

### Sessions & Collections
Organize your work into **collections** — one per project, repo, or however you like. Each collection holds multiple sessions that persist across restarts. Double-click to rename.

### Multi-Provider Support
Launch **Claude Code** or **GitHub Copilot** sessions from the same workspace. Set your preferred default in Settings and switch per-session from the add menu.

### Grid View
Toggle grid view with `Ctrl+G` to see every session in a collection at once. Perfect for monitoring builds, tests, and dev servers side by side.

### Context Forking
Press `Ctrl+Shift+F` to fork the active session. Manifold copies the conversation history and opens both the original and fork in grid view — branch your thinking without losing context.

### Remote Sessions (SSH & Tailscale)
Connect to remote machines over SSH or Tailscale directly from the Settings panel. Add a remote, browse its filesystem, and launch sessions that run on the remote host with automatic SSH reconnection on disconnect.

### Shell Terminals & Custom Commands
Not everything needs an AI. Add plain shell terminals (`Ctrl+Shift+T`) or save custom commands per collection (e.g. `docker compose up`, `npm run dev`) for one-click launch.

### Session Resume
Manifold tracks conversation IDs automatically. Close the app, come back later, and every session picks up where it left off.

### Settings & Customization
- **UI Scale** — slider from 50% to 200%
- **Default session source** — Claude, Copilot, or plain terminal
- **Remote management** — add, edit, and remove SSH/Tailscale remotes
- **Factory reset** — wipe all state and start fresh

### GPU-Accelerated Rendering
Terminals use WebGL when available, with automatic fallback to Canvas2D. Software renderers (llvmpipe/SwiftShader) are detected and skipped.

### Cross-Platform
Native builds for Linux (.deb), macOS (.dmg), and Windows (.exe). Windows runs Claude Code through WSL.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New session (default source) |
| `Ctrl+Shift+T` | New shell terminal |
| `Ctrl+Y` | New collection |
| `Ctrl+Shift+F` | Fork session |
| `Ctrl+W` | Close session |
| `Ctrl+G` | Toggle grid view |
| `Ctrl+1-9` | Jump to session N |
| `Alt+Up/Down` | Jump between collections |
| `Alt+Left/Right` | Cycle sessions |
| `Ctrl+Shift+C/V` | Copy / Paste |
| `Ctrl+Shift+A` | Select all (terminal) |

> On macOS, `Cmd` replaces `Ctrl`.

## Building

```bash
npm run build:linux   # .deb
npm run build:mac     # .dmg
npm run build:win     # .exe
```

On WSL, you can build and install the Windows exe in one step:

```bash
bash install.sh
```

## Tech Stack

- [Electron](https://www.electronjs.org/) — app shell
- [xterm.js](https://xtermjs.org/) — terminal emulation with WebGL/Canvas addons
- [node-pty](https://github.com/microsoft/node-pty) — pseudo-terminal spawning
- [electron-builder](https://www.electron.build/) — packaging & distribution

Vanilla JS, no frameworks, five core files. See [CLAUDE.md](CLAUDE.md) for architecture details.

## License

MIT
