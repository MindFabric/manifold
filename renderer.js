/* xterm and FitAddon loaded via script tags */
const Terminal = globalThis.Terminal;
const FitAddon = (globalThis.FitAddon || {}).FitAddon;
const WebglAddon = (globalThis.WebglAddon || {}).WebglAddon;
const CanvasAddon = (globalThis.CanvasAddon || {}).CanvasAddon;

if (!Terminal) console.error('xterm Terminal not loaded!');
if (!FitAddon) console.error('FitAddon not loaded!');

// Home directory - resolved async at startup
let homeDir = '/';

// ── State ──
const state = {
  collections: [],
  activeCollectionIdx: -1,
  activeTabIdx: -1,
  gridCollection: null,
  defaultSource: 'claude', // 'claude' | 'copilot' | 'terminal' — what Ctrl/Cmd+T launches
  remotes: [], // { name, host, defaultPath }
};

// Terminal instances: tabId -> { terminal, fitAddon, element }
const terminalInstances = new Map();
let tabIdCounter = 0;

// ── DOM refs ──
const collectionsList = document.getElementById('collections-list');
const terminalSingle = document.getElementById('terminal-single');
const terminalGrid = document.getElementById('terminal-grid');

// ── Helpers ──
function genTabId() { return `tab-${++tabIdCounter}`; }

function getActiveCollection() {
  return state.collections[state.activeCollectionIdx] || null;
}

function getActiveTab() {
  const col = getActiveCollection();
  if (!col) return null;
  return col.tabs[state.activeTabIdx] || null;
}

// ── Terminal helpers ──
function fitTerminal(tabId) {
  const inst = terminalInstances.get(tabId);
  if (!inst) return;
  inst.fitAddon.fit();
  manifold.resizeTerminal(tabId, inst.terminal.cols, inst.terminal.rows);
  scrollTerminalToBottom(inst);
}

function scrollTerminalToBottom(inst) {
  inst.terminal.scrollToBottom();
  // xterm renders async after fit() — scroll again after render settles
  setTimeout(() => {
    inst.terminal.scrollToBottom();
    const vp = inst.element.querySelector('.xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
  }, 50);
}

// ── Terminal creation ──
function createTerminalInstance(tabId, cwd, conversationId, name, collectionName, prompt, shellOnly, customCmd, provider = 'claude', sessionId = null, resume = false, remote = null) {
  const term = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontFamily: '"Share Tech Mono", monospace',
    fontSize: 14,
    theme: {
      background: '#1a1a1a',
      foreground: '#d0d0d0',
      cursor: '#D97757',
      black: '#2e3436',
      red: '#cc0000',
      green: '#4e9a06',
      yellow: '#c4a000',
      blue: '#3465a4',
      magenta: '#75507b',
      cyan: '#06989a',
      white: '#d3d7cf',
      brightBlack: '#555753',
      brightRed: '#ef2929',
      brightGreen: '#8ae234',
      brightYellow: '#fce94f',
      brightBlue: '#729fcf',
      brightMagenta: '#ad7fa8',
      brightCyan: '#34e2e2',
      brightWhite: '#eeeeec',
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const el = document.createElement('div');
  el.className = 'terminal-container';
  el.style.width = '100%';
  el.style.height = '100%';

  terminalInstances.set(tabId, { terminal: term, fitAddon, element: el });

  // Spawn backend pty
  manifold.createTerminal({ id: tabId, cwd, conversationId: conversationId || null, name: name || tabId, collectionName: collectionName || '', prompt: prompt || null, shell: shellOnly || false, cmd: customCmd || null, provider, sessionId, resume, remote: remote || null });

  // Pipe input to pty
  term.onData((data) => manifold.sendInput(tabId, data));

  // Let xterm handle only terminal keys — app shortcuts go through handleAppShortcut
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey || e.metaKey;
    // Clipboard — Ctrl+C copies when text is selected, otherwise sends SIGINT
    if (ctrl && e.key === 'c' && !e.shiftKey && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (ctrl && e.shiftKey && e.key === 'C') {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel);
      return false;
    }
    if (ctrl && e.shiftKey && e.key === 'V') {
      e.preventDefault();
      navigator.clipboard.readText().then(text => {
        if (text) manifold.sendInput(tabId, text);
      });
      return false;
    }
    // Defer to central shortcut handler
    if (handleAppShortcut(e)) return false;
    return true;
  });

  // Open terminal (double RAF to let DOM fully settle before measuring)
  requestAnimationFrame(() => {
    term.open(el);

    // GPU-accelerated rendering: WebGL → Canvas2D → DOM (slowest)
    // On Linux, WebGL often runs in software (llvmpipe/SwiftShader) which is
    // slower than DOM. Detect this and fall back to Canvas2D which is reliably
    // hardware-accelerated on all platforms.
    let rendererLoaded = false;
    if (WebglAddon) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          // Try canvas fallback on context loss
          if (CanvasAddon) {
            try { term.loadAddon(new CanvasAddon()); } catch (_) {}
          }
        });
        term.loadAddon(webgl);
        // Check if WebGL is hardware-accelerated
        const testCanvas = document.createElement('canvas');
        const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
        if (gl) {
          const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
          if (debugInfo) {
            const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL).toLowerCase();
            if (renderer.includes('swiftshader') || renderer.includes('llvmpipe') || renderer.includes('softpipe') || renderer.includes('software')) {
              // Software WebGL — worse than DOM, bail out
              webgl.dispose();
            } else {
              rendererLoaded = true;
            }
          } else {
            rendererLoaded = true; // Can't detect, assume OK
          }
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
      } catch (_) {
        // WebGL failed entirely
      }
    }
    if (!rendererLoaded && CanvasAddon) {
      try {
        term.loadAddon(new CanvasAddon());
      } catch (_) {
        // Canvas2D failed — stuck with DOM renderer
      }
    }

    requestAnimationFrame(() => fitTerminal(tabId));
  });

  return { terminal: term, fitAddon, element: el };
}

// ── Terminal cleanup ──
function destroyTerminalInstance(tabId) {
  manifold.destroyTerminal(tabId);
  pendingWrites.delete(tabId);
  hiddenBuffers.delete(tabId);
  const inst = terminalInstances.get(tabId);
  if (inst) {
    if (inst.element.parentNode) inst.element.parentNode.removeChild(inst.element);
    try { inst.terminal.dispose(); } catch (_) {}
    terminalInstances.delete(tabId);
  }
}

// ── Receive data from pty — chunked write queue with flow control ──
// Without this, dumping large output (cat hugefile, ls -laR /) into a single
// terminal.write() blocks xterm's parser and renderer, causing input lag.
// We chunk incoming data into 4KB pieces and use xterm's write(data, callback)
// to only feed the next chunk when xterm is ready. Hidden terminals buffer
// data and flush when they become visible.

const WRITE_CHUNK_SIZE = 4096;
const pendingWrites = new Map(); // tabId -> { queue: string[], draining: bool }

function getWriteState(id) {
  let ws = pendingWrites.get(id);
  if (!ws) {
    ws = { queue: [], draining: false };
    pendingWrites.set(id, ws);
  }
  return ws;
}

