const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, data) => {
    let validChannels = [
      'bridge:get', 
      'bridge:postForm', 
      'product:get', 
      'dialog:select-file',
      'update:check',
      'app:get-version',
      'app:launch-indofinity',
      'ui:get-version',
      'ui:set-version',
      'p2p:get-status',
      'p2p:set-config',
      'p2p:cancel-download',
      'p2p:check-readiness'
    ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    }
  },
  getP2PStatus: () => ipcRenderer.invoke('p2p:get-status'),
  setP2PConfig: (config) => ipcRenderer.invoke('p2p:set-config', config),
  cancelP2PDownload: () => ipcRenderer.invoke('p2p:cancel-download'),
  checkP2PReadiness: () => ipcRenderer.invoke('p2p:check-readiness'),
  onP2PStatusChanged: (callback) => ipcRenderer.on('p2p:status-changed', (_event, value) => callback(value)),
  onConfigChanged: (callback) => ipcRenderer.on('config:changed', (_event, value) => callback(value)),
  onUiVersionChanged: (callback) => ipcRenderer.on('ui:version-changed', (_event, value) => callback(value))
});
