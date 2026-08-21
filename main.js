const { app, BrowserWindow, ipcMain, dialog, Menu, screen, nativeImage, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const crypto = require('crypto');
const { exec } = require('child_process');

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
    // Wait for renderer to confirm save, with a safety timeout
    ipcMain.once('save-state-done', () => {
      destroyAllTerminals();
      mainWindow.destroy();
    });
    setTimeout(() => {
      destroyAllTerminals();
      mainWindow.destroy();
    }, 2000);
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

// Clipboard — must go through main process because sandboxed preload scripts
// don't have access to Electron's clipboard module on Windows.
ipcMain.handle('clipboard-read', () => {
  try { return clipboard.readText(); } catch (e) { return ''; }
});
ipcMain.handle('clipboard-write', (_, text) => {
  try { clipboard.writeText(text); } catch (_) {}
});

// ── SSH helpers ──

function sendTerminalMsg(id, msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal-data', { id, data: `\r\n\x1b[33m[SSH] ${msg}\x1b[0m\r\n` });
  }
}

function buildRemoteCmd(sshParams) {
  const { remotePath, shellOnly, customCmd, conversationId } = sshParams;
  if (shellOnly) return `cd "${remotePath}"`;
  if (customCmd) return `cd "${remotePath}" && ${customCmd}`;
  const toolArgs = conversationId ? `${getToolCmd()} --resume ${conversationId}` : getToolCmd();
  return `cd "${remotePath}" && ${toolArgs}`;
}

function spawnSshPty(id, sshParams) {
  const { remote, cleanEnv } = sshParams;
  const parts = remote.trim().split(/\s+/);
  const sshBin = parts[0];
  const sshTargetArgs = parts.slice(1);
  const remoteCmd = buildRemoteCmd(sshParams);

  // Add ServerAliveInterval to detect dead connections faster
  const sshOpts = ['-t', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

  const ptyProcess = IS_WIN
    ? pty.spawn('wsl.exe', [sshBin, ...sshOpts, ...sshTargetArgs], {
        name: 'xterm-256color', cols: 120, rows: 30, env: cleanEnv,
      })
    : pty.spawn(sshBin, [...sshOpts, ...sshTargetArgs], {
        name: 'xterm-256color', cols: 120, rows: 30, env: cleanEnv,
      });

  // After SSH connects, send the cd + command
  let sshReady = false;
  let sshDataCount = 0;
  const onSshData = (data) => {
    sshDataCount += data.length;
    if (!sshReady && sshDataCount > 20) {
      sshReady = true;
      ptyProcess.removeListener('data', onSshData);
      setTimeout(() => {
        try { ptyProcess.write(remoteCmd + '\r'); } catch (_) {}
      }, 300);
    }
  };
  ptyProcess.on('data', onSshData);

  return ptyProcess;
}

function wireUpSshPty(id, ptyProcess, sshParams) {
  const term = terminals.get(id);
  if (!term) return;

  // Clean up old flush interval
  if (term.flushInterval) clearInterval(term.flushInterval);

  // Set up data batching for this pty
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

  // Handle exit — attempt reconnection
  ptyProcess.onExit(() => {
    const t = terminals.get(id);
    if (!t || t.sshDead) return; // already handling reconnect or terminal was destroyed
    t.alive = false;
    if (t.flushInterval) clearInterval(t.flushInterval);
    attemptSshReconnect(id, sshParams, 0);
  });

  // Update terminal entry
  term.pty = ptyProcess;
  term.alive = true;
  term.flushInterval = flushInterval;
  term.sshDead = false;

  // Sync size: get current terminal size from renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal-request-size', { id });
  }
}

const SSH_RECONNECT_DELAYS = [3, 6, 15]; // seconds between attempts
const SSH_MAX_ATTEMPTS = SSH_RECONNECT_DELAYS.length;