function drainWriteQueue(id) {
  const inst = terminalInstances.get(id);
  const ws = pendingWrites.get(id);
  if (!inst || !ws || ws.queue.length === 0) {
    if (ws) ws.draining = false;
    return;
  }
  ws.draining = true;
  const chunk = ws.queue.shift();
  inst.terminal.write(chunk, () => {
    // xterm finished processing this chunk — feed next
    if (ws.queue.length > 0) {
      drainWriteQueue(id);
    } else {
      ws.draining = false;
    }
  });
}

function enqueueWrite(id, data) {
  const ws = getWriteState(id);
  // Split into chunks so xterm can breathe between renders
  for (let i = 0; i < data.length; i += WRITE_CHUNK_SIZE) {
    ws.queue.push(data.slice(i, i + WRITE_CHUNK_SIZE));
  }
  if (!ws.draining) {
    drainWriteQueue(id);
  }
}

function isTerminalVisible(tabId) {
  const tab = getActiveTab();
  if (tab && tab.id === tabId) return true;
  // Also visible if in grid view
  const gc = state.gridCollection;
  if (gc !== null && state.collections[gc]) {
    return state.collections[gc].tabs.some(t => t.id === tabId);
  }
  return false;
}

// Buffer for hidden terminals — flushed when they become visible
const hiddenBuffers = new Map(); // tabId -> string[]

// Cache conversation IDs as soon as main process detects them
manifold.onConversationDetected((tabId, conversationId) => {
  for (const col of state.collections) {
    const tab = col.tabs.find(t => t.id === tabId);
    if (tab) { tab.conversationId = conversationId; break; }
  }
});

manifold.onTerminalData((id, data) => {
  const inst = terminalInstances.get(id);
  if (!inst) return;

  if (isTerminalVisible(id)) {
    enqueueWrite(id, data);
  } else {
    // Buffer data for hidden terminals
    let buf = hiddenBuffers.get(id);
    if (!buf) { buf = []; hiddenBuffers.set(id, buf); }
    buf.push(data);
  }
});

