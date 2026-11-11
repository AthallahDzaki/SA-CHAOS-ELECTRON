import { dialog, app } from 'electron';
import path from 'path';
import { launchIndofinityApp } from './server/indofinity.js';
import { captureTikTokCookies } from './server/tiktok-cookie.js';
import { globalTikTokAuthManager } from './server/tiktok-auth-session.js';
import { resolveUpdateChannel, checkAndSyncDesktopApp } from './server/updater.js';
import { GeneralConfig, writeJson, APP_DATA_ROOT } from './server/shared.js';
import {
  getGlobalP2PStatus,
  updateGlobalP2PConfig,
  getGlobalP2POrchestrator,
  probeP2PReadiness
} from './server/p2p/index.js';

export function setupIpcHandlers(ipcMain, mainWindow, getPort) {
  const resolvePort = () => (typeof getPort === 'function' ? getPort() : (getPort || 9001));

  // Generic bridge proxy for GET requests
  ipcMain.handle('bridge:get', async (event, path) => {
    try {
      const port = resolvePort();
      const response = await fetch(`http://localhost:${port}${path}`);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error(`Error in bridge:get for ${path}:`, error);
      return { error: error.message };
    }
  });

  // Generic bridge proxy for POST Form requests
  ipcMain.handle('bridge:postForm', async (event, { path, data }) => {
    try {
      const port = resolvePort();
      const formParams = new URLSearchParams(data);
      const response = await fetch(`http://localhost:${port}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formParams
      });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error(`Error in bridge:postForm for ${path}:`, error);
      return { error: error.message };
    }
  });

  ipcMain.handle('dialog:select-file', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Executables', extensions: ['exe'] }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return 'empty';
  });

  ipcMain.handle('app:get-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:launch-indofinity', async () => {
    return launchIndofinityApp();
  });

  ipcMain.handle('ui:get-version', () => {
    return 'v1';
  });

  ipcMain.handle('ui:set-version', () => {
    return 'v1';
  });

  ipcMain.handle('p2p:get-status', async () => {
    try {
      return { status: 'success', p2p: getGlobalP2PStatus() };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });

  ipcMain.handle('p2p:set-config', async (_event, payload) => {
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Invalid P2P config payload');
      }
      const allowed = {};
      if (typeof payload.p2pUpdaterConsentAccepted === 'boolean') {
        allowed.p2pUpdaterConsentAccepted = payload.p2pUpdaterConsentAccepted;
      }
      if (typeof payload.p2pUpdaterEnabled === 'boolean') {
        allowed.p2pUpdaterEnabled = payload.p2pUpdaterEnabled;
      }
      if (typeof payload.p2pSeedingEnabled === 'boolean') {
        allowed.p2pSeedingEnabled = payload.p2pSeedingEnabled;
      }
      if (typeof payload.p2pMaxUploadKBps === 'number' && Number.isFinite(payload.p2pMaxUploadKBps)) {
        allowed.p2pMaxUploadKBps = payload.p2pMaxUploadKBps;
      }
      if (typeof payload.p2pMaxCacheMB === 'number' && Number.isFinite(payload.p2pMaxCacheMB)) {
        allowed.p2pMaxCacheMB = payload.p2pMaxCacheMB;
      }
      if (Array.isArray(payload.p2pBootstrapMultiaddrs)) {
        allowed.p2pBootstrapMultiaddrs = payload.p2pBootstrapMultiaddrs.filter((m) => typeof m === 'string');
      }
      const snapshot = await updateGlobalP2PConfig(allowed);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('p2p:status-changed', snapshot);
      }
      return { status: 'success', p2p: snapshot };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });

  ipcMain.handle('p2p:cancel-download', async () => {
    try {
      const cancelled = getGlobalP2POrchestrator().cancelP2PAndFallbackToS3();
      const snapshot = getGlobalP2PStatus();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('p2p:status-changed', snapshot);
      }
      return { status: 'success', cancelled, p2p: snapshot };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });

  ipcMain.handle('p2p:check-readiness', async () => {
    try {
      const result = await probeP2PReadiness();
      return { status: 'success', readiness: result };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });

  ipcMain.handle('tiktok:capture-cookies', async () => {
    try {
      return await captureTikTokCookies(mainWindow);
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });

  ipcMain.handle('tiktok:get-provider-status', async () => {
    try {
      if (global.TikTokProviderManager) {
        return { status: 'success', data: global.TikTokProviderManager.getStatus() };
      }
      return { status: 'success', data: { selectedProvider: 'indofinity', channel: 'Stable' } };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });

  ipcMain.handle('tiktok:switch-provider', async (_event, provider) => {
    try {
      const clean = String(provider).toLowerCase() === 'custom_beta' ? 'custom_beta' : 'indofinity';
      if (global.TikTokProviderManager) {
        await global.TikTokProviderManager.setProvider(clean);
      }
      return { status: 'success', provider: clean };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });

  ipcMain.handle('tiktok:logout', async () => {
    try {
      await globalTikTokAuthManager.clearSession();
      if (global.TikTokProviderManager && global.TikTokProviderManager.getProvider() === 'custom_beta') {
        global.TikTokProviderManager.customConnector.disconnect();
      }
      return { status: 'success' };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });

  ipcMain.handle('updater:get-channel', async () => {
    try {
      const channel = resolveUpdateChannel(GeneralConfig);
      return {
        status: 'success',
        channel,
        channels: [
          {
            id: 'release',
            name: 'Release (Stable)',
            description: 'Channel rilis resmi stabil, direkomendasikan untuk live streaming sehari-hari.'
          },
          {
            id: 'beta',
            name: 'Beta (Fitur Lebih Awal)',
            description: 'Channel pengujian awal dengan fitur terbaru lebih cepat. Tidak menjamin kestabilan dan mungkin mengandung error.'
          }
        ]
      };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });

  ipcMain.handle('updater:set-channel', async (_event, targetChannel) => {
    try {
      const target = String(targetChannel).trim().toLowerCase() === 'beta' ? 'beta' : 'release';
      if (!GeneralConfig.General) GeneralConfig.General = {};
      GeneralConfig.General.UpdateChannel = target;
      writeJson(path.join(APP_DATA_ROOT, 'config.json'), GeneralConfig);

      try {
        const orch = getGlobalP2POrchestrator();
        if (orch && typeof orch.updateConfig === 'function') {
          await orch.updateConfig({ channel: target === 'beta' ? 'beta' : 'win' });
        }
      } catch (err) {
        console.warn('[IPC] Channel update to P2P orchestrator warning:', err.message);
      }

      mainWindow.webContents.send('updater:channel-changed', target);
      // Trigger background check for updates under the newly selected channel
      checkAndSyncDesktopApp(false).catch((err) => {
        console.warn('[IPC] Desktop update check error on channel switch:', err.message);
      });

      return { status: 'success', channel: target };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });
}