function attemptSshReconnect(id, sshParams, attempt) {
  const term = terminals.get(id);
  if (!term) return;

  if (attempt >= SSH_MAX_ATTEMPTS) {
    term.sshDead = true;
    sendTerminalMsg(id, 'Connection lost. Max reconnection attempts reached. Close and reopen the tab to retry.');
    return;
  }

  const delay = SSH_RECONNECT_DELAYS[attempt];
  sendTerminalMsg(id, `Connection lost. Reconnecting in ${delay}s... (attempt ${attempt + 1}/${SSH_MAX_ATTEMPTS})`);

  term.sshReconnectTimer = setTimeout(() => {
    const t = terminals.get(id);
    if (!t) return; // terminal was destroyed while waiting

    sendTerminalMsg(id, 'Reconnecting...');
    try {
      const newPty = spawnSshPty(id, sshParams);
      wireUpSshPty(id, newPty, sshParams);
      sendTerminalMsg(id, 'Reconnected.');
    } catch (err) {
      sendTerminalMsg(id, `Reconnection failed: ${err.message}`);
      attemptSshReconnect(id, sshParams, attempt + 1);
    }
  }, delay * 1000);
}

// ── Terminal management ──

ipcMain.handle('terminal-create', (event, { id, cwd, conversationId, name, collectionName, prompt, shell: shellOnly, cmd: customCmd, provider, sessionId, resume, remote }) => {
  const home = os.homedir();
  const dir = cwd || home;

  const cleanEnv = { ...process.env, HOME: home };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  let ptyProcess;
  let initialPrompt = prompt || null;

  if (remote) {
    // Remote SSH session — parse user's SSH command, spawn directly
    const remotePath = cwd || '/';
    const sshParams = { remote, remotePath, shellOnly, customCmd, conversationId, cleanEnv };

    ptyProcess = spawnSshPty(id, sshParams);
    initialPrompt = null;
  } else if (provider === 'copilot') {
    const copilotCmd = resume
      ? `copilot --yolo --resume "${sessionId}"`
      : `copilot --yolo --session-id "${sessionId}"`;
    if (IS_WIN) {
      const wslDir = winToWslPath(dir);
      const shellCmd = `cd "${wslDir}" && ${copilotCmd}; exec bash`;
      ptyProcess = pty.spawn('wsl.exe', ['bash', '-c', shellCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    } else {
      const userShell = process.env.SHELL || '/bin/bash';
      const runCmd = `cd "${dir}" && ${copilotCmd}; exec ${userShell}`;
      ptyProcess = pty.spawn(userShell, ['-c', runCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    }
  } else if (customCmd) {
    // Custom command terminal
    if (IS_WIN) {
      const wslDir = winToWslPath(dir);
      const shellCmd = `cd "${wslDir}" && ${customCmd}; exec bash`;
      ptyProcess = pty.spawn('wsl.exe', ['bash', '-c', shellCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    } else {
      const userShell = process.env.SHELL || '/bin/bash';
      const runCmd = `cd "${dir}" && ${customCmd}; exec ${userShell}`;
      ptyProcess = pty.spawn(userShell, ['-c', runCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    }
  } else if (shellOnly) {
    // Plain terminal — no Claude
    if (IS_WIN) {
      const wslDir = winToWslPath(dir);
      ptyProcess = pty.spawn('wsl.exe', ['bash', '-c', `cd "${wslDir}" && exec bash`], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    } else {
      const userShell = process.env.SHELL || '/bin/bash';
      ptyProcess = pty.spawn(userShell, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    }
  } else {
    // Build tool command with resume support
    let toolArgs;
    if (conversationId) {
      toolArgs = `${getToolCmd()} --resume "${conversationId}"`;
    } else {
      toolArgs = getToolCmd();
    }

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
      const userShell = process.env.SHELL || '/bin/bash';
      const cmd = `cd "${dir}" && ${toolArgs}`;
      ptyProcess = pty.spawn(userShell, ['-c', `${cmd}; exec ${userShell}`], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    }
  }

  // ── Data batching & exit handling ──
  let flushInterval;

  if (remote) {
    // SSH terminals: register in map first, then wire up (enables reconnection)
    const sshParams = { remote, remotePath: cwd || '/', shellOnly, customCmd, conversationId, cleanEnv };
    terminals.set(id, {
      pty: ptyProcess,
      alive: true,
      conversationId: conversationId || null,
      spawnTime: Date.now(),
      projectDir: null,
      convoCheck: null,
      flushInterval: null,
      sshParams,
      sshDead: false,
      sshReconnectTimer: null,
    });
    wireUpSshPty(id, ptyProcess, sshParams);
    return { id };
  }

  // Non-SSH terminals: accumulate PTY output, flush every 16ms
  let chunks = [];
  let chunkBytes = 0;

  ptyProcess.onData((data) => {
    chunks.push(data);
    chunkBytes += data.length;
  });

  flushInterval = setInterval(() => {
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

  // Conversation ID detection — find the most recently modified .jsonl after spawn
  const isNonClaude = shellOnly || customCmd || provider === 'copilot';
  const projectDir = isNonClaude ? null : getProjectDir(dir);
  const spawnTime = Date.now();
  let detectedConvoId = conversationId || null;

  let convoCheck = null;
  if (!conversationId && !isNonClaude) {
    let checks = 0;
    convoCheck = setInterval(() => {
      checks++;
      try {
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
        let best = null;
        let bestMtime = 0;
        for (const f of files) {
          try {
            const stat = fs.statSync(path.join(projectDir, f));
            if (stat.mtimeMs > spawnTime && stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              best = f.replace('.jsonl', '');
            }
          } catch (_) {}
        }
        if (best) {
          detectedConvoId = best;
          const term = terminals.get(id);
          if (term) term.conversationId = best;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('conversation-detected', { id, conversationId: best });
          }
          clearInterval(convoCheck);
        }
      } catch (_) {}
      if (checks > 60) clearInterval(convoCheck);
    }, 1000);
  }

  terminals.set(id, {
    pty: ptyProcess,
    alive: true,
    conversationId: detectedConvoId,
    spawnTime,
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
    try { term.pty.write(data); } catch (_) {}
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
    if (term.sshReconnectTimer) clearTimeout(term.sshReconnectTimer);
    term.sshDead = true; // prevent reconnection attempts
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

// Manual SSH reconnection (e.g. after max attempts exhausted)
ipcMain.handle('terminal-reconnect', (event, { id }) => {
  const term = terminals.get(id);
  if (!term || !term.sshParams) return { ok: false, error: 'Not an SSH terminal' };
  if (term.alive) return { ok: false, error: 'Terminal is still alive' };

  // Cancel any pending reconnect timer
  if (term.sshReconnectTimer) clearTimeout(term.sshReconnectTimer);
  term.sshDead = false;

  sendTerminalMsg(id, 'Reconnecting...');
  try {
    const newPty = spawnSshPty(id, term.sshParams);
    wireUpSshPty(id, newPty, term.sshParams);
    sendTerminalMsg(id, 'Reconnected.');
    return { ok: true };
  } catch (err) {
    sendTerminalMsg(id, `Reconnection failed: ${err.message}`);
    term.sshDead = true;
    return { ok: false, error: err.message };
  }
});

// Get the detected conversation ID for a terminal
ipcMain.handle('terminal-get-conversation-id', (event, { id }) => {
  const term = terminals.get(id);
  if (!term) return null;

  if (term.conversationId) return term.conversationId;

  // Fallback: find the most recently modified .jsonl in the project dir
  if (term.projectDir) {
    try {
      const files = fs.readdirSync(term.projectDir).filter(f => f.endsWith('.jsonl'));
      let best = null;
      let bestMtime = 0;
      // First try: files modified after spawn
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(term.projectDir, f));
          if (stat.mtimeMs > (term.spawnTime || 0) && stat.mtimeMs > bestMtime) {
            bestMtime = stat.mtimeMs;
            best = f.replace('.jsonl', '');
          }
        } catch (_) {}
      }
      // Second try: if nothing found, pick the most recently modified file overall
      if (!best) {
        for (const f of files) {
          try {
            const stat = fs.statSync(path.join(term.projectDir, f));
            if (stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              best = f.replace('.jsonl', '');
            }
          } catch (_) {}
        }
      }
      if (best) {
        term.conversationId = best;
        return best;
      }
    } catch (_) {}
  }

  return null;
});

// ── Conversation tracking helpers ──

function getProjectDir(cwd) {
  const encoded = cwd.replace(/[^a-zA-Z0-9._-]/g, '-');
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

// ── Scan for conversation by cwd (last resort) ──

ipcMain.handle('scan-conversation', (event, { cwd }) => {
  if (!cwd) return null;
  const projectDir = getProjectDir(cwd);
  try {
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    let best = null;
    let bestMtime = 0;
    for (const f of files) {
      try {
        const stat = fs.statSync(path.join(projectDir, f));
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          best = f.replace('.jsonl', '');
        }
      } catch (_) {}
    }
    return best;
  } catch (_) {}
  return null;
});

// ── Fork conversation ──

ipcMain.handle('fork-conversation', (event, { conversationId, cwd }) => {
  if (!conversationId || !cwd) return null;
  const projectDir = getProjectDir(cwd);
  const srcFile = path.join(projectDir, conversationId + '.jsonl');
  if (!fs.existsSync(srcFile)) return null;
  const newId = crypto.randomUUID();
  const dstFile = path.join(projectDir, newId + '.jsonl');
  fs.copyFileSync(srcFile, dstFile);
  return newId;
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

// ── SSH remote helpers ──

ipcMain.handle('ssh-ls', async (event, { cmd, remotePath }) => {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');

    // Parse user's SSH command and inject options + remote ls command
    const parts = cmd.trim().split(/\s+/);
    // e.g. ["ssh", "gs6-term"] → ["ssh", opts..., "gs6-term", "ls", "-1AF", "/path"]
    const sshBin = parts[0]; // "ssh"
    const sshTargetArgs = parts.slice(1); // ["gs6-term"] or ["-i", "key", "user@host"]
    const fullArgs = ['-o', 'RequestTTY=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...sshTargetArgs, 'ls', '-1AF', remotePath];

    const proc = IS_WIN
      ? spawn('wsl.exe', [sshBin, ...fullArgs])
      : spawn(sshBin, fullArgs);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => { proc.kill(); resolve({ error: 'Timeout' }); }, 10000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ error: stderr.trim() || `Exit code ${code}` });
        return;
      }
      const entries = stdout.trim().split('\n').filter(Boolean);
      const dirs = entries
        .filter(e => e.endsWith('/'))
        .map(e => e.slice(0, -1))
        .filter(e => !e.startsWith('.'))
        .sort();
      resolve({ dirs, path: remotePath });
    });
  });
});

ipcMain.handle('ssh-test', async (event, { cmd }) => {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');

    const parts = cmd.trim().split(/\s+/);
    const sshBin = parts[0];
    const sshTargetArgs = parts.slice(1);
    const fullArgs = ['-o', 'RequestTTY=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...sshTargetArgs, 'echo', 'ok'];

    const proc = IS_WIN
      ? spawn('wsl.exe', [sshBin, ...fullArgs])
      : spawn(sshBin, fullArgs);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, error: 'Timeout' }); }, 10000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `Exit code ${code}` });
      } else {
        resolve({ ok: stdout.trim() === 'ok' });
      }
    });
  });
});

