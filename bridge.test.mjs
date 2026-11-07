import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { createBridgeServer } from "./bridge-core.mjs";
import { exportImageContent } from "./export-image.mjs";

async function fixture(t, options = {}) {
  const server = createBridgeServer({ pollMs: 80, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(url + path).then(async r => ({ status: r.status, body: await r.json() }));
  const post = (path, body, client = "a", signal) => fetch(url + path, {
    method: "POST", headers: { "content-type": "application/json", "x-pr-bridge-client": client }, body: JSON.stringify(body), signal,
  }).then(async r => ({ status: r.status, body: await r.json() }));
  await get("/poll?session=plugin");
  return { server, url, get, post };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(10); }
  throw new Error("Condition not reached");
}

test("many agents share one FIFO queue; results cannot cross; second plugin rejected", async t => {
  const { get, post } = await fixture(t);
  const calls = [];
  for (let i = 0; i < 8; i++) {
    calls.push(post("/command", { type: "rename_node", name: String(i) }, `agent-${i}`));
    await until(async () => (await get("/health")).body.queuedCommands === i + 1);
  }
  assert.equal((await get("/health")).body.activeClients, 8);
  assert.equal((await get("/poll?session=another-file")).status, 409);
  for (let i = 0; i < 8; i++) {
    const { body: command } = await get("/poll?session=plugin");
    assert.equal(command.command.name, String(i));
    assert.equal((await get("/poll?session=plugin")).body.command, null);
    assert.equal((await post("/result", { id: command.id, session: "wrong", ok: true })).status, 409);
    const result = { id: command.id, session: "plugin", ok: true, result: i };
    assert.equal((await post("/result", result)).status, 200);
    assert.equal((await calls[i]).body.result, i);
    assert.equal((await post("/result", result)).status, 200);
  }
  assert.equal((await get("/health")).body.pendingCommands, 0);
});

test("queued timeouts are removed and never execute later", async t => {
  const { get, post } = await fixture(t, { timeoutMs: 100 });
  const response = await post("/command", { type: "delete_node" });
  assert.equal(response.status, 504);
  assert.match(response.body.error, /not executed/);
  assert.equal((await get("/poll?session=plugin")).body.command, null);
});

test("idle long-poll responses keep the plugin connected before its next poll", async t => {
  const { get } = await fixture(t, { pollMs: 100, connectionGraceMs: 30 });
  assert.equal((await get('/health')).body.pluginConnected, true);
});

test("completed long tasks allow an immediate next command before plugin repoll", async t => {
  const {get,post}=await fixture(t,{pollMs:100,connectionGraceMs:30});
  const first=post('/command',{type:'status'});
  await until(async()=>(await get('/health')).body.queuedCommands===1);
  const delivered=(await get('/poll?session=plugin')).body;
  await delay(60);
  await post('/result',{id:delivered.id,session:'plugin',ok:true,result:{}});
  assert.equal((await first).status,200);
  assert.equal((await get('/health')).body.pluginConnected,true);
  const next=post('/command',{type:'status'});
  await until(async()=>(await get('/health')).body.queuedCommands===1);
  const second=(await get('/poll?session=plugin')).body;
  await post('/result',{id:second.id,session:'plugin',ok:true,result:{}});
  assert.equal((await next).status,200);
});

test("execution timeout blocks subsequent edits until late result arrives", async t => {
  const { get, post } = await fixture(t, { timeoutMs: 150 });
  const call = post("/command", { type: "rename_node" });
  const { body: command } = await get("/poll?session=plugin");
  assert.equal((await call).status, 504);
  assert.equal((await get("/health")).body.executing.timedOut, true);
  assert.equal((await post("/command", { type: "delete_node" })).status, 503);
  await post("/result", { id: command.id, session: "plugin", ok: true });
  assert.equal((await get("/health")).body.executing, null);
});

test("disconnected clients lose queued edits", async t => {
  const { get, post } = await fixture(t);
  const abort = new AbortController();
  const response = post("/command", { type: "delete_node" }, "a", abort.signal).catch(() => null);
  await until(async () => (await get("/health")).body.queuedCommands === 1);
  abort.abort();
  await response;
  await until(async () => (await get("/health")).body.queuedCommands === 0);
  assert.equal((await get("/poll?session=plugin")).body.command, null);
});

function launch(script, env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], { env: { ...process.env, ...env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", data => { out += data; });
  child.stderr.on("data", data => { err += data; });
  return { child, done: once(child, "exit").then(([code]) => ({ code, out, err })) };
}

test("duplicate startup reuses the existing listener", async t => {
  const { server } = await fixture(t);
  const runs = Array.from({ length: 5 }, () => launch("./bridge-server.mjs", { FIGMA_BRIDGE_PORT: String(server.address().port) }));
  for (const run of runs) {
    const result = await run.done;
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /reusing shared service/);
  }
});

test("independent MCP processes share the bridge and return their own results", async t => {
  const { url, get, post } = await fixture(t);
  const runs = ["one", "two", "three"].map(client => launch("./mcp-server.mjs", { FIGMA_BRIDGE_URL: url, PR_BRIDGE_CLIENT_ID: client }));
  t.after(() => runs.forEach(run => run.child.kill()));
  for (const run of runs) {
    run.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    run.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "figma_list_pages" } }) + "\n");
  }
  await until(async () => (await get("/health")).body.queuedCommands === 3);
  for (let i = 0; i < 3; i++) {
    const { body: command } = await get("/poll?session=plugin");
    const { body: health } = await get("/health");
    await post("/result", { id: command.id, session: "plugin", ok: true, result: health.executing.clientId });
  }
  for (const [i, run] of runs.entries()) {
    run.child.stdin.end();
    const result = await run.done;
    assert.equal(result.code, 0, result.err);
    const messages = result.out.trim().split("\n").map(JSON.parse);
    assert.equal(messages.find(x => x.id === 1).result.serverInfo.name, "PR-bridge");
    assert.equal(JSON.parse(messages.find(x => x.id === 2).result.content[0].text), ["one", "two", "three"][i]);
  }
});

