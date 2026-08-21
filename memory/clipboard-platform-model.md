---
name: clipboard-platform-model
description: How Manifold's copy/paste must be wired per-platform, and the macOS menu-role gotcha
metadata:
  type: project
---

Manifold's copy/paste is split by platform because the constraints genuinely differ. Do NOT "simplify" this back into one path.

**macOS gotcha (the bug we fixed 2026-08-19):** macOS text inputs get their Cmd+C/V/X behavior *from the Edit menu's roles*. Removing `role:'paste'`/`role:'cut'` to protect the terminal's Ctrl+C (SIGINT) killed paste in SSH form fields AND the terminal. On macOS, Cmd (clipboard) and Ctrl (SIGINT) are different keys — they never conflict, so menu roles are safe there.

**The model:**
- macOS: Edit menu uses `role:'cut'` (Cmd+X) and `role:'paste'` (Cmd+V) — works for fields and, for paste, rides xterm's own native paste listener. Cmd+C is owned by the renderer (`copyContextAware` in handleAppShortcut) with `registerAccelerator:false` on the menu item, because xterm's selection isn't a DOM selection so a copy role can't read it.
- Win/Linux: ALL Edit menu items are click-only, NO registered accelerators (any Ctrl accel — Ctrl+C/X/A/Z — would be stolen from the terminal). Fields get native Chromium editing without the menu. Terminal copy/paste = Ctrl+Shift+C / Ctrl+Shift+V.
- Terminal copy always goes getSelection() → main-process clipboard via IPC (`clipboard-read`/`clipboard-write`); clipboard module lives in main because sandboxed preload lacks it on Windows.

Files: menu in `main.js` (editMenu, IS_MAC branch), dispatch in `renderer.js` (Clipboard section: copy/paste/cut/selectAllContextAware + handleAppShortcut), channels in `preload.js` (onMenuCopy/Paste/Cut/SelectAll).
