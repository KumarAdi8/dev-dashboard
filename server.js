#!/usr/bin/env node
'use strict';

const express = require('express');
const cors = require('cors');
const { exec, execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 3131;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// CONFIG: root directories to scan
// ─────────────────────────────────────────────
const CODE_ROOTS = [
  '/Users/Adi/Documents/Code/Personal Projects',
  '/Users/Adi/Documents/Code/Untamed-bristleup-ios',
];

// Projects to skip
const SKIP_DIRS = new Set(['node_modules', '.build', 'DerivedData', 'Pods', '.git', 'Old', 'flipoff.worktrees']);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function run(cmd, cwd, timeout = 8000) {
  try {
    return execSync(cmd, { cwd, timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function findFile(dir, name, maxDepth = 4) {
  function walk(d, depth) {
    if (depth > maxDepth) return null;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name === name) return path.join(d, entry.name);
        if (entry.isDirectory()) {
          const found = walk(path.join(d, entry.name), depth + 1);
          if (found) return found;
        }
      }
    } catch { /* ignore */ }
    return null;
  }
  return walk(dir, 0);
}

function findFiles(dir, ext, maxDepth = 4) {
  const results = [];
  function walk(d, depth) {
    if (depth > maxDepth) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(d, entry.name);
        if (entry.isDirectory()) walk(fullPath, depth + 1);
        else if (entry.name.endsWith(ext)) results.push(fullPath);
      }
    } catch { /* ignore */ }
  }
  walk(dir, 0);
  return results;
}

// Find best app icon image from AppIcon.appiconset
function findAppIconPath(dir) {
  const iconsetPath = findFile(dir, 'AppIcon.appiconset');
  if (!iconsetPath) return null;
  const contentsJson = path.join(iconsetPath, 'Contents.json');
  if (!fileExists(contentsJson)) return null;
  try {
    const contents = JSON.parse(fs.readFileSync(contentsJson, 'utf8'));
    const images = (contents.images || []).filter(i => i.filename);
    images.sort((a, b) => {
      const toPixels = img => {
        const size = parseInt((img.size || '0x0').split('x')[0]);
        const scale = parseInt((img.scale || '1x').replace('x', ''));
        return size * scale;
      };
      return toPixels(b) - toPixels(a);
    });
    for (const img of images) {
      const iconPath = path.join(iconsetPath, img.filename);
      if (fileExists(iconPath)) return iconPath;
    }
  } catch { /* ignore */ }
  return null;
}

// Find requirements.md / app idea*.md in project root
function findRequirementsFile(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (
        (lower.startsWith('requirements') || lower.startsWith('app idea') ||
         lower.startsWith('app_idea') || lower.startsWith('app-idea')) &&
        (lower.endsWith('.md') || lower.endsWith('.txt'))
      ) {
        return path.join(dir, entry.name);
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ─────────────────────────────────────────────
// Project detection
// ─────────────────────────────────────────────
function detectProjectType(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => e.name);
  if (entries.some(e => e.endsWith('.xcworkspace') && !e.includes('xcodeproj'))) return 'xcode-workspace';
  if (entries.some(e => e.endsWith('.xcodeproj'))) return 'xcode';
  if (entries.includes('package.json') && !entries.includes('pubspec.yaml')) return 'node';
  if (entries.includes('pubspec.yaml')) return 'flutter';
  if (entries.includes('Cargo.toml')) return 'rust';
  if (entries.includes('go.mod')) return 'go';
  return null;
}

function getXcodeproj(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // Prefer .xcworkspace (non-xcodeproj ones)
    const ws = entries.find(e => e.name.endsWith('.xcworkspace') && !e.name.includes('xcodeproj'));
    if (ws) return path.join(dir, ws.name);
    const proj = entries.find(e => e.name.endsWith('.xcodeproj'));
    if (proj) return path.join(dir, proj.name);
  } catch { /* ignore */ }
  return null;
}

function getBundleId(dir) {
  const pbxFiles = findFiles(dir, '.pbxproj');
  for (const pbx of pbxFiles) {
    try {
      const content = fs.readFileSync(pbx, 'utf8');
      const match = content.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/);
      if (match) return match[1].trim();
    } catch { /* ignore */ }
  }
  return null;
}

function getDeploymentTarget(dir) {
  const pbxFiles = findFiles(dir, '.pbxproj');
  for (const pbx of pbxFiles) {
    try {
      const content = fs.readFileSync(pbx, 'utf8');
      const match = content.match(/IPHONEOS_DEPLOYMENT_TARGET\s*=\s*([^;]+);/);
      if (match) return match[1].trim();
    } catch { /* ignore */ }
  }
  return null;
}