test("explicit pageId keeps edits on the requested page despite current-page changes", async () => {
  const writes = [], output = [];
  const page = { id: "target", type: "PAGE", appendChild: node => writes.push(node) };
  const figma = {
    showUI() {}, ui: { postMessage: message => output.push(message) }, loadAllPagesAsync: async () => {},
    currentPage: { appendChild() { throw new Error("Wrong page"); } },
    getNodeByIdAsync: async id => id === "target" ? page : null,
    createRectangle: () => ({ id: "rect", type: "RECTANGLE" }),
  };
  vm.runInNewContext(await readFile(new URL("./figma-plugin/code.js", import.meta.url), "utf8"), { figma, __html__: "" });
  await figma.ui.onmessage({ type: "bridge-command", id: "test", command: { type: "apply_operations", pageId: "target", operations: [{ op: "create_rectangle", name: "correct" }] } });
  assert.equal(output[0].ok, true);
  assert.equal(writes[0].name, "correct");
});

test("simultaneous cold starts create one shared background service", async t => {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  let ownedPid;
  t.after(() => { if (ownedPid) { try { process.kill(ownedPid); } catch {} } });
  const runs = Array.from({ length: 6 }, () => launch("./start-shared.mjs", { FIGMA_BRIDGE_URL: url }));
  const results = await Promise.all(runs.map(run => run.done));
  const health = await fetch(url + "/health").then(r => r.json());
  ownedPid = health.pid;
  for (const result of results) assert.equal(result.code, 0, result.err);
  assert.equal(health.service, "PR-bridge");
  assert.equal(health.protocol, 2);
  const again = await launch("./start-shared.mjs", { FIGMA_BRIDGE_URL: url }).done;
  assert.equal(again.code, 0, again.err);
  assert.equal((await fetch(url + "/health").then(r => r.json())).pid, ownedPid);
});

test("an unrelated occupied port is reported without replacing its service", async t => {
  const http = await import("node:http");
  const server = http.createServer((req, res) => res.end(JSON.stringify({ service: "unrelated" })));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const result = await launch("./start-shared.mjs", { FIGMA_BRIDGE_URL: url }).done;
  assert.equal(result.code, 1);
  assert.match(result.err, /old or different service/);
  assert.equal((await fetch(url).then(r => r.json())).service, "unrelated");
});

