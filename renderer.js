/* xterm and FitAddon loaded via script tags */
const Terminal = globalThis.Terminal;
const FitAddon = (globalThis.FitAddon || {}).FitAddon;

if (!Terminal) console.error('xterm Terminal not loaded!');
if (!FitAddon) console.error('FitAddon not loaded!');

// Home directory - resolved async at startup
let homeDir = '/';

// Selected CLI tool: 'claude' | 'gemini' | 'codex'
let currentTool = null;

const TOOL_NAMES = { claude: 'Claude Code', gemini: 'Gemini CLI', codex: 'Codex CLI' };

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
    // Direct DOM fallback in case xterm API doesn't stick
    const vp = inst.element.querySelector('.xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
  }, 50);
}

// ── Terminal creation ──
function createTerminalInstance(tabId, cwd, conversationId, name, collectionName, prompt) {
  const term = new Terminal({
    cursorBlink: true,
    scrollback: 50000,
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

  // Spawn backend pty — pass conversationId for --resume if available, or prompt for GSD mode
  manifold.createTerminal({ id: tabId, cwd, conversationId: conversationId || null, name: name || tabId, collectionName: collectionName || '', prompt: prompt || null });

  // Pipe input to pty
  term.onData((data) => manifold.sendInput(tabId, data));

  // Open terminal (double RAF to let DOM fully settle before measuring)
  requestAnimationFrame(() => {
    term.open(el);
    requestAnimationFrame(() => fitTerminal(tabId));
  });

  return { terminal: term, fitAddon, element: el };
}

// ── Terminal cleanup ──
function destroyTerminalInstance(tabId) {
  manifold.destroyTerminal(tabId);
  const inst = terminalInstances.get(tabId);
  if (inst) {
    if (inst.element.parentNode) inst.element.parentNode.removeChild(inst.element);
    try { inst.terminal.dispose(); } catch (_) {}
    terminalInstances.delete(tabId);
  }
}

// ── Receive data from pty ──
manifold.onTerminalData((id, data) => {
  const inst = terminalInstances.get(id);
  if (inst) inst.terminal.write(data);
});

// ── Auto-naming ──
manifold.onTerminalAutoName((id, name) => {
  // Find the tab with this ID and update its name (only if still default)
  for (const col of state.collections) {
    for (const tab of col.tabs) {
      if (tab.id === id && /^Session \d+$/i.test(tab.name)) {
        tab.name = name;
        renderCollections();
        saveState();
        return;
      }
    }
  }
});

// ── Collection rendering ──
function renderCollections() {
  collectionsList.innerHTML = '';
  state.collections.forEach((col, ci) => {
    const colEl = document.createElement('div');
    colEl.className = 'collection';
    colEl.innerHTML = `
      <div class="collection-header" data-ci="${ci}">
        <span class="collection-arrow">${col.expanded ? '\u25BC' : '\u25B6'}</span>
        <div class="collection-info">
          <span class="collection-name">${escHtml(col.name)}</span>
          <span class="collection-path">${escHtml(col.path)}</span>
        </div>
        <input class="collection-rename" type="text" value="${escAttr(col.name)}">
        <div class="collection-btns">
          <button class="gsd-btn" data-ci="${ci}" title="Plan — orchestrated execution">Plan</button>
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

  // Bind events
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
          // Grid is on for this collection — switch to it
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

      // Only reorder within same collection
      if (srcCi !== dstCi) return;
      if (srcTi === dstTi) return;

      const col = state.collections[srcCi];
      const [moved] = col.tabs.splice(srcTi, 1);
      // After splice, indices above srcTi shift down by 1
      const insertAt = srcTi < dstTi ? dstTi - 1 : dstTi;
      col.tabs.splice(insertAt, 0, moved);

      // Update active tab index if needed
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

  // Plan button — launch GSD session directly (no modal)
  document.querySelectorAll('.gsd-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const ci = parseInt(el.dataset.ci);
      launchGsdSession(ci);
    });
  });
}

// ── Tab selection ──
function selectTab(ci, ti) {
  state.activeCollectionIdx = ci;
  state.activeTabIdx = ti;

  const tab = state.collections[ci].tabs[ti];
  if (!tab) return;

  document.querySelectorAll('.tab-row').forEach((el) => el.classList.remove('selected'));
  const row = document.querySelector(`.tab-row[data-ci="${ci}"][data-ti="${ti}"]`);
  if (row) row.classList.add('selected');

  const col = state.collections[ci];
  if (col.gridded) {
    // This collection has grid on — show grid view
    state.gridCollection = ci;
    showGridView(ci);
    highlightGridCell(tab.id);
  } else {
    // Different collection or no grid — show single terminal
    if (state.gridCollection !== null) hideGridView();
    state.gridCollection = null;
    showSingleTerminal(tab.id);
  }
}

function showSingleTerminal(tabId) {
  // Hide all terminals instead of removing them (preserves scroll position)
  for (const child of terminalSingle.children) {
    child.style.display = 'none';
  }
  const inst = terminalInstances.get(tabId);
  if (inst) {
    if (!inst.element.parentNode || inst.element.parentNode !== terminalSingle) {
      terminalSingle.appendChild(inst.element);
    }
    inst.element.style.display = '';
    // Double RAF: first lets browser recalc layout, second measures correctly
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

  // If this collection is now empty, clear its grid flag
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

  // Update gridCollection index after splice
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
// Grid is per-collection: col.gridded is the persistent flag.
// state.gridCollection tracks which collection's grid is currently displayed in the DOM.

function toggleGrid(ci) {
  const col = state.collections[ci];
  if (col.gridded) {
    // Turn grid off for this collection
    col.gridded = false;
    state.gridCollection = null;
    hideGridView();
    const tab = getActiveTab();
    if (tab) showSingleTerminal(tab.id);
  } else {
    // Turn grid on
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

  // Detach any terminals currently in the grid
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
      requestAnimationFrame(() => {
        requestAnimationFrame(() => fitTerminal(tab.id));
      });
    }

    terminalGrid.appendChild(cell);
  });
}

function hideGridView() {
  // Detach all terminal elements from grid cells before clearing
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
// Before saving, fetch conversation IDs from main process for each tab
async function saveState() {
  // Update conversation IDs from main process (parallel for speed)
  const allTabs = state.collections.flatMap(col => col.tabs);
  const convoResults = await Promise.all(
    allTabs.map(tab => manifold.getConversationId(tab.id).catch(() => null))
  );
  allTabs.forEach((tab, i) => {
    if (convoResults[i]) tab.conversationId = convoResults[i];
  });

  const data = {
    selectedTool: currentTool,
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
// Use capture phase so shortcuts fire before xterm swallows keys like Ctrl+3 (ESC)
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

  // Ctrl/Cmd+Shift+G: launch GSD plan session for active collection
  if (ctrl && e.shiftKey && e.key === 'G') {
    if (state.activeCollectionIdx >= 0) {
      launchGsdSession(state.activeCollectionIdx);
    }
    handled = true;
  }

  // Ctrl/Cmd+J: toggle journal viewer
  if (ctrl && e.key === 'j') {
    if (journalOverlay.classList.contains('hidden')) {
      openJournalViewer();
    } else {
      closeJournalViewer();
    }
    handled = true;
  }

  // Escape: close overlays
  if (e.key === 'Escape') {
    if (!journalOverlay.classList.contains('hidden')) {
      closeJournalViewer();
      handled = true;
    } else if (!settingsOverlay.classList.contains('hidden')) {
      settingsOverlay.classList.add('hidden');
      handled = true;
    }
  }

  // Alt+1-9: switch tabs within active collection (same as Ctrl+1-9)
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

// ── Plan (GSD integration) ──

function launchGsdSession(ci) {
  const col = state.collections[ci];
  if (!col) return;

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  // Spawn a new Claude session that runs /gsd:new-project directly
  const tabId = genTabId();
  col.tabs.push({ id: tabId, name: 'Plan', cwd: col.path });
  createTerminalInstance(tabId, col.path, null, 'Plan', col.name, '/gsd:new-project');

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();

  if (wasGridded) showGridView(ci);
  saveState();
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
manifold.onSaveState(() => saveState());

// ── Window focus handler — scroll active terminal to bottom ──
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
  document.getElementById('settings-tool-name').textContent = TOOL_NAMES[currentTool] || 'Not selected';
  settingsOverlay.classList.toggle('hidden');
});

document.getElementById('tool-change-btn').addEventListener('click', async () => {
  settingsOverlay.classList.add('hidden');
  await showToolSelector();
});
document.getElementById('settings-close-btn').addEventListener('click', () => {
  settingsOverlay.classList.add('hidden');
});
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
});

// ── Journal viewer ──
const journalOverlay = document.getElementById('journal-overlay');
const journalCalDays = document.getElementById('journal-cal-days');
const journalCalMonthLabel = document.getElementById('journal-cal-month-label');
const journalDayList = document.getElementById('journal-day-list');
const journalContentDate = document.getElementById('journal-content-date');
const journalContentBody = document.getElementById('journal-content-body');

let journalDates = new Set(); // dates with entries: '2026-02-17'
let journalViewMonth = new Date(); // currently viewed month
let journalSelectedDate = null; // currently selected date string

function padZ(n) { return n < 10 ? '0' + n : '' + n; }

function toDateStr(d) {
  return `${d.getFullYear()}-${padZ(d.getMonth() + 1)}-${padZ(d.getDate())}`;
}

function todayStr() { return toDateStr(new Date()); }

async function openJournalViewer() {
  journalOverlay.classList.remove('hidden');
  // Load available dates
  const dates = await manifold.listJournalDates();
  journalDates = new Set(dates);
  journalViewMonth = new Date();
  journalSelectedDate = null;
  renderJournalCalendar();
  renderJournalDayList();
  // Auto-select today if it has an entry
  const today = todayStr();
  if (journalDates.has(today)) {
    selectJournalDate(today);
  } else if (dates.length > 0) {
    selectJournalDate(dates[0]); // most recent
  } else {
    journalContentDate.textContent = '';
    journalContentBody.innerHTML = '<p class="journal-empty">No journal entries yet. Activity is recorded automatically as you work.</p>';
  }
}

function closeJournalViewer() {
  journalOverlay.classList.add('hidden');
}

function renderJournalCalendar() {
  const year = journalViewMonth.getFullYear();
  const month = journalViewMonth.getMonth();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  journalCalMonthLabel.textContent = `${monthNames[month]} ${year}`;

  journalCalDays.innerHTML = '';

  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    const cell = document.createElement('div');
    cell.className = 'jcal-day empty';
    journalCalDays.appendChild(cell);
  }

  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${padZ(month + 1)}-${padZ(d)}`;
    const cell = document.createElement('div');
    cell.className = 'jcal-day';
    cell.textContent = d;

    const isFuture = dateStr > today;
    if (journalDates.has(dateStr)) cell.classList.add('has-entry');
    if (dateStr === today) cell.classList.add('today');
    if (isFuture) cell.classList.add('future');
    if (dateStr === journalSelectedDate) cell.classList.add('selected');

    if (!isFuture) {
      cell.addEventListener('click', () => selectJournalDate(dateStr));
    }

    journalCalDays.appendChild(cell);
  }
}

function renderJournalDayList() {
  journalDayList.innerHTML = '';
  const sortedDates = [...journalDates].sort().reverse();

  for (const dateStr of sortedDates) {
    const d = new Date(dateStr + 'T12:00:00');
    const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    const item = document.createElement('div');
    item.className = 'jday-item';
    if (dateStr === journalSelectedDate) item.classList.add('selected');
    item.innerHTML = `<span class="jday-dot"></span><span>${label}</span>`;
    item.addEventListener('click', () => selectJournalDate(dateStr));
    journalDayList.appendChild(item);
  }
}

async function selectJournalDate(dateStr) {
  journalSelectedDate = dateStr;

  // Update calendar selection
  journalCalDays.querySelectorAll('.jcal-day').forEach(c => c.classList.remove('selected'));
  journalCalDays.querySelectorAll('.jcal-day').forEach(c => {
    // Find matching cell by checking date
    const d = new Date(dateStr + 'T12:00:00');
    const viewYear = journalViewMonth.getFullYear();
    const viewMonth = journalViewMonth.getMonth();
    if (d.getFullYear() === viewYear && d.getMonth() === viewMonth && parseInt(c.textContent) === d.getDate()) {
      c.classList.add('selected');
    }
  });

  // Update day list selection
  journalDayList.querySelectorAll('.jday-item').forEach(el => el.classList.remove('selected'));
  journalDayList.querySelectorAll('.jday-item').forEach((el, i) => {
    const sortedDates = [...journalDates].sort().reverse();
    if (sortedDates[i] === dateStr) el.classList.add('selected');
  });

  // Load and render content
  const d = new Date(dateStr + 'T12:00:00');
  journalContentDate.textContent = d.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const content = await manifold.readJournal(dateStr);
  if (content) {
    journalContentBody.innerHTML = renderMarkdown(content);
  } else {
    journalContentBody.innerHTML = '<p class="journal-empty">No entry for this date.</p>';
  }
}

// Simple markdown renderer for journal entries
function inlineMarkdown(escaped) {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

function renderMarkdown(md) {
  return md
    .split('\n')
    .map(line => {
      if (/^### (.+)/.test(line)) return `<h3>${inlineMarkdown(escHtml(line.replace(/^### /, '')))}</h3>`;
      if (/^## (.+)/.test(line)) return `<h2>${inlineMarkdown(escHtml(line.replace(/^## /, '')))}</h2>`;
      if (/^# (.+)/.test(line)) return `<h1>${inlineMarkdown(escHtml(line.replace(/^# /, '')))}</h1>`;
      if (/^---\s*$/.test(line)) return '<hr>';
      if (/^- (.+)/.test(line)) return `<li>${inlineMarkdown(escHtml(line.replace(/^- /, '')))}</li>`;
      if (line.trim() === '') return '';
      return `<p>${inlineMarkdown(escHtml(line))}</p>`;
    })
    .join('\n')
    // Wrap consecutive <li> in <ul>
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
}

// Journal button opens viewer
document.getElementById('journal-btn').addEventListener('click', () => openJournalViewer());

// Close journal viewer
document.getElementById('journal-close-btn').addEventListener('click', closeJournalViewer);
journalOverlay.addEventListener('click', (e) => {
  if (e.target === journalOverlay) closeJournalViewer();
});

// Calendar navigation
document.getElementById('journal-cal-prev').addEventListener('click', () => {
  journalViewMonth.setMonth(journalViewMonth.getMonth() - 1);
  renderJournalCalendar();
});
document.getElementById('journal-cal-next').addEventListener('click', () => {
  journalViewMonth.setMonth(journalViewMonth.getMonth() + 1);
  renderJournalCalendar();
});

// Weekly export
document.getElementById('journal-export-btn').addEventListener('click', async () => {
  const btn = document.getElementById('journal-export-btn');
  const origText = btn.textContent;
  btn.textContent = 'Exporting...';
  btn.classList.add('exporting');

  try {
    const result = await manifold.weeklyExport();
    if (!result.success) {
      btn.textContent = result.error || 'No entries found';
      setTimeout(() => { btn.textContent = origText; btn.classList.remove('exporting'); }, 2500);
      return;
    }

    // Trigger download via blob
    const blob = new Blob([result.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `weekly-report-${result.startDate}-to-${result.endDate}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    btn.textContent = 'Exported!';
    setTimeout(() => { btn.textContent = origText; btn.classList.remove('exporting'); }, 2000);
  } catch (err) {
    console.error('Weekly export failed:', err);
    btn.textContent = 'Export failed';
    setTimeout(() => { btn.textContent = origText; btn.classList.remove('exporting'); }, 2500);
  }
});

// ── UI Scale slider ──
const scaleSlider = document.getElementById('scale-slider');
const scaleValue = document.getElementById('scale-value');

function applyScale(pct) {
  const factor = pct / 100;
  manifold.setZoomFactor(factor);
  scaleValue.textContent = `${pct}%`;
  scaleSlider.value = pct;
  // Refit all visible terminals after zoom settles
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

// Double-click slider to reset to 100%
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

// ── Tool selector ──

async function showToolSelector() {
  return new Promise(async (resolve) => {
    const overlay = document.getElementById('tool-selector-overlay');
    const cardsContainer = document.getElementById('tool-cards');
    const installStatus = document.getElementById('tool-install-status');
    const installText = document.getElementById('tool-install-text');
    const installError = document.getElementById('tool-install-error');

    const [installed, configs] = await Promise.all([
      manifold.detectTools(),
      manifold.getToolConfigs(),
    ]);

    cardsContainer.innerHTML = '';
    installStatus.classList.add('hidden');
    installError.classList.add('hidden');

    for (const [key, config] of Object.entries(configs)) {
      const card = document.createElement('div');
      card.className = 'tool-card';
      card.dataset.tool = key;
      card.innerHTML = `
        <div class="tool-card-info">
          <span class="tool-card-name">${escHtml(config.name)}</span>
          <span class="tool-card-binary">${escHtml(config.binary)}</span>
        </div>
        <span class="tool-card-status ${installed[key] ? '' : 'not-installed'}">
          ${installed[key] ? 'installed' : 'not installed'}
        </span>
      `;

      card.addEventListener('click', async () => {
        // Disable all cards during processing
        cardsContainer.querySelectorAll('.tool-card').forEach(c => {
          c.classList.remove('selected');
          c.style.pointerEvents = 'none';
        });
        card.classList.add('selected');
        installError.classList.add('hidden');

        if (!installed[key]) {
          installStatus.classList.remove('hidden');
          installText.textContent = `Installing ${config.name}...`;
          const result = await manifold.installTool(key);
          if (result.success) {
            installed[key] = true;
            card.querySelector('.tool-card-status').textContent = 'installed';
            card.querySelector('.tool-card-status').classList.remove('not-installed');
            installStatus.classList.add('hidden');
          } else {
            installStatus.classList.add('hidden');
            installError.textContent = `Install failed: ${result.error}`;
            installError.classList.remove('hidden');
            // Re-enable cards
            cardsContainer.querySelectorAll('.tool-card').forEach(c => c.style.pointerEvents = '');
            return;
          }
        }

        // Tool is installed — select and close
        currentTool = key;
        await manifold.setSelectedTool(key);
        overlay.classList.add('hidden');
        // Re-enable cards for next time
        cardsContainer.querySelectorAll('.tool-card').forEach(c => c.style.pointerEvents = '');
        resolve();
      });

      cardsContainer.appendChild(card);
    }

    overlay.classList.remove('hidden');
  });
}

// ── Workspace init (after tool is selected) ──

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
    const toggle = isMac ? 'Cmd+Shift+C' : 'Super+C';
    document.getElementById('header-hints').textContent =
      `${toggle} toggle | ${mod}+T session | ${mod}+Y collection | ${mod}+W close | ${mod}+G grid | ${mod}+J journal | ${mod}+Shift+G plan | Alt+1-9 switch`;

    const savedState = await manifold.loadState();

    // Apply saved UI scale early
    if (savedState && savedState.uiScale) {
      applyScale(savedState.uiScale);
    }

    if (savedState && savedState.selectedTool) {
      // Returning user — restore tool and proceed
      currentTool = savedState.selectedTool;
      await manifold.setSelectedTool(currentTool);
      await initWorkspace(savedState);
    } else if (savedState && savedState.collections && savedState.collections.length > 0) {
      // Existing user upgrading — default to Claude
      currentTool = 'claude';
      await manifold.setSelectedTool('claude');
      await initWorkspace(savedState);
    } else {
      // First launch — show tool selector, then init workspace
      await showToolSelector();
      await initWorkspace(null);
    }
  } catch (err) {
    console.error('Init failed:', err);
  }
})();