function getAppVersion(dir) {
  const pbxFiles = findFiles(dir, '.pbxproj');
  for (const pbx of pbxFiles) {
    try {
      const content = fs.readFileSync(pbx, 'utf8');
      const match = content.match(/MARKETING_VERSION\s*=\s*([^;]+);/);
      const build = content.match(/CURRENT_PROJECT_VERSION\s*=\s*([^;]+);/);
      if (match) return { version: match[1].trim(), build: build ? build[1].trim() : '?' };
    } catch { /* ignore */ }
  }
  return null;
}

// ─────────────────────────────────────────────
// App Store Readiness Checker
// ─────────────────────────────────────────────
function checkAppStoreReadiness(dir) {
  const checks = [];

  // APP-STORE.md or metadata
  const appStoreMd = findFile(dir, 'APP-STORE.md');
  checks.push({ id: 'app_store_doc', label: 'App Store doc (APP-STORE.md)', done: !!appStoreMd, critical: false });

  // AppIcon - check all sizes
  const appIconContents = findFile(dir, 'AppIcon.appiconset');
  let iconComplete = false;
  if (appIconContents) {
    const contentsJson = path.join(appIconContents, 'Contents.json');
    if (fileExists(contentsJson)) {
      try {
        const contents = JSON.parse(fs.readFileSync(contentsJson, 'utf8'));
        const images = contents.images || [];
        iconComplete = images.some(i => i.filename && i.filename.length > 0);
      } catch { /* ignore */ }
    }
  }
  checks.push({ id: 'app_icon', label: 'App Icon (all sizes)', done: iconComplete, critical: true });

  // Privacy Manifest
  const privacyManifest = findFile(dir, 'PrivacyInfo.xcprivacy');
  checks.push({ id: 'privacy_manifest', label: 'Privacy Manifest (PrivacyInfo.xcprivacy)', done: !!privacyManifest, critical: true });

  // Info.plist
  const infoPlist = findFile(dir, 'Info.plist');
  checks.push({ id: 'info_plist', label: 'Info.plist present', done: !!infoPlist, critical: false });

  // Entitlements
  const entitlements = findFiles(dir, '.entitlements');
  checks.push({ id: 'entitlements', label: 'Entitlements file', done: entitlements.length > 0, critical: false });

  // Localizations (check for .xcstrings or .strings)
  const xcstrings = findFiles(dir, '.xcstrings');
  const strings = findFiles(dir, '.strings');
  checks.push({ id: 'localization', label: 'Localization files', done: xcstrings.length > 0 || strings.length > 0, critical: false });

  // Screenshots folder
  const screenshotsDir = [
    path.join(dir, 'Screenshots'),
    path.join(dir, 'screenshots'),
    path.join(dir, 'AppStore'),
    path.join(dir, 'Marketing'),
  ];
  const hasScreenshotsDir = screenshotsDir.some(d => fileExists(d));
  checks.push({ id: 'screenshots', label: 'Screenshots directory', done: hasScreenshotsDir, critical: false });

  // Unit Tests
  const testFiles = findFiles(dir, 'Tests.swift');
  checks.push({ id: 'tests', label: 'Unit Tests present', done: testFiles.length > 0, critical: false });

  // README or PRODUCT doc
  const readme = fileExists(path.join(dir, 'README.md')) || fileExists(path.join(dir, 'PRODUCT-RESEARCH.md'));
  checks.push({ id: 'readme', label: 'README / Product doc', done: readme, critical: false });

  // Deployment target
  const target = getDeploymentTarget(dir);
  checks.push({ id: 'deployment_target', label: `Deployment target (${target || 'unknown'})`, done: !!target, critical: true });

  // Version set
  const versionInfo = getAppVersion(dir);
  checks.push({ id: 'version', label: `Version set (${versionInfo ? `v${versionInfo.version} build ${versionInfo.build}` : 'not set'})`, done: !!versionInfo, critical: true });

  // SDK checks (RevenueCat, Crashlytics) — scan Podfile, Podfile.lock, Package.resolved
  const podfilePath = findFile(dir, 'Podfile');
  const podfileLockPath = findFile(dir, 'Podfile.lock');
  const packageResolvedPath = findFile(dir, 'Package.resolved');
  function grepSDK(pattern) {
    return [podfilePath, podfileLockPath, packageResolvedPath].some(f => {
      if (!f) return false;
      try { return pattern.test(fs.readFileSync(f, 'utf8')); } catch { return false; }
    });
  }
  const hasRevenueCat = grepSDK(/revenuecat|purchases-ios/i);
  checks.push({ id: 'revenuecat', label: 'RevenueCat (in-app purchases)', done: hasRevenueCat, critical: false });

  const hasCrashlytics = grepSDK(/crashlytics/i);
  checks.push({ id: 'crashlytics', label: 'Crashlytics (crash reporting)', done: hasCrashlytics, critical: false });

  const done = checks.filter(c => c.done).length;
  const critical = checks.filter(c => c.critical);
  const criticalDone = critical.filter(c => c.done).length;
  const score = Math.round((done / checks.length) * 100);

  return { checks, score, done, total: checks.length, criticalDone, criticalTotal: critical.length };
}