// ── Collection rendering ──
function renderCollections() {
  collectionsList.innerHTML = '';
  state.collections.forEach((col, ci) => {
    const colEl = document.createElement('div');
    colEl.className = `collection${ci === state.activeCollectionIdx ? ' collection-active' : ''}`;
    colEl.innerHTML = `
      <div class="collection-header" data-ci="${ci}">
        <span class="collection-arrow">${col.expanded ? '\u25BC' : '\u25B6'}</span>
        <div class="collection-info">
          <span class="collection-name">${escHtml(col.name)}</span>
          <span class="collection-path">${col.remote ? escHtml(col.remote.split(/\s+/).pop()) + ':' : ''}${escHtml(col.path)}</span>
        </div>
        <input class="collection-rename" type="text" value="${escAttr(col.name)}">
        <div class="collection-btns">
          <button class="collection-btn grid-btn" data-ci="${ci}" title="Grid view">${'\u229E'}</button>
          <button class="collection-btn-del del-btn" data-ci="${ci}" title="Delete collection">${'\u2715'}</button>
          <div class="add-menu-wrap">
            <button class="collection-btn add-trigger" data-ci="${ci}" title="New...">+</button>
            <div class="add-menu" data-ci="${ci}">
              <button class="add-menu-item add-btn" data-ci="${ci}"><span class="add-menu-icon">&#x2726;</span> Claude</button>
              <button class="add-menu-item copilot-btn" data-ci="${ci}"><span class="add-menu-icon">&#x2708;</span> Copilot</button>
              <button class="add-menu-item term-btn" data-ci="${ci}"><span class="add-menu-icon">&gt;_</span> Terminal</button>
              ${(col.commands || []).map((cmd, cmdI) => `<button class="add-menu-item cmd-btn" data-ci="${ci}" data-cmdi="${cmdI}" title="${escAttr(cmd.cmd)}"><span class="add-menu-icon">&#x26A1;</span> ${escHtml(cmd.name)}</button>`).join('')}
              <button class="add-menu-item addcmd-btn" data-ci="${ci}"><span class="add-menu-icon">+</span> Add command</button>
            </div>
          </div>
        </div>
      </div>
      <div class="collection-body ${col.expanded ? '' : 'collapsed'}" data-ci="${ci}">
        ${col.tabs.map((tab, ti) => `
          <div class="tab-row ${ci === state.activeCollectionIdx && ti === state.activeTabIdx ? 'selected' : ''}"
               data-ci="${ci}" data-ti="${ti}" draggable="true">
            <span class="row-drag" title="Drag to reorder">${'\u2847'}</span>
            <span class="row-dot" data-tabid="${tab.id}">${'\u2022'}</span>
            <span class="row-idx">${ti + 1}</span>
            <span class="row-label">${escHtml(tab.name)}</span>
            <input class="row-rename" type="text" value="${escAttr(tab.name)}">
            <button class="row-close" data-ci="${ci}" data-ti="${ti}">${'\u2715'}</button>
          </div>
        `).join('')}
      </div>
    `;
    collectionsList.appendChild(colEl);

    // Grid button active state
    if (col.gridded) {
      colEl.querySelector('.grid-btn').classList.add('active');
    }
  });

  bindCollectionEvents();
}

function bindCollectionEvents() {
  // Collection header click — if gridded, switch to it; otherwise expand/collapse
  document.querySelectorAll('.collection-header').forEach((el) => {
    let clickTimer = null;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.collection-btns')) return;
      if (e.target.classList.contains('collection-rename')) return;
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        const ci = parseInt(el.dataset.ci);
        if (state.collections[ci].gridded && state.activeCollectionIdx !== ci) {
          const col = state.collections[ci];
          if (col.tabs.length > 0) {
            selectTab(ci, 0);
          }
        } else {
          state.collections[ci].expanded = !state.collections[ci].expanded;
        }
        renderCollections();
      }, 250);
    });

    // Double-click to rename
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.collection-btns')) return;
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      const ci = parseInt(el.dataset.ci);
      const infoEl = el.querySelector('.collection-info');
      const input = el.querySelector('.collection-rename');
      infoEl.style.display = 'none';
      input.style.display = 'block';
      input.value = state.collections[ci].name;
      input.focus();
      input.select();

      const finish = () => {
        const val = input.value.trim();
        if (val) state.collections[ci].name = val;
        infoEl.style.display = '';
        input.style.display = 'none';
        renderCollections();
        saveState();
      };
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') finish();
        if (ev.key === 'Escape') { infoEl.style.display = ''; input.style.display = 'none'; }
      };
      input.onblur = finish;
    });
  });

  // Tab row click + double-click rename
  document.querySelectorAll('.tab-row').forEach((el) => {
    let tabClickTimer = null;

    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('row-close')) return;
      if (e.target.classList.contains('row-rename')) return;
      if (e.target.classList.contains('row-drag')) return;
      if (tabClickTimer) { clearTimeout(tabClickTimer); tabClickTimer = null; return; }
      tabClickTimer = setTimeout(() => {
        tabClickTimer = null;
        const ci = parseInt(el.dataset.ci);
        const ti = parseInt(el.dataset.ti);
        selectTab(ci, ti);
      }, 250);
    });

    el.addEventListener('dblclick', (e) => {
      if (e.target.classList.contains('row-close')) return;
      if (e.target.classList.contains('row-drag')) return;
      if (tabClickTimer) { clearTimeout(tabClickTimer); tabClickTimer = null; }
      const ci = parseInt(el.dataset.ci);
      const ti = parseInt(el.dataset.ti);
      const label = el.querySelector('.row-label');
      const input = el.querySelector('.row-rename');
      label.style.display = 'none';
      input.style.display = 'block';
      input.value = state.collections[ci].tabs[ti].name;
      input.focus();
      input.select();

      const finish = () => {
        const val = input.value.trim();
        if (val) state.collections[ci].tabs[ti].name = val;
        label.style.display = '';
        input.style.display = 'none';
        renderCollections();
        saveState();
      };
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(); }
        if (ev.key === 'Escape') { label.style.display = ''; input.style.display = 'none'; }
      };
      input.onblur = finish;
    });

    // Right-click context menu
    el.addEventListener('contextmenu', (e) => {
      if (e.target.classList.contains('row-rename')) return;
      e.preventDefault();
      const ci = parseInt(el.dataset.ci);
      const ti = parseInt(el.dataset.ti);
      showTabContextMenu(e.clientX, e.clientY, ci, ti);
    });

    // Drag and drop reordering
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `${el.dataset.ci}:${el.dataset.ti}`);
      el.classList.add('dragging');
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      document.querySelectorAll('.tab-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });

    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over');
    });

    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const [srcCi, srcTi] = e.dataTransfer.getData('text/plain').split(':').map(Number);
      const dstCi = parseInt(el.dataset.ci);
      const dstTi = parseInt(el.dataset.ti);

      if (srcCi !== dstCi) return;
      if (srcTi === dstTi) return;

      const col = state.collections[srcCi];
      const [moved] = col.tabs.splice(srcTi, 1);
      const insertAt = srcTi < dstTi ? dstTi - 1 : dstTi;
      col.tabs.splice(insertAt, 0, moved);

      if (state.activeCollectionIdx === srcCi) {
        if (state.activeTabIdx === srcTi) {
          state.activeTabIdx = insertAt;
        } else if (srcTi < state.activeTabIdx && insertAt >= state.activeTabIdx) {
          state.activeTabIdx--;
        } else if (srcTi > state.activeTabIdx && insertAt <= state.activeTabIdx) {
          state.activeTabIdx++;
        }
      }

      renderCollections();
      saveState();
    });
  });

  // Close tab
  document.querySelectorAll('.row-close').forEach((el) => {
    el.addEventListener('click', () => {
      const ci = parseInt(el.dataset.ci);
      const ti = parseInt(el.dataset.ti);
      closeSession(ci, ti);
    });
  });

  // Delete collection button
  document.querySelectorAll('.del-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const ci = parseInt(el.dataset.ci);
      deleteCollection(ci);
    });
  });

  // Grid toggle button
  document.querySelectorAll('.grid-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const ci = parseInt(el.dataset.ci);
      toggleGrid(ci);
    });
  });

  // Add menu items
  document.querySelectorAll('.add-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      const ci = parseInt(el.dataset.ci);
      // Close menu
      const wrap = el.closest('.add-menu-wrap');
      if (wrap) wrap.classList.remove('menu-open');

      if (el.classList.contains('add-btn')) {
        addSession(ci);
      } else if (el.classList.contains('copilot-btn')) {
        addCopilot(ci);
      } else if (el.classList.contains('term-btn')) {
        addTerminal(ci);
      } else if (el.classList.contains('cmd-btn')) {
        const cmdI = parseInt(el.dataset.cmdi);
        const col = state.collections[ci];
        if (col && col.commands && col.commands[cmdI]) {
          launchCommand(ci, col.commands[cmdI]);
        }
      } else if (el.classList.contains('addcmd-btn')) {
        addCommandToCollection(ci);
      }
    });

    // Right-click to delete custom commands
    if (el.classList.contains('cmd-btn')) {
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const ci = parseInt(el.dataset.ci);
        const cmdI = parseInt(el.dataset.cmdi);
        const col = state.collections[ci];
        if (col && col.commands && col.commands[cmdI]) {
          removeCommandFromCollection(ci, cmdI);
        }
      });
    }
  });

}

// ── Tab selection ──
function selectTab(ci, ti) {
  state.activeCollectionIdx = ci;
  state.activeTabIdx = ti;

  const col = state.collections[ci];
  if (!col) return;
  const tab = col.tabs[ti];
  if (!tab) return;

  // Auto-expand collapsed collections when navigating into them
  if (!col.expanded) {
    col.expanded = true;
    renderCollections();
  }

  document.querySelectorAll('.tab-row').forEach((el) => el.classList.remove('selected'));
  const row = document.querySelector(`.tab-row[data-ci="${ci}"][data-ti="${ti}"]`);
  if (row) row.classList.add('selected');

  if (col.gridded) {
    state.gridCollection = ci;
    showGridView(ci);
    highlightGridCell(tab.id);
  } else {
    if (state.gridCollection !== null) hideGridView();
    state.gridCollection = null;
    showSingleTerminal(tab.id);
  }
}

function flushHiddenBuffer(tabId) {
  const buf = hiddenBuffers.get(tabId);
  if (buf && buf.length > 0) {
    const data = buf.join('');
    hiddenBuffers.delete(tabId);
    enqueueWrite(tabId, data);
  }
}

function showSingleTerminal(tabId) {
  for (const child of terminalSingle.children) {
    child.style.display = 'none';
  }
  const inst = terminalInstances.get(tabId);
  if (inst) {
    if (!inst.element.parentNode || inst.element.parentNode !== terminalSingle) {
      terminalSingle.appendChild(inst.element);
    }
    inst.element.style.display = '';
    flushHiddenBuffer(tabId);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitTerminal(tabId);
        inst.terminal.focus();
      });
    });
  }
}

function highlightGridCell(tabId) {
  document.querySelectorAll('.grid-cell').forEach((cell) => {
    cell.classList.remove('grid-cell-active');
  });
  const inst = terminalInstances.get(tabId);
  if (inst && inst.element) {
    const cell = inst.element.closest('.grid-cell');
    if (cell) cell.classList.add('grid-cell-active');
    requestAnimationFrame(() => inst.terminal.focus());
  }
}

// ── Session management ──
function addSession(ci, cwd = null) {
  const col = state.collections[ci];
  if (!col) return;

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  const tabId = genTabId();
  const dir = cwd || col.path;
  const name = `Session ${col.tabs.length + 1}`;

  col.tabs.push({ id: tabId, name, cwd: dir, remote: col.remote || null });
  createTerminalInstance(tabId, dir, null, name, col.name, null, false, null, 'claude', null, false, col.remote || null);

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();

  if (wasGridded) showGridView(ci);
  saveState();
}

// Launch whichever source is set as the default (Ctrl/Cmd+T).
function addDefaultSession(ci, cwd = null) {
  switch (state.defaultSource) {
    case 'copilot': return addCopilot(ci, cwd);
    case 'terminal': return addTerminal(ci, cwd);
    default: return addSession(ci, cwd);
  }
}

function addCopilot(ci, cwd = null) {
  const col = state.collections[ci];
  if (!col) return;

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  const tabId = genTabId();
  const dir = cwd || col.path;
  const name = `Copilot ${col.tabs.length + 1}`;

  const sessionId = crypto.randomUUID();
  col.tabs.push({ id: tabId, name, cwd: dir, provider: 'copilot', copilotSessionId: sessionId });
  createTerminalInstance(tabId, dir, null, name, col.name, null, false, null, 'copilot', sessionId);

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();

  if (wasGridded) showGridView(ci);
  saveState();
}

function addTerminal(ci, cwd = null) {
  const col = state.collections[ci];
  if (!col) return;

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  const tabId = genTabId();
  const dir = cwd || col.path;
  const name = `Terminal ${col.tabs.length + 1}`;

  col.tabs.push({ id: tabId, name, cwd: dir, shell: true, remote: col.remote || null });
  createTerminalInstance(tabId, dir, null, name, col.name, null, true, null, 'claude', null, false, col.remote || null);

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();

  if (wasGridded) showGridView(ci);
  saveState();
}

function launchCommand(ci, command) {
  const col = state.collections[ci];
  if (!col) return;

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  const tabId = genTabId();
  const dir = col.path;
  const name = command.name;

  col.tabs.push({ id: tabId, name, cwd: dir, cmd: command.cmd, remote: col.remote || null });
  createTerminalInstance(tabId, dir, null, name, col.name, null, false, command.cmd, 'claude', null, false, col.remote || null);

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();

  if (wasGridded) showGridView(ci);
  saveState();
}

// ── Input dialog helper ──
function showInputDialog(title, placeholder) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('input-dialog-overlay');
    const titleEl = document.getElementById('input-dialog-title');
    const field = document.getElementById('input-dialog-field');
    const okBtn = document.getElementById('input-dialog-ok');
    const cancelBtn = document.getElementById('input-dialog-cancel');

    titleEl.textContent = title;
    field.value = '';
    field.placeholder = placeholder || '';
    overlay.classList.remove('hidden');
    field.focus();

    function cleanup(val) {
      overlay.classList.add('hidden');
      field.onkeydown = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      overlay.onclick = null;
      resolve(val);
    }

    okBtn.onclick = () => cleanup(field.value.trim() || null);
    cancelBtn.onclick = () => cleanup(null);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };
    field.onkeydown = (e) => {
      if (e.key === 'Enter') cleanup(field.value.trim() || null);
      if (e.key === 'Escape') cleanup(null);
    };
  });
}

async function addCommandToCollection(ci) {
  const col = state.collections[ci];
  if (!col) return;

  const name = await showInputDialog('Command name', 'e.g. Dev Server');
  if (!name) return;

  const cmd = await showInputDialog('Command to run', 'e.g. npm run dev');
  if (!cmd) return;

  if (!col.commands) col.commands = [];
  col.commands.push({ name, cmd });
  renderCollections();
  saveState();
}

// ── Fork session ──
async function forkSession(ci, ti) {
  const col = state.collections[ci];
  if (!col) { showToast('No collection selected', true); return; }
  const tab = col.tabs[ti];
  if (!tab) { showToast('No session selected', true); return; }
  if (tab.provider === 'copilot') {
    if (!tab.copilotSessionId) { showToast('No Copilot session ID available', true); return; }

    if (col.gridded) hideGridView();

    const tabId = genTabId();
    const name = `${tab.name} (fork)`;
    col.tabs.push({ id: tabId, name, cwd: tab.cwd, provider: 'copilot', copilotSessionId: tab.copilotSessionId });
    createTerminalInstance(tabId, tab.cwd, null, name, col.name, null, false, null, 'copilot', tab.copilotSessionId, true);

    col.expanded = true;
    col.gridded = true;
    state.gridCollection = ci;
    selectTab(ci, col.tabs.length - 1);
    renderCollections();
    showGridView(ci);
    saveState();
    return;
  }

  if (tab.shell || tab.cmd) { showToast('Can only fork Claude or Copilot sessions', true); return; }

  const convoId = tab.conversationId || await manifold.getConversationId(tab.id) || await manifold.scanConversation(tab.cwd);
  if (!convoId) { showToast('No conversation yet — send a message first', true); return; }
  tab.conversationId = convoId;

  const newId = await manifold.forkConversation({ conversationId: convoId, cwd: tab.cwd });
  if (!newId) return;

  if (col.gridded) hideGridView();

  const tabId = genTabId();
  const name = `${tab.name} (fork)`;

  col.tabs.push({ id: tabId, name, cwd: tab.cwd, conversationId: newId });
  createTerminalInstance(tabId, tab.cwd, newId, name, col.name);

  col.expanded = true;
  col.gridded = true;
  state.gridCollection = ci;

  selectTab(ci, col.tabs.length - 1);
  renderCollections();
  showGridView(ci);
  saveState();
}

function removeCommandFromCollection(ci, cmdIdx) {
  const col = state.collections[ci];
  if (!col || !col.commands) return;
  col.commands.splice(cmdIdx, 1);
  renderCollections();
  saveState();
}

function closeSession(ci, ti) {
  const col = state.collections[ci];
  const tab = col.tabs[ti];
  if (!tab) return;

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  destroyTerminalInstance(tab.id);

  col.tabs.splice(ti, 1);

  if (col.tabs.length === 0 && col.gridded) {
    col.gridded = false;
    state.gridCollection = null;
  }

  if (ci === state.activeCollectionIdx) {
    if (col.tabs.length > 0) {
      const newTi = Math.min(ti, col.tabs.length - 1);
      selectTab(ci, newTi);
    } else {
      // Find another collection with tabs, or go empty
      let found = false;
      for (let i = 0; i < state.collections.length; i++) {
        if (state.collections[i].tabs.length > 0) {
          selectTab(i, 0);
          found = true;
          break;
        }
      }
      if (!found) {
        state.activeTabIdx = -1;
        for (const child of terminalSingle.children) child.style.display = 'none';
        hideGridView();
      }
    }
  }

  if (wasGridded && col.tabs.length > 0) showGridView(ci);
  renderCollections();
  saveState();
}

// ── Collection management ──
async function addCollection(askPath = false) {
  let folderPath = null;
  let name = null;

  if (askPath) {
    folderPath = await manifold.pickFolder();
    if (!folderPath) return;
    const parts = folderPath.split(/[/\\]/);
    name = parts[parts.length - 1] || folderPath;
  }

  if (!name) name = `Collection ${state.collections.length + 1}`;
  if (!folderPath) folderPath = homeDir || '/';

  const col = { name, path: folderPath, expanded: true, gridded: false, commands: [], tabs: [] };
  state.collections.push(col);
  const ci = state.collections.length - 1;

  if (askPath) {
    const tabId = genTabId();
    col.tabs.push({ id: tabId, name: 'Session 1', cwd: folderPath });
    createTerminalInstance(tabId, folderPath, null, 'Session 1', col.name);
    selectTab(ci, 0);
  }

  renderCollections();
  saveState();
}

function deleteCollection(ci) {
  const col = state.collections[ci];
  if (!col) return;

  if (col.gridded) {
    hideGridView();
    state.gridCollection = null;
  }

  col.tabs.forEach((tab) => {
    destroyTerminalInstance(tab.id);
  });

  state.collections.splice(ci, 1);

  state.gridCollection = null;

  if (state.collections.length === 0) {
    state.activeCollectionIdx = -1;
    state.activeTabIdx = -1;
    // Clear terminal area
    for (const child of terminalSingle.children) child.style.display = 'none';
    hideGridView();
  } else {
    if (state.activeCollectionIdx >= state.collections.length) {
      state.activeCollectionIdx = state.collections.length - 1;
    }
    if (state.activeCollectionIdx === ci || state.activeCollectionIdx < 0) {
      let found = false;
      for (let i = 0; i < state.collections.length; i++) {
        if (state.collections[i].tabs.length > 0) {
          selectTab(i, 0);
          found = true;
          break;
        }
      }
      if (!found) {
        state.activeCollectionIdx = 0;
        state.activeTabIdx = -1;
      }
    }
    for (let i = 0; i < state.collections.length; i++) {
      if (state.collections[i].gridded && i === state.activeCollectionIdx) {
        state.gridCollection = i;
      }
    }
  }

  renderCollections();
  saveState();
}

// ── Grid view ──

function toggleGrid(ci) {
  const col = state.collections[ci];
  if (col.gridded) {
    col.gridded = false;
    state.gridCollection = null;
    hideGridView();
    const tab = getActiveTab();
    if (tab) showSingleTerminal(tab.id);
  } else {
    if (state.gridCollection !== null) hideGridView();
    col.gridded = true;
    state.gridCollection = ci;
    state.activeCollectionIdx = ci;
    if (col.tabs.length > 0) {
      state.activeTabIdx = Math.min(state.activeTabIdx, col.tabs.length - 1);
      if (state.activeTabIdx < 0) state.activeTabIdx = 0;
    }
    showGridView(ci);
  }
  renderCollections();
  saveState();
}

function showGridView(ci) {
  const col = state.collections[ci];
  if (!col || !col.tabs.length) return;

  for (const [, inst] of terminalInstances) {
    if (inst.element.parentNode && inst.element.closest('#terminal-grid')) {
      inst.element.parentNode.removeChild(inst.element);
    }
  }

  terminalSingle.classList.add('hidden');
  terminalGrid.classList.remove('hidden');
  terminalGrid.innerHTML = '';

  const count = col.tabs.length;
  const cols = count <= 2 ? count : count <= 4 ? 2 : 3;
  terminalGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  col.tabs.forEach((tab, ti) => {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';

    const header = document.createElement('div');
    header.className = 'grid-cell-header';
    header.textContent = tab.name;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'grid-cell-close';
    closeBtn.textContent = '\u2715';
    closeBtn.title = 'Close session';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSession(ci, ti);
    });
    header.appendChild(closeBtn);

    header.addEventListener('click', (e) => {
      if (e.target === closeBtn) return;
      selectTab(ci, ti);
    });

    cell.appendChild(header);

    const inst = terminalInstances.get(tab.id);
    if (inst) {
      if (inst.element.parentNode) inst.element.parentNode.removeChild(inst.element);
      inst.element.style.display = '';
      cell.appendChild(inst.element);
      flushHiddenBuffer(tab.id);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => fitTerminal(tab.id));
      });
    }

    terminalGrid.appendChild(cell);
  });
}

function hideGridView() {
  for (const [, inst] of terminalInstances) {
    if (inst.element.parentNode && inst.element.closest('#terminal-grid')) {
      inst.element.parentNode.removeChild(inst.element);
    }
  }
  terminalGrid.classList.add('hidden');
  terminalGrid.innerHTML = '';
  terminalSingle.classList.remove('hidden');
}

// ── State persistence ──
async function saveState() {
  // Conversation IDs are cached on tab objects by the activity poll.
  // Only fetch for tabs that still lack one (e.g. freshly spawned).
  const allTabs = state.collections.flatMap(col => col.tabs);
  const missing = allTabs.filter(t => !t.conversationId && !t.shell && !t.cmd && t.provider !== 'copilot' && !t.remote);
  if (missing.length > 0) {
    const results = await Promise.all(
      missing.map(tab => manifold.getConversationId(tab.id).catch(() => null))
    );
    missing.forEach((tab, i) => {
      if (results[i]) tab.conversationId = results[i];
    });
  }

  const data = {
    collections: state.collections.map((col) => ({
      name: col.name,
      path: col.path,
      remote: col.remote || null,
      expanded: col.expanded,
      gridded: col.gridded || false,
      commands: col.commands || [],
      tabs: col.tabs.map((t) => ({
        name: t.name,
        cwd: t.cwd,
        conversationId: t.conversationId || null,
        provider: t.provider || 'claude',
        copilotSessionId: t.copilotSessionId || null,
        shell: t.shell || false,
        cmd: t.cmd || null,
        remote: t.remote || null,
      })),
    })),
    activeCollection: state.activeCollectionIdx,
    activeTab: state.activeTabIdx,
    uiScale: parseInt(scaleSlider.value) || 100,
    defaultSource: state.defaultSource,
    remotes: state.remotes,
  };
  await manifold.saveState(data);
}

// ── Keybindings (single source of truth) ──
// Returns true if the event matched an app shortcut.
// Called from both xterm's key handler and the document listener.
// Toast notification
function showToast(msg, isError) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.style.cssText = 'position:fixed;top:8px;right:8px;padding:8px 14px;border-radius:6px;font-size:13px;z-index:99999;font-family:monospace;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = isError ? '#cc0000' : '#D97757';
  el.style.color = isError ? '#fff' : '#000';
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function handleAppShortcut(e) {
  const ctrl = e.ctrlKey || e.metaKey;

  // Ctrl+Shift combos — use e.code for reliability across platforms
  if (ctrl && e.shiftKey) {
    if (e.code === 'KeyF') {
      if (state.activeCollectionIdx >= 0 && state.activeTabIdx >= 0) forkSession(state.activeCollectionIdx, state.activeTabIdx);
      return true;
    }
    if (e.code === 'KeyT') {
      const ci = state.activeCollectionIdx >= 0 ? state.activeCollectionIdx : 0;
      if (state.collections[ci]) addTerminal(ci);
      return true;
    }
  }

  // Ctrl combos (no shift)
  if (ctrl && !e.shiftKey) {
    if (e.key === 't') {
      const ci = state.activeCollectionIdx >= 0 ? state.activeCollectionIdx : 0;
      if (state.collections[ci]) addDefaultSession(ci);
      return true;
    }
    if (e.key === 'w') {
      if (state.activeCollectionIdx >= 0 && state.activeTabIdx >= 0) closeSession(state.activeCollectionIdx, state.activeTabIdx);
      return true;
    }
    if (e.key === 'p' || e.key === 'y') { addCollection(true); return true; }
    if (e.key === 'g') {
      if (state.activeCollectionIdx >= 0) toggleGrid(state.activeCollectionIdx);
      return true;
    }
    if (e.key >= '1' && e.key <= '9') {
      const ci = state.activeCollectionIdx;
      if (ci >= 0 && state.collections[ci]) {
        const ti = parseInt(e.key) - 1;
        if (ti < state.collections[ci].tabs.length) selectTab(ci, ti);
      }
      return true;
    }
  }

  // Alt combos
  if (e.altKey) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const cols = state.collections;
      if (cols.length > 1) {
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const ci = (state.activeCollectionIdx + dir + cols.length) % cols.length;
        if (cols[ci].tabs.length > 0) { selectTab(ci, 0); renderCollections(); }
      }
      return true;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const ci = state.activeCollectionIdx;
      const col = state.collections[ci];
      if (col && col.tabs.length > 1) {
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const ti = (state.activeTabIdx + dir + col.tabs.length) % col.tabs.length;
        selectTab(ci, ti); renderCollections();
      }
      return true;
    }
    if (e.key >= '1' && e.key <= '9') {
      const ci = state.activeCollectionIdx;
      if (ci >= 0 && state.collections[ci]) {
        const ti = parseInt(e.key) - 1;
        if (ti < state.collections[ci].tabs.length) selectTab(ci, ti);
      }
      return true;
    }
  }

  // Escape
  if (e.key === 'Escape' && !settingsOverlay.classList.contains('hidden')) {
    settingsOverlay.classList.add('hidden');
    return true;
  }

  return false;
}

document.addEventListener('keydown', (e) => {
  if (handleAppShortcut(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// ── Tab context menu ──
function showTabContextMenu(x, y, ci, ti) {
  dismissContextMenu();
  const tab = state.collections[ci]?.tabs[ti];
  if (!tab) return;

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const isClaudeSession = !tab.shell && (!tab.cmd || tab.provider === 'copilot');

  const items = [];
  if (isClaudeSession) {
    items.push({ label: 'Fork session', hint: 'Ctrl+Shift+F', action: () => forkSession(ci, ti) });
  }
  items.push({ label: 'Close', hint: 'Ctrl+W', action: () => closeSession(ci, ti) });

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'ctx-menu-item';
    row.innerHTML = `<span>${item.label}</span><span class="ctx-menu-hint">${item.hint}</span>`;
    row.addEventListener('click', () => { dismissContextMenu(); item.action(); });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  // Clamp to viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
  });

  // Dismiss on click outside or Escape
  setTimeout(() => {
    document.addEventListener('mousedown', dismissContextMenuOutside);
    document.addEventListener('keydown', dismissContextMenuOnEsc);
  }, 0);
}

function dismissContextMenu() {
  const existing = document.querySelector('.tab-context-menu');
  if (existing) existing.remove();
  document.removeEventListener('mousedown', dismissContextMenuOutside);
  document.removeEventListener('keydown', dismissContextMenuOnEsc);
}

function dismissContextMenuOutside(e) {
  if (!e.target.closest('.tab-context-menu')) dismissContextMenu();
}

function dismissContextMenuOnEsc(e) {
  if (e.key === 'Escape') dismissContextMenu();
}

// ── Activity polling ──
setInterval(async () => {
  const tabIds = [...terminalInstances.keys()];
  const results = await Promise.all(
    tabIds.map(id => manifold.isTerminalActive(id).catch(() => false))
  );
  tabIds.forEach((tabId, i) => {
    const dot = document.querySelector(`.row-dot[data-tabid="${tabId}"]`);
    if (dot) {
      if (results[i]) dot.classList.add('active');
      else dot.classList.remove('active');
    }
  });
}, 1500);

// ── Auto-save ──
setInterval(saveState, 30000);
manifold.onSaveState(() => saveState().then(() => manifold.saveStateDone()));

// ── Window focus handler ──
manifold.onWindowFocus(() => {
  const tab = getActiveTab();
  if (tab) {
    const inst = terminalInstances.get(tab.id);
    if (inst) {
      scrollTerminalToBottom(inst);
      inst.terminal.focus();
    }
  }
});

// ── Resize handler ──
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (state.gridCollection === null) {
          const tab = getActiveTab();
          if (tab) fitTerminal(tab.id);
        } else {
          const col = state.collections[state.gridCollection];
          if (col) col.tabs.forEach((t) => fitTerminal(t.id));
        }
      });
    });
  }, 50);
});

// ── Button events ──
document.getElementById('btn-new-collection').addEventListener('click', () => {
  if (state.remotes.length === 0) {
    addCollection(true).catch(err => console.error('addCollection failed:', err));
  } else {
    showCollectionMenu();
  }
});

// ── Settings modal ──
const settingsOverlay = document.getElementById('settings-overlay');

document.getElementById('settings-btn').addEventListener('click', () => {
  settingsOverlay.classList.toggle('hidden');
});

document.getElementById('settings-close-btn').addEventListener('click', () => {
  settingsOverlay.classList.add('hidden');
});
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
});

// ── Shortcuts table (populated after platform detection) ──
function populateShortcuts(isMac) {
  const mod = isMac ? '\u2318' : 'Ctrl';
  const shortcuts = [
    [`${mod}+T`, 'New session (default source)'],
    [`${mod}+Shift+T`, 'New terminal'],
    [`${mod}+Y`, 'New collection'],
    [`${mod}+Shift+F`, 'Fork session'],
    [`${mod}+W`, 'Close session'],
    [`${mod}+G`, 'Toggle grid view'],
    [`${mod}+1-9`, 'Switch to tab N'],
    ['Alt+1-9', 'Switch to tab N'],
    ['Alt+\u2191/\u2193', 'Jump between collections'],
    ['Alt+\u2190/\u2192', 'Cycle sessions'],
    ['Ctrl+Shift+C', 'Copy from terminal'],
    ['Ctrl+Shift+V', 'Paste into terminal'],
    ['Esc', 'Close settings'],
  ];
  const table = document.getElementById('shortcuts-table');
  table.innerHTML = shortcuts.map(([key, desc]) =>
    `<div class="shortcut-row"><span class="shortcut-key">${key}</span><span class="shortcut-desc">${desc}</span></div>`
  ).join('');
}

// ── Default source picker ──
const defaultSourceSeg = document.getElementById('default-source-seg');
let headerHintMod = 'Ctrl';
const SOURCE_LABELS = { claude: 'claude', copilot: 'copilot', terminal: 'terminal' };

function updateHeaderHints() {
  const m = headerHintMod;
  const src = SOURCE_LABELS[state.defaultSource] || 'session';
  document.getElementById('header-hints').textContent =
    `${m}+T ${src} | ${m}+Shift+F fork | ${m}+Y collection | ${m}+W close | ${m}+G grid`;
}

function renderDefaultSource() {
  defaultSourceSeg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.source === state.defaultSource);
  });
  updateHeaderHints();
}

defaultSourceSeg.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.defaultSource = btn.dataset.source;
    renderDefaultSource();
    saveState();
  });
});

// ── UI Scale slider ──
const scaleSlider = document.getElementById('scale-slider');
const scaleValue = document.getElementById('scale-value');

function applyScale(pct) {
  const factor = pct / 100;
  manifold.setZoomFactor(factor);
  scaleValue.textContent = `${pct}%`;
  scaleSlider.value = pct;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const [tabId] of terminalInstances) {
        try { fitTerminal(tabId); } catch (_) {}
      }
    });
  });
}

scaleSlider.addEventListener('input', () => {
  const pct = parseInt(scaleSlider.value);
  applyScale(pct);
});

scaleSlider.addEventListener('change', () => {
  saveState();
});

scaleSlider.addEventListener('dblclick', () => {
  applyScale(100);
  saveState();
});

document.getElementById('nuke-btn').addEventListener('click', async () => {
  if (!confirm('Factory reset — clear all saved state and start fresh?')) return;
  if (!confirm('Last chance. Reset everything?')) return;
  await manifold.saveState(null);
  location.reload();
});

// ── Remote destinations management ──

function renderRemotes() {
  const list = document.getElementById('remotes-list');
  if (!list) return;
  list.innerHTML = state.remotes.map((r, i) => `
    <div class="remote-row" data-ri="${i}">
      <div class="remote-row-info">
        <span class="remote-row-name remote-editable" data-ri="${i}" data-field="name" title="Click to edit name">${escHtml(r.name)}</span>
        <span class="remote-row-host remote-editable" data-ri="${i}" data-field="cmd" title="Click to edit command">${escHtml(r.cmd)}</span>
        <span class="remote-row-path remote-editable" data-ri="${i}" data-field="defaultPath" title="Click to edit path">${escHtml(r.defaultPath)}</span>
      </div>
      <div class="remote-row-btns">
        <button class="remote-row-btn remote-test-btn" data-ri="${i}" title="Test connection">&#x21BB;</button>
        <button class="remote-row-btn remote-browse-btn" data-ri="${i}" title="Browse to set path">&#x25B8;</button>
        <button class="remote-row-btn remote-row-btn-del remote-del-btn" data-ri="${i}" title="Delete">&times;</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.remote-test-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ri = parseInt(btn.dataset.ri);
      const r = state.remotes[ri];
      btn.textContent = '...';
      const result = await manifold.sshTest({ cmd: r.cmd });
      btn.textContent = result.ok ? '\u2713' : '\u2717';
      btn.style.color = result.ok ? '#4e9a06' : '#e74c3c';
      setTimeout(() => { btn.textContent = '\u21BB'; btn.style.color = ''; }, 3000);
    });
  });

  list.querySelectorAll('.remote-editable').forEach(el => {
    el.addEventListener('click', async () => {
      const ri = parseInt(el.dataset.ri);
      const field = el.dataset.field;
      const r = state.remotes[ri];
      if (!r) return;
      const labels = { name: 'Remote name', cmd: 'SSH command', defaultPath: 'Default browse path' };
      const val = await showInputDialog(labels[field], r[field]);
      if (val) {
        r[field] = val;
        renderRemotes();
        saveState();
      }
    });
  });

  list.querySelectorAll('.remote-browse-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ri = parseInt(btn.dataset.ri);
      const r = state.remotes[ri];
      settingsOverlay.classList.add('hidden');
      showRemoteBrowser(r, true, ri);
    });
  });

  list.querySelectorAll('.remote-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.remotes.splice(parseInt(btn.dataset.ri), 1);
      renderRemotes();
      saveState();
    });
  });
}

