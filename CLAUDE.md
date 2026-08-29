# Manifold — Claude Code Workspace Manager

An Electron app that runs multiple Claude Code sessions in parallel with collections, grid view, auto-naming, and conversation tracking.

## Architecture

5 core files, no framework, vanilla JS:

| File | Role |
|------|------|
| `main.js` | Electron main process: window, IPC, node-pty terminals, state persistence |
| `preload.js` | Context bridge — exposes `claude` IPC API to renderer. **Do not edit** (overwritten on reload) |
| `renderer.js` | All client-side logic: collections, tabs, grid view, keybindings, auto-naming |
| `styles.css` | Dark theme, layout, grid |
| `index.html` | HTML shell |

## Key Patterns

- **State**: Saved to `userData/state/state.json`, auto-restored on launch
- **Terminals**: `node-pty` spawns, tracked in `Map` by tab ID
- **Conversations**: Detected by watching `~/.claude/projects/<encoded-path>/*.jsonl`
- **IPC**: All renderer↔main communication through `preload.js` bridge

## Style

- Accent: `#D97757` (orange)
- Background: `#1a1a1a`
- Font: Share Tech Mono
- Keep it minimal — no frameworks, no abstractions

## Commands

```bash
npm start          # Run in dev mode
npm run build:linux   # Build .deb
npm run build:mac     # Build .dmg
npm run build:win     # Build .exe
```

## CI/CD

GitHub Actions workflow at `.github/workflows/release.yml`:
- Triggered on `v*` tags
- Builds for all 3 platforms
- Publishes to public repo MindFabric/manifold-releases using `RELEASE_TOKEN`

## Repos

- Private: `MindFabric/manifold`
- Public releases: `MindFabric/manifold-releases`
