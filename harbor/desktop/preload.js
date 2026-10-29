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
  resolveClip: (fingerprint, rel) => ipcRenderer.invoke('harbor:resolveClip', fingerprint, rel),
  connectCard: (fingerprint) => ipcRenderer.invoke('harbor:connectCard', fingerprint),
  pickCardFolder: (fingerprint) => ipcRenderer.invoke('harbor:pickCardFolder', fingerprint),
  openClipExternally: (fingerprint, rel) => ipcRenderer.invoke('harbor:openClipExternally', fingerprint, rel),
  setVolumeRole: (fingerprint, role) => ipcRenderer.invoke('harbor:setVolumeRole', fingerprint, role),
  onEvent: (cb) => {
    const fn = (_e, msg) => cb(msg);
    ipcRenderer.on('harbor:event', fn);
    return () => ipcRenderer.removeListener('harbor:event', fn);
  },
});