async function addRemote() {
  const name = await showInputDialog('Remote name', 'e.g. GS6');
  if (!name) return;
  const cmd = await showInputDialog('SSH command', 'e.g. ssh gs6-term');
  if (!cmd) return;
  const defaultPath = await showInputDialog('Default browse path', '/home/user') || '/';

  state.remotes.push({ name, cmd, defaultPath });
  renderRemotes();
  saveState();
}


document.getElementById('add-remote-btn').addEventListener('click', addRemote);

// ── Collection source menu ──

function showCollectionMenu() {
  const existing = document.querySelector('.collection-source-menu');
  if (existing) { existing.remove(); return; }

  const btn = document.getElementById('btn-new-collection');
  const rect = btn.getBoundingClientRect();

  const menu = document.createElement('div');
  menu.className = 'collection-source-menu';
  menu.style.left = `${rect.left}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;

  // Local option
  const localItem = document.createElement('button');
  localItem.className = 'collection-menu-item';
  localItem.innerHTML = '<span class="collection-menu-icon">&#x25B8;</span> Local folder...';
  localItem.addEventListener('click', () => {
    menu.remove();
    addCollection(true);
  });
  menu.appendChild(localItem);

  // Divider
  if (state.remotes.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'collection-menu-divider';
    menu.appendChild(divider);
  }

  // Remote options
  for (const remote of state.remotes) {
    const item = document.createElement('button');
    item.className = 'collection-menu-item';
    item.innerHTML = `<span class="collection-menu-icon">&#x2192;</span> ${escHtml(remote.name)}`;
    item.title = remote.host;
    item.addEventListener('click', () => {
      menu.remove();
      showRemoteBrowser(remote);
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);

  setTimeout(() => {
    const dismiss = (e) => {
      if (!e.target.closest('.collection-source-menu')) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss);
      }
    };
    document.addEventListener('mousedown', dismiss);
  }, 0);
}

