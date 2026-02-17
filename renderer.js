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
  micDevice: null,
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
function createTerminalInstance(tabId, cwd, resume = false) {
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

  // Spawn backend pty
  claude.createTerminal({ id: tabId, cwd, resume });

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
    colEl.className = `collection${col.isSystem ? ' collection-system' : ''}`;
    colEl.innerHTML = `
      <div class="collection-header${col.isSystem ? ' system-header' : ''}" data-ci="${ci}">
        <span class="collection-arrow">${col.expanded ? '\u25BC' : '\u25B6'}</span>
        <div class="collection-info">
          <span class="collection-name">${escHtml(col.name)}</span>
          <span class="collection-path">${escHtml(col.path)}</span>
        </div>
        <input class="collection-rename" type="text" value="${escAttr(col.name)}">
        <div class="collection-btns">
          <button class="collection-btn grid-btn" data-ci="${ci}" title="Grid view">${'\u229E'}</button>
          ${col.isSystem ? '' : `<button class="collection-btn-del del-btn" data-ci="${ci}" title="Delete collection">${'\u2715'}</button>`}
          <button class="collection-btn add-btn" data-ci="${ci}" title="New session">+</button>
        </div>
      </div>
      <div class="collection-body ${col.expanded ? '' : 'collapsed'}" data-ci="${ci}">
        ${col.tabs.map((tab, ti) => `
          <div class="tab-row ${ci === state.activeCollectionIdx && ti === state.activeTabIdx ? 'selected' : ''}"
               data-ci="${ci}" data-ti="${ti}">
            <span class="row-dot" data-tabid="${tab.id}">${'\u2022'}</span>
            <span class="row-label">${escHtml(tab.name)}</span>
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
      const nameEl = el.querySelector('.collection-name');
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

  // Tab row click
  document.querySelectorAll('.tab-row').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('row-close')) return;
      const ci = parseInt(el.dataset.ci);
      const ti = parseInt(el.dataset.ti);
      selectTab(ci, ti);
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
  // Exit grid if selecting from different collection
  if (state.gridCollection !== null && state.gridCollection !== ci) {
    exitGridMode();
  }

  state.activeCollectionIdx = ci;
  state.activeTabIdx = ti;

  const tab = state.collections[ci].tabs[ti];
  if (!tab) return;

  // Update sidebar selection
  document.querySelectorAll('.tab-row').forEach((el) => el.classList.remove('selected'));
  const row = document.querySelector(`.tab-row[data-ci="${ci}"][data-ti="${ti}"]`);
  if (row) row.classList.add('selected');

  // Show terminal and focus it
  if (state.gridCollection === null) {
    showSingleTerminal(tab.id);
  } else {
    // Grid mode: highlight selected cell and focus its terminal
    highlightGridCell(tab.id);
  }
}

function showSingleTerminal(tabId) {
  terminalSingle.innerHTML = '';
  const inst = terminalInstances.get(tabId);
  if (inst) {
    terminalSingle.appendChild(inst.element);
    requestAnimationFrame(() => {
      inst.fitAddon.fit();
      claude.resizeTerminal(tabId, inst.terminal.cols, inst.terminal.rows);
      inst.terminal.focus();
    });
  }
}

