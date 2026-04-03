const express = require('express');
const { exec } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = 4003;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Runtime definitions ──────────────────────────────────────────────
const RUNTIMES = {
  node: {
    name: 'Node.js',
    commands: ['node'],
    color: '#22c55e',
    icon: 'N',
    defaultEnabled: true,
  },
  python: {
    name: 'Python',
    commands: ['python', 'python3', 'python3.', 'uvicorn', 'gunicorn', 'flask', 'django'],
    color: '#3b82f6',
    icon: 'Py',
    defaultEnabled: true,
  },
  ruby: {
    name: 'Ruby',
    commands: ['ruby', 'puma', 'rails', 'unicorn', 'thin'],
    color: '#ef4444',
    icon: 'Rb',
    defaultEnabled: true,
  },
  java: {
    name: 'Java',
    commands: ['java'],
    color: '#f97316',
    icon: 'J',
    defaultEnabled: true,
  },
  go: {
    name: 'Go',
    commands: ['go', 'Google'],
    color: '#06b6d4',
    icon: 'Go',
    defaultEnabled: true,
  },
  php: {
    name: 'PHP',
    commands: ['php', 'php-fpm'],
    color: '#8b5cf6',
    icon: 'PHP',
    defaultEnabled: true,
  },
  rust: {
    name: 'Rust',
    commands: ['cargo'],
    color: '#f97316',
    icon: 'Rs',
    defaultEnabled: true,
  },
  dotnet: {
    name: '.NET',
    commands: ['dotnet'],
    color: '#7c3aed',
    icon: '.N',
    defaultEnabled: true,
  },
  docker: {
    name: 'Docker',
    commands: ['com.docke', 'docker-pr', 'docker'],
    color: '#0ea5e9',
    icon: 'D',
    defaultEnabled: true,
  },
  nginx: {
    name: 'Nginx',
    commands: ['nginx'],
    color: '#10b981',
    icon: 'Nx',
    defaultEnabled: false,
  },
  apache: {
    name: 'Apache',
    commands: ['httpd', 'apache2', 'apache'],
    color: '#dc2626',
    icon: 'Ap',
    defaultEnabled: false,
  },
  postgres: {
    name: 'PostgreSQL',
    commands: ['postgres', 'postmaste'],
    color: '#3b82f6',
    icon: 'PG',
    defaultEnabled: true,
  },
  mysql: {
    name: 'MySQL',
    commands: ['mysqld', 'mysql', 'mariadbd', 'mariadb'],
    color: '#f59e0b',
    icon: 'My',
    defaultEnabled: true,
  },
  redis: {
    name: 'Redis',
    commands: ['redis-ser', 'redis'],
    color: '#ef4444',
    icon: 'Rd',
    defaultEnabled: true,
  },
  mongo: {
    name: 'MongoDB',
    commands: ['mongod', 'mongos'],
    color: '#22c55e',
    icon: 'Mo',
    defaultEnabled: true,
  },
  other: {
    name: 'Other',
    commands: [],
    color: '#6b7280',
    icon: '?',
    defaultEnabled: false,
  },
};

// ── Settings persistence ─────────────────────────────────────────────
const SETTINGS_FILE = path.join(__dirname, 'devdock-settings.json');

function getDefaultSettings() {
  const runtimes = {};
  for (const [key, rt] of Object.entries(RUNTIMES)) {
    runtimes[key] = { enabled: rt.defaultEnabled };
  }
  return {
    runtimes,
    showOtherProcesses: false,
    showExport: false,
    favorites: [],
    theme: 'dark',
    notifications: true,
    groupByProject: false,
    groupingDepth: 1,
    showHistory: true,
    history: [],
  };
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      const defaults = getDefaultSettings();
      for (const key of Object.keys(defaults.runtimes)) {
        if (!data.runtimes || !data.runtimes[key]) {
          if (!data.runtimes) data.runtimes = {};
          data.runtimes[key] = defaults.runtimes[key];
        }
      }
      return { ...defaults, ...data };
    }
  } catch (e) {
    // fall through
  }
  return getDefaultSettings();
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ── Runtime matching ─────────────────────────────────────────────────
function identifyRuntime(command) {
  const cmd = command.toLowerCase();
  for (const [key, rt] of Object.entries(RUNTIMES)) {
    if (key === 'other') continue;
    for (const pattern of rt.commands) {
      if (cmd === pattern.toLowerCase() || cmd.startsWith(pattern.toLowerCase())) {
        return key;
      }
    }
  }
  return 'other';
}

