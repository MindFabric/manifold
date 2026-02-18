/* xterm and FitAddon loaded via script tags */
const Terminal = globalThis.Terminal;
const FitAddon = (globalThis.FitAddon || {}).FitAddon;

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

// ── Terminal creation ──
function createTerminalInstance(tabId, cwd, conversationId, name) {
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

  // Spawn backend pty — pass conversationId for --resume if available
  claude.createTerminal({ id: tabId, cwd, conversationId: conversationId || null, name: name || tabId });

  // Pipe input to pty
  term.onData((data) => claude.sendInput(tabId, data));

  // Open terminal (deferred to let DOM settle)
  requestAnimationFrame(() => {
    term.open(el);
    fitAddon.fit();
    claude.resizeTerminal(tabId, term.cols, term.rows);
  });

  return { terminal: term, fitAddon, element: el };
}

// ── Terminal cleanup ──
function destroyTerminalInstance(tabId) {
  claude.destroyTerminal(tabId);
  const inst = terminalInstances.get(tabId);
  if (inst) {
    if (inst.element.parentNode) inst.element.parentNode.removeChild(inst.element);
    try { inst.terminal.dispose(); } catch (_) {}
    terminalInstances.delete(tabId);
  }
}

// ── Receive data from pty ──
claude.onTerminalData((id, data) => {
  const inst = terminalInstances.get(id);
  if (inst) inst.terminal.write(data);
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
            <span class="row-label">${escHtml(tab.name)}</span>
            <input class="row-rename" type="text" value="${escAttr(tab.name)}">
            <button class="row-close" data-ci="${ci}" data-ti="${ti}">${'\u2715'}</button>
          </div>
        `).join('')}
      </div>
    `;
    collectionsList.appendChild(colEl);

    // Grid button active state
    if (state.gridCollection === ci) {
      colEl.querySelector('.grid-btn').classList.add('active');
    }
  });

  // Bind events
  bindCollectionEvents();
}