// ─────────────────────────────────────────────
// Scan a single project directory
// ─────────────────────────────────────────────
function scanProject(projectDir, name) {
  const type = detectProjectType(projectDir);
  if (!type) return null;

  const xcproj = getXcodeproj(projectDir);

  // Git info
  const branch = run('git rev-parse --abbrev-ref HEAD', projectDir);
  const lastCommit = run('git log --oneline -1 --format="%h|%s|%cr|%ct"', projectDir);
  const [commitHash, commitMsg, commitAge, commitTimestamp] = lastCommit ? lastCommit.split('|') : ['', '', '', '0'];
  const gitStatus = run('git status --porcelain', projectDir);
  const isDirty = gitStatus.length > 0;
  const changedFiles = gitStatus ? gitStatus.split('\n').filter(Boolean).length : 0;
  const remoteUrl = run('git remote get-url origin', projectDir);

  // App Store readiness (only for Xcode projects)
  const appStore = (type === 'xcode' || type === 'xcode-workspace')
    ? checkAppStoreReadiness(projectDir)
    : null;

  const bundleId = (type === 'xcode' || type === 'xcode-workspace') ? getBundleId(projectDir) : null;
  const version = (type === 'xcode' || type === 'xcode-workspace') ? getAppVersion(projectDir) : null;

  // Requirements / App Idea file
  const requirementsPath = findRequirementsFile(projectDir);
  let requirementsSummary = null;
  if (requirementsPath) {
    try {
      requirementsSummary = fs.readFileSync(requirementsPath, 'utf8').slice(0, 1200).trim();
    } catch { /* ignore */ }
  }

  return {
    id: Buffer.from(projectDir).toString('base64'),
    name: name || path.basename(projectDir),
    path: projectDir,
    type,
    xcproj,
    bundleId,
    version,
    git: {
      branch,
      commitHash: commitHash.trim(),
      commitMsg,
      commitAge,
      commitTimestamp: commitTimestamp ? parseInt(commitTimestamp) : 0,
      isDirty,
      changedFiles,
      remoteUrl,
    },
    appStore,
    requirementsPath,
    requirementsSummary,
    scannedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────
// Scan all projects
// ─────────────────────────────────────────────
function scanAllProjects() {
  const projects = [];

  for (const root of CODE_ROOTS) {
    if (!fileExists(root)) continue;

    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });

      // If root itself is a project dir (e.g., Untamed-bristleup-ios)
      const rootType = detectProjectType(root);
      if (rootType) {
        const p = scanProject(root, path.basename(root));
        if (p) projects.push(p);
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_DIRS.has(entry.name)) continue;

        const dir = path.join(root, entry.name);
        const type = detectProjectType(dir);
        if (type) {
          const p = scanProject(dir, entry.name);
          if (p) projects.push(p);
          continue; // don't go deeper if this dir is itself a project
        }

        // Scan one level deeper for nested projects (e.g. flipoff/ios/)
        try {
          const subEntries = fs.readdirSync(dir, { withFileTypes: true });
          for (const sub of subEntries) {
            if (!sub.isDirectory()) continue;
            if (SKIP_DIRS.has(sub.name)) continue;
            const subDir = path.join(dir, sub.name);
            const subType = detectProjectType(subDir);
            if (!subType) continue;
            const p = scanProject(subDir, `${entry.name} / ${sub.name}`);
            if (p) projects.push(p);
          }
        } catch { /* ignore */ }
      }
    } catch (e) {
      console.error(`Error scanning ${root}:`, e.message);
    }
  }

  // Sort: iOS first, then by name
  projects.sort((a, b) => {
    const order = { 'xcode-workspace': 0, 'xcode': 1, 'node': 2, 'flutter': 3, 'rust': 4, 'go': 5 };
    return (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.name.localeCompare(b.name);
  });

  return projects;
}