// ── Port detection ───────────────────────────────────────────────────
function getAllPorts() {
  return new Promise((resolve) => {
    const cmd = 'lsof -iTCP -sTCP:LISTEN -P -n';

    exec(cmd, async (err, stdout) => {
      if (err || !stdout.trim()) return resolve([]);

      // Batch fetch memory from top (matches Activity Monitor)
      // and CPU from ps (top -l 1 always shows 0% CPU, needs 2 samples)
      const [memMap, cpuMap] = await Promise.all([
        new Promise(resolve2 => {
          exec('top -l 1 -stats pid,mem', (err2, out2) => {
            const map = {};
            if (err2 || !out2) return resolve2(map);
            out2.trim().split('\n').slice(12).forEach(line => {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
                const memStr = parts[1];
                let memMB = 0;
                const match = memStr.match(/^([\d.]+)([KMG]?)$/i);
                if (match) {
                  const val = parseFloat(match[1]);
                  const unit = (match[2] || '').toUpperCase();
                  if (unit === 'K') memMB = val / 1024;
                  else if (unit === 'G') memMB = val * 1024;
                  else memMB = val;
                }
                map[parts[0]] = Math.round(memMB * 10) / 10;
              }
            });
            resolve2(map);
          });
        }),
        new Promise(resolve2 => {
          exec('ps -eo pid,%cpu', (err2, out2) => {
            const map = {};
            if (err2 || !out2) return resolve2(map);
            out2.trim().split('\n').slice(1).forEach(line => {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 2) {
                map[parts[0]] = parseFloat(parts[1]) || 0;
              }
            });
            resolve2(map);
          });
        }),
      ]);
      const usageMap = {};
      for (const pid of new Set([...Object.keys(memMap), ...Object.keys(cpuMap)])) {
        usageMap[pid] = { cpu: cpuMap[pid] || 0, memMB: memMap[pid] || 0 };
      }

      const lines = stdout.trim().split('\n');
      const settings = loadSettings();
      const results = [];
      const seen = new Set();

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(/\s+/);
        const command = parts[0];
        const pid = parts[1];
        const user = parts[2];

        const runtime = identifyRuntime(command);

        if (settings.runtimes[runtime] && !settings.runtimes[runtime].enabled) continue;
        if (runtime === 'other' && !settings.showOtherProcesses) continue;

        const addr = parts.find(p => p.includes(':')) || '';
        let port = null;
        if (addr) {
          const lastColon = addr.lastIndexOf(':');
          if (lastColon !== -1) {
            const candidate = addr.slice(lastColon + 1);
            if (/^\d+$/.test(candidate)) {
              port = parseInt(candidate, 10);
            }
          }
        }

        const dedupeKey = `${pid}:${port}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const cwdPath = await new Promise(resolve2 => {
          exec(`lsof -p ${pid} -a -d cwd -Fn`, (err2, out2) => {
            if (err2 || !out2) return resolve2(null);
            const lineWithPath = out2.split('\n').find(l => l.startsWith('n/'));
            resolve2(lineWithPath ? lineWithPath.substring(1) : null);
          });
        });

        const usage = usageMap[pid] || { cpu: 0, memMB: 0 };
        const runtimeInfo = RUNTIMES[runtime];
        const isFavorite = settings.favorites.includes(port);

        results.push({
          command,
          pid,
          user,
          port,
          runtime,
          runtimeName: runtimeInfo.name,
          runtimeColor: runtimeInfo.color,
          runtimeIcon: runtimeInfo.icon,
          scriptPath: cwdPath,
          favorite: isFavorite,
          cpu: usage.cpu,
          memMB: usage.memMB,
        });
      }

      resolve(results);
    });
  });
}

// ── Health check ─────────────────────────────────────────────────────
function checkPortHealth(port) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      req.destroy();
      resolve('unknown');
    }, 2000);

    const req = http.get(`http://localhost:${port}`, (res) => {
      clearTimeout(timeout);
      resolve(res.statusCode < 500 ? 'healthy' : 'unhealthy');
    });

    req.on('error', () => {
      clearTimeout(timeout);
      resolve('unreachable');
    });
  });
}

