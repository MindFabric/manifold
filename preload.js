const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('manifold', {
  // Environment
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),

  // Terminal
  createTerminal: (opts) => ipcRenderer.invoke('terminal-create', opts),
  sendInput: (id, data) => ipcRenderer.send('terminal-input', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', { id, cols, rows }),
  destroyTerminal: (id) => ipcRenderer.send('terminal-destroy', { id }),
  isTerminalActive: (tabId) => ipcRenderer.invoke('terminal-is-active', { id: tabId }),
  getConversationId: (tabId) => ipcRenderer.invoke('terminal-get-conversation-id', { id: tabId }),
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (event, { id, data }) => callback(id, data));
  },
  onTerminalAutoName: (callback) => {
    ipcRenderer.on('terminal-auto-name', (event, { id, name }) => callback(id, name));
  },

  // State
  saveState: (state) => ipcRenderer.invoke('save-state', state),
  loadState: () => ipcRenderer.invoke('load-state'),
  onSaveState: (callback) => ipcRenderer.on('save-state', callback),
  onWindowFocus: (callback) => ipcRenderer.on('window-focus', callback),

  // Dialogs
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  // Tool selection
  detectTools: () => ipcRenderer.invoke('detect-tools'),
  installTool: (toolKey) => ipcRenderer.invoke('install-tool', toolKey),
  setSelectedTool: (toolKey) => ipcRenderer.invoke('set-selected-tool', toolKey),
  getToolConfigs: () => ipcRenderer.invoke('get-tool-configs'),

  // Journal
  listJournalDates: () => ipcRenderer.invoke('journal-list-dates'),
  readJournal: (dateStr) => ipcRenderer.invoke('journal-read', dateStr),
  weeklyExport: () => ipcRenderer.invoke('journal-weekly-export'),

  // UI Scale
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
  getZoomFactor: () => webFrame.getZoomFactor(),
});