// ── Remote folder browser ──

let remoteBrowserState = {
  remote: null,
  currentPath: '/',
};

function showRemoteBrowser(remote, pickPathMode = false, remoteIdx = -1) {
  remoteBrowserState.remote = remote;
  remoteBrowserState.currentPath = remote.defaultPath || '/';

  const selectBtn = document.getElementById('remote-browser-select');
  document.getElementById('remote-browser-title').textContent = pickPathMode
    ? `SET PATH: ${remote.name.toUpperCase()}`
    : `BROWSE: ${remote.name.toUpperCase()}`;
  selectBtn.textContent = pickPathMode ? 'Set Path' : 'Select';
  document.getElementById('remote-browser-overlay').classList.remove('hidden');

  navigateRemote(remoteBrowserState.currentPath);

  document.getElementById('remote-browser-close').onclick = () => closeRemoteBrowser();
  document.getElementById('remote-browser-cancel').onclick = () => closeRemoteBrowser();
  document.getElementById('remote-browser-copy').onclick = () => {
    navigator.clipboard.writeText(remoteBrowserState.currentPath);
    const btn = document.getElementById('remote-browser-copy');
    btn.textContent = '\u2713';
    setTimeout(() => { btn.innerHTML = '&#x2398;'; }, 1500);
  };
  selectBtn.onclick = () => {
    const selectedPath = remoteBrowserState.currentPath;
    closeRemoteBrowser();
    if (pickPathMode && remoteIdx >= 0 && state.remotes[remoteIdx]) {
      state.remotes[remoteIdx].defaultPath = selectedPath;
      renderRemotes();
      saveState();
      settingsOverlay.classList.remove('hidden');
    } else {
      addRemoteCollection(remoteBrowserState.remote, selectedPath);
    }
  };
  document.getElementById('remote-browser-overlay').onclick = (e) => {
    if (e.target.id === 'remote-browser-overlay') closeRemoteBrowser();
  };
}

