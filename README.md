# PR-bridge

<img src="assets/logo.png" alt="PR-bridge" width="112">

本机 Figma MCP 工具与连接控制台。多个 Agent 共用队列，一个 Figma 插件切换不同端口，表格展示端口、调用客户端、文件和任务。

**v2.2.1** 在 Prototype 读写基础上增加目标视口校验、底栏适配和原生固定子层设置，并修复长轮询交接期间短暂误报“未连接”的问题。兼容协议 2 和现有端口配置，不增加 npm 依赖。

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
| `figma_get_prototype` | 回读原型交互、滚动、固定子层及视口裁切风险 |
| `figma_apply_prototype` | 在指定范围内设置原型交互、流程、滚动、视口适配及整页背景 |
| `figma_export_frame` | 导出 PNG 并返回 MCP 图片内容 |
| `figma_create_page` | 创建页面 |
| `figma_rename_node` | 重命名节点 |
| `figma_delete_node` | 删除节点 |
| `figma_apply_operations` | 按顺序执行一批编辑 |

明确填写 `pageId`、`parentId`、`nodeId`，避免其他 Agent 切换页面造成误写。同端口串行处理请求，但不会自动解决两个 Agent 对同一节点的内容冲突。普通 `figma_apply_operations` 批量操作出错不自动回滚之前已完成的编辑；原型接口的恢复行为见下文。

```json
{"pageId":"123:456","operations":[{"op":"create_text","text":"标题","fontFamily":"Inter","fontStyle":"Regular"}]}
```

`create_vector` 创建可继续用钢笔工具编辑的原生矢量，默认无描边，支持闭合贝塞尔路径、线性渐变和原生投影。`parentId` 必填；`paths` 使用 SVG 路径数据和 `NONZERO/EVENODD/NONE` 填充规则。`status.vectorCapabilities` 可确认运行中的插件是否已加载此能力；更新脚本后须重新打开插件，无需重启端口服务。

```json
{"pageId":"123:456","operations":[{"op":"create_vector","parentId":"123:100","name":"蓝色曲面","paths":[{"windingRule":"NONZERO","data":"M 0 0 C 0 100 150 240 300 300 L 800 300 L 800 0 Z"}],"fill":"#3276A3","shadow":{"color":"#203443","opacity":0.32,"x":-10,"y":2,"radius":25}}]}
```

投影与路径可通过 `figma_inspect_nodes` 回读。创建时若原生路径校验失败，该次刚创建的矢量会被清理；整批操作仍不是事务，须检查已有结果。

`clone_text` 从指定原文字节点原生复制，再修改内容，保留字体、字号、行高、填充、字距和文本框设置。声明 `sourceNodeId` 和 `parentId`；`mirrorFromSource:true` 根据目标父框宽度镜像位置并切换左右对齐，保持字形正向。源字体不可用时会在复制前停止。`status.textCapabilities.clone` 用于确认运行中的插件已加载该接口。

```json
{"pageId":"123:456","operations":[{"op":"clone_text","sourceNodeId":"123:101","parentId":"123:200","characters":"产品PPT","mirrorFromSource":true}]}
```

`clone_frame` 原生复制已有页面级画框，保留图片裁切、旋转、文字字体和矢量效果。必须指定 `sourceNodeId`、源页面 `sourceParentId` 与目标页面 `parentId`；可用 `expectedSourceWidth/expectedSourceHeight` 防止按过期尺寸复制。返回完整 `createdNodeIds` 和源节点到复制节点的 `nodeMap`，便于只调整新副本。传入 `width/height` 时使用 `resizeWithoutConstraints`，子图层保持原始尺寸，后续按布局需要调整。`status.cloneCapabilities.pageFrames` 可确认已加载此接口。

