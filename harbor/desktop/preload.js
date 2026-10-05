'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets a small, explicit API. No Node, no fs, no arbitrary IPC.
contextBridge.exposeInMainWorld('harbor', {
  getState: () => ipcRenderer.invoke('harbor:getState'),
  saveSettings: (patch) => ipcRenderer.invoke('harbor:saveSettings', patch),
  pickShare: () => ipcRenderer.invoke('harbor:pickShare'),
  submit: (req) => ipcRenderer.invoke('harbor:submit', req),
  confirmClear: (ticketId) => ipcRenderer.invoke('harbor:confirmClear', ticketId),
  openReport: (ticketId) => ipcRenderer.invoke('harbor:openReport', ticketId),
  onEvent: (cb) => {
    const fn = (_e, msg) => cb(msg);
    ipcRenderer.on('harbor:event', fn);
    return () => ipcRenderer.removeListener('harbor:event', fn);
  },
});
