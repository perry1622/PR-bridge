import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const plain = value => JSON.parse(JSON.stringify(value));
const navigation = destinationId => [{
  trigger: { type: "ON_CLICK" },
  actions: [{ type: "NODE", destinationId, navigation: "NAVIGATE", transition: { type: "DISSOLVE", easing: { type: "EASE_OUT" }, duration: 0.2 } }],
}];

async function plugin() {
  const replies = [], calls = [];
  const document = { id: "doc", name: "Prototype fixture", type: "DOCUMENT", children: [] };
  const page = { id: "page", name: "Screens", type: "PAGE", parent: document, children: [], loadAsync: async () => {},
    flowStartingPoints: [{ nodeId: "outside", name: "Existing flow" }, { nodeId: "nested", name: "Old scoped flow" }],
    prototypeBackgrounds: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], prototypeStartNode: null,
  };
  document.children.push(page);
  const nodes = new Map([[document.id, document], [page.id, page]]);
  function node(id, parent, type = "FRAME") {
    const result = { id, name: id, type, parent, visible: true, children: [], overflowDirection: "NONE", scrollBehavior: "SCROLLS", reactions: [],
      overlayPositionType: "CENTER", overlayBackground: { type: "NONE" }, overlayBackgroundInteraction: "NONE",
      async setReactionsAsync(value) {
        // Model asynchronous native validation: a bad transition fails only at write time.
        await Promise.resolve();
        calls.push(id);
        if (value.some(reaction => reaction.actions?.some(action => action.transition?.duration < 0))) throw new Error("Native transition rejected");
        this.reactions = plain(value);
      },
    };
    parent.children.push(result);
    nodes.set(id, result);
    return result;
  }
  const first = node("first", page), second = node("second", page), outside = node("outside", page);
  const nested = node("nested", first), button = node("button", first, "RECTANGLE");
  button.reactions = [{ trigger: { type: "ON_HOVER" }, actions: [{ type: "BACK" }] }];
  const figma = { root: document, fileKey: "fixture", showUI() {}, ui: { postMessage: message => replies.push(plain(message)) },
    currentPage: { id: "wrong-page", name: "Other page", type: "PAGE", selection: [] },
    getNodeByIdAsync: async id => nodes.get(id) || null,
  };
  vm.runInNewContext(await readFile(new URL("./figma-plugin/code.js", import.meta.url), "utf8"), { figma, __html__: "" });
  async function run(command, deadlineAt) {
    await figma.ui.onmessage({ type: "bridge-command", id: "test", command, deadlineAt });
    return replies.at(-1);
  }
  const apply = operations => run({ type: "apply_prototype", pageId: "page", scopeFrameIds: ["first", "second"], expectedFileName: document.name, operations });
  return { run, apply, calls, document, page, first, second, outside, nested, button };
}

test("prototype read includes native interactions, flows, scrolling and explicit device limitations", async () => {
  const f = await plugin();
  const response = await f.run({ type: "get_prototype", nodeIds: ["page", "missing"], depth: 4, maxNodes: 100 });
  assert.equal(response.ok, true);
  assert.equal(response.result.prototypeCapabilities.reactions, true);
  assert.equal(response.result.prototypeCapabilities.devicePresets, false);
  assert.equal(response.result.prototypeCapabilities.overlaySettingsWrite, false);
  assert.equal(response.result.truncated, false);
  assert.deepEqual(response.result.nodes[0].flowStartingPoints, f.page.flowStartingPoints);
  assert.deepEqual(response.result.nodes[0].children[0].children[1].reactions, f.button.reactions);
  assert.equal(response.result.nodes[0].children[0].overlayPositionType, "CENTER");
  assert.equal(response.result.nodes[1].missing, true);
  const limited = await f.run({ type: "get_prototype", nodeIds: ["page"], depth: 0 });
  assert.equal(limited.result.truncated, true);
  const legacy = await f.run({ type: "inspect_nodes", nodeIds: ["button"], depth: 0 });
  assert.equal("reactions" in legacy.result.nodes[0], false);
  const optional = await f.run({ type: "inspect_nodes", nodeIds: ["button"], includePrototype: true });
  assert.deepEqual(optional.result.nodes[0].reactions, f.button.reactions);
});

test("prototype writes await native reactions, return before values and can remove interactions", async () => {
  const f = await plugin();
  const before = plain(f.button.reactions);
  const result = await f.apply([{ op: "set_reactions", nodeId: "button", reactions: navigation("second") }]);
  assert.equal(result.ok, true);
  assert.deepEqual(f.button.reactions, navigation("second"));
  assert.deepEqual(result.result.mutatedNodeIds, ["button"]);
  assert.deepEqual(result.result.previous[0], { nodeId: "button", property: "reactions", value: before });
  const read = await f.run({ type: "get_prototype", nodeIds: ["button"], depth: 0 });
  assert.deepEqual(read.result.nodes[0].reactions, navigation("second"));
  assert.equal((await f.apply([{ op: "set_reactions", nodeId: "button", reactions: [] }])).ok, true);
  assert.deepEqual(f.button.reactions, []);
});

test("prototype preflight rejects out-of-scope sources, destinations and nested actions without writes", async () => {
  const f = await plugin();
  for (const operation of [
    { op: "set_reactions", nodeId: "outside", reactions: [] },
    { op: "set_reactions", nodeId: "button", reactions: navigation("outside") },
    { op: "set_reactions", nodeId: "button", reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "CONDITIONAL", conditionalBlocks: [{ actions: navigation("outside")[0].actions }] }] }] },
    { op: "set_device", preset: "iPhone" },
  ]) {
    const result = await f.apply([{ op: "set_reactions", nodeId: "button", reactions: navigation("second") }, operation]);
    assert.equal(result.ok, false);
    assert.equal(f.calls.length, 0);
  }
  assert.equal((await f.run({ type: "apply_prototype", pageId: "page", scopeFrameIds: ["first"], expectedFileName: "Wrong file", operations: [{ op: "set_reactions", nodeId: "button", reactions: [] }] })).ok, false);
  assert.equal(f.calls.length, 0);
});

