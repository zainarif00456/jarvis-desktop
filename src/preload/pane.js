'use strict';
// Preload of a Development Mode pane window (src/main/devwindows). The page is the web client's dev-window.html:
// it shows ONE pane. It may show the native browser view over the pane (setBounds) and close or full-screen
// its own window; it cannot drive the browser (no `call`) and cannot open other windows.
const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('jarvisBrowser', {
  version: 1,
  setBounds: (rect) => ipcRenderer.send('jarvis-browser:bounds', rect),
  onEvent: (fn) => { ipcRenderer.on('jarvis-browser:event', (_e, ev) => fn(ev)); },
});
contextBridge.exposeInMainWorld('jarvisDev', {
  closeSelf: () => ipcRenderer.send('jarvis-dev:self', 'close'),
  toggleFullScreen: () => ipcRenderer.send('jarvis-dev:self', 'fullscreen'),
});