async function textPlugin({ fontDelay = 0, rejectInter = false, failOnce = false } = {}) {
  const fonts = [], nodes = [], replies = [];
  let allPagesLoads = 0;
  const figma = {
    showUI() {}, ui: { postMessage: reply => replies.push(reply) },
    loadAllPagesAsync: async () => { allPagesLoads++; },
    loadFontAsync: async font => {
      fonts.push({ ...font });
      if (fontDelay) await delay(fontDelay);
      if (rejectInter && font.family === "Inter" || failOnce && fonts.length === 1) throw new Error("Font unavailable");
    },
    currentPage: { appendChild: node => nodes.push(node) },
    createText: () => {
      let value = "";
      return {
        id: `text-${nodes.length}`, type: "TEXT", fontName: { family: "Inter", style: "Regular" },
        get characters() { return value; },
        set characters(text) {
          assert.ok(fonts.some(font => font.family === this.fontName.family && font.style === this.fontName.style), "Correct font must load before characters");
          value = text;
        },
      };
    },
  };
  vm.runInNewContext(await readFile(new URL("./figma-plugin/code.js", import.meta.url), "utf8"), { figma, __html__: "" });
  return { figma, fonts, nodes, replies, allPagesLoads: () => allPagesLoads,
    run: (operations, deadlineAt) => figma.ui.onmessage({ type: "bridge-command", id: "text", deadlineAt, command: { type: "apply_operations", operations } }),
  };
}

test("50 text nodes reuse one font load and never load all pages", async () => {
  const plugin = await textPlugin();
  await plugin.run(Array.from({ length: 50 }, (_, i) => ({ op: "create_text", text: `段落 ${i}` })));
  assert.equal(plugin.replies[0].ok, true);
  assert.equal(plugin.nodes.length, 50);
  assert.equal(plugin.fonts.length, 1);
  assert.equal(plugin.allPagesLoads(), 0);
  await plugin.run([{ op: "create_text", text: "下一批" }]);
  assert.equal(plugin.fonts.length, 1);
});

test("font styles and fallback are applied before text is assigned", async () => {
  const styled = await textPlugin();
  await styled.run([{ op: "create_text", fontFamily: "MiSans", fontStyle: "Bold", text: "标题" }]);
  assert.equal(styled.replies[0].ok, true);
  assert.equal(styled.nodes[0].fontName.family, "MiSans");
  assert.equal(styled.nodes[0].fontName.style, "Bold");
  const fallback = await textPlugin({ rejectInter: true });
  await fallback.run([{ op: "create_text", text: "fallback" }, { op: "create_text", text: "again" }]);
  assert.equal(fallback.replies[0].ok, true);
  assert.equal(fallback.nodes[0].fontName.family, "Arial");
  assert.equal(fallback.fonts.length, 2);
});

test("font failure does not poison retries or leave empty text nodes", async () => {
  const plugin = await textPlugin({ failOnce: true });
  const op = { op: "create_text", fontFamily: "MiSans", text: "retry" };
  await plugin.run([op]);
  assert.equal(plugin.replies[0].ok, false);
  assert.equal(plugin.nodes.length, 0);
  await plugin.run([op]);
  assert.equal(plugin.replies[1].ok, true);
  assert.equal(plugin.nodes.length, 1);
});

test("a font load finishing after deadline cannot cause a late text write", async () => {
  const plugin = await textPlugin({ fontDelay: 50 });
  await plugin.run([{ op: "create_text", text: "must not appear" }], Date.now() + 20);
  assert.equal(plugin.replies[0].ok, false);
  assert.match(plugin.replies[0].error, /deadline/);
  assert.equal(plugin.nodes.length, 0);
});