test("flow updates preserve unrelated flows and replace nested scoped flows; default is explicit", async () => {
  const f = await plugin();
  const point = { nodeId: "first", name: "Mobile demo" };
  assert.equal((await f.apply([{ op: "set_flow_starting_points", startingPoints: [point] }])).ok, true);
  assert.deepEqual(plain(f.page.flowStartingPoints), [{ nodeId: "outside", name: "Existing flow" }, point]);
  assert.equal((await f.apply([{ op: "set_flow_starting_points", startingPoints: [point], makeDefault: true }])).ok, true);
  assert.deepEqual(plain(f.page.flowStartingPoints), [point, { nodeId: "outside", name: "Existing flow" }]);
  const duplicate = await f.apply([{ op: "set_flow_starting_points", startingPoints: [point, point] }]);
  assert.equal(duplicate.ok, false);
  assert.equal((await f.apply([{ op: "set_flow_starting_points", startingPoints: [] }])).ok, true);
  assert.deepEqual(plain(f.page.flowStartingPoints), [{ nodeId: "outside", name: "Existing flow" }]);
});

test("scroll and page background read back; invalid settings leave the file unchanged", async () => {
  const f = await plugin();
  const result = await f.apply([
    { op: "set_scroll", nodeId: "first", overflowDirection: "VERTICAL" },
    { op: "set_scroll", nodeId: "button", scrollBehavior: "FIXED" },
    { op: "set_prototype_background", color: { r: 0.1, g: 0.2, b: 0.3 }, opacity: 0.5 },
  ]);
  assert.equal(result.ok, true);
  assert.equal(f.first.overflowDirection, "VERTICAL");
  assert.equal(f.button.scrollBehavior, "FIXED");
  const read = await f.run({ type: "get_prototype", nodeIds: ["page"], depth: 3 });
  assert.deepEqual(read.result.nodes[0].prototypeBackgrounds, [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 }, opacity: 0.5 }]);
  for (const bad of [{ op: "set_scroll", nodeId: "first", overflowDirection: "WRONG" }, { op: "set_prototype_background", color: { r: 255, g: 0, b: 0 } }]) {
    assert.equal((await f.apply([bad])).ok, false);
  }
  assert.equal(f.first.overflowDirection, "VERTICAL");
});

test("native write failure restores preceding interactions and page settings", async () => {
  const f = await plugin();
  const before = { reactions: plain(f.button.reactions), flows: plain(f.page.flowStartingPoints), background: plain(f.page.prototypeBackgrounds) };
  const invalid = navigation("first");
  invalid[0].actions[0].transition.duration = -1;
  const result = await f.apply([
    { op: "set_reactions", nodeId: "button", reactions: navigation("second") },
    { op: "set_flow_starting_points", startingPoints: [{ nodeId: "first", name: "Temporary" }] },
    { op: "set_prototype_background", color: { r: 0, g: 0, b: 0 } },
    { op: "set_reactions", nodeId: "second", reactions: invalid },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /Native transition rejected; earlier changes restored/);
  assert.deepEqual(f.button.reactions, before.reactions);
  assert.deepEqual(plain(f.page.flowStartingPoints), before.flows);
  assert.deepEqual(plain(f.page.prototypeBackgrounds), before.background);
});

test("expired prototype requests do not mutate the file", async () => {
  const f = await plugin();
  const result = await f.run({ type: "apply_prototype", pageId: "page", scopeFrameIds: ["first"], operations: [{ op: "set_reactions", nodeId: "button", reactions: [] }] }, Date.now() - 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /deadline exceeded/);
  assert.deepEqual(f.calls, []);
});

test("MCP exposes and forwards prototype tools through the bridge", { timeout: 10000 }, async t => {
  const f = await plugin();
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    let response = { ok: true };
    if (req.url === "/health") response = { ok: true, service: "PR-bridge", protocol: 2 };
    if (req.url === "/command") response = await f.run(JSON.parse(Buffer.concat(parts).toString()));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))], {
    env: { ...process.env, FIGMA_BRIDGE_URL: `http://127.0.0.1:${server.address().port}` },
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { child.kill(); server.closeAllConnections(); server.close(); });
  let sequence = 0;
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });
  function call(method, params) {
    const id = ++sequence;
    return new Promise(resolve => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  const initialized = await call("initialize", {});
  assert.equal(initialized.serverInfo.version, "2.2.0");
  const listed = await call("tools/list", {});
  assert.ok(listed.tools.some(tool => tool.name === "figma_get_prototype"));
  assert.ok(listed.tools.some(tool => tool.name === "figma_apply_prototype"));
  const read = await call("tools/call", { name: "figma_get_prototype", arguments: { nodeIds: ["button"], depth: 0 } });
  assert.equal(JSON.parse(read.content[0].text).nodes[0].reactions.length, 1);
  const write = await call("tools/call", { name: "figma_apply_prototype", arguments: { pageId: "page", scopeFrameIds: ["first", "second"], operations: [{ op: "set_reactions", nodeId: "button", reactions: navigation("second") }] } });
  assert.equal(write.isError, undefined);
  assert.deepEqual(JSON.parse(write.content[0].text).mutatedNodeIds, ["button"]);
  assert.deepEqual(f.button.reactions, navigation("second"));
});
