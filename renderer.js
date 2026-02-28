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
function createTerminalInstance(tabId, cwd, conversationId, name, collectionName, prompt) {
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
  manifold.createTerminal({ id: tabId, cwd, conversationId: conversationId || null, name: name || tabId, collectionName: collectionName || '', prompt: prompt || null });

  // Pipe input to pty
  term.onData((data) => manifold.sendInput(tabId, data));

  // Clipboard: Ctrl+Shift+C to copy, Ctrl+Shift+V to paste
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.shiftKey && e.key === 'C') {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel);
      return false;
    }
    if (ctrl && e.shiftKey && e.key === 'V') {
      navigator.clipboard.readText().then(text => {
        if (text) manifold.sendInput(tabId, text);
      });
      return false;
    }
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
          <span class="collection-path">${escHtml(col.path)}</span>
        </div>
        <input class="collection-rename" type="text" value="${escAttr(col.name)}">
        <div class="collection-btns">
<button class="collection-btn grid-btn" data-ci="${ci}" title="Grid view">${'\u229E'}</button>
          <button class="collection-btn-del del-btn" data-ci="${ci}" title="Delete collection">${'\u2715'}</button>
          <button class="collection-btn add-btn" data-ci="${ci}" title="New session">+</button>
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

  // Add session button
  document.querySelectorAll('.add-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const ci = parseInt(el.dataset.ci);
      addSession(ci);
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

  col.tabs.push({ id: tabId, name, cwd: dir });
  createTerminalInstance(tabId, dir, null, name, col.name);

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();

  if (wasGridded) showGridView(ci);
  saveState();
}

