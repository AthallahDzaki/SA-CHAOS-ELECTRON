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
      'p2p:check-readiness',
      'tiktok:capture-cookies',
      'tiktok:get-provider-status',
      'tiktok:switch-provider',
      'tiktok:logout',
      'updater:get-channel',
      'updater:set-channel'
    ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    }
  },
  getUpdateChannel: () => ipcRenderer.invoke('updater:get-channel'),
  setUpdateChannel: (channel) => ipcRenderer.invoke('updater:set-channel', channel),
  onUpdateChannelChanged: (callback) => ipcRenderer.on('updater:channel-changed', (_event, value) => callback(value)),
  captureTikTokCookies: () => ipcRenderer.invoke('tiktok:capture-cookies'),
  getTikTokProviderStatus: () => ipcRenderer.invoke('tiktok:get-provider-status'),
  switchTikTokProvider: (provider) => ipcRenderer.invoke('tiktok:switch-provider', provider),
  logoutTikTok: () => ipcRenderer.invoke('tiktok:logout'),
  onTikTokProviderStatusChanged: (callback) => ipcRenderer.on('tiktok:provider-status-changed', (_event, value) => callback(value)),
  getP2PStatus: () => ipcRenderer.invoke('p2p:get-status'),
  setP2PConfig: (config) => ipcRenderer.invoke('p2p:set-config', config),
  cancelP2PDownload: () => ipcRenderer.invoke('p2p:cancel-download'),
  checkP2PReadiness: () => ipcRenderer.invoke('p2p:check-readiness'),
  onP2PStatusChanged: (callback) => ipcRenderer.on('p2p:status-changed', (_event, value) => callback(value)),
  onConfigChanged: (callback) => ipcRenderer.on('config:changed', (_event, value) => callback(value)),
  onUiVersionChanged: (callback) => ipcRenderer.on('ui:version-changed', (_event, value) => callback(value))
});
