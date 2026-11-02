import http from "node:http";
import { randomUUID } from "node:crypto";

export function createBridgeServer({ timeoutMs = 120000, pollMs = 25000, managerToken = process.env.PR_BRIDGE_MANAGER_TOKEN } = {}) {
  const queue = [], pending = new Map(), polls = new Set(), completed = new Set();
  const clients = new Map(), history = [];
  let file = null, shuttingDown = false;
  let active = null, owner = null, lastPollAt = 0;
  const connected = () => !!owner && (polls.size > 0 || !!active || Date.now() - lastPollAt < 8000);
  function json(res, status, body) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-PR-Bridge-Client",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end(JSON.stringify(body));
  }
  async function readBody(req, limit = 5000000) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error("Request body too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  }
  function finish(entry, status, body) {
    if (pending.has(entry.id)) {
      history.unshift({ id: entry.id, clientId: entry.clientId, type: entry.command.type, startedAt: entry.startedAt || null, finishedAt: Date.now(), outcome: status === 200 && body.ok !== false ? "success" : "error", error: body.error || null });
      history.length = Math.min(history.length, 60);
    }
    clearTimeout(entry.timer);
    pending.delete(entry.id);
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    json(entry.res, status, body);
  }
  function dispatch() {
    if (active || !queue.length || !polls.size) return;
    const poll = polls.values().next().value;
    active = queue.shift();
    active.startedAt = Date.now();
    poll.send({ id: active.id, command: active.command, deadlineAt: active.deadlineAt });
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return json(res, 204, {});
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/agents/heartbeat") {
        const body = await readBody(req);
        if (typeof body.clientId !== "string" || !body.clientId) return json(res, 400, { error: "clientId required" });
        const id = body.clientId.slice(0, 160);
        clients.set(id, { clientId: id, name: String(body.name || "MCP Agent").slice(0, 100), pid: Number(body.pid) || null, connectedAt: clients.get(id)?.connectedAt || Date.now(), lastSeen: Date.now() });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/agents/disconnect") {
        const body = await readBody(req);
        clients.delete(body.clientId);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/plugin/context") {
        const body = await readBody(req);
        if (body.session !== owner) return json(res, 409, { error: "Wrong plugin session" });
        file = { name: String(body.name || "未命名文件").slice(0, 200), fileKey: typeof body.fileKey === "string" ? body.fileKey.slice(0, 200) : null, pageName: String(body.pageName || "").slice(0, 200), pageId: String(body.pageId || "").slice(0, 100), updatedAt: Date.now() };
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/plugin/disconnect") {
        const body = await readBody(req);
        if (body.session !== owner) return json(res, 409, { error: "插件连接已变化，请重新打开插件" });
        if (active || pending.size) return json(res, 409, { error: "当前端口有执行或排队任务，完成后才能切换" });
        for (const poll of [...polls]) poll.send({ command: null });
        owner = null; file = null; lastPollAt = 0;
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/dashboard") {
        for (const [id, client] of clients) if (Date.now() - client.lastSeen > 120000) clients.delete(id);
        return json(res, 200, {
          telemetryVersion: 1, file: connected() ? file : null,
          agents: [...clients.values()].map(client => ({ ...client, online: Date.now() - client.lastSeen < 20000, busy: active?.clientId === client.clientId, queued: queue.filter(entry => entry.clientId === client.clientId).length })),
          queue: queue.map(entry => ({ id: entry.id, clientId: entry.clientId, type: entry.command.type })), history,
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/stop") {
        if (!managerToken || req.headers["x-pr-manager"] !== managerToken) return json(res, 403, { error: "Only the owning console may stop this service" });
        if (active || pending.size) return json(res, 409, { error: "仍有任务执行或等待，请完成后再停止" });
        shuttingDown = true;
        json(res, 200, { ok: true });
        for (const poll of [...polls]) poll.send({ command: null });
        server.close();
        setTimeout(() => server.closeAllConnections(), 200).unref();
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true, service: "PR-bridge", version: "2.1.0", protocol: 2, telemetryVersion: 1,
          port: server.address().port, pid: process.pid, pluginConnected: connected(),
          queuedCommands: queue.length, pendingCommands: pending.size,
          activeClients: new Set([...pending.values(), ...(active ? [active] : [])].map(x => x.clientId)).size,
          executing: active ? { id: active.id, clientId: active.clientId, startedAt: active.startedAt, timedOut: !pending.has(active.id) } : null,
        });
      }
      if (req.method === "GET" && url.pathname === "/poll") {
        const session = url.searchParams.get("session") || "legacy";
        if (owner && owner !== session && (connected() || pending.size)) {
          return json(res, 409, { ok: false, error: "Another Figma plugin owns this bridge. Use one plugin for the shared file." });
        }
        if (owner !== session) file = null;
        owner = session;
        lastPollAt = Date.now();
        const poll = { send: body => { cleanup(); json(res, 200, body); } };
        const timer = setTimeout(() => poll.send({ command: null }), pollMs);
        function cleanup() { clearTimeout(timer); polls.delete(poll); }
        res.on("close", cleanup);
        polls.add(poll);
        dispatch();
        return;
      }
      if (req.method === "POST" && url.pathname === "/command") {
        if (shuttingDown) return json(res, 503, { error: "Service stopping" });
        const command = await readBody(req);
        if (!command || typeof command.type !== "string") return json(res, 400, { ok: false, error: "Command requires type" });
        if (!connected()) return json(res, 503, { ok: false, error: "Open PR-bridge in the target Figma file first." });
        if (active && !pending.has(active.id)) return json(res, 503, { ok: false, error: "Previous edit timed out; waiting for its result. Do not retry the edit blindly." });
        const entry = { id: randomUUID(), command, res, deadlineAt: Date.now() + timeoutMs, clientId: String(req.headers["x-pr-bridge-client"] || "http-client").slice(0, 160) };
        entry.timer = setTimeout(() => {
          finish(entry, 504, { ok: false, error: active === entry ? "Execution timed out; outcome unknown. Queue stays blocked until the plugin returns its result." : "Queue wait timed out; command was not executed." });
        }, timeoutMs);
        pending.set(entry.id, entry);
        queue.push(entry);
        res.on("close", () => {
          if (pending.has(entry.id)) finish(entry, 499, { ok: false, error: "Client disconnected" });
        });
        dispatch();
        return;
      }
      if (req.method === "POST" && url.pathname === "/result") {
        // 8 MiB PNG becomes roughly 11 MiB after base64 encoding.
        const body = await readBody(req, 12 * 1024 * 1024);
        if ((body.session || "legacy") !== owner) return json(res, 409, { ok: false, error: "Wrong plugin session" });
        if (completed.has(body.id)) return json(res, 200, { ok: true });
        if (!active || active.id !== body.id) return json(res, 404, { ok: false, error: "Unknown command id" });
        finish(active, 200, body);
        completed.add(body.id);
        if (completed.size > 256) completed.delete(completed.values().next().value);
        active = null;
        json(res, 200, { ok: true });
        dispatch();
        return;
      }
      json(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
  });
  server.on("close", () => {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    for (const poll of polls) poll.send({ command: null });
  });
  return server;
}
