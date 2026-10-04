const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopDialog', {
    submit: (value) => ipcRenderer.send('desktop-dialog:submit', value),
    cancel: () => ipcRenderer.send('desktop-dialog:cancel'),
    copy: (text) => ipcRenderer.send('desktop-dialog:copy', String(text))
});