function closeSession(ci, ti) {
  const totalTabs = state.collections.reduce((sum, c) => sum + c.tabs.length, 0);
  if (totalTabs <= 1) return;

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
      for (let i = 0; i < state.collections.length; i++) {
        if (state.collections[i].tabs.length > 0) {
          selectTab(i, 0);
          break;
        }
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

  const col = { name, path: folderPath, expanded: true, gridded: false, tabs: [] };
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
  if (state.collections.length <= 1) return;

  const col = state.collections[ci];

  if (col.gridded) {
    hideGridView();
    state.gridCollection = null;
  }

  col.tabs.forEach((tab) => {
    destroyTerminalInstance(tab.id);
  });

  state.collections.splice(ci, 1);

  if (state.activeCollectionIdx >= state.collections.length) {
    state.activeCollectionIdx = state.collections.length - 1;
  }
  if (state.activeCollectionIdx === ci || state.activeCollectionIdx < 0) {
    for (let i = 0; i < state.collections.length; i++) {
      if (state.collections[i].tabs.length > 0) {
        selectTab(i, 0);
        break;
      }
    }
  }

  state.gridCollection = null;
  for (let i = 0; i < state.collections.length; i++) {
    if (state.collections[i].gridded) {
      if (i === state.activeCollectionIdx) state.gridCollection = i;
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
  const allTabs = state.collections.flatMap(col => col.tabs);
  const convoResults = await Promise.all(
    allTabs.map(tab => manifold.getConversationId(tab.id).catch(() => null))
  );
  allTabs.forEach((tab, i) => {
    if (convoResults[i]) tab.conversationId = convoResults[i];
  });

  const data = {
    collections: state.collections.map((col) => ({
      name: col.name,
      path: col.path,
      expanded: col.expanded,
      gridded: col.gridded || false,
      tabs: col.tabs.map((t) => ({
        name: t.name,
        cwd: t.cwd,
        conversationId: t.conversationId || null,
      })),
    })),
    activeCollection: state.activeCollectionIdx,
    activeTab: state.activeTabIdx,
    uiScale: parseInt(scaleSlider.value) || 100,
  };
  await manifold.saveState(data);
}

// ── Keybindings ──
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  let handled = false;

  if (ctrl && e.key === 't') {
    const ci = state.activeCollectionIdx >= 0 ? state.activeCollectionIdx : 0;
    if (state.collections[ci]) addSession(ci);
    handled = true;
  }

  if (ctrl && e.key === 'w') {
    if (state.activeCollectionIdx >= 0 && state.activeTabIdx >= 0) {
      closeSession(state.activeCollectionIdx, state.activeTabIdx);
    }
    handled = true;
  }

  if (ctrl && e.key === 'p') {
    addCollection(true);
    handled = true;
  }

  if (ctrl && e.key === 'y') {
    addCollection(true);
    handled = true;
  }

  if (ctrl && e.key === 'g') {
    if (state.activeCollectionIdx >= 0) {
      toggleGrid(state.activeCollectionIdx);
    }
    handled = true;
  }

  // Ctrl/Cmd+1-9: switch tabs within active collection
  if (ctrl && e.key >= '1' && e.key <= '9') {
    const ci = state.activeCollectionIdx;
    if (ci >= 0 && state.collections[ci]) {
      const ti = parseInt(e.key) - 1;
      if (ti < state.collections[ci].tabs.length) {
        selectTab(ci, ti);
      }
    }
    handled = true;
  }

  // Escape: close settings overlay
  if (e.key === 'Escape') {
    if (!settingsOverlay.classList.contains('hidden')) {
      settingsOverlay.classList.add('hidden');
      handled = true;
    }
  }

  // Alt+Up/Down: jump between collections
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const cols = state.collections;
    if (cols.length > 1) {
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const ci = (state.activeCollectionIdx + dir + cols.length) % cols.length;
      const col = cols[ci];
      if (col.tabs.length > 0) {
        selectTab(ci, 0);
        renderCollections();
      }
    }
    handled = true;
  }

  // Alt+Left/Right: cycle sessions within active collection
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const ci = state.activeCollectionIdx;
    const col = state.collections[ci];
    if (col && col.tabs.length > 1) {
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const ti = (state.activeTabIdx + dir + col.tabs.length) % col.tabs.length;
      selectTab(ci, ti);
      renderCollections();
    }
    handled = true;
  }

  // Alt+1-9: switch tabs within active collection
  if (e.altKey && e.key >= '1' && e.key <= '9') {
    const ci = state.activeCollectionIdx;
    if (ci >= 0 && state.collections[ci]) {
      const ti = parseInt(e.key) - 1;
      if (ti < state.collections[ci].tabs.length) {
        selectTab(ci, ti);
      }
    }
    handled = true;
  }

  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

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
manifold.onSaveState(() => saveState());

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
  addCollection(true).catch(err => console.error('addCollection failed:', err));
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
    [`${mod}+T`, 'New session'],
    [`${mod}+Y`, 'New collection'],
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
  saveState();
}

async function restoreFromState(data) {
  if (!data || !data.collections || !data.collections.length) return false;

  for (let ci = 0; ci < data.collections.length; ci++) {
    const colData = data.collections[ci];

    const col = {
      name: colData.name || `Collection ${ci + 1}`,
      path: colData.path || homeDir || '/',
      expanded: colData.expanded !== false,
      gridded: colData.gridded || false,
      tabs: [],
    };

    const tabs = colData.tabs && colData.tabs.length > 0
      ? colData.tabs
      : [{ name: 'Session 1', cwd: col.path }];

    for (const tabData of tabs) {
      const tabId = genTabId();
      const cwd = tabData.cwd || col.path;
      col.tabs.push({
        id: tabId,
        name: tabData.name || 'Session',
        cwd,
        conversationId: tabData.conversationId || null,
      });
      createTerminalInstance(tabId, cwd, tabData.conversationId || null, tabData.name || 'Session', col.name);
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
    document.getElementById('header-hints').textContent =
      `${mod}+T session | ${mod}+Y collection | ${mod}+W close | ${mod}+G grid | Alt+\u2190\u2192 sessions | Alt+\u2191\u2193 collections`;
    populateShortcuts(isMac);

    const savedState = await manifold.loadState();

    // Apply saved UI scale early
    if (savedState && savedState.uiScale) {
      applyScale(savedState.uiScale);
    }

    await initWorkspace(savedState);
  } catch (err) {
    console.error('Init failed:', err);
  }
})();
