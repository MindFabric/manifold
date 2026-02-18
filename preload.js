const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claude', {
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

  // State
  saveState: (state) => ipcRenderer.invoke('save-state', state),
  loadState: () => ipcRenderer.invoke('load-state'),
  onSaveState: (callback) => ipcRenderer.on('save-state', callback),

  // Dialogs
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  // Journal
  openJournalExternal: () => ipcRenderer.invoke('journal-open-external'),
  openJournalDir: () => ipcRenderer.invoke('journal-open-dir'),
  flushJournal: () => ipcRenderer.invoke('journal-flush'),
  listJournalDates: () => ipcRenderer.invoke('journal-list-dates'),
  readJournal: (dateStr) => ipcRenderer.invoke('journal-read', dateStr),
});