// ── API routes ───────────────────────────────────────────────────────

app.get('/api/ports', async (req, res) => {
  try {
    const ports = await getAllPorts();
    const settings = loadSettings();

    // Update history with currently running ports
    const now = new Date().toISOString();
    const historyMap = {};
    (settings.history || []).forEach(h => { historyMap[`${h.port}:${h.scriptPath}`] = h; });

    ports.forEach(p => {
      const key = `${p.port}:${p.scriptPath}`;
      historyMap[key] = {
        port: p.port,
        command: p.command,
        user: p.user,
        runtime: p.runtime,
        runtimeName: p.runtimeName,
        runtimeColor: p.runtimeColor,
        runtimeIcon: p.runtimeIcon,
        scriptPath: p.scriptPath,
        lastSeen: now,
      };
    });

    // Keep last 50 history entries, sorted by lastSeen
    settings.history = Object.values(historyMap)
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, 50);
    saveSettings(settings);

    // Build history list: entries not currently running
    const runningKeys = new Set(ports.map(p => `${p.port}:${p.scriptPath}`));
    const history = settings.showHistory !== false
      ? settings.history
          .filter(h => !runningKeys.has(`${h.port}:${h.scriptPath}`))
          .map(h => ({
            ...h,
            stopped: true,
            pathExists: h.scriptPath ? fs.existsSync(h.scriptPath) : false,
            favorite: settings.favorites.includes(h.port),
          }))
      : [];

    res.json({
      timestamp: now,
      count: ports.length,
      ports,
      history,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/health/:port', async (req, res) => {
  const port = parseInt(req.params.port);
  if (!port || isNaN(port)) return res.status(400).json({ error: 'Invalid port' });
  const status = await checkPortHealth(port);
  res.json({ port, status });
});

app.get('/api/health', async (req, res) => {
  try {
    const ports = await getAllPorts();
    const checks = await Promise.all(
      ports.filter(p => p.port).map(async (p) => ({
        port: p.port,
        status: await checkPortHealth(p.port),
      }))
    );
    const healthMap = {};
    checks.forEach(c => { healthMap[c.port] = c.status; });
    res.json(healthMap);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/kill/:pid', (req, res) => {
  const pid = req.params.pid;
  if (!pid || !/^\d+$/.test(pid)) {
    return res.status(400).json({ error: 'Invalid PID' });
  }
  exec(`kill ${pid}`, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({
        error: `Failed to kill PID ${pid}`,
        details: stderr || err.message,
      });
    }
    res.json({ success: true, pid, message: `Process ${pid} killed` });
  });
});

app.post('/api/restart/:pid', (req, res) => {
  const pid = req.params.pid;
  if (!pid || !/^\d+$/.test(pid)) {
    return res.status(400).json({ error: 'Invalid PID' });
  }
  // Send SIGHUP to restart
  exec(`kill -HUP ${pid}`, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({
        error: `Failed to restart PID ${pid}`,
        details: stderr || err.message,
      });
    }
    res.json({ success: true, pid, message: `SIGHUP sent to ${pid}` });
  });
});

app.post('/api/start-server', (req, res) => {
  const dir = req.body.path;
  if (!dir || typeof dir !== 'string' || !dir.startsWith('/')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Directory not found' });
  }
  // Check for package.json to determine start command
  const pkgPath = path.join(dir, 'package.json');
  let cmd = 'npm start';
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts && pkg.scripts.dev) cmd = 'npm run dev';
      else if (pkg.scripts && pkg.scripts.start) cmd = 'npm start';
    } catch {}
  }
  // Open a new terminal and run the command
  exec(`open -a Terminal "${dir}" && sleep 0.5 && osascript -e 'tell application "Terminal" to do script "cd \\"${dir}\\" && ${cmd}" in front window'`, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to start server' });
    }
    res.json({ success: true, command: cmd });
  });
});

