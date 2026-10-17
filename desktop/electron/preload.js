// Gives the launcher page, and only the launcher page, a way to ask the app to do things. A bouncer's page, which
// is not part of the app, gets nothing.
const { contextBridge, ipcRenderer } = require('electron')

if (location.protocol === 'file:') {
  // The same shape Tauri gives the launcher, so one launcher page serves both shells.
  contextBridge.exposeInMainWorld('__TAURI__', {
    core: { invoke: (name, args) => ipcRenderer.invoke('gestalt:' + name, args ?? {}) },
  })
}
