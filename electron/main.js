const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { fork } = require('child_process');

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

function startServer() {
  serverProcess = fork(path.join(__dirname, '..', 'server.js'), [], {
    env: { ...process.env, ELECTRON: '1' },
    silent: true,
  });

  serverProcess.stdout?.on('data', (d) => process.stdout.write(d));
  serverProcess.stderr?.on('data', (d) => process.stderr.write(d));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 850,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#020617',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
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
  const iconPath = path.join(__dirname, '..', 'assets', 'trayTemplate.png');
  let trayIcon;
  if (require('fs').existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  } else {
    // Fallback: use app icon
    trayIcon = nativeImage.createEmpty();
  }
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

  // Wait for server to be ready
  const check = setInterval(async () => {
    try {
      await fetch(`http://localhost:${PORT}/api/ports`);
      clearInterval(check);
      createWindow();
      createTray();
    } catch {}
  }, 200);
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
