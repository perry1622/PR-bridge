# PR-bridge

<img src="assets/logo.png" alt="PR-bridge" width="112">

本机 Figma MCP 工具与连接控制台。多个 Agent 共用队列，一个 Figma 插件切换不同端口，表格展示端口、调用客户端、文件和任务。

## 快速开始

需要 **Node.js 22+**、Figma Desktop。当前桥接与控制台不需要安装 npm 依赖。Windows 提供双击启动入口；其他系统可使用 Node 命令，尚未做真实桌面验收。

```sh
git clone https://github.com/perry1622/PR-bridge.git
cd PR-bridge
node start-console.mjs
```

打开 **http://127.0.0.1:38470/**。Windows 也可双击仓库内的 `打开控制台.cmd`。

1. 在端口表格点击“启动”，再点击“配置”。
2. 将配置窗口显示的统一 `manifest.json` 导入 Figma：Plugins → Development → Import plugin from manifest。
3. 在目标文件运行 **PR-bridge**，选择表格中的端口并连接。
4. 将同一行生成的 MCP 配置添加到 Agent 客户端，重新加载 MCP。
5. 先读取并核对目标文件、页面和节点，再执行编辑。

统一插件生成在 `<仓库目录>/console-data/plugins/PR-bridge/`。新增端口会更新这一个插件的列表与网络白名单，重新打开插件加载；必要时重新导入同一路径的 manifest。不要给不同文件同时使用同一端口。

| 端口 | 默认用途 |
| --- | --- |
| 38470 | 总控制台 |
| 38471 | 第一份文件的桥接服务 |
| 38472 | 第二份文件的桥接服务 |

多个 Agent 操作同一个文件时，共用该文件对应端口。不同文件使用不同端口。端口表默认只登记 38471 和 38472，不会自动启动全部服务。

## MCP 配置

控制台会生成当前机器的实际路径。也可参考 `claude-code.mcp.json`、`codex-mcp.toml.example`，将 `/absolute/path/to/PR-bridge/` 替换为克隆目录。

```json
{
  "mcpServers": {
    "PR-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/PR-bridge/mcp-server.mjs"],
      "env": { "FIGMA_BRIDGE_URL": "http://127.0.0.1:38471" }
    }
  }
}
```

`PR_BRIDGE_CLIENT_ID` 可为调用方设置名字。省略时 MCP 客户端会自动生成会话标识。

## 工具

| 工具 | 功能 |
| --- | --- |
| `figma_status` | 连接和队列状态 |
| `figma_list_pages` | 页面列表 |
| `figma_current_page` | 当前页面和选中节点 |
| `figma_find_nodes` | 按名称或类型查找节点 |
| `figma_inspect_nodes` | 回读文字、字体、颜色、布局及子节点 |
| `figma_export_frame` | 导出 PNG 并返回 MCP 图片内容 |
| `figma_create_page` | 创建页面 |
| `figma_rename_node` | 重命名节点 |
| `figma_delete_node` | 删除节点 |
| `figma_apply_operations` | 按顺序执行一批编辑 |

明确填写 `pageId`、`parentId`、`nodeId`，避免其他 Agent 切换页面造成误写。同端口串行处理请求，但不会自动解决两个 Agent 对同一节点的内容冲突。批量操作出错不自动回滚之前已完成的编辑。

```json
{"pageId":"123:456","operations":[{"op":"create_text","text":"标题","fontFamily":"Inter","fontStyle":"Regular"}]}
```

节点回读默认深度 4、总计 2000 个节点；支持深度 0–12、总节点数 1–10000，最多 20 个目标。留意 `missing`、`truncated` 及混合字体标记。

```json
{"nodeIds":["123:456"],"depth":4,"maxNodes":2000}
```

截图默认比例 1，最长边 2048，可提高到 4096；PNG 上限 8 MiB。导出成功后仍需查看画面，不能据此自动判定排版正确或云端已保存。

```json
{"nodeId":"123:456","scale":1,"maxDimension":2048}
```

## 连接与状态

- MCP 每 5 秒发送心跳；20 秒后显示过期，120 秒后移除失联会话。控制台也从队列和最近 60 条任务中识别 HTTP 调用方，区分正在使用和历史调用。
- 未发心跳的 HTTP 调用结束后，只能确认“最近调用”，无法知道 Agent 是否仍在线。请求应携带 `X-PR-Bridge-Client`；否则统一显示为未标识 HTTP 客户端。
- 插件每 5 秒读取文件与页面信息，网络取任务使用长轮询，空闲时约 25 秒返回一次。此版本仍有常驻开销。
- 控制台只停止自己启动且没有未完成任务的服务。控制台重启后，已有服务会变为只读监测；不会强制接管。
- 运行数据、生成的插件及日志保留在本机，不纳入发布包。

## 已知限制

**PNG 导出仍有实际文件中长时间不返回的情况，尚未定位根因。** 本地模拟测试通过不代表所有真实文件都能稳定导出。不要在前一次导出未确认结束时连续重试。

任务总期限为 120 秒，正常 MCP 客户端等待 130 秒。若调用方自行设为 30 秒，会提前断开，但 Figma 原生导出不因此取消。正在执行的任务失联或超时后保留执行锁，避免继续交错编辑；核对实际结果后再处理插件或服务。

本机 HTTP 接口不要求 Figma API Token；当前版本也没有逐请求身份验证。不要将端口暴露到公网或转发给不可信网络。本工具无法自动识别调用者所属聊天窗口，也不能保证 Agent 未传名称时仍可精确区分身份。

## 验证

```sh
node --test bridge.test.mjs console.test.mjs
```

浏览器测试是可选开发工具：需要 Python、Playwright 及其 Chromium；也可用 `PR_BROWSER_PATH` 指定本机浏览器可执行文件。

```sh
python -m pip install playwright
python -m playwright install chromium
python plugin-port-ui-test.py
```

`plugin-port-ui-test.py` 使用独立测试服务，不操作真实 Figma 文件。`console-ui-test.py`、`agent-status-ui-test.py` 默认针对已启动的控制台；前者会创建并清理一个测试端口，不应在多人同时改端口配置时运行。

## 仓库迁移

本仓库由 `codex-figma-desktop-bridge` 更名为 **PR-bridge**。原来的 Python broker 与 Codex Skill 原样保留在 [legacy/codex-figma-desktop-bridge](legacy/codex-figma-desktop-bridge/README.md)，协议与当前 Node MCP 不兼容，请勿混用。旧 Skill 的安装和运行说明只适用于该 legacy 子目录。

Windows 图标见 `assets/pr-bridge.ico`。源码包不包含任何已连接的 Figma 文件、个人页面截图、用户凭据或桌面快捷方式。
