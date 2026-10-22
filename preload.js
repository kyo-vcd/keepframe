const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  download: opts => ipcRenderer.invoke('download', opts),
  cancel: id => ipcRenderer.invoke('cancel', id),
  openFolder: f => ipcRenderer.invoke('open-folder', f),
  openFile: f => ipcRenderer.invoke('open-file', f),
  showFile: f => ipcRenderer.invoke('show-file', f),
  defaultFolder: () => ipcRenderer.invoke('default-folder'),
  onJob: cb => ipcRenderer.on('job', (_e, j) => cb(j)),
  isReady: () => ipcRenderer.invoke('is-ready'),
  onReady: cb => ipcRenderer.on('ready', cb),
  onDownloadUrl: cb => ipcRenderer.on('download-url', (_e, u) => cb(u)),
  onToast: cb => ipcRenderer.on('toast', (_e, m) => cb(m)),
});