function closeRemoteBrowser() {
  document.getElementById('remote-browser-overlay').classList.add('hidden');
}

async function navigateRemote(remotePath) {
  remoteBrowserState.currentPath = remotePath;

  // Update breadcrumb
  const breadcrumb = document.getElementById('remote-browser-breadcrumb');
  const parts = remotePath.split('/').filter(Boolean);
  let breadcrumbHtml = '<button class="breadcrumb-segment" data-path="/">/</button>';
  let accumulated = '';
  for (const part of parts) {
    accumulated += '/' + part;
    breadcrumbHtml += `<span class="breadcrumb-sep">/</span><button class="breadcrumb-segment" data-path="${escAttr(accumulated)}">${escHtml(part)}</button>`;
  }
  breadcrumb.innerHTML = breadcrumbHtml;

  breadcrumb.querySelectorAll('.breadcrumb-segment').forEach(btn => {
    btn.addEventListener('click', () => navigateRemote(btn.dataset.path));
  });

  // Update path display
  document.getElementById('remote-browser-path').textContent = `${remoteBrowserState.remote.cmd}:${remotePath}`;

  // Show loading
  const list = document.getElementById('remote-browser-list');
  list.innerHTML = '<div class="remote-browser-loading">Loading...</div>';

  // Fetch directory listing
  const result = await manifold.sshLs({ cmd: remoteBrowserState.remote.cmd, remotePath });

  if (result.error) {
    list.innerHTML = `<div class="remote-browser-error">${escHtml(result.error)}</div>`;
    return;
  }

  if (result.dirs.length === 0) {
    list.innerHTML = '<div class="remote-browser-loading">No subdirectories</div>';
    return;
  }

  let listHtml = '';
  if (remotePath !== '/') {
    const parent = remotePath.split('/').slice(0, -1).join('/') || '/';
    listHtml += `<button class="remote-dir-item" data-path="${escAttr(parent)}"><span class="remote-dir-icon">&uarr;</span><span class="remote-dir-name">..</span></button>`;
  }

  for (const dir of result.dirs) {
    const fullPath = remotePath === '/' ? `/${dir}` : `${remotePath}/${dir}`;
    listHtml += `<button class="remote-dir-item" data-path="${escAttr(fullPath)}"><span class="remote-dir-icon">&#x25B8;</span><span class="remote-dir-name">${escHtml(dir)}</span></button>`;
  }

  list.innerHTML = listHtml;

  list.querySelectorAll('.remote-dir-item').forEach(item => {
    item.addEventListener('click', () => navigateRemote(item.dataset.path));
  });
}

