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
  forkConversation: (opts) => ipcRenderer.invoke('fork-conversation', opts),
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (event, { id, data }) => callback(id, data));
  },
  onConversationDetected: (callback) => {
    ipcRenderer.on('conversation-detected', (event, { id, conversationId }) => callback(id, conversationId));
  },

  // State
  saveState: (state) => ipcRenderer.invoke('save-state', state),
  saveStateDone: () => ipcRenderer.send('save-state-done'),
  loadState: () => ipcRenderer.invoke('load-state'),
  onSaveState: (callback) => ipcRenderer.on('save-state', callback),
  onWindowFocus: (callback) => ipcRenderer.on('window-focus', callback),

  // Dialogs
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  // UI Scale
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
  getZoomFactor: () => webFrame.getZoomFactor(),
});