```json
{"pageId":"123:456","operations":[{"op":"clone_frame","sourceNodeId":"123:100","sourceParentId":"123:456","parentId":"123:456","expectedSourceWidth":1800,"expectedSourceHeight":300,"width":1600,"height":400,"x":1800,"y":43600,"name":"横幅 01｜1600×400"}]}
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
- `set_scroll` 接受 `nodeId` 和 `overflowDirection`（`NONE/HORIZONTAL/VERTICAL/BOTH`）。
- `set_fixed_children` 接受容器的 `nodeId` 与 `count`，使用 Figma 原生 `numberOfFixedChildren`：最后 N 个直接子层固定，图层顺序不变。请先检查子层顺序。`scrollBehavior` 仅兼容实际具有该原生属性的环境；标准 Figma API 应使用此固定子层接口，不支持用它设置 sticky。
- `set_prototype_background` 接受 `color: {r,g,b}`（0–1）及可选的 `opacity`。**此设置作用于整页原型**。

接口先检查全部目标与范围，再调用 Figma 原生 setter；原生格式错误会在写入时被 Figma 拒绝。返回值包含 `mutatedNodeIds`、回读的 `results` 和写入前的 `previous`，便于保存恢复依据。写入失败时尝试按相反顺序恢复已触及的属性，失败会明确报告 `rollback incomplete`。这不是 Figma 原子事务；超时、插件失联或恢复失败后仍须回读实际结果，不能盲目重试。

**边界：设备外框预设（例如 iPhone 18 Pro）不支持读写；覆盖层的位置、遮罩与点击遮罩行为可读取，不能通过此接口设置。** 打开覆盖层的交互动作本身可以读写。设置后应回读节点，并在 Figma 播放视图检查真实操作和设备显示。

### 手机视口与底栏

连线写入成功和画框 PNG 完整，不能证明放进手机设备预设后仍完整。画框比例与设备视口不同时，底部导航可能被裁掉。例如 1236×2874 的画框按宽度映射到 402×874 视口时，底部约有 60.75 个视口像素位于屏幕之外。

制作手机原型时，在 `figma_get_prototype` 中同时传入目标视口尺寸：

```json
{"nodeIds":["123:100"],"depth":6,"viewportWidth":402,"viewportHeight":874}
```

`viewportAudit` 返回比例是否匹配、保持当前宽度时应有的画框高度及溢出的视口像素。没有提供尺寸时，`viewportCheck` 明确为 `not_requested`；脚本不会从设备名称猜尺寸。`figma_apply_prototype` 也可传入这两个字段，比例不匹配时会在写入前拒绝该批操作。

使用 `fit_viewport` 适配已检查的画框：

```json
{
  "pageId":"123:456", "scopeFrameIds":["123:100"],
  "viewportWidth":402, "viewportHeight":874,
  "operations":[{
    "op":"fit_viewport", "nodeId":"123:100",
    "viewportWidth":402, "viewportHeight":874,
    "scrollContainerIds":["123:110"],
    "bottomNodeIds":["123:120","123:121","123:122"]
  }]
}
```

适配保持画框宽度、文字字号和正文内容，调整画框高度，缩放与原画框重合的全屏容器高度，缩短声明的滚动区，并平移声明的底栏或底部弹层。`bottomNodeIds` 应包含底栏文字、图标及背景的全部独立层；若底栏已经在容器中，只声明该容器。底层图层自动识别可用 `viewportNodeIds` 显式限定。仅支持无自动布局的画框，滚动区和底部层须直接位于全屏容器中；不符合结构时会拒绝修改。

默认还会为声明的底部层设置底部约束，为全屏容器和滚动区设置拉伸约束；`constrainAnchors:false` 可仅调整本次几何。尺寸调整使用原生 `resizeWithoutConstraints` 保持正文子层，重复适配同一尺寸不会累计偏移。适配后仍需在真实设备预设中检查显示和滚动，不能用普通画框导出代替设备视口检查。

### 从旧版升级

更新仓库后，控制台生成的插件副本也需更新：在控制台点击该端口的“配置”，或重新启动控制台生成副本。确认端口队列空闲，再关闭并重新运行 Figma 中的 PR-bridge，选择原端口。MCP 客户端重载后可发现新增工具；现有协议 2 服务能继续转发新命令，不必为了加载插件脚本重启桥接服务。

`POST /command` 的 `{"type":"status"}` 返回实际加载插件的 `pluginVersion` 和 `prototypeCapabilities`；服务 `/health` 中的版本只代表服务进程版本。未重新运行的旧插件不会因磁盘文件更新自动获得新能力。

v2.2.1 的连接交接修复还需要在各会话空闲时重启对应端口的桥接服务。它在轮询返回、有效上下文上报和任务结果交接时刷新连接活动时间，避免下一次轮询尚未建立时误报离线；未确认结果的写入仍保留执行锁。

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
node --test bridge.test.mjs console.test.mjs prototype.test.mjs viewport.test.mjs
```

42 项测试覆盖读写与回读、范围校验、保留已有流程、写入失败恢复、MCP 转发、视口裁切、底栏适配、原生固定子层，以及空闲轮询和长任务交接。模拟测试不代替真实 Figma 中的交互预览验收。

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