function addRemoteCollection(remote, remotePath) {
  const parts = remotePath.split('/');
  const name = parts[parts.length - 1] || remote.name;

  const col = {
    name,
    path: remotePath,
    remote: remote.cmd,
    expanded: true,
    gridded: false,
    commands: [],
    tabs: [],
  };
  state.collections.push(col);
  const ci = state.collections.length - 1;

  const tabId = genTabId();
  const tabName = 'Session 1';
  col.tabs.push({ id: tabId, name: tabName, cwd: remotePath, remote: remote.cmd });
  createTerminalInstance(tabId, remotePath, null, tabName, col.name, null, false, null, 'claude', null, false, remote.cmd);

  selectTab(ci, 0);
  renderCollections();
  saveState();
}

// ── Utility ──
function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ── Workspace init ──

async function initWorkspace(savedData) {
  const loaded = await restoreFromState(savedData);

  if (!loaded) {
    const gTabId = genTabId();
    state.collections.push({
      name: 'General',
      path: homeDir,
      expanded: true,
      gridded: false,
      tabs: [{ id: gTabId, name: 'Session 1', cwd: homeDir }],
    });
    createTerminalInstance(gTabId, homeDir, null, 'Session 1', 'General');
  }

  if (loaded) {
    const aci = Math.min(loaded.activeCollection, state.collections.length - 1);
    const col = state.collections[aci];
    const ati = Math.min(loaded.activeTab, (col ? col.tabs.length - 1 : 0));
    selectTab(Math.max(0, aci), Math.max(0, ati));
  } else {
    selectTab(0, 0);
  }
  renderCollections();
  // Delay first save so conversation detection has time to run
  setTimeout(saveState, 10000);
}

