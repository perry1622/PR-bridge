import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { ensureBridge } from "./ensure-bridge.mjs";
import { exportImageContent } from "./export-image.mjs";

const bridgeUrl = process.env.FIGMA_BRIDGE_URL || "http://127.0.0.1:38471";
const clientId = process.env.PR_BRIDGE_CLIENT_ID || `agent-${process.pid}-${randomUUID()}`;
let starting;
let agentName = process.env.PR_BRIDGE_CLIENT_ID || "MCP Agent";
let heartbeatTimer;
async function heartbeat() {
  try { await fetch(bridgeUrl + "/agents/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, name: agentName, pid: process.pid }), signal: AbortSignal.timeout(2000) }); } catch {}
}
async function ready() {
  if (!starting) starting = ensureBridge(bridgeUrl).finally(() => { starting = null; });
  await starting;
  await heartbeat();
  if (!heartbeatTimer) { heartbeatTimer = setInterval(heartbeat, 5000); heartbeatTimer.unref(); }
}

const toolDefinitions = [
  {
    name: "figma_inspect_nodes",
    description: "按节点 ID 回读文字、字体、颜色、位置、尺寸、自动布局和子图层。适合编辑后核对属性，并配合 figma_export_frame 查看实际排版。返回 missing/truncated 标记，不能将截断结果视为完整检查。",
    inputSchema: {
      type: "object",
      properties: {
        nodeIds: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1 }, description: "需要读取的节点 ID，最多 20 个" },
        depth: { type: "integer", minimum: 0, maximum: 12, default: 4, description: "子图层读取深度，0 只读目标本身" },
        maxNodes: { type: "integer", minimum: 1, maximum: 10000, default: 2000, description: "本次读取的节点总数上限" },
      },
      required: ["nodeIds"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_export_frame",
    description: "将指定画框导出为 PNG，直接返回可查看的图片，用于写入后的视觉回读与排版检查。不会切换页面或修改图层。返回实际像素尺寸和缩放比例；截图只代表导出时刻，不能代替完整节点属性检查。",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", minLength: 1, description: "目标画框、组件或实例的节点 ID" },
        scale: { type: "number", minimum: 0.1, maximum: 4, default: 1, description: "期望缩放比例；超出最长边限制时自动缩小" },
        maxDimension: { type: "integer", minimum: 256, maximum: 4096, default: 2048, description: "导出最长边像素上限，默认 2048；细节检查可提高至 4096" },
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_status",
    description: "检查本机 Figma Desktop 开发插件是否已连接。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_list_pages",
    description: "列出当前 Figma 文件中的页面。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_current_page",
    description: "读取当前页面和当前选中图层。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_find_nodes",
    description: "按名称关键字或节点类型查找 Figma 图层。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "名称包含的关键字，可为空" },
        type: { type: "string", description: "节点类型，例如 FRAME、TEXT、RECTANGLE" },
        pageId: { type: "string", description: "可选页面 ID" },
        maxResults: { type: "number", description: "最多返回数量，默认 100" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_create_page",
    description: "在当前 Figma 文件中创建页面并切换过去。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_rename_node",
    description: "按节点 ID 重命名图层。",
    inputSchema: {
      type: "object",
      properties: { nodeId: { type: "string" }, name: { type: "string" } },
      required: ["nodeId", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_delete_node",
    description: "按节点 ID 删除图层。",
    inputSchema: {
      type: "object",
      properties: { nodeId: { type: "string" } },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_apply_operations",
    description: "按队列串行执行一批 Figma 编辑。多个 Agent 应明确指定 pageId / parentId / nodeId，避免依赖其他 Agent 会改变的当前页面。支持 create_page、create_frame、create_rectangle、create_text、set、delete_node、clear_page。",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "本批次默认目标页面，多 Agent 时建议填写" },
        operations: {
          type: "array",
          items: { type: "object" },
          description: "按顺序执行的操作数组",
        },
      },
      required: ["operations"],
      additionalProperties: false,
    },
  },
];

async function callBridge(command) {
  const response = await fetch(bridgeUrl + "/command", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pr-bridge-client": clientId },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(130000),
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || "Bridge HTTP " + response.status);
  }
  return body.result;
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function errorReply(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.method === "notifications/initialized") return;

  if (message.method === "initialize") {
    agentName = process.env.PR_BRIDGE_CLIENT_ID || String(message.params?.clientInfo?.name || "MCP Agent");
    ready().catch(error => process.stderr.write("PR-bridge: " + error.message + "\n"));
    return reply(message.id, {
      protocolVersion: message.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "PR-bridge", version: "2.1.0" },
    });
  }

  if (message.method === "ping") return reply(message.id, {});
  if (message.method === "tools/list") return reply(message.id, { tools: toolDefinitions });

  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    try {
      await ready();
      let result;
      if (name === "figma_inspect_nodes") {
        result = await callBridge({ type: "inspect_nodes", nodeIds: args.nodeIds, depth: args.depth, maxNodes: args.maxNodes });
      } else if (name === "figma_export_frame") {
        result = await callBridge({ type: "export_frame", nodeId: args.nodeId, scale: args.scale, maxDimension: args.maxDimension });
        return reply(message.id, { content: exportImageContent(result) });
      } else if (name === "figma_status") {
        result = await fetch(bridgeUrl + "/health", { signal: AbortSignal.timeout(3000) }).then((response) => response.json());
        result.clientId = clientId;
      } else if (name === "figma_list_pages") {
        result = await callBridge({ type: "list_pages" });
      } else if (name === "figma_current_page") {
        result = await callBridge({ type: "current_page" });
      } else if (name === "figma_find_nodes") {
        result = await callBridge({
          type: "find_nodes",
          query: args.query,
          nodeType: args.type,
          pageId: args.pageId,
          maxResults: args.maxResults,
        });
      } else if (name === "figma_create_page") {
        result = await callBridge({ type: "create_page", ...args });
      } else if (name === "figma_rename_node") {
        result = await callBridge({ type: "rename_node", ...args });
      } else if (name === "figma_delete_node") {
        result = await callBridge({ type: "delete_node", ...args });
      } else if (name === "figma_apply_operations") {
        result = await callBridge({ type: "apply_operations", ...args });
      } else {
        throw new Error("Unknown tool: " + name);
      }

      return reply(message.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (error) {
      return reply(message.id, {
        isError: true,
        content: [{ type: "text", text: error.message }],
      });
    }
  }

  if (message.id !== undefined) errorReply(message.id, -32601, "Method not found: " + message.method);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("close", () => {
  clearInterval(heartbeatTimer);
  fetch(bridgeUrl + "/agents/disconnect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }), signal: AbortSignal.timeout(1000) }).catch(() => {});
});
input.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    Promise.resolve(handle(message)).catch((error) => {
      if (message.id !== undefined) errorReply(message.id, -32000, error.message);
    });
  } catch (error) {
    process.stderr.write("Invalid MCP message: " + error.message + "\n");
  }
});