test("editing existing mixed-font text loads its actual fonts", async () => {
  const plugin = await textPlugin();
  const node = { id: "existing", type: "TEXT", characters: "旧文", getRangeAllFontNames: () => [
    { family: "MiSans", style: "Regular" }, { family: "MiSans", style: "Bold" },
  ] };
  plugin.figma.getNodeByIdAsync = async () => node;
  await plugin.run([{ op: "set", nodeId: "existing", characters: "新文" }]);
  assert.equal(plugin.replies[0].ok, true);
  assert.equal(node.characters, "新文");
  assert.deepEqual(plugin.fonts.map(font => font.family + "/" + font.style), ["MiSans/Regular", "MiSans/Bold"]);
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
test("plugin remembers its port with Figma clientStorage and ignores invalid ports", async () => {
  const replies = [], saved = new Map();
  const figma = { showUI() {}, ui: { postMessage: message => replies.push(message) }, clientStorage: {
    getAsync: async key => saved.get(key), setAsync: async (key,value) => saved.set(key,value),
  } };
  vm.runInNewContext(await readFile(new URL("./figma-plugin/code.js", import.meta.url), "utf8"), { figma, __html__: "" });
  await figma.ui.onmessage({ type: "bridge-settings-save", port: 38472 });
  await figma.ui.onmessage({ type: "bridge-settings-load" });
  assert.equal(replies[0].port,38472);
  await figma.ui.onmessage({ type: "bridge-settings-save", port: 70000 });
  await figma.ui.onmessage({ type: "bridge-settings-load" });
  assert.equal(replies[1].port,38472);
});
async function exportPlugin({ type = "FRAME", width = 1920, height = 1080, byteLength, exportDelay = 0 } = {}) {
  const calls = [], replies = [];
  const node = {
    id: "frame:7", name: "第七页", type, width, height,
    exportAsync: async settings => {
      calls.push(settings);
      if (exportDelay) await delay(exportDelay);
      return byteLength ? new Uint8Array(byteLength) : new Uint8Array(Buffer.from(PNG, "base64"));
    },
  };
  const figma = {
    showUI() {}, ui: { postMessage: reply => replies.push(reply) },
    getNodeByIdAsync: async id => id === node.id ? node : null,
    base64Encode: bytes => Buffer.from(bytes).toString("base64"),
    setCurrentPageAsync() { throw new Error("Export must not switch pages"); },
    loadAllPagesAsync() { throw new Error("Export must not load every page"); },
  };
  vm.runInNewContext(await readFile(new URL("./figma-plugin/code.js", import.meta.url), "utf8"), { figma, __html__: "" });
  return { calls, replies, run: (command, deadlineAt) => figma.ui.onmessage({ type: "bridge-command", id: "export", command, deadlineAt }) };
}

test("frame export uses PNG and bounded scale without changing the page", async () => {
  const plugin = await exportPlugin({ width: 8000, height: 4000 });
  await plugin.run({ type: "export_frame", nodeId: "frame:7", scale: 2 });
  assert.equal(plugin.replies[0].ok, true);
  assert.equal(plugin.calls[0].format, "PNG");
  assert.equal(plugin.calls[0].constraint.value, 2048 / 8000);
  assert.equal(plugin.calls[0].useAbsoluteBounds, true);
  const content = exportImageContent(plugin.replies[0].result);
  assert.equal(content[1].type, "image");
  assert.equal(content[1].data, PNG);
  assert.equal(JSON.parse(content[0].text).pixelWidth, 1);
  assert.ok(!content[0].text.includes(PNG), "Image bytes must not be dumped into text");
});

test("frame export rejects missing nodes, wrong targets and invalid arguments", async () => {
  for (const [options, command] of [
    [{}, { nodeId: "missing" }],
    [{ type: "TEXT" }, { nodeId: "frame:7" }],
    [{}, { nodeId: "frame:7", scale: 0 }],
    [{}, { nodeId: "frame:7", scale: "2" }],
    [{}, { nodeId: "frame:7", maxDimension: 9000 }],
    [{ width: 0 }, { nodeId: "frame:7" }],
  ]) {
    const plugin = await exportPlugin(options);
    await plugin.run({ type: "export_frame", ...command });
    assert.equal(plugin.replies[0].ok, false);
    assert.equal(plugin.calls.length, 0);
  }
});

test("frame export limits oversized results and observes command deadlines", async () => {
  const huge = await exportPlugin({ byteLength: 8 * 1024 * 1024 + 1 });
  await huge.run({ type: "export_frame", nodeId: "frame:7" });
  assert.match(huge.replies[0].error, /8 MiB/);
  const slow = await exportPlugin({ exportDelay: 50 });
  await slow.run({ type: "export_frame", nodeId: "frame:7" }, Date.now() + 20);
  assert.match(slow.replies[0].error, /deadline/);
  assert.throws(() => exportImageContent({ mimeType: "image/png", data: "bm90LXBuZw==" }), /PNG/);
});

test("MCP exposes screenshot tool and returns a native image through the shared bridge", async t => {
  const { url, get, post } = await fixture(t);
  const plugin = await exportPlugin();
  const run = launch("./mcp-server.mjs", { FIGMA_BRIDGE_URL: url });
  t.after(() => run.child.kill());
  run.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  run.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "figma_export_frame", arguments: { nodeId: "frame:7" } } }) + "\n");
  await until(async () => (await get("/health")).body.queuedCommands === 1);
  const { body: envelope } = await get("/poll?session=plugin");
  await plugin.run(envelope.command, envelope.deadlineAt);
  const { id, type, ...payload } = plugin.replies[0];
  await post("/result", { ...payload, id: envelope.id, session: "plugin" });
  run.child.stdin.end();
  const output = await run.done;
  assert.equal(output.code, 0, output.err);
  const messages = output.out.trim().split("\n").map(JSON.parse);
  assert.ok(messages.find(x => x.id === 1).result.tools.some(x => x.name === "figma_export_frame"));
  const result = messages.find(x => x.id === 2).result;
  assert.equal(result.isError, undefined);
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/png");
  assert.equal(result.content[1].data, PNG);
});

