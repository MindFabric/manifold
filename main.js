const { app, BrowserWindow, ipcMain, dialog, Menu, screen, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Set Linux WM_CLASS so desktop environment uses our icon
if (!IS_WIN && !IS_MAC) app.setName('manifold');

const TOOL_CMD = 'claude --dangerously-skip-permissions';

const STATE_DIR = path.join(app.getPath('userData'), 'state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

let mainWindow = null;
const terminals = new Map();

// ── Platform helpers ──

function winToWslPath(winPath) {
  if (!winPath || !IS_WIN) return winPath;
  const m = winPath.match(/^([A-Za-z]):[/\\](.*)/);
  if (!m) return winPath;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

function getToolCmd() {
  return process.env.MANIFOLD_CMD || TOOL_CMD;
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
    if (term.flushInterval) clearInterval(term.flushInterval);
    try { term.pty.kill(); } catch (_) {}
  }
  terminals.clear();
}

// ── Environment ──

ipcMain.handle('get-home-dir', () => os.homedir());
ipcMain.handle('get-platform', () => process.platform);

// ── Terminal management ──

ipcMain.handle('terminal-create', (event, { id, cwd, conversationId, name, collectionName, prompt }) => {
  const home = os.homedir();
  const dir = cwd || home;

  const cleanEnv = { ...process.env, HOME: home };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  // Build tool command with resume support
  let toolArgs;
  let initialPrompt = prompt || null;
  if (conversationId) {
    toolArgs = `${getToolCmd()} --resume "${conversationId}"`;
  } else {
    toolArgs = getToolCmd();
  }

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

  // ── Data batching: accumulate PTY output, flush every 16ms ──
  // Use array + join instead of string concat to avoid O(n²) allocation
  let chunks = [];
  let chunkBytes = 0;

  ptyProcess.onData((data) => {
    chunks.push(data);
    chunkBytes += data.length;
  });

  const flushInterval = setInterval(() => {
    if (chunkBytes > 0 && mainWindow && !mainWindow.isDestroyed()) {
      const batch = chunks.length === 1 ? chunks[0] : chunks.join('');
      chunks = [];
      chunkBytes = 0;
      mainWindow.webContents.send('terminal-data', { id, data: batch });
    }
  }, 16);

  ptyProcess.onExit(() => {
    const term = terminals.get(id);
    if (term) {
      term.alive = false;
      if (term.flushInterval) clearInterval(term.flushInterval);
    }
  });

  // Conversation ID detection (watches ~/.claude/projects/ for new .jsonl files)
  const projectDir = getProjectDir(dir);
  const beforeConvos = new Set(listConversations(projectDir));
  const spawnTime = Date.now();
  let detectedConvoId = conversationId || null;

  let convoCheck = null;
  if (!conversationId) {
    let checks = 0;
    convoCheck = setInterval(() => {
      checks++;
      const afterConvos = listConversations(projectDir);
      const newConvos = afterConvos.filter(c => !beforeConvos.has(c));
      if (newConvos.length > 0) {
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
        const term = terminals.get(id);
        if (term) term.conversationId = best;
        clearInterval(convoCheck);
      }
      if (checks > 30) clearInterval(convoCheck);
    }, 1000);
  }

  terminals.set(id, {
    pty: ptyProcess,
    alive: true,
    conversationId: detectedConvoId,
    spawnTime,
    beforeConvos,
    projectDir,
    convoCheck,
    flushInterval,
  });

  // If there's an initial prompt, wait for Claude to start then type it in
  if (initialPrompt) {
    let prompted = false;
    let dataCount = 0;
    const onData = (data) => {
      dataCount += data.length;
      if (!prompted && dataCount > 100) {
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
    if (term.convoCheck) clearInterval(term.convoCheck);
    if (term.flushInterval) clearInterval(term.flushInterval);
    try { term.pty.kill(); } catch (_) {}
    terminals.delete(id);
  }
});

ipcMain.handle('terminal-is-active', (event, { id }) => {
  const term = terminals.get(id);
  return !!(term && term.alive);
});

// Get the detected conversation ID for a terminal
ipcMain.handle('terminal-get-conversation-id', (event, { id }) => {
  const term = terminals.get(id);
  if (!term) return null;

  if (term.conversationId) return term.conversationId;

  // Lazy detection: check for new conversation files since launch
  if (term.beforeConvos && term.projectDir) {
    const afterConvos = listConversations(term.projectDir);
    const newConvos = afterConvos.filter(c => !term.beforeConvos.has(c));
    if (newConvos.length > 0) {
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
      return best;
    }
  }

  return null;
});

// ── Conversation tracking helpers ──

function getProjectDir(cwd) {
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
  if (!IS_MAC) app.quit();
});

app.on('will-quit', () => {
  destroyAllTerminals();
});
