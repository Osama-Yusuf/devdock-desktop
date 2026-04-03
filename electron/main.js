const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4003;
let mainWindow = null;
let tray = null;
let serverProcess = null;

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function getResourcePath(file) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', file);
  }
  return path.join(__dirname, '..', file);
}

function startServer() {
  const serverPath = getResourcePath('server.js');

  // Use the system node if available, otherwise use Electron's bundled node
  serverProcess = spawn(process.execPath, ['--no-warnings', serverPath], {
    env: {
      ...process.env,
      ELECTRON: '1',
      ELECTRON_RUN_AS_NODE: '1',  // Makes Electron binary act as plain Node
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  serverProcess.stdout?.on('data', (d) => process.stdout.write(d));
  serverProcess.stderr?.on('data', (d) => process.stderr.write(d));
  serverProcess.on('error', (err) => console.error('Server error:', err));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 850,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: '#020617',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Open external links in default browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Wait for page to fully render before showing
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.show();
      }
    }, 300);
  });

  mainWindow.on('close', (e) => {
    // Hide to tray instead of quitting
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const iconPath = getResourcePath('assets/trayTemplate.png');
  const icon2xPath = getResourcePath('assets/trayTemplate@2x.png');
  let trayIcon = nativeImage.createFromPath(iconPath);
  // Add @2x for retina
  if (require('fs').existsSync(icon2xPath)) {
    const icon2x = nativeImage.createFromPath(icon2xPath);
    trayIcon.addRepresentation({ scaleFactor: 2.0, buffer: icon2x.toPNG() });
  }
  trayIcon = trayIcon.resize({ width: 18, height: 18 });
  tray = new Tray(trayIcon);

  updateTrayMenu(0);
  tray.setToolTip('DevDock');

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });

  // Poll port count for tray
  setInterval(async () => {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/ports`);
      const data = await res.json();
      updateTrayMenu(data.count || 0);
    } catch {}
  }, 5000);
}

function updateTrayMenu(count) {
  const contextMenu = Menu.buildFromTemplate([
    { label: `DevDock — ${count} listener${count !== 1 ? 's' : ''}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Show Dashboard',
      click: () => {
        if (mainWindow) mainWindow.show();
        else createWindow();
      },
    },
    {
      label: 'Open History',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.loadURL(`http://localhost:${PORT}/history`);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Launch at Startup',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit DevDock',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.setToolTip(`DevDock — ${count} listener${count !== 1 ? 's' : ''}`);
}

app.whenReady().then(() => {
  startServer();

  // Wait for server to be fully ready
  const check = setInterval(async () => {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/ports`);
      if (res.ok) {
        clearInterval(check);
        // Give server a moment to stabilize
        setTimeout(() => {
          createWindow();
          createTray();
        }, 500);
      }
    } catch {}
  }, 500);
});

app.on('window-all-closed', () => {
  // Don't quit on macOS — tray keeps running
  if (process.platform !== 'darwin') {
    app.isQuitting = true;
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  } else {
    createWindow();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProcess) serverProcess.kill();
});
