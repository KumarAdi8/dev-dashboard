'use strict';

const { app, Tray, Menu, shell, nativeImage, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

// ─────────────────────────────────────────────
// Resolve node executable at startup (GUI apps get a minimal PATH)
// ─────────────────────────────────────────────
function resolveNodePath() {
  // Extra dirs beyond the default macOS GUI app PATH
  const extraDirs = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
  ];

  // Add the latest nvm-managed node if present
  try {
    const nvmDir = path.join(require('os').homedir(), '.nvm', 'versions', 'node');
    const { readdirSync } = require('fs');
    const versions = readdirSync(nvmDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions.length) extraDirs.push(path.join(nvmDir, versions[0], 'bin'));
  } catch { /* nvm not installed */ }

  // Augment PATH for all child processes
  const augmented = `${process.env.PATH || ''}:${extraDirs.join(':')}`;
  process.env.PATH = augmented;

  // Return first resolvable node binary
  for (const dir of extraDirs) {
    const candidate = path.join(dir, 'node');
    try { require('fs').accessSync(candidate, require('fs').constants.X_OK); return candidate; } catch { /* skip */ }
  }
  return 'node'; // fallback — hope it's on PATH
}

const NODE_BIN = resolveNodePath();

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const SERVER_PORT = 3131;
const DASHBOARD_URL = `http://localhost:${SERVER_PORT}`;
const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const REFRESH_INTERVAL_MS = 30_000;

let tray = null;
let serverProcess = null;
let serverRunning = false;
let projectCache = [];
let refreshTimer = null;