// ─────────────────────────────────────────────
// Connected Devices (physical)
// ─────────────────────────────────────────────
function getConnectedDevices() {
  try {
    const raw = execSync('xcrun xctrace list devices 2>/dev/null', { timeout: 10000, encoding: 'utf8' });
    const devices = [];
    let section = null; // 'online' | 'offline' | null
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '== Devices ==') { section = 'online'; continue; }
      if (trimmed === '== Devices Offline ==') { section = 'offline'; continue; }
      if (trimmed.startsWith('==')) { section = null; continue; }
      if (!section || !trimmed) continue;
      // UDIDs can be 25-char (00008140-00026C1114A2801C) or 36-char UUID
      const match = trimmed.match(/^(.+?)\s+\(([0-9A-Fa-f-]{20,36})\)\s*$/);
      if (match) {
        const name = match[1].trim();
        if (/macbook|imac|mac mini|mac pro|mac studio/i.test(name)) continue;
        devices.push({ name, udid: match[2], type: 'device', offline: section === 'offline' });
      }
    }
    return devices;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────
// Simulators
// ─────────────────────────────────────────────
function getSimulators() {
  try {
    const raw = execSync('xcrun simctl list devices available --json', { timeout: 10000, encoding: 'utf8' });
    const data = JSON.parse(raw);
    const results = [];
    for (const [runtime, devices] of Object.entries(data.devices)) {
      for (const d of devices) {
        if (!d.isAvailable) continue;
        results.push({
          udid: d.udid,
          name: d.name,
          state: d.state,
          runtime: runtime.replace('com.apple.CoreSimulator.SimRuntime.', '').replace('-', ' '),
        });
      }
    }
    return results.filter(d => d.name.includes('iPhone') || d.name.includes('iPad'));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────

app.get('/api/projects', (req, res) => {
  try {
    const projects = scanAllProjects();
    res.json({ ok: true, projects, scannedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/project/:id', (req, res) => {
  const dir = Buffer.from(req.params.id, 'base64').toString('utf8');
  if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'Not found' });
  const name = path.basename(dir);
  const project = scanProject(dir, name);
  res.json({ ok: true, project });
});

app.post('/api/open/xcode', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ ok: false, error: 'projectPath required' });

  // Prefer .xcworkspace, then .xcodeproj, then directory
  exec(`open "${projectPath}"`, (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true });
  });
});

app.post('/api/open/vscode', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ ok: false, error: 'projectPath required' });

  exec(`code "${projectPath}"`, (err) => {
    if (err) {
      // try code-insiders
      exec(`code-insiders "${projectPath}"`, (err2) => {
        if (err2) return res.status(500).json({ ok: false, error: err2.message });
        res.json({ ok: true });
      });
      return;
    }
    res.json({ ok: true });
  });
});

app.post('/api/open/finder', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ ok: false, error: 'projectPath required' });
  exec(`open "${projectPath}"`, (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true });
  });
});

app.post('/api/open/terminal', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ ok: false, error: 'projectPath required' });
  // Open terminal at directory
  exec(`osascript -e 'tell application "Terminal" to do script "cd \\\"${projectPath}\\\""'`, (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true });
  });
});

app.get('/api/simulators', (req, res) => {
  const sims = getSimulators();
  res.json({ ok: true, simulators: sims });
});

app.get('/api/devices', (req, res) => {
  const devices = getConnectedDevices();
  res.json({ ok: true, devices });
});

app.post('/api/build/device', (req, res) => {
  const { projectPath, xcproj, deviceUdid } = req.body;
  if (!projectPath || !xcproj || !deviceUdid)
    return res.status(400).json({ ok: false, error: 'projectPath, xcproj and deviceUdid required' });

  const isWorkspace = xcproj.endsWith('.xcworkspace');
  const projName = path.basename(xcproj, isWorkspace ? '.xcworkspace' : '.xcodeproj');
  const flag = isWorkspace ? '-workspace' : '-project';

  res.json({ ok: true, message: 'Build & run on device started — check Xcode for progress.' });

  const cmd = `xcodebuild ${flag} "${xcproj}" -scheme "${projName}" -destination "id=${deviceUdid}" -configuration Debug build 2>&1 | tail -20`;
  exec(cmd, { cwd: projectPath, timeout: 300000 }, (err, stdout) => {
    console.log('Device build result:', stdout?.slice(-500));
  });
});

