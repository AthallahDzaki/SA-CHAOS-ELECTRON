import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } from 'electron';
import { VelopackApp } from 'velopack';

VelopackApp.build().run();

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { StartServer } from './server/index.js';
import { setupIpcHandlers } from './ipc-handlers.js';
import { GeneralConfig } from './server/shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let tray;
let activePort = 9001;

function getActivePort() {
  return activePort;
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'favicon', 'favicon.ico');
  let buildTimeTitle = "";
  try {
    buildTimeTitle = " | Build: " + fs.readFileSync(path.join(__dirname, 'build-time.txt'), 'utf8').trim();
  } catch (e) {
    buildTimeTitle = " | Dev";
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "SA-CHAOS Dashboard" + buildTimeTitle,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  global.mainWindowInstance = mainWindow;

  mainWindow.on('closed', () => {
    if (global.mainWindowInstance === mainWindow) {
      global.mainWindowInstance = null;
    }
  });

  const appMenu = Menu.buildFromTemplate([
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' }
      ]
    }
  ]);
  Menu.setApplicationMenu(appMenu);

  // URL loading is now handled after StartServer resolves in app.whenReady()

  const isLocalUrl = (targetUrl) => {
    if (!targetUrl || typeof targetUrl !== 'string') return false;
    return targetUrl.startsWith(`http://localhost:${activePort}`) ||
           targetUrl.startsWith(`http://127.0.0.1:${activePort}`) ||
           targetUrl.startsWith('file://');
  };

  // Intercept external links to open in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !isLocalUrl(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http') && !isLocalUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      if (GeneralConfig.General.MinimizeToTray) {
        event.preventDefault();
        mainWindow.hide();
      } else {
        app.quit();
      }
    }
    return false;
  });
}

function createTray() {
  const trayIconPath = path.join(__dirname, '..', 'favicon', 'favicon-32x32.png');
  const icon = nativeImage.createFromPath(trayIconPath);
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setToolTip('SA-CHAOS Server');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // 1. Show splash screen first
    const splash = new BrowserWindow({
      width: 400,
      height: 450,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      icon: path.join(__dirname, '..', 'favicon', 'favicon.ico'),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    
    await splash.loadFile(path.join(__dirname, 'splash.html'));

    // 2. Run auto-updater
    const { runVelopackUpdater } = await import('./server/updater.js');
    await new Promise((resolve) => {
      // runVelopackUpdater(serverVersion, productCode, onProgress, onComplete)
      runVelopackUpdater("1.0.3", "SA-CHAOS", 
        (progress) => {
          if (!splash.isDestroyed()) splash.webContents.send('updater-message', progress);
        },
        (applied) => {
          resolve(); // Resolves if no update or if error (if updated, app will restart automatically)
        }
      );
    });

    if (!splash.isDestroyed()) {
      splash.close();
    }

    // 3. Normal startup continues
    setupIpcHandlers(ipcMain, mainWindow, getActivePort);
    createWindow();
    createTray();
    
    // Start the SA-CHAOS background server
    StartServer().then((port) => {
      activePort = port;
      // Load the React app from the local express server only after server is fully started
      if (mainWindow) {
        mainWindow.loadURL(`http://localhost:${port}/index.html`);
      }
    }).catch(console.error);
    
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
