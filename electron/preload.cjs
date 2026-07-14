const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shelly', {
  openPdf: () => ipcRenderer.invoke('dialog:open-pdf'),
  openImage: () => ipcRenderer.invoke('dialog:open-image'),
  saveAsDialog: (defaultName) => ipcRenderer.invoke('dialog:save-as', defaultName),
  savePdf: (filePath, data) => ipcRenderer.invoke('file:save', filePath, data),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  setDirty: (dirty) => ipcRenderer.send('doc:set-dirty', !!dirty),
  confirmClose: () => ipcRenderer.send('app:confirm-close'),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
  onOpenFiles: (fn) => ipcRenderer.on('open-files', (_e, files) => fn(files)),
});