function highlightGridCell(tabId) {
  // Remove highlight from all grid cells
  document.querySelectorAll('.grid-cell').forEach((cell) => {
    cell.classList.remove('grid-cell-active');
  });

  // Find and highlight the cell containing this terminal, then focus it
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
  createTerminalInstance(tabId, dir, false);

  // Expand if collapsed
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

  // Destroy terminal
  claude.destroyTerminal(tab.id);
  const inst = terminalInstances.get(tab.id);
  if (inst) {
    inst.terminal.dispose();
    terminalInstances.delete(tab.id);
  }

  col.tabs.splice(ti, 1);

  // Re-select if needed
  if (ci === state.activeCollectionIdx) {
    if (col.tabs.length > 0) {
      const newTi = Math.min(ti, col.tabs.length - 1);
      selectTab(ci, newTi);
    } else {
      // Find any tab in any collection
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

  // Auto-create first session
  if (askPath) {
    const tabId = genTabId();
    col.tabs.push({ id: tabId, name: 'Session 1', cwd: folderPath });
    createTerminalInstance(tabId, folderPath, false);
    selectTab(ci, 0);
  }

  renderCollections();
  saveState();
}

function deleteCollection(ci) {
  if (state.collections.length <= 1) return;
  if (state.collections[ci] && state.collections[ci].isSystem) return; // Can't delete System

  if (state.gridCollection === ci) exitGridMode();

  const col = state.collections[ci];

  // Destroy all terminals
  col.tabs.forEach((tab) => {
    claude.destroyTerminal(tab.id);
    const inst = terminalInstances.get(tab.id);
    if (inst) { inst.terminal.dispose(); terminalInstances.delete(tab.id); }
  });

  state.collections.splice(ci, 1);

  // Fix active indices
  if (state.activeCollectionIdx >= state.collections.length) {
    state.activeCollectionIdx = state.collections.length - 1;
  }
  if (state.activeCollectionIdx === ci || state.activeCollectionIdx < 0) {
    // Find first collection with tabs
    for (let i = 0; i < state.collections.length; i++) {
      if (state.collections[i].tabs.length > 0) {
        selectTab(i, 0);
        break;
      }
    }
  }

  // Fix grid reference
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

  // Dynamic column count based on session count
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

    // Click cell header to select and focus this terminal
    header.addEventListener('click', (e) => {
      if (e.target === closeBtn) return;
      selectTab(ci, ti);
    });

    cell.appendChild(header);

    const inst = terminalInstances.get(tab.id);
    if (inst) {
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

  // Move terminal elements back (they'll be re-attached on selectTab)
  state.gridCollection = null;
  terminalGrid.classList.add('hidden');
  terminalGrid.innerHTML = '';
  terminalSingle.classList.remove('hidden');

  // Re-show active tab
  const tab = getActiveTab();
  if (tab) showSingleTerminal(tab.id);

  renderCollections();
}

// ── State persistence ──
async function saveState() {
  const data = {
    collections: state.collections.map((col) => ({
      name: col.name,
      path: col.path,
      expanded: col.expanded,
      isSystem: col.isSystem || false,
      tabs: col.tabs.map((t) => ({ name: t.name, cwd: t.cwd })),
    })),
    activeCollection: state.activeCollectionIdx,
    activeTab: state.activeTabIdx,
    micDevice: state.micDevice,
  };
  await claude.saveState(data);
}

async function loadState() {
  const data = await claude.loadState();
  if (!data || !data.collections || !data.collections.length) return false;

  for (let ci = 0; ci < data.collections.length; ci++) {
    const colData = data.collections[ci];
    const col = {
      name: colData.name || `Collection ${ci + 1}`,
      path: colData.path || homeDir || '/',
      expanded: colData.expanded !== false,
      isSystem: colData.isSystem || false,
      tabs: [],
    };

    const tabs = colData.tabs && colData.tabs.length > 0
      ? colData.tabs
      : [{ name: 'Session 1', cwd: col.path }];

    for (const tabData of tabs) {
      const tabId = genTabId();
      const cwd = tabData.cwd || col.path;
      col.tabs.push({ id: tabId, name: tabData.name || 'Session', cwd });
      createTerminalInstance(tabId, cwd, true);
    }

    state.collections.push(col);
  }

  state.micDevice = data.micDevice || null;

  const aci = Math.min(data.activeCollection || 0, state.collections.length - 1);
  const ati = Math.min(data.activeTab || 0, state.collections[aci].tabs.length - 1);
  selectTab(aci, ati);
  renderCollections();

  return true;
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

// ── Activity polling (dots + per-terminal border) ──
setInterval(async () => {
  for (const [tabId, inst] of terminalInstances) {
    const active = await claude.isTerminalActive(tabId);

    // Sidebar dot
    const dot = document.querySelector(`.row-dot[data-tabid="${tabId}"]`);
    if (dot) {
      if (active) dot.classList.add('active');
      else dot.classList.remove('active');
    }

  }
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
  console.log('+ Session clicked, activeIdx:', state.activeCollectionIdx, 'collections:', state.collections.length);
  const ci = state.activeCollectionIdx >= 0 ? state.activeCollectionIdx : 0;
  if (state.collections[ci]) {
    addSession(ci);
  } else {
    console.error('No collection at index', ci);
  }
});

document.getElementById('btn-new-collection').addEventListener('click', () => {
  console.log('+ Collection clicked');
  addCollection(true).catch(err => console.error('addCollection failed:', err));
});

// ── Utility ──
function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Handle CSS hot-reload without full page reload
claude.onHotReloadCss(() => {
  const links = document.querySelectorAll('link[rel="stylesheet"]');
  links.forEach((link) => {
    if (link.href.includes('styles.css')) {
      link.href = 'styles.css?' + Date.now();
    }
  });
});

// ── Init ──
(async () => {
  try {
    // Resolve home directory and platform from main process
    homeDir = await claude.getHomeDir() || '/';
    const platform = await claude.getPlatform();
    const isMac = platform === 'darwin';
    document.body.classList.add(`platform-${platform}`);

    // Set platform-appropriate keyboard hints
    const mod = isMac ? 'Cmd' : 'Ctrl';
    const toggle = isMac ? 'Cmd+Shift+C' : 'Super+C';
    document.getElementById('header-hints').textContent =
      `${toggle} toggle | ${mod}+T new session | ${mod}+P open in path | ${mod}+W close | ${mod}+G grid | Alt+1-9 switch`;

    // Get app source dir for the System collection
    const appSourceDir = await claude.getAppSourceDir();

    const loaded = await loadState();
    if (!loaded) {
      state.collections.push({
        name: 'General',
        path: homeDir,
        expanded: true,
        tabs: [],
      });
      addSession(0);
    }

    // Ensure System collection always exists as the first collection
    const sysIdx = state.collections.findIndex((c) => c.isSystem);
    if (sysIdx === -1) {
      // Insert at position 0
      state.collections.unshift({
        name: 'System',
        path: appSourceDir,
        expanded: false,
        isSystem: true,
        tabs: [],
      });
      // Shift active indices since we inserted at 0
      if (state.activeCollectionIdx >= 0) state.activeCollectionIdx++;
      addSession(0);
    } else if (sysIdx !== 0) {
      // Move it to the front if it ended up somewhere else
      const sys = state.collections.splice(sysIdx, 1)[0];
      state.collections.unshift(sys);
      if (state.activeCollectionIdx >= 0) {
        if (state.activeCollectionIdx === sysIdx) state.activeCollectionIdx = 0;
        else if (state.activeCollectionIdx < sysIdx) state.activeCollectionIdx++;
      }
    }

    renderCollections();
  } catch (err) {
    console.error('Init failed:', err);
  }
})();
