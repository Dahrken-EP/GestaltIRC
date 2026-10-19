// Gives the launcher page, and only the launcher page, a way to ask the app to do things. A bouncer's page, which
// is not part of the app, gets nothing.
const { contextBridge, ipcRenderer } = require('electron')

// Only the launcher page. (The main process refuses its commands to anything else as well.)
if (location.protocol === 'file:' && /\/ui\/index\.html$/.test(location.pathname)) {
  // The same shape Tauri gives the launcher, so one launcher page serves both shells.
  contextBridge.exposeInMainWorld('__TAURI__', {
    core: { invoke: (name, args) => ipcRenderer.invoke('gestalt:' + name, args ?? {}) },
  })
}

// What every page the window shows may know about the app: that it is the desktop app, and a way to bring a hidden window
// forward (a notification's click does it). Neither reaches anything else.
contextBridge.exposeInMainWorld('gestaltDesktop', { desktop: true, show: () => ipcRenderer.send('gestalt:show') })