// ── SSH setup (key generation + key copy) ──

function runCmd(bin, args, opts = {}) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const proc = IS_WIN
      ? spawn('wsl.exe', [bin, ...args], opts)
      : spawn(bin, args, opts);

    let stdout = '', stderr = '';
    if (proc.stdout) proc.stdout.on('data', d => { stdout += d; });
    if (proc.stderr) proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      resolve({ ok: false, stdout, stderr: 'Timeout' });
    }, opts.timeout || 15000);

    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message });
    });
  });
}

function sshCopyIdWithPassword(host, port, username, password) {
  return new Promise((resolve) => {
    const args = ['-o', 'StrictHostKeyChecking=accept-new'];
    if (port && port !== 22) args.push('-p', String(port));
    args.push(`${username}@${host}`);

    const proc = IS_WIN
      ? pty.spawn('wsl.exe', ['ssh-copy-id', ...args], { name: 'xterm-256color', cols: 80, rows: 10 })
      : pty.spawn('ssh-copy-id', args, { name: 'xterm-256color', cols: 80, rows: 10 });

    let output = '';
    let passwordSent = false;
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      resolve({ ok: false, error: 'Timeout — could not reach host' });
    }, 20000);

    proc.onData((data) => {
      output += data;
      if (!passwordSent && /password/i.test(output)) {
        passwordSent = true;
        proc.write(password + '\r');
      }
    });

    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0) {
        resolve({ ok: true });
      } else {
        const err = output.includes('Permission denied') ? 'Wrong password'
          : output.includes('Connection refused') ? 'Connection refused'
          : output.includes('No route to host') ? 'No route to host'
          : output.trim().split('\n').pop() || 'ssh-copy-id failed';
        resolve({ ok: false, error: err });
      }
    });
  });
}