app.post('/api/open-terminal', (req, res) => {
  const dir = req.body.path;
  if (!dir || typeof dir !== 'string' || !dir.startsWith('/')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  // Verify directory exists before opening
  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: 'Directory not found' });
  }
  // macOS: open Terminal.app at the given directory
  exec(`open -a Terminal "${dir}"`, (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to open terminal' });
    }
    res.json({ success: true });
  });
});

app.get('/api/settings', (req, res) => {
  res.json(loadSettings());
});

app.put('/api/settings', (req, res) => {
  const current = loadSettings();
  const updated = { ...current, ...req.body };
  if (req.body.runtimes) {
    updated.runtimes = { ...current.runtimes };
    for (const [key, val] of Object.entries(req.body.runtimes)) {
      updated.runtimes[key] = { ...current.runtimes[key], ...val };
    }
  }
  saveSettings(updated);
  res.json(updated);
});

app.post('/api/favorites/:port', (req, res) => {
  const port = parseInt(req.params.port);
  if (!port || isNaN(port)) return res.status(400).json({ error: 'Invalid port' });
  const settings = loadSettings();
  if (!settings.favorites.includes(port)) {
    settings.favorites.push(port);
  }
  saveSettings(settings);
  res.json({ favorites: settings.favorites });
});

app.delete('/api/favorites/:port', (req, res) => {
  const port = parseInt(req.params.port);
  if (!port || isNaN(port)) return res.status(400).json({ error: 'Invalid port' });
  const settings = loadSettings();
  settings.favorites = settings.favorites.filter(p => p !== port);
  saveSettings(settings);
  res.json({ favorites: settings.favorites });
});

app.delete('/api/history', (req, res) => {
  const settings = loadSettings();
  settings.history = [];
  saveSettings(settings);
  res.json({ success: true });
});

app.delete('/api/history/:port', (req, res) => {
  const port = parseInt(req.params.port);
  if (!port || isNaN(port)) return res.status(400).json({ error: 'Invalid port' });
  const settings = loadSettings();
  settings.history = (settings.history || []).filter(h => h.port !== port);
  saveSettings(settings);
  res.json({ success: true });
});

// Serve history page at clean /history route
app.get('/history', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'history.html'));
});

app.get('/api/runtimes', (req, res) => {
  const runtimes = {};
  for (const [key, rt] of Object.entries(RUNTIMES)) {
    runtimes[key] = {
      name: rt.name,
      color: rt.color,
      icon: rt.icon,
      commands: rt.commands,
    };
  }
  res.json(runtimes);
});

// ── WebSocket broadcast ──────────────────────────────────────────────
async function broadcastPorts() {
  if (wss.clients.size === 0) return;

  try {
    const ports = await getAllPorts();
    const settings = loadSettings();
    const now = new Date().toISOString();

    // Update history
    const historyMap = {};
    (settings.history || []).forEach(h => { historyMap[`${h.port}:${h.scriptPath}`] = h; });
    ports.forEach(p => {
      historyMap[`${p.port}:${p.scriptPath}`] = {
        port: p.port, command: p.command, user: p.user, runtime: p.runtime,
        runtimeName: p.runtimeName, runtimeColor: p.runtimeColor,
        runtimeIcon: p.runtimeIcon, scriptPath: p.scriptPath, lastSeen: now,
      };
    });
    settings.history = Object.values(historyMap)
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 50);
    saveSettings(settings);

    const runningKeys = new Set(ports.map(p => `${p.port}:${p.scriptPath}`));
    const history = settings.showHistory !== false
      ? settings.history
          .filter(h => !runningKeys.has(`${h.port}:${h.scriptPath}`))
          .map(h => ({
            ...h, stopped: true,
            pathExists: h.scriptPath ? fs.existsSync(h.scriptPath) : false,
            favorite: settings.favorites.includes(h.port),
          }))
      : [];

    const payload = JSON.stringify({
      type: 'ports',
      timestamp: now,
      count: ports.length,
      ports,
      history,
    });

    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(payload);
    });
  } catch (err) {
    console.error('Broadcast error:', err);
  }
}

setInterval(broadcastPorts, 3000);

server.listen(PORT, () => {
  console.log(`\n  DevDock is running at http://localhost:${PORT}\n`);
});
