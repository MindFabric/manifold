const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Menu, screen, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const journal = require('./journal');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Set Linux WM_CLASS so desktop environment uses our icon
if (!IS_WIN && !IS_MAC) app.setName('manifold');

const { execSync, exec } = require('child_process');

// ── Tool configuration registry ──

const TOOL_CONFIGS = {
  claude: {
    name: 'Claude Code',
    binary: 'claude',
    installCmd: 'npm i -g @anthropic-ai/claude-code',
    autoApproveFlag: '--dangerously-skip-permissions',
    buildResumeArgs: (id) => `--resume "${id}"`,
    promptFlag: '-p',
    conversationTracking: true,
  },
  gemini: {
    name: 'Gemini CLI',
    binary: 'gemini',
    installCmd: 'npm i -g @google/gemini-cli',
    autoApproveFlag: '--approval-mode=yolo',
    buildResumeArgs: (id) => `--resume "${id}"`,
    promptFlag: null,
    conversationTracking: false,
  },
  codex: {
    name: 'Codex CLI',
    binary: 'codex',
    installCmd: 'npm i -g codex',
    autoApproveFlag: '--full-auto',
    buildResumeArgs: () => null,
    buildResumeCmd: (id) => `codex resume "${id}"`,
    promptFlag: null,
    conversationTracking: false,
  },
};

let selectedToolKey = null;

function getToolConfig() {
  return TOOL_CONFIGS[selectedToolKey] || TOOL_CONFIGS.claude;
}

function getToolCmd() {
  if (process.env.MANIFOLD_CMD) return process.env.MANIFOLD_CMD;
  const tool = getToolConfig();
  return `${tool.binary} ${tool.autoApproveFlag}`;
}

const STATE_DIR = path.join(app.getPath('userData'), 'state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

let mainWindow = null;
const terminals = new Map();
const claimedConversations = new Set(); // prevent two terminals from claiming the same conversation

// ── Conversation tracking ──
// Claude stores conversations in ~/.claude/projects/<encoded-path>/<uuid>.jsonl
// We detect new conversation files after launching Claude to track per-tab IDs.

function getProjectDir(cwd) {
  // Claude encodes project paths: /home/user → -home-user
  const encoded = cwd.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

function listConversations(projectDir) {
  try {
    return fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''));
  } catch (_) {
    return [];
  }
}

// ── Platform helpers ──

function winToWslPath(winPath) {
  if (!winPath || !IS_WIN) return winPath;
  const m = winPath.match(/^([A-Za-z]):[/\\](.*)/);
  if (!m) return winPath;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

function createWindow() {
  const primary = screen.getPrimaryDisplay();
  const { x, y, width, height } = primary.workArea;

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    icon: nativeImage.createFromPath(path.join(__dirname, 'icon.png')),
    backgroundColor: '#1a1a1a',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.maximize();

  mainWindow.on('focus', () => {
    mainWindow.webContents.send('window-focus');
  });

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.webContents.send('save-state');
    setTimeout(() => {
      destroyAllTerminals();
      mainWindow.destroy();
    }, 300);
  });
}

function destroyAllTerminals() {
  for (const [id, term] of terminals) {
    if (term.convoCheck) clearInterval(term.convoCheck);
    if (term.autoNameTimer) clearTimeout(term.autoNameTimer);
    try { term.pty.kill(); } catch (_) {}
  }
  terminals.clear();
}

// ── Environment ──

ipcMain.handle('get-home-dir', () => os.homedir());
ipcMain.handle('get-platform', () => process.platform);

// ── Tool detection and installation ──

ipcMain.handle('detect-tools', async () => {
  const whichCmd = IS_WIN ? 'where' : 'which';
  const results = {};
  for (const [key, config] of Object.entries(TOOL_CONFIGS)) {
    try {
      execSync(`${whichCmd} ${config.binary}`, { stdio: 'ignore', timeout: 5000 });
      results[key] = true;
    } catch (_) {
      results[key] = false;
    }
  }
  return results;
});