ipcMain.handle('ssh-setup', async (event, { host, port, username, password }) => {
  const home = os.homedir();
  const target = `${username}@${host}`;
  const portArg = port && port !== 22 ? `-p ${port} ` : '';
  const cmd = `ssh ${portArg}${target}`.trim();
  const portArgs = port && port !== 22 ? ['-p', String(port)] : [];

  // Step 1: Check for local SSH key
  const keyCheck = await runCmd('bash', ['-c',
    'test -f ~/.ssh/id_ed25519 && echo "ed25519" || (test -f ~/.ssh/id_rsa && echo "rsa" || echo "none")'
  ]);
  const keyType = keyCheck.stdout || 'none';

  // Step 2: Generate key if missing
  if (keyType === 'none') {
    const gen = await runCmd('bash', ['-c',
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -q <<< y 2>/dev/null; test -f ~/.ssh/id_ed25519 && echo "ok" || echo "fail"'
    ]);
    if (!gen.stdout.includes('ok')) {
      return { ok: false, error: 'Failed to generate SSH key', cmd };
    }
  }

  // Step 3: Test key-based auth
  const authTest = await runCmd('ssh', [
    ...portArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=accept-new',
    target, 'echo', 'ok'
  ]);

  if (authTest.ok && authTest.stdout === 'ok') {
    return { ok: true, keyAuthWorked: true, cmd };
  }

  // Step 4: Key auth failed — need password
  if (!password) {
    return { ok: false, needsPassword: true, error: 'Key auth failed — enter password to copy your SSH key.', cmd };
  }

  // Step 5: Copy key using pty-based ssh-copy-id
  const copyResult = await sshCopyIdWithPassword(host, port, username, password);
  if (!copyResult.ok) {
    return { ok: false, error: copyResult.error, cmd };
  }

  // Step 6: Verify key auth now works
  const verify = await runCmd('ssh', [
    ...portArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    target, 'echo', 'ok'
  ]);

  if (verify.ok && verify.stdout === 'ok') {
    return { ok: true, cmd };
  }

  return { ok: false, error: 'Key was copied but auth verification failed', cmd };
});

