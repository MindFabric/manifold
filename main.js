const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const journal = require('./journal');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Set Linux WM_CLASS so desktop environment uses our icon
if (!IS_WIN && !IS_MAC) app.setName('claude-sidebar');

const CLAUDE_CMD = process.env.CLAUDE_SIDEBAR_CMD || 'claude --dangerously-skip-permissions';
const STATE_DIR = path.join(app.getPath('userData'), 'state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

let mainWindow = null;
const terminals = new Map();

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
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    frame: false,
    icon: path.join(__dirname, 'icon.png'),
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
    try { term.pty.kill(); } catch (_) {}
  }
  terminals.clear();
}

// ── Environment ──

ipcMain.handle('get-home-dir', () => os.homedir());
ipcMain.handle('get-platform', () => process.platform);

// ── Terminal management ──

ipcMain.handle('terminal-create', (event, { id, cwd, conversationId, name }) => {
  const home = os.homedir();
  const dir = cwd || home;

  const cleanEnv = { ...process.env, HOME: home };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  // Build Claude command: --resume <id> if we have a conversation ID, otherwise fresh
  let claudeArgs = CLAUDE_CMD;
  if (conversationId) {
    claudeArgs += ` --resume "${conversationId}"`;
  }

  // Snapshot existing conversations before launching
  const projectDir = getProjectDir(dir);
  const beforeConvos = new Set(listConversations(projectDir));

  let ptyProcess;

  if (IS_WIN) {
    const wslDir = winToWslPath(dir);
    const claudeArg = `cd "${wslDir}" && ${claudeArgs}; exec bash`;
    ptyProcess = pty.spawn('wsl.exe', ['bash', '-c', claudeArg], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: dir,
      env: cleanEnv,
    });
  } else {
    const shell = process.env.SHELL || '/bin/bash';
    const cmd = `cd "${dir}" && ${claudeArgs}`;
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

  ptyProcess.onData((data) => {
    const now = Date.now();
    if (now - windowStart > 2000) {
      dataBytes = 0;
      windowStart = now;
    }
    dataBytes += data.length;

    // Feed journal with terminal output
    journal.feed(id, name || id, data);

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

  // Poll for new conversation file if we don't already have an ID
  let convoCheck = null;
  if (!conversationId) {
    let checks = 0;
    convoCheck = setInterval(() => {
      checks++;
      const afterConvos = listConversations(projectDir);
      const newConvos = afterConvos.filter(c => !beforeConvos.has(c));
      if (newConvos.length > 0) {
        // Pick the newest (most recently modified)
        let newest = newConvos[0];
        let newestTime = 0;
        for (const c of newConvos) {
          try {
            const stat = fs.statSync(path.join(projectDir, c + '.jsonl'));
            if (stat.mtimeMs > newestTime) { newestTime = stat.mtimeMs; newest = c; }
          } catch (_) {}
        }
        detectedConvoId = newest;
        const term = terminals.get(id);
        if (term) term.conversationId = newest;
        clearInterval(convoCheck);
      }
      if (checks > 30) clearInterval(convoCheck); // Stop after 30s
    }, 1000);
  }

  terminals.set(id, {
    pty: ptyProcess,
    alive: true,
    conversationId: detectedConvoId,
    beforeConvos,
    projectDir,
    convoCheck,
    isWorking: () => {
      return dataBytes > 500 && (Date.now() - windowStart) < 3000;
    },
  });
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
    if (term.convoCheck) clearInterval(term.convoCheck);
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

  // Lazy detection: check for new conversation files since launch
  if (term.beforeConvos && term.projectDir) {
    const afterConvos = listConversations(term.projectDir);
    const newConvos = afterConvos.filter(c => !term.beforeConvos.has(c));
    if (newConvos.length > 0) {
      // Pick the most recently modified
      let newest = newConvos[0];
      let newestTime = 0;
      for (const c of newConvos) {
        try {
          const stat = fs.statSync(path.join(term.projectDir, c + '.jsonl'));
          if (stat.mtimeMs > newestTime) { newestTime = stat.mtimeMs; newest = c; }
        } catch (_) {}
      }
      term.conversationId = newest;
      return newest;
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
    return JSON.parse(data);
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
  journal.start();

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