ipcMain.handle('install-tool', async (event, toolKey) => {
  const config = TOOL_CONFIGS[toolKey];
  if (!config) return { success: false, error: 'Unknown tool' };
  return new Promise((resolve) => {
    exec(config.installCmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) resolve({ success: false, error: stderr || err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('set-selected-tool', (event, toolKey) => {
  if (!TOOL_CONFIGS[toolKey]) return false;
  selectedToolKey = toolKey;
  return true;
});

ipcMain.handle('get-tool-configs', () => {
  const configs = {};
  for (const [key, config] of Object.entries(TOOL_CONFIGS)) {
    configs[key] = { name: config.name, binary: config.binary };
  }
  return configs;
});

// ── Auto-naming ──

async function autoNameSession(id) {
  const tool = getToolConfig();
  if (!tool.promptFlag) return; // tool doesn't support piped prompts

  const lines = journal.getBufferLines(id);
  if (!lines || lines.length < 5) return; // not enough content yet

  const context = lines.join('\n');
  const prompt = `Given this terminal session output, generate a very short name (2-4 words, lowercase) describing what's being worked on. Examples: "auth bug fix", "api refactor", "test suite", "db migration". Reply with ONLY the name, nothing else.\n\n${context}`;

  try {
    const result = await journal.callTool(prompt, tool.binary, tool.promptFlag);
    const name = result.trim().replace(/["\n]/g, '').substring(0, 40);
    if (name && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-auto-name', { id, name });
    }
  } catch (_) {
    // Silent fail - auto-naming is best-effort
  }
}

// ── Terminal management ──

ipcMain.handle('terminal-create', (event, { id, cwd, conversationId, name, collectionName, prompt }) => {
  const home = os.homedir();
  const dir = cwd || home;
  const tool = getToolConfig();

  const cleanEnv = { ...process.env, HOME: home };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  // Build tool command with resume support or prompt mode
  let toolArgs;
  let initialPrompt = prompt || null; // sent as first input after spawn
  if (conversationId && tool.buildResumeCmd) {
    // Codex-style: entirely different command for resume
    toolArgs = tool.buildResumeCmd(conversationId);
  } else if (conversationId && tool.buildResumeArgs) {
    const resumePart = tool.buildResumeArgs(conversationId);
    toolArgs = resumePart ? `${getToolCmd()} ${resumePart}` : getToolCmd();
  } else {
    toolArgs = getToolCmd();
  }

  // Conversation tracking (Claude-only: watches ~/.claude/projects/)
  const shouldTrackConvos = tool.conversationTracking;
  const projectDir = shouldTrackConvos ? getProjectDir(dir) : null;
  const beforeConvos = shouldTrackConvos ? new Set(listConversations(projectDir)) : new Set();

  let ptyProcess;

  if (IS_WIN) {
    const wslDir = winToWslPath(dir);
    const shellCmd = `cd "${wslDir}" && ${toolArgs}; exec bash`;
    ptyProcess = pty.spawn('wsl.exe', ['bash', '-c', shellCmd], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: dir,
      env: cleanEnv,
    });
  } else {
    const shell = process.env.SHELL || '/bin/bash';
    const cmd = `cd "${dir}" && ${toolArgs}`;
    ptyProcess = pty.spawn(shell, ['-c', `${cmd}; exec ${shell}`], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: dir,
      env: cleanEnv,
    });
  }

  let dataBytes = 0;
  let windowStart = Date.now();
  let detectedConvoId = conversationId || null;
  const spawnTime = Date.now();

  // Claim the conversation ID so no other terminal can steal it
  if (conversationId) claimedConversations.add(conversationId);

  ptyProcess.onData((data) => {
    const now = Date.now();
    if (now - windowStart > 2000) {
      dataBytes = 0;
      windowStart = now;
    }
    dataBytes += data.length;

    // Feed journal with terminal output
    journal.feed(id, name || id, collectionName || path.basename(dir), data);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', { id, data });
    }
  });

  ptyProcess.onExit(() => {
    const term = terminals.get(id);
    if (term) {
      term.alive = false;
      if (term.convoCheck) clearInterval(term.convoCheck);
    }
  });

  // Poll for new conversation file if we don't already have an ID (Claude-only)
  let convoCheck = null;
  if (!conversationId && shouldTrackConvos) {
    let checks = 0;
    convoCheck = setInterval(() => {
      checks++;
      const afterConvos = listConversations(projectDir);
      // Filter to conversations that are new AND not claimed by another terminal
      const newConvos = afterConvos.filter(c => !beforeConvos.has(c) && !claimedConversations.has(c));
      if (newConvos.length > 0) {
        // Pick the conversation created closest to (but after) this terminal's spawn time
        let best = newConvos[0];
        let bestTime = Infinity;
        for (const c of newConvos) {
          try {
            const stat = fs.statSync(path.join(projectDir, c + '.jsonl'));
            const age = Math.abs(stat.birthtimeMs - spawnTime);
            if (age < bestTime) { bestTime = age; best = c; }
          } catch (_) {}
        }
        detectedConvoId = best;
        claimedConversations.add(best);
        const term = terminals.get(id);
        if (term) term.conversationId = best;
        clearInterval(convoCheck);
      }
      if (checks > 30) clearInterval(convoCheck);
    }, 1000);
  }

  // Auto-name: after 30s, if the session still has a default name
  let autoNameTimer = null;
  const isDefaultName = !name || /^Session \d+$/i.test(name);
  if (isDefaultName && tool.promptFlag) {
    autoNameTimer = setTimeout(() => {
      autoNameSession(id);
    }, 30000);
  }

  terminals.set(id, {
    pty: ptyProcess,
    alive: true,
    conversationId: detectedConvoId,
    spawnTime,
    beforeConvos,
    projectDir,
    convoCheck,
    autoNameTimer,
    isWorking: () => {
      return dataBytes > 500 && (Date.now() - windowStart) < 3000;
    },
  });

  // If there's an initial prompt, wait for Claude to start then type it in
  if (initialPrompt) {
    let prompted = false;
    const onData = (data) => {
      // Wait for Claude's input prompt ("> " or the cursor waiting for input)
      if (!prompted && dataBytes > 100) {
        prompted = true;
        ptyProcess.removeListener('data', onData);
        setTimeout(() => {
          ptyProcess.write(initialPrompt + '\r');
        }, 500);
      }
    };
    ptyProcess.on('data', onData);
  }

  return { id };
});

ipcMain.on('terminal-input', (event, { id, data }) => {
  const term = terminals.get(id);
  if (term && term.alive) {
    term.pty.write(data);
  }
});

ipcMain.on('terminal-resize', (event, { id, cols, rows }) => {
  const term = terminals.get(id);
  if (term && term.alive) {
    try { term.pty.resize(cols, rows); } catch (_) {}
  }
});

ipcMain.on('terminal-destroy', (event, { id }) => {
  const term = terminals.get(id);
  if (term) {
    if (term.conversationId) claimedConversations.delete(term.conversationId);
    if (term.convoCheck) clearInterval(term.convoCheck);
    if (term.autoNameTimer) clearTimeout(term.autoNameTimer);
    try { term.pty.kill(); } catch (_) {}
    terminals.delete(id);
    journal.removeTerminal(id);
  }
});

ipcMain.handle('terminal-is-active', (event, { id }) => {
  const term = terminals.get(id);
  if (!term) return false;
  return term.isWorking();
});

// Get the detected conversation ID for a terminal (with lazy detection)
ipcMain.handle('terminal-get-conversation-id', (event, { id }) => {
  const term = terminals.get(id);
  if (!term) return null;

  // If we already have it, return it
  if (term.conversationId) return term.conversationId;

  // Lazy detection: check for new conversation files since launch (exclude already-claimed)
  if (term.beforeConvos && term.projectDir) {
    const afterConvos = listConversations(term.projectDir);
    const newConvos = afterConvos.filter(c => !term.beforeConvos.has(c) && !claimedConversations.has(c));
    if (newConvos.length > 0) {
      // Pick the conversation created closest to this terminal's spawn time
      let best = newConvos[0];
      let bestTime = Infinity;
      for (const c of newConvos) {
        try {
          const stat = fs.statSync(path.join(term.projectDir, c + '.jsonl'));
          const age = Math.abs(stat.birthtimeMs - (term.spawnTime || 0));
          if (age < bestTime) { bestTime = age; best = c; }
        } catch (_) {}
      }
      term.conversationId = best;
      claimedConversations.add(best);
      return best;
    }
  }

  return null;
});

// ── State persistence ──

ipcMain.handle('save-state', (event, state) => {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save state:', e);
    return false;
  }
});

ipcMain.handle('load-state', () => {
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed && parsed.selectedTool && TOOL_CONFIGS[parsed.selectedTool]) {
      selectedToolKey = parsed.selectedTool;
    }
    return parsed;
  } catch (e) {
    return null;
  }
});

// ── Journal ──

// List all journal dates that have .md files -> ['2026-02-17', '2026-02-16', ...]
// Scans month subdirectories: journal/YYYY-MM/YYYY-MM-DD.md
ipcMain.handle('journal-list-dates', () => {
  try {
    fs.mkdirSync(journal.JOURNAL_DIR, { recursive: true });
    const dates = [];
    const monthDirs = fs.readdirSync(journal.JOURNAL_DIR)
      .filter(d => /^\d{4}-\d{2}$/.test(d));
    for (const monthDir of monthDirs) {
      const full = path.join(journal.JOURNAL_DIR, monthDir);
      try {
        const files = fs.readdirSync(full)
          .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
        for (const f of files) {
          dates.push(f.replace('.md', ''));
        }
      } catch (_) {}
    }
    return dates.sort().reverse();
  } catch (_) {
    return [];
  }
});

// Read a specific journal file by date string 'YYYY-MM-DD'
ipcMain.handle('journal-read', (event, dateStr) => {
  try {
    const monthDir = dateStr.substring(0, 7); // 'YYYY-MM'
    const filePath = path.join(journal.JOURNAL_DIR, monthDir, `${dateStr}.md`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch (_) {
    return null;
  }
});

// Weekly export: collect last 7 days of journal entries, summarize into a clean report
ipcMain.handle('journal-weekly-export', async () => {
  const tool = getToolConfig();
  const today = new Date();
  const entries = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    const filePath = path.join(journal.JOURNAL_DIR, `${year}-${month}`, `${dateStr}.md`);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        entries.push({ date: dateStr, content });
      }
    } catch (_) {}
  }

  if (entries.length === 0) {
    return { success: false, error: 'No journal entries in the last 7 days.' };
  }

  // Build date range label
  const oldest = entries[entries.length - 1].date;
  const newest = entries[0].date;

  const rawContent = entries
    .reverse()
    .map(e => e.content)
    .join('\n\n---\n\n');

  // If tool supports prompt mode, summarize; otherwise return raw
  if (tool.promptFlag) {
    const prompt = `You are writing a weekly development summary report. Below are daily dev journal entries from the past week. Produce a clean, well-structured markdown report with:

1. A title: "# Weekly Report: ${oldest} to ${newest}"
2. An "## Overview" section with a 2-3 sentence summary of the week
3. A "## Projects" section grouping work by project with bullet points of key accomplishments
4. A "## Key Changes" section listing the most significant files, features, or fixes touched
5. Keep it concise — this is a summary, not a copy of the raw entries

Raw journal entries:

${rawContent}`;

    try {
      const result = await journal.callTool(prompt, tool.binary, tool.promptFlag);
      return { success: true, markdown: result.trim(), startDate: oldest, endDate: newest };
    } catch (err) {
      // Fallback to raw if summarization fails
      const fallback = `# Weekly Report: ${oldest} to ${newest}\n\n${rawContent}`;
      return { success: true, markdown: fallback, startDate: oldest, endDate: newest };
    }
  } else {
    // No prompt support — return raw entries as-is
    const fallback = `# Weekly Report: ${oldest} to ${newest}\n\n${rawContent}`;
    return { success: true, markdown: fallback, startDate: oldest, endDate: newest };
  }
});

// (GSD orchestration removed — now uses native /gsd:* slash commands in-terminal)

// ── Folder picker ──

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'New Collection — Select Project Folder',
    defaultPath: os.homedir(),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ── App lifecycle ──

app.whenReady().then(() => {
  const editMenu = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  };

  if (IS_MAC) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      editMenu,
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { role: 'close' },
        ],
      },
    ]));
  } else {
    Menu.setApplicationMenu(Menu.buildFromTemplate([editMenu]));
  }

  createWindow();
  journal.start(getToolConfig);

  const toggleKey = IS_MAC ? 'Command+Shift+C' : 'Super+C';
  globalShortcut.register(toggleKey, () => {
    if (mainWindow.isVisible()) {
      mainWindow.webContents.send('save-state');
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.maximize();
      mainWindow.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (!IS_MAC) app.quit();
});

app.on('will-quit', () => {
  journal.stop();
  destroyAllTerminals();
  globalShortcut.unregisterAll();
});