// ── App lifecycle ──

app.whenReady().then(() => {
  const send = (ch) => mainWindow?.webContents.send(ch);

  // Edit menu — platform-aware, because copy/paste has different constraints on
  // each OS:
  //
  //   macOS: text inputs get Cmd+X/C/V from the Edit menu's roles, so we DO
  //     register cut/paste roles (Cmd-based keys never collide with the
  //     terminal's Ctrl-based keys, e.g. Ctrl+C = SIGINT). The one exception is
  //     Copy: xterm's visual selection isn't a DOM selection, so a plain
  //     role:'copy' can't read it — we route Cmd+C through the renderer instead
  //     (registerAccelerator:false shows the ⌘C hint without stealing the key).
  //
  //   Windows/Linux: every Ctrl-accelerator a menu role registers (Ctrl+C/X/A/Z)
  //     would be stolen from the terminal, so ALL items are click-only with no
  //     registered accelerator. Text inputs still get native Ctrl+X/C/V/Z/A from
  //     Chromium directly (they don't need the menu on these platforms); the
  //     terminal uses Ctrl+Shift+C / Ctrl+Shift+V, handled in renderer.js.
  const editMenu = IS_MAC
    ? {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { label: 'Copy', accelerator: 'Cmd+C', registerAccelerator: false, click: () => send('menu-copy') },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      }
    : {
        label: 'Edit',
        submenu: [
          { label: 'Cut', click: () => send('menu-cut') },
          { label: 'Copy', click: () => send('menu-copy') },
          { label: 'Paste', click: () => send('menu-paste') },
          { type: 'separator' },
          { label: 'Select All', click: () => send('menu-select-all') },
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
