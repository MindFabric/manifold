<p align="center">
  <img src="assets/icon.png" alt="Manifold" width="128" height="128">
</p>

<h1 align="center">Manifold</h1>

<p align="center">
  A workspace manager for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>. Run multiple sessions in parallel, organize them into collections, and monitor everything in grid view.
</p>

<p align="center">
  <img src="screenshots/Screenshot From 2026-02-28 11-12-05.png" alt="Manifold grid view" width="900">
</p>

---

## Getting started

```bash
git clone https://github.com/MindFabric/manifold.git && cd manifold && npm install && npm start
```

That's it. Clone, install, run — one line.

## Features

**Terminal multiplexing** — Run many Claude Code sessions at once, organized into named collections (one per project, or however you like). Each session gets its own pseudo-terminal with 5000 lines of scrollback.

**Grid view** — Press `Ctrl+G` to see every session in the active collection rendered simultaneously. Great for watching a build, tests, and a dev server at the same time.

**GPU-accelerated rendering** — Terminals use WebGL when available, with automatic fallback to Canvas2D. Software renderers (llvmpipe/SwiftShader) are detected and skipped.

**Conversation tracking** — Manifold detects when Claude Code starts a new conversation and saves the ID. Close a tab, reopen it later, and you can resume exactly where you left off.

**State persistence** — Collections, tabs, working directories, conversation IDs, and UI preferences are saved automatically and restored on launch.

**Cross-platform** — Native builds for Linux (.deb), macOS (.dmg), and Windows (.exe). Windows runs Claude Code through WSL.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New session in active collection |
| `Ctrl+Y` | New collection (opens folder picker) |
| `Ctrl+W` | Close active session |
| `Ctrl+G` | Toggle grid view |
| `Alt+Up/Down` | Jump between collections |
| `Alt+Left/Right` | Cycle sessions within collection |
| `Alt+1-9` / `Ctrl+1-9` | Jump to session N |
| `Ctrl+Shift+C` | Copy from terminal |
| `Ctrl+Shift+V` | Paste into terminal |
| `Escape` | Close overlays |

On macOS, `Cmd` replaces `Ctrl` where applicable.

## Tech stack

- [Electron](https://www.electronjs.org/) — app shell
- [xterm.js](https://xtermjs.org/) — terminal emulation (with WebGL/Canvas addons)
- [node-pty](https://github.com/microsoft/node-pty) — pseudo-terminal spawning
- [electron-builder](https://www.electron.build/) — packaging and distribution

## License

MIT