// ─────────────────────────────────────────────
// Icon: procedural 22×22 template PNG (black dot on transparent)
// macOS auto-inverts template images for dark mode
// ─────────────────────────────────────────────
function generateTemplateIcon() {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c;
  }
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
  function chunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return Buffer.concat([u32(d.length), t, d, u32(crc32(Buffer.concat([t, d])))]);
  }

  const size = 22;
  const cx = size / 2, cy = size / 2;

  // Draw: a small terminal-style `</>` icon using 3 pixel columns
  const draw = (x, y) => {
    // Left chevron  "<"
    const lx = x - 3, ly = y - cy;
    const leftChevron = lx >= -5 && lx <= -2 && Math.abs(ly) <= 4 - Math.abs(lx + 3);
    // Slash "/"
    const slash = x >= 9 && x <= 11 && Math.abs((y - cy) - (x - 10) * 1.2) < 1.2;
    // Right chevron ">"
    const rx = x - cx + 2, ry = y - cy;
    const rightChevron = rx >= 2 && rx <= 5 && Math.abs(ry) <= 4 - Math.abs(rx - 3);
    return leftChevron || slash || rightChevron;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  const raw = [];
  for (let y = 0; y < size; y++) {
    raw.push(0); // filter: None
    for (let x = 0; x < size; x++) {
      raw.push(0, 0, 0, draw(x, y) ? 255 : 0); // RGBA
    }
  }
  const idat = zlib.deflateSync(Buffer.from(raw));
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ─────────────────────────────────────────────
// Server lifecycle
// ─────────────────────────────────────────────
function checkServerRunning() {
  return new Promise((resolve) => {
    const req = http.get(`${DASHBOARD_URL}/api/status`, { timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startServer() {
  return new Promise((resolve) => {
    // Check if already running (externally started)
    checkServerRunning().then((running) => {
      if (running) {
        serverRunning = true;
        resolve(true);
        return;
      }

      serverProcess = spawn(NODE_BIN, [SERVER_PATH], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: path.dirname(SERVER_PATH),
      });

      serverProcess.stdout.on('data', (d) => console.log('[server]', d.toString().trim()));
      serverProcess.stderr.on('data', (d) => console.error('[server err]', d.toString().trim()));
      serverProcess.on('exit', (code) => {
        serverRunning = false;
        serverProcess = null;
        console.log(`Server exited (code ${code})`);
        updateMenu();
      });

      // Poll until ready (max 20s)
      let attempts = 0;
      const poll = setInterval(() => {
        checkServerRunning().then((ok) => {
          if (ok || ++attempts >= 80) {
            clearInterval(poll);
            serverRunning = ok;
            resolve(ok);
            updateMenu();
          }
        });
      }, 250);
    });
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
  serverRunning = false;
  updateMenu();
}

// ─────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────
function fetchProjects() {
  return new Promise((resolve) => {
    const req = http.get(`${DASHBOARD_URL}/api/projects`, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.ok ? data.projects : []);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

// ─────────────────────────────────────────────
// Menu building
// ─────────────────────────────────────────────
function branchLabel(project) {
  const { branch, isDirty, changedFiles } = project.git;
  const branchStr = branch || 'unknown';
  const dirtyStr = isDirty ? ` · ~${changedFiles}` : '';
  const isMainBranch = ['main', 'master'].includes(branchStr);
  return `${branchStr}${dirtyStr}${!isMainBranch ? ' ⚑' : ''}`;
}

function typeEmoji(type) {
  switch (type) {
    case 'xcode':
    case 'xcode-workspace': return '📱';
    case 'node': return '🟢';
    case 'flutter': return '🔵';
    case 'rust': return '🦀';
    case 'go': return '🐹';
    default: return '📁';
  }
}

function buildMenu() {
  const statusLabel = serverRunning
    ? '● Running'
    : '○ Stopped';

  const projectItems = projectCache.length > 0
    ? projectCache.map((p) => ({
        label: `${typeEmoji(p.type)} ${p.name}`,
        submenu: [
          {
            label: `Branch: ${branchLabel(p)}`,
            enabled: false,
          },
          {
            label: p.git.commitMsg
              ? `${p.git.commitHash}  ${p.git.commitMsg.slice(0, 48)}…`
              : 'No commits',
            enabled: false,
          },
          { type: 'separator' },
          ...(p.xcproj ? [{
            label: 'Open in Xcode',
            click: () => shell.openPath(p.xcproj),
          }] : []),
          {
            label: 'Open in VS Code',
            click: () => {
              try { execSync(`code-insiders "${p.path}" 2>/dev/null || code "${p.path}"`); } catch { /* ignore */ }
            },
          },
          {
            label: 'Open in Finder',
            click: () => shell.openPath(p.path),
          },
          {
            label: 'Open Terminal Here',
            click: () => {
              try {
                execSync(`osascript -e 'tell application "Terminal" to do script "cd \\"${p.path}\\""'`);
              } catch { /* ignore */ }
            },
          },
        ],
      }))
    : [{ label: serverRunning ? 'Scanning projects…' : 'Server not running', enabled: false }];

  // Branches summary item (dirty repos)
  const dirtyProjects = projectCache.filter((p) => p.git.isDirty);
  const nonMainProjects = projectCache.filter(
    (p) => p.git.branch && !['main', 'master'].includes(p.git.branch)
  );

  const summaryItems = [];
  if (dirtyProjects.length) {
    summaryItems.push({
      label: `⚠ ${dirtyProjects.length} repo${dirtyProjects.length > 1 ? 's' : ''} with uncommitted changes`,
      enabled: false,
    });
  }
  if (nonMainProjects.length) {
    summaryItems.push({
      label: `⚑ ${nonMainProjects.length} repo${nonMainProjects.length > 1 ? 's' : ''} on non-main branch`,
      enabled: false,
    });
  }

  const template = [
    // Header
    { label: `Dev Dashboard  ${statusLabel}`, enabled: false },
    { type: 'separator' },

    // Open browser
    {
      label: 'Open Dashboard',
      enabled: serverRunning,
      accelerator: 'Command+D',
      click: () => shell.openExternal(DASHBOARD_URL),
    },
    { type: 'separator' },

    // Summary
    ...(summaryItems.length ? [...summaryItems, { type: 'separator' }] : []),

    // Projects with branches
    {
      label: `Projects (${projectCache.length})`,
      submenu: projectItems,
    },
    { type: 'separator' },

    // Refresh
    {
      label: 'Refresh Projects',
      click: refreshProjects,
    },

    // Server control
    serverRunning
      ? { label: 'Stop Server', click: stopServer }
      : { label: 'Start Server', click: () => startServer().then(refreshProjects) },

    { type: 'separator' },
    { label: 'Quit', accelerator: 'Command+Q', click: () => { stopServer(); app.quit(); } },
  ];

  return Menu.buildFromTemplate(template);
}

function updateMenu() {
  if (tray) tray.setContextMenu(buildMenu());
}

// ─────────────────────────────────────────────
// Refresh cycle
// ─────────────────────────────────────────────
async function refreshProjects() {
  if (!serverRunning) return;
  projectCache = await fetchProjects();
  updateMenu();
}

function startRefreshCycle() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    const running = await checkServerRunning();
    if (running !== serverRunning) {
      serverRunning = running;
    }
    if (serverRunning) {
      await refreshProjects();
    } else {
      updateMenu();
    }
  }, REFRESH_INTERVAL_MS);
}

// ─────────────────────────────────────────────
// App lifecycle
// ─────────────────────────────────────────────
app.whenReady().then(async () => {
  // Hide from Dock — menubar-only app
  if (app.dock) app.dock.hide();

  // Create tray icon
  const iconBuf = generateTemplateIcon();
  const icon = nativeImage.createFromBuffer(iconBuf, { scaleFactor: 2 });
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Dev Dashboard');
  updateMenu(); // show initial menu immediately

  // Left-click also opens the context menu (standard tray behaviour on macOS)
  tray.on('click', () => tray.popUpContextMenu());

  // Start server then load projects
  tray.setTitle(' …');
  const started = await startServer();
  tray.setTitle(started ? ' ●' : ' ○');

  if (started) {
    await refreshProjects();
  }

  startRefreshCycle();
});

app.on('before-quit', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  stopServer();
});

// Prevent the app from quitting when all windows are closed
// (menubar apps have no windows)
app.on('window-all-closed', () => {/* intentional no-op */});
