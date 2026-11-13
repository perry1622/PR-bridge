# Claude Code 接入 PR-bridge

1. 将 `claude-code.mcp.json` 中的 `PR-bridge` 配置合并到 Claude Code 的 MCP 配置；若已有指向本目录的旧名称条目，将其替换，避免重复注册。
2. 在 Figma Desktop 导入 `figma-plugin/manifest.json`，运行 **PR-bridge**。
3. 重载 MCP，调用 `figma_status`。第一次工具调用自动启动共享后台服务，随后多个 Agent 共用它。
4. 确认 `pluginConnected: true` 后操作。协作时使用明确的 `pageId`、`parentId` 和 `nodeId`。

需要 Node.js 22 或更新版本，无需安装 npm 依赖。详细协作范围和故障处理见 README.md。
