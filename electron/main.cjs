const { app, BrowserWindow, Menu, ipcMain, dialog, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const DIST = path.join(__dirname, '..', 'dist');

// A real (registered) scheme rather than file:// so that web workers — which
// pdf.js needs — are allowed to load. file:// pages have a null origin and
// Chromium refuses to spawn workers for them.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

let win = null;
let docDirty = false;
let forceClose = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#1b1c20',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL('app://bundle/index.html');

  // Links inside PDFs open in the user's browser, never in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.on('close', (e) => {
    if (forceClose || !docDirty) return;
    e.preventDefault();
    dialog
      .showMessageBox(win, {
        type: 'warning',
        buttons: ['Save', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'You have unsaved changes.',
        detail: 'Do you want to save your changes before closing?',
      })
      .then(({ response }) => {
        if (response === 2) return; // Cancel
        if (response === 1) {
          forceClose = true;
          win.close();
          return;
        }
        // Save: the renderer saves, then calls app:confirm-close (or aborts
        // if the user cancels the Save As dialog).
        win.webContents.send('menu', 'save-and-close');
      });
  });

  win.on('closed', () => {
    win = null;
  });
}

function sendMenu(cmd) {
  if (win) win.webContents.send('menu', cmd);
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { label: 'Insert Pages from PDF…', click: () => sendMenu('insert') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('save-as') },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => sendMenu('print') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendMenu('close-tab') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenu('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendMenu('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => sendMenu('find') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => sendMenu('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => sendMenu('zoom-out') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => sendMenu('zoom-100') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+1', click: () => sendMenu('fit-width') },
        { label: 'Fit Page', accelerator: 'CmdOrCtrl+2', click: () => sendMenu('fit-page') },
        { type: 'separator' },
        { label: 'Toggle Thumbnails', accelerator: 'CmdOrCtrl+B', click: () => sendMenu('sidebar') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(DIST, p));
    if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { headers: { 'content-type': mime } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC ----

ipcMain.handle('dialog:open-pdf', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open PDF',
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  const files = await Promise.all(
    filePaths.map(async (p) => ({
      path: p,
      name: path.basename(p),
      data: await fs.promises.readFile(p),
    }))
  );
  return { canceled: false, files };
});

ipcMain.handle('dialog:open-image', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  const p = filePaths[0];
  const ext = path.extname(p).toLowerCase();
  return {
    canceled: false,
    path: p,
    format: ext === '.png' ? 'png' : 'jpeg',
    data: await fs.promises.readFile(p),
  };
});

ipcMain.handle('dialog:save-as', async (_e, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save PDF As',
    defaultPath: defaultName || 'document.pdf',
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  });
  return canceled ? { canceled: true } : { canceled: false, path: filePath };
});

ipcMain.handle('file:save', async (_e, filePath, data) => {
  try {
    await fs.promises.writeFile(filePath, Buffer.from(data));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.on('doc:set-dirty', (_e, dirty) => {
  docDirty = !!dirty;
  if (win && process.platform === 'darwin') win.setDocumentEdited(docDirty);
});

ipcMain.on('app:confirm-close', () => {
  forceClose = true;
  if (win) win.close();
});