function bindCollectionEvents() {
  // Collection header click (expand/collapse)
  document.querySelectorAll('.collection-header').forEach((el) => {
    let clickTimer = null;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.collection-btns')) return;
      if (e.target.classList.contains('collection-rename')) return;
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        const ci = parseInt(el.dataset.ci);
        state.collections[ci].expanded = !state.collections[ci].expanded;
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
      const insertAt = srcTi < dstTi ? dstTi : dstTi;
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
}

// ── Tab selection ──
function selectTab(ci, ti) {
  if (state.gridCollection !== null && state.gridCollection !== ci) {
    exitGridMode();
  }

  state.activeCollectionIdx = ci;
  state.activeTabIdx = ti;

  const tab = state.collections[ci].tabs[ti];
  if (!tab) return;

  document.querySelectorAll('.tab-row').forEach((el) => el.classList.remove('selected'));
  const row = document.querySelector(`.tab-row[data-ci="${ci}"][data-ti="${ti}"]`);
  if (row) row.classList.add('selected');

  if (state.gridCollection === null) {
    showSingleTerminal(tab.id);
  } else {
    highlightGridCell(tab.id);
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
    requestAnimationFrame(() => {
      inst.fitAddon.fit();
      claude.resizeTerminal(tabId, inst.terminal.cols, inst.terminal.rows);
      inst.terminal.focus();
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

  const wasGridded = state.gridCollection === ci;
  if (wasGridded) exitGridMode();

  const tabId = genTabId();
  const dir = cwd || col.path;
  const name = `Session ${col.tabs.length + 1}`;

  col.tabs.push({ id: tabId, name, cwd: dir });
  createTerminalInstance(tabId, dir, null, name);

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();

  if (wasGridded) enterGridMode(ci);
  saveState();
}

function closeSession(ci, ti) {
  const totalTabs = state.collections.reduce((sum, c) => sum + c.tabs.length, 0);
  if (totalTabs <= 1) return;

  const col = state.collections[ci];
  const tab = col.tabs[ti];
  if (!tab) return;

  const wasGridded = state.gridCollection === ci;
  if (wasGridded) exitGridMode();

  destroyTerminalInstance(tab.id);

  col.tabs.splice(ti, 1);

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

  if (wasGridded && col.tabs.length > 0) enterGridMode(ci);
  renderCollections();
  saveState();
}

// ── Collection management ──
async function addCollection(askPath = false) {
  let folderPath = null;
  let name = null;

  if (askPath) {
    folderPath = await claude.pickFolder();
    if (!folderPath) return;
    const parts = folderPath.split(/[/\\]/);
    name = parts[parts.length - 1] || folderPath;
  }

  if (!name) name = `Collection ${state.collections.length + 1}`;
  if (!folderPath) folderPath = homeDir || '/';

  const col = { name, path: folderPath, expanded: true, tabs: [] };
  state.collections.push(col);
  const ci = state.collections.length - 1;

  if (askPath) {
    const tabId = genTabId();
    col.tabs.push({ id: tabId, name: 'Session 1', cwd: folderPath });
    createTerminalInstance(tabId, folderPath, null, 'Session 1');
    selectTab(ci, 0);
  }

  renderCollections();
  saveState();
}

function deleteCollection(ci) {
  if (state.collections.length <= 1) return;

  if (state.gridCollection === ci) exitGridMode();

  const col = state.collections[ci];

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

  if (state.gridCollection !== null) {
    if (state.gridCollection === ci) state.gridCollection = null;
    else if (state.gridCollection > ci) state.gridCollection--;
  }

  renderCollections();
  saveState();
}

// ── Grid view ──
function toggleGrid(ci) {
  if (state.gridCollection === ci) {
    exitGridMode();
  } else {
    if (state.gridCollection !== null) exitGridMode();
    enterGridMode(ci);
  }
  renderCollections();
}

function enterGridMode(ci) {
  const col = state.collections[ci];
  if (!col || !col.tabs.length) return;

  state.gridCollection = ci;
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
      // Detach from previous parent (terminalSingle) before moving to grid cell
      if (inst.element.parentNode) inst.element.parentNode.removeChild(inst.element);
      inst.element.style.display = '';
      cell.appendChild(inst.element);
      requestAnimationFrame(() => {
        inst.fitAddon.fit();
        claude.resizeTerminal(tab.id, inst.terminal.cols, inst.terminal.rows);
      });
    }

    terminalGrid.appendChild(cell);
  });
}

function exitGridMode() {
  if (state.gridCollection === null) return;

  // Detach all terminal elements from grid cells BEFORE clearing grid
  // so they aren't orphaned when grid-cell divs are destroyed
  for (const [, inst] of terminalInstances) {
    if (inst.element.parentNode && inst.element.closest('#terminal-grid')) {
      inst.element.parentNode.removeChild(inst.element);
    }
  }

  state.gridCollection = null;
  terminalGrid.classList.add('hidden');
  terminalGrid.innerHTML = '';
  terminalSingle.classList.remove('hidden');

  const tab = getActiveTab();
  if (tab) showSingleTerminal(tab.id);

  renderCollections();
}

// ── State persistence ──
// Before saving, fetch conversation IDs from main process for each tab
async function saveState() {
  // Update conversation IDs from main process (parallel for speed)
  const allTabs = state.collections.flatMap(col => col.tabs);
  const convoResults = await Promise.all(
    allTabs.map(tab => claude.getConversationId(tab.id).catch(() => null))
  );
  allTabs.forEach((tab, i) => {
    if (convoResults[i]) tab.conversationId = convoResults[i];
  });

  const data = {
    collections: state.collections.map((col) => ({
      name: col.name,
      path: col.path,
      expanded: col.expanded,
      tabs: col.tabs.map((t) => ({
        name: t.name,
        cwd: t.cwd,
        conversationId: t.conversationId || null,
      })),
    })),
    activeCollection: state.activeCollectionIdx,
    activeTab: state.activeTabIdx,
  };
  await claude.saveState(data);
}

async function loadState() {
  const data = await claude.loadState();
  if (!data || !data.collections || !data.collections.length) return false;

  for (let ci = 0; ci < data.collections.length; ci++) {
    const colData = data.collections[ci];
    // Skip any leftover System collections from old state
    if (colData.isSystem || colData.name === 'System') continue;

    const col = {
      name: colData.name || `Collection ${ci + 1}`,
      path: colData.path || homeDir || '/',
      expanded: colData.expanded !== false,
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
      // Resume specific conversation if we have its ID, otherwise start fresh
      createTerminalInstance(tabId, cwd, tabData.conversationId || null, tabData.name || 'Session');
    }

    state.collections.push(col);
  }

  if (state.collections.length === 0) return false;

  return {
    activeCollection: data.activeCollection || 0,
    activeTab: data.activeTab || 0,
  };
}

// ── Keybindings ──
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === 't') {
    e.preventDefault();
    const ci = state.activeCollectionIdx >= 0 ? state.activeCollectionIdx : 0;
    if (state.collections[ci]) addSession(ci);
  }

  if (ctrl && e.key === 'w') {
    e.preventDefault();
    if (state.activeCollectionIdx >= 0 && state.activeTabIdx >= 0) {
      closeSession(state.activeCollectionIdx, state.activeTabIdx);
    }
  }

  if (ctrl && e.key === 'p') {
    e.preventDefault();
    addCollection(true);
  }

  if (ctrl && e.key === 'g') {
    e.preventDefault();
    if (state.activeCollectionIdx >= 0) {
      toggleGrid(state.activeCollectionIdx);
    }
  }

  // Ctrl/Cmd+1-9: switch tabs within active collection
  if (ctrl && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const ci = state.activeCollectionIdx;
    if (ci >= 0 && state.collections[ci]) {
      const ti = parseInt(e.key) - 1;
      if (ti < state.collections[ci].tabs.length) {
        selectTab(ci, ti);
      }
    }
  }

  // Ctrl/Cmd+J: toggle journal viewer
  if (ctrl && e.key === 'j') {
    e.preventDefault();
    if (journalOverlay.classList.contains('hidden')) {
      openJournalViewer();
    } else {
      closeJournalViewer();
    }
  }

  // Escape: close overlays
  if (e.key === 'Escape') {
    if (!journalOverlay.classList.contains('hidden')) {
      closeJournalViewer();
      e.preventDefault();
      return;
    }
    if (!settingsOverlay.classList.contains('hidden')) {
      settingsOverlay.classList.add('hidden');
      e.preventDefault();
      return;
    }
  }

  // Alt+1-9: switch globally across all collections
  if (e.altKey && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    let count = 0;
    for (let ci = 0; ci < state.collections.length; ci++) {
      for (let ti = 0; ti < state.collections[ci].tabs.length; ti++) {
        if (count === idx) { selectTab(ci, ti); return; }
        count++;
      }
    }
  }
});

