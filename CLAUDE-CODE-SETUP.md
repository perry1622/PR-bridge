# Claude Code 接入 PR-bridge

1. 在控制台启动所需端口，点击该行“配置”。
2. 将生成的 MCP 配置合并到 Claude Code 设置，重载 MCP。
3. 导入配置窗口中的统一 Figma 插件，在目标文件选择相同端口。
4. 调用 figma_status 确认插件在线，再核对页面和目标节点。

仓库中的 claude-code.mcp.json 是模板，需替换成克隆目录的绝对路径。需要 Node.js 22+，核心工具无需安装 npm 依赖。