test("bridge transports screenshot payloads larger than the old 5 MB limit", async t => {
  const { get, post } = await fixture(t);
  const response = post("/command", { type: "export_frame", nodeId: "frame:7" });
  const { body: envelope } = await get("/poll?session=plugin");
  const data = "A".repeat(6 * 1024 * 1024);
  assert.equal((await post("/result", { id: envelope.id, session: "plugin", ok: true, result: { data } })).status, 200);
  assert.equal((await response).body.result.data.length, data.length);
});

async function inspectPlugin() {
  const replies = [];
  const mixed = Symbol("mixed");
  const text = { id: "text:1", name: "标题", type: "TEXT", characters: "实际文字", fontName: mixed, fills: mixed, width: 120, height: 30, hasMissingFont: false };
  const frame = { id: "frame:1", type: "FRAME", name: "画框", children: [text], width: 300, height: 200, clipsContent: true, fills: [] };
  const page = { id: "page:1", type: "PAGE", children: [frame], loadAsync: async () => { page.loaded = true; } };
  const nodes = new Map([text, frame, page].map(node => [node.id, node]));
  const figma = { showUI() {}, ui: { postMessage: message => replies.push(message) },
    root: { name: "测试文件" }, fileKey: "test-file", getNodeByIdAsync: async id => nodes.get(id),
    loadAllPagesAsync() { throw new Error("Do not load unrelated pages"); },
  };
  vm.runInNewContext(await readFile(new URL("./figma-plugin/code.js", import.meta.url), "utf8"), { figma, __html__: "" });
  return { replies, page, run: command => figma.ui.onmessage({ type: "bridge-command", id: "inspect", command }) };
}

test("inspection reads real text and mixed properties, and marks missing nodes", async () => {
  const plugin = await inspectPlugin();
  await plugin.run({ type: "inspect_nodes", nodeIds: ["page:1", "missing"] });
  assert.equal(plugin.replies[0].ok, true);
  const result = plugin.replies[0].result;
  assert.equal(plugin.page.loaded, true);
  assert.equal(result.nodeCount, 3);
  assert.equal(result.truncated, false);
  const text = result.nodes[0].children[0].children[0];
  assert.equal(text.characters, "实际文字");
  assert.equal(text.fontName, "Symbol(mixed)");
  assert.equal(text.fills, "Symbol(mixed)");
  assert.equal(result.nodes[1].missing, true);
});

test("inspection enforces depth and aggregate node limits with explicit truncation", async () => {
  const plugin = await inspectPlugin();
  await plugin.run({ type: "inspect_nodes", nodeIds: ["frame:1"], depth: 0 });
  assert.equal(plugin.replies[0].result.nodes[0].truncationReason, "depth");
  assert.equal(plugin.replies[0].result.nodeCount, 1);
  await plugin.run({ type: "inspect_nodes", nodeIds: ["page:1", "text:1"], maxNodes: 2 });
  const result = plugin.replies[1].result;
  assert.equal(result.nodeCount, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.nodes[1].truncationReason, "maxNodes");
  await plugin.run({ type: "inspect_nodes", nodeIds: [] });
  assert.equal(plugin.replies[2].ok, false);
});

test("MCP exposes inspect_nodes and returns plugin node details", async t => {
  const { url, get, post } = await fixture(t);
  const plugin = await inspectPlugin();
  const run = launch("./mcp-server.mjs", { FIGMA_BRIDGE_URL: url });
  t.after(() => run.child.kill());
  run.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
  run.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "figma_inspect_nodes", arguments: { nodeIds: ["frame:1"], depth: 2, maxNodes: 10 } } }) + "\n");
  await until(async () => (await get("/health")).body.queuedCommands === 1);
  const { body: envelope } = await get("/poll?session=plugin");
  await plugin.run(envelope.command);
  const { id, type, ...payload } = plugin.replies[0];
  await post("/result", { ...payload, id: envelope.id, session: "plugin" });
  run.child.stdin.end();
  const output = await run.done;
  assert.equal(output.code, 0, output.err);
  const messages = output.out.trim().split("\n").map(JSON.parse);
  assert.ok(messages.find(x => x.id === 1).result.tools.some(x => x.name === "figma_inspect_nodes"));
  const result = messages.find(x => x.id === 2).result;
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).nodes[0].children[0].characters, "实际文字");
});
