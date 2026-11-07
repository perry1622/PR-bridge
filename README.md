# PR-bridge

<img src="assets/logo.png" alt="PR-bridge" width="112">

本机 Figma MCP 工具与连接控制台。多个 Agent 共用队列，一个 Figma 插件切换不同端口，表格展示端口、调用客户端、文件和任务。

**v2.2.0** 新增 Prototype 读写：交互连线、触发器、跳转与过渡、流程起点、滚动和原型背景。原有协议与端口配置兼容，不增加 npm 依赖。

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
| `figma_get_prototype` | 回读原型交互、流程起点、滚动、背景及覆盖层设置 |
| `figma_apply_prototype` | 在指定画框范围内设置原型交互、起点和滚动，可设置整页原型背景 |
| `figma_export_frame` | 导出 PNG 并返回 MCP 图片内容 |
| `figma_create_page` | 创建页面 |
| `figma_rename_node` | 重命名节点 |
| `figma_delete_node` | 删除节点 |
| `figma_apply_operations` | 按顺序执行一批编辑 |

明确填写 `pageId`、`parentId`、`nodeId`，避免其他 Agent 切换页面造成误写。同端口串行处理请求，但不会自动解决两个 Agent 对同一节点的内容冲突。普通 `figma_apply_operations` 批量操作出错不自动回滚之前已完成的编辑；原型接口的恢复行为见下文。

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

## Prototype 读写

先用 `figma_get_prototype` 读取已有画框及其子图层。返回原生 `reactions`，包含 `trigger`、`actions`、目标和过渡；页面节点还返回 `flowStartingPoints`、`prototypeBackgrounds` 和只读的 `prototypeStartNode`。节点不存在或读取被截断时会明确标记。`figma_inspect_nodes` 也可传入 `includePrototype: true`。

```json
{"nodeIds":["123:100","123:200"],"depth":8,"maxNodes":4000}
```

用 `figma_apply_prototype` 写入。`pageId` 与 `scopeFrameIds` 必填，源节点、NODE 动作的目标节点及流程起点都必须在范围内；可用 `expectedFileName` 核对连接文件。以下示例将按钮连接到第二个画框，并添加流程起点：

```json
{
  "pageId": "123:456",
  "scopeFrameIds": ["123:100", "123:200"],
  "operations": [
    {
      "op": "set_reactions",
      "nodeId": "123:101",
      "reactions": [{
        "trigger": {"type": "ON_CLICK"},
        "actions": [{
          "type": "NODE", "destinationId": "123:200", "navigation": "NAVIGATE",
          "transition": {"type": "DISSOLVE", "duration": 0.2, "easing": {"type": "EASE_OUT"}}
        }]
      }]
    },
    {"op": "set_flow_starting_points", "startingPoints": [{"nodeId": "123:100", "name": "手机交互演示"}]}
  ]
}
```

- `set_reactions` 使用 Figma 原生触发器、动作和过渡格式，例如导航、打开覆盖层、返回和关闭；`duration` 单位为秒。它替换该节点整组交互，先读取再编辑；`reactions: []` 清空该节点交互。
- `set_flow_starting_points` 替换声明范围内的起点，保留范围外的已有起点及默认顺序。传入 `makeDefault: true` 才将新起点排在最前；空数组移除范围内起点。
- `set_scroll` 接受 `nodeId`，以及 `overflowDirection`（`NONE/HORIZONTAL/VERTICAL/BOTH`）和/或 `scrollBehavior`（`SCROLLS/FIXED/STICKY`）。
- `set_prototype_background` 接受 `color: {r,g,b}`（0–1）及可选的 `opacity`。**此设置作用于整页原型**。

接口先检查全部目标与范围，再调用 Figma 原生 setter；原生格式错误会在写入时被 Figma 拒绝。返回值包含 `mutatedNodeIds`、回读的 `results` 和写入前的 `previous`，便于保存恢复依据。写入失败时尝试按相反顺序恢复已触及的属性，失败会明确报告 `rollback incomplete`。这不是 Figma 原子事务；超时、插件失联或恢复失败后仍须回读实际结果，不能盲目重试。

**边界：设备外框预设（例如 iPhone 18 Pro）不支持读写；覆盖层的位置、遮罩与点击遮罩行为可读取，不能通过此接口设置。** 打开覆盖层的交互动作本身可以读写。设置后应回读节点，并在 Figma 播放视图检查真实操作和设备显示。

### 从旧版升级

更新仓库后，控制台生成的插件副本也需更新：在控制台点击该端口的“配置”，或重新启动控制台生成副本。确认端口队列空闲，再关闭并重新运行 Figma 中的 PR-bridge，选择原端口。MCP 客户端重载后可发现新增工具；现有协议 2 服务能继续转发新命令，不必为了加载插件脚本重启桥接服务。

`POST /command` 的 `{"type":"status"}` 返回实际加载插件的 `pluginVersion` 和 `prototypeCapabilities`；服务 `/health` 中的版本只代表服务进程版本。未重新运行的旧插件不会因磁盘文件更新自动获得新能力。

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
node --test bridge.test.mjs console.test.mjs prototype.test.mjs
```

Prototype 测试覆盖读写与回读、删除交互、范围校验、保留已有流程、滚动/背景、原生写入失败恢复和 MCP 转发。模拟测试不代替真实 Figma 中的交互预览验收。

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
