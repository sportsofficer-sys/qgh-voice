const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');

const appRoot = path.resolve(__dirname, 'app');
const allowedPagePaths = new Set(
  ['index.html', 'single.html', 'tactical.html'].map(page => path.resolve(appRoot, page))
);

function isAllowedLocalAppUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'file:') return false;
    return allowedPagePaths.has(path.resolve(fileURLToPath(parsed)));
  } catch {
    return false;
  }
}

function createWindow() {
  const startUrl = pathToFileURL(path.join(__dirname, 'app', 'index.html')).href;
  const window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#f6f5f1',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedLocalAppUrl(targetUrl)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, targetUrl) => {
    if (!isAllowedLocalAppUrl(targetUrl)) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.loadURL(startUrl);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