// ── Activity polling ──
setInterval(async () => {
  const tabIds = [...terminalInstances.keys()];
  const results = await Promise.all(
    tabIds.map(id => claude.isTerminalActive(id).catch(() => false))
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
claude.onSaveState(() => saveState());

// ── Resize handler ──
window.addEventListener('resize', () => {
  const tab = getActiveTab();
  if (tab && state.gridCollection === null) {
    const inst = terminalInstances.get(tab.id);
    if (inst) {
      inst.fitAddon.fit();
      claude.resizeTerminal(tab.id, inst.terminal.cols, inst.terminal.rows);
    }
  }
  if (state.gridCollection !== null) {
    const col = state.collections[state.gridCollection];
    if (col) {
      col.tabs.forEach((t) => {
        const inst = terminalInstances.get(t.id);
        if (inst) {
          inst.fitAddon.fit();
          claude.resizeTerminal(t.id, inst.terminal.cols, inst.terminal.rows);
        }
      });
    }
  }
});

// ── Button events ──
document.getElementById('btn-new-session').addEventListener('click', () => {
  const ci = state.activeCollectionIdx >= 0 ? state.activeCollectionIdx : 0;
  if (state.collections[ci]) addSession(ci);
});

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
  const dates = await claude.listJournalDates();
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

    if (journalDates.has(dateStr)) cell.classList.add('has-entry');
    if (dateStr === today) cell.classList.add('today');
    if (dateStr === journalSelectedDate) cell.classList.add('selected');

    if (journalDates.has(dateStr)) {
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

  const content = await claude.readJournal(dateStr);
  if (content) {
    journalContentBody.innerHTML = renderMarkdown(content);
  } else {
    journalContentBody.innerHTML = '<p class="journal-empty">No entry for this date.</p>';
  }
}

// Simple markdown renderer for journal entries
function renderMarkdown(md) {
  return md
    .split('\n')
    .map(line => {
      if (/^### (.+)/.test(line)) return `<h3>${escHtml(line.replace(/^### /, ''))}</h3>`;
      if (/^## (.+)/.test(line)) return `<h2>${escHtml(line.replace(/^## /, ''))}</h2>`;
      if (/^# (.+)/.test(line)) return `<h1>${escHtml(line.replace(/^# /, ''))}</h1>`;
      if (/^---\s*$/.test(line)) return '<hr>';
      if (/^- (.+)/.test(line)) return `<li>${escHtml(line.replace(/^- /, ''))}</li>`;
      if (line.trim() === '') return '';
      return `<p>${escHtml(line)}</p>`;
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

// Journal header buttons
document.getElementById('journal-flush-btn').addEventListener('click', async () => {
  const btn = document.getElementById('journal-flush-btn');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    await claude.flushJournal();
    // Refresh view
    const dates = await claude.listJournalDates();
    journalDates = new Set(dates);
    renderJournalCalendar();
    renderJournalDayList();
    const today = todayStr();
    if (journalDates.has(today)) selectJournalDate(today);
  } catch (_) {}
  btn.textContent = '\u270E';
  btn.disabled = false;
});
document.getElementById('journal-ext-btn').addEventListener('click', () => claude.openJournalExternal());
document.getElementById('journal-dir-btn').addEventListener('click', () => claude.openJournalDir());

// Settings journal buttons (point to viewer now)
document.getElementById('settings-journal-open').addEventListener('click', () => {
  settingsOverlay.classList.add('hidden');
  openJournalViewer();
});
document.getElementById('settings-journal-dir').addEventListener('click', () => claude.openJournalDir());
document.getElementById('settings-journal-flush').addEventListener('click', async () => {
  const btn = document.getElementById('settings-journal-flush');
  const label = btn.querySelector('.settings-label');
  const origText = label.textContent;
  label.textContent = 'Writing...';
  btn.disabled = true;
  try {
    await claude.flushJournal();
    label.textContent = 'Done!';
    setTimeout(() => { label.textContent = origText; btn.disabled = false; }, 2000);
  } catch (err) {
    label.textContent = 'Failed';
    setTimeout(() => { label.textContent = origText; btn.disabled = false; }, 2000);
  }
});

document.getElementById('nuke-btn').addEventListener('click', async () => {
  if (!confirm('Factory reset — clear all saved state and start fresh?')) return;
  if (!confirm('Last chance. Reset everything?')) return;
  await claude.saveState(null);
  location.reload();
});

// ── Utility ──
function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ── Init ──
(async () => {
  try {
    homeDir = await claude.getHomeDir() || '/';
    const platform = await claude.getPlatform();
    const isMac = platform === 'darwin';
    document.body.classList.add(`platform-${platform}`);

    const mod = isMac ? 'Cmd' : 'Ctrl';
    const toggle = isMac ? 'Cmd+Shift+C' : 'Super+C';
    document.getElementById('header-hints').textContent =
      `${toggle} toggle | ${mod}+T new | ${mod}+P path | ${mod}+W close | ${mod}+G grid | ${mod}+J journal | Alt+1-9 switch`;

    const loaded = await loadState();
    if (!loaded) {
      const gTabId = genTabId();
      state.collections.push({
        name: 'General',
        path: homeDir,
        expanded: true,
        tabs: [{ id: gTabId, name: 'Session 1', cwd: homeDir }],
      });
      createTerminalInstance(gTabId, homeDir, null, 'Session 1');
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
  } catch (err) {
    console.error('Init failed:', err);
  }
})();
