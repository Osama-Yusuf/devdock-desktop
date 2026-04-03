const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4003;
let mainWindow = null;
let tray = null;
let serverProcess = null;

// Single instance lock — kill the duplicate immediately
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}

function getResourcePath(file) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', file);
  }
  return path.join(__dirname, '..', file);
}

function startServer() {
  serverProcess = spawn(process.execPath, ['--no-warnings', getResourcePath('server.js')], {
    env: { ...process.env, ELECTRON: '1', ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  serverProcess.stdout?.on('data', (d) => process.stdout.write(d));
  serverProcess.stderr?.on('data', (d) => process.stderr.write(d));
  serverProcess.on('error', (err) => console.error('Server error:', err));
}

function createWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 850,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: '#020617',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
    }, 300);
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      app.dock?.hide(); // Remove from Cmd+Tab and dock
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  if (tray) return;

  const iconPath = getResourcePath('assets/trayTemplate.png');
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);

  updateTrayMenu(0);
  tray.setToolTip('DevDock');

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        app.dock?.show();
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  setInterval(async () => {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/ports`);
      const data = await res.json();
      updateTrayMenu(data.count || 0);
    } catch {}
  }, 5000);
}

function updateTrayMenu(count) {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: `DevDock — ${count} listener${count !== 1 ? 's' : ''}`, enabled: false },
    { type: 'separator' },
    { label: 'Show Dashboard', click: () => { app.dock?.show(); if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); } },
    { label: 'Open History', click: () => { app.dock?.show(); if (mainWindow) { mainWindow.show(); mainWindow.focus(); mainWindow.loadURL(`http://localhost:${PORT}/history`); } } },
    { type: 'separator' },
    { label: 'Launch at Startup', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: 'separator' },
    { label: 'Quit DevDock', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.setToolTip(`DevDock — ${count} listener${count !== 1 ? 's' : ''}`);
}

// ── App lifecycle ────────────────────────────────────────────────────

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  startServer();

  let started = false;
  const check = setInterval(async () => {
    if (started) return;
    try {
      const res = await fetch(`http://localhost:${PORT}/api/ports`);
      if (res.ok) {
        started = true;
        clearInterval(check);
        setTimeout(() => { createWindow(); createTray(); }, 500);
      }
    } catch {}
  }, 500);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { app.isQuitting = true; app.quit(); }
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
  else createWindow();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProcess) serverProcess.kill();
});
