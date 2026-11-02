import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('./', import.meta.url));
export async function createConsoleServer({ stateDir = new URL('./console-data/', import.meta.url) } = {}) {
  await mkdir(stateDir, { recursive: true });
  const configFile = new URL('ports.json', stateDir);
  let ports;
  try { ports = JSON.parse(await readFile(configFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; ports = [38471, 38472]; }
  const valid = port => Number.isInteger(port) && port >= 1024 && port <= 65535;
  if (!Array.isArray(ports) || ports.some(port => !valid(port))) throw new Error('Invalid ports configuration');
  const owned = new Map(), locks = new Set();
  async function save() { await writeFile(configFile, JSON.stringify(ports)); }
  async function probe(port) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(url + '/health', { signal: AbortSignal.timeout(900) });
      const health = await response.json();
      const recognized = ['PR-bridge', 'bobyapp-figma-local-bridge'].includes(health.service);
      let dashboard = null;
      if (recognized && health.telemetryVersion) dashboard = await fetch(url + '/dashboard', { signal: AbortSignal.timeout(900) }).then(r => r.json());
      return { port, status: recognized ? 'running' : 'occupied', health: recognized ? health : null, dashboard, managed: recognized && owned.has(port) && owned.get(port).pid === health.pid };
    } catch {
      const listening = await new Promise(resolve => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const finish = value => { socket.destroy(); resolve(value); };
        socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(400, () => finish(true));
      });
      return { port, status: listening ? 'occupied' : 'stopped', managed: false, health: null, dashboard: null };
    }
  }
  async function prepare(port) {
    const folder = new URL('plugins/PR-bridge/', stateDir);
    await mkdir(folder, { recursive: true });
    const manifest = JSON.parse(await readFile(new URL('./figma-plugin/manifest.json', import.meta.url), 'utf8'));
    manifest.networkAccess.allowedDomains = ports.map(p => `http://localhost:${p}`);
    const ui = (await readFile(new URL('./figma-plugin/ui.html', import.meta.url), 'utf8')).replace(/const allowedPorts = .*?; \/\/ PR_PORTS/, `const allowedPorts = ${JSON.stringify(ports)}; // PR_PORTS`);
    await writeFile(new URL('manifest.json', folder), JSON.stringify(manifest, null, 2));
    await writeFile(new URL('ui.html', folder), ui);
    await writeFile(new URL('code.js', folder), await readFile(new URL('./figma-plugin/code.js', import.meta.url)));
    return { manifestPath: fileURLToPath(new URL('manifest.json', folder)), selectedPort: port, mcpConfig: { mcpServers: { [`PR-bridge-${port}`]: { command: process.execPath, args: [root + 'mcp-server.mjs'], env: { FIGMA_BRIDGE_URL: `http://127.0.0.1:${port}` } } } } };
  }

  const server = http.createServer(async (req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const host = `127.0.0.1:${server.address().port}`;
    if (![host, `localhost:${server.address().port}`].includes(req.headers.host)) return json(403, { error: 'Invalid host' });
    const pathname = new URL(req.url, `http://${host}`).pathname;
    try {
      if (req.method === 'GET' && pathname === '/api/state') return json(200, { service: 'PR-bridge-console', updatedAt: Date.now(), bridges: await Promise.all(ports.map(probe)) });
      if (req.method === 'POST' && pathname === '/api/action') {
        if (req.headers['x-pr-console'] !== '1' || (req.headers.origin && ![`http://${host}`, `http://localhost:${server.address().port}`].includes(req.headers.origin))) return json(403, { error: '仅允许本地控制台操作' });
        let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 2048) throw new Error('Request too large'); }
        const { port, action } = JSON.parse(data);
        if (!valid(port) || port === server.address().port) throw new Error('请输入 1024–65535 内的端口，不能使用控制台端口');
        if (locks.has(port)) return json(409, { error: '该端口正在处理中' });
        locks.add(port);
        try {
          if (action === 'add') { if (!ports.includes(port)) { if (ports.length >= 16) throw new Error('最多管理 16 个端口'); ports.push(port); await save(); await prepare(port); } return json(200, { ok: true }); }
          if (!ports.includes(port)) throw new Error('请先添加端口');
          if (action === 'prepare') return json(200, { ok: true, ...await prepare(port) });
          const state = await probe(port);
          if (action === 'remove') { if (state.status !== 'stopped') throw new Error('请先停止此端口的服务'); ports = ports.filter(p => p !== port); await save(); return json(200, { ok: true }); }
          if (action === 'start') {
            if (state.status !== 'stopped') throw new Error('此端口已在使用中');
            const token = randomUUID();
            const child = spawn(process.execPath, [root + 'bridge-server.mjs'], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, FIGMA_BRIDGE_PORT: String(port), PR_BRIDGE_MANAGER_TOKEN: token } });
            let failure; child.on('error', error => { failure = error; }); child.unref();
            owned.set(port, { pid: child.pid, token });
            for (let i = 0; i < 30; i++) { if (failure) throw failure; await delay(100); const next = await probe(port); if (next.status === 'running') { if (!next.managed) throw new Error('端口被其他进程先占用，请刷新'); return json(200, { ok: true }); } }
            throw new Error('服务启动超时，请检查端口');
          }
          if (action === 'stop') {
            if (!state.managed) throw new Error('只能停止由此控制台启动的服务');
            const response = await fetch(`http://127.0.0.1:${port}/admin/stop`, { method: 'POST', headers: { 'x-pr-manager': owned.get(port).token }, signal: AbortSignal.timeout(2000) });
            const result = await response.json(); if (!response.ok) throw new Error(result.error);
            owned.delete(port); return json(200, { ok: true });
          }
          throw new Error('Unknown action');
        } finally { locks.delete(port); }
      }
      const files = { '/': ['index.html', 'text/html'], '/app.css': ['app.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
      if (req.method === 'GET' && files[pathname]) {
        const [file, type] = files[pathname];
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
        return res.end(await readFile(new URL('./console/' + file, import.meta.url)));
      }
      json(404, { error: 'Not found' });
    } catch (error) { json(400, { error: error.message }); }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await createConsoleServer();
  const port = Number(process.env.PR_CONSOLE_PORT || 38470);
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`PR-bridge console: http://127.0.0.1:${port}`));
}