app.get('/api/project/:id/requirements', (req, res) => {
  const dir = Buffer.from(req.params.id, 'base64').toString('utf8');
  if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'Not found' });
  const reqFile = findRequirementsFile(dir);
  if (!reqFile) return res.json({ ok: true, content: null, filename: null });
  try {
    const content = fs.readFileSync(reqFile, 'utf8');
    res.json({ ok: true, content, filename: path.basename(reqFile) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/simulator/boot', (req, res) => {
  const { udid } = req.body;
  if (!udid) return res.status(400).json({ ok: false, error: 'udid required' });
  exec(`xcrun simctl boot "${udid}"`, (err) => {
    // Ignore "already booted" error
    exec('open -a Simulator', () => {});
    res.json({ ok: true });
  });
});

app.post('/api/build/simulator', (req, res) => {
  const { projectPath, xcproj, simulatorUdid } = req.body;
  if (!projectPath || !xcproj) return res.status(400).json({ ok: false, error: 'projectPath and xcproj required' });

  const isWorkspace = xcproj.endsWith('.xcworkspace');
  const projName = path.basename(xcproj, isWorkspace ? '.xcworkspace' : '.xcodeproj');
  const flag = isWorkspace ? '-workspace' : '-project';
  const udid = simulatorUdid || '47087030-9187-4A44-BF3D-37AA60CB1A47'; // iPhone 17 Pro default

  // Build async and stream
  res.json({ ok: true, message: 'Build started. Check Xcode or run logs.' });

  const cmd = `xcodebuild ${flag} "${xcproj}" -scheme "${projName}" -destination "id=${udid}" -configuration Debug build 2>&1 | tail -20`;
  exec(cmd, { cwd: projectPath, timeout: 300000 }, (err, stdout) => {
    // Result not sent — build is fire-and-forget from API perspective
    console.log('Build completed:', stdout?.slice(-500));
  });
});

app.post('/api/git/pull', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ ok: false, error: 'projectPath required' });
  exec('git pull', { cwd: projectPath, timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: stderr || err.message });
    res.json({ ok: true, output: stdout });
  });
});

app.get('/api/git/log/:id', (req, res) => {
  const dir = Buffer.from(req.params.id, 'base64').toString('utf8');
  if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'Not found' });
  const log = run('git log --oneline -10 --format="%h|%s|%cr|%an"', dir);
  const commits = log.split('\n').filter(Boolean).map(line => {
    const [hash, msg, age, author] = line.split('|');
    return { hash, msg, age, author };
  });
  res.json({ ok: true, commits });
});

app.get('/api/git/diff/:id', (req, res) => {
  const dir = Buffer.from(req.params.id, 'base64').toString('utf8');
  if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'Not found' });
  const status = run('git status --porcelain', dir);
  const files = status
    ? status.split('\n').filter(Boolean).map(line => ({
        status: line.slice(0, 2).trim(),
        file: line.slice(3).trim(),
      }))
    : [];
  // Branches for this repo
  const branch = run('git rev-parse --abbrev-ref HEAD', dir);
  const allBranches = run('git branch --format="%(refname:short)"', dir)
    .split('\n').filter(Boolean);
  res.json({ ok: true, files, branch, allBranches });
});

app.get('/api/git/branches/:id', (req, res) => {
  const dir = Buffer.from(req.params.id, 'base64').toString('utf8');
  if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'Not found' });
  const current = run('git rev-parse --abbrev-ref HEAD', dir);
  const raw = run('git for-each-ref --sort=-committerdate refs/heads --format="%(refname:short)|%(committerdate:relative)|%(contents:subject)"', dir);
  const branches = raw.split('\n').filter(Boolean).map(line => {
    const [name, age, lastMsg] = line.split('|');
    return { name, age, lastMsg, current: name === current };
  });
  res.json({ ok: true, current, branches });
});

app.get('/api/project/:id/icon', (req, res) => {
  const dir = Buffer.from(req.params.id, 'base64').toString('utf8');
  const isAllowed = CODE_ROOTS.some(root => path.normalize(dir).startsWith(path.normalize(root)));
  if (!isAllowed || !fs.existsSync(dir)) return res.status(404).send('Not found');
  const iconPath = findAppIconPath(dir);
  if (!iconPath) return res.status(404).send('No icon');
  res.sendFile(iconPath);
});

// ─────────────────────────────────────────────
// Health check (used by the menubar tray app)
// ─────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    projects: null, // lightweight — don't scan here
    ts: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 Dev Dashboard running at http://localhost:${PORT}\n`);
});