async function restoreFromState(data) {
  if (!data || !data.collections || !data.collections.length) return false;

  for (let ci = 0; ci < data.collections.length; ci++) {
    const colData = data.collections[ci];

    const col = {
      name: colData.name || `Collection ${ci + 1}`,
      path: colData.path || homeDir || '/',
      remote: colData.remote || null,
      expanded: colData.expanded !== false,
      gridded: colData.gridded || false,
      commands: colData.commands || [],
      tabs: [],
    };

    const tabs = colData.tabs && colData.tabs.length > 0
      ? colData.tabs
      : [{ name: 'Session 1', cwd: col.path }];

    for (const tabData of tabs) {
      const tabId = genTabId();
      const cwd = tabData.cwd || col.path;
      const provider = tabData.provider || 'claude';
      const copilotSessionId = tabData.copilotSessionId || null;
      const isNonClaude = tabData.shell || tabData.cmd;
      const tabRemote = tabData.remote || col.remote || null;
      col.tabs.push({
        id: tabId,
        name: tabData.name || 'Session',
        cwd,
        conversationId: tabData.conversationId || null,
        provider,
        copilotSessionId,
        shell: tabData.shell || false,
        cmd: tabData.cmd || null,
        remote: tabRemote,
      });
      createTerminalInstance(tabId, cwd, isNonClaude ? null : (tabData.conversationId || null), tabData.name || 'Session', col.name, null, tabData.shell || false, tabData.cmd || null, provider, copilotSessionId, provider === 'copilot' && !!copilotSessionId, tabRemote);
    }

    state.collections.push(col);
  }

  if (state.collections.length === 0) return false;

  return {
    activeCollection: data.activeCollection || 0,
    activeTab: data.activeTab || 0,
  };
}

// ── Init ──
(async () => {
  try {
    homeDir = await manifold.getHomeDir() || '/';
    const platform = await manifold.getPlatform();
    const isMac = platform === 'darwin';
    document.body.classList.add(`platform-${platform}`);

    const mod = isMac ? 'Cmd' : 'Ctrl';
    headerHintMod = mod;
    updateHeaderHints();
    populateShortcuts(isMac);

    const savedState = await manifold.loadState();

    // Apply saved UI scale early
    if (savedState && savedState.uiScale) {
      applyScale(savedState.uiScale);
    }

    // Restore default-source preference
    if (savedState && savedState.defaultSource) {
      state.defaultSource = savedState.defaultSource;
    }
    // Restore remote destinations
    if (savedState && savedState.remotes) {
      state.remotes = savedState.remotes;
    }
    renderRemotes();

    document.getElementById('default-source-kbd').textContent = `${mod}+T`;
    renderDefaultSource();

    await initWorkspace(savedState);
  } catch (err) {
    console.error('Init failed:', err);
  }
})();
