# Codex Figma Desktop Bridge

A Codex skill and local Figma development plugin for inspecting and editing an open Figma Desktop file. A Python broker serializes jobs from multiple local Codex sessions; the plugin applies scoped changes through Figma's Plugin API.

## 中文快速开始

在另一台 Windows 电脑上，把仓库克隆到 `~/.codex/skills/figma-desktop-bridge`。运行 `python scripts/setup.py`，再运行 `python scripts/server.py`（保留终端）或 `.\scripts\start.ps1`。在 Figma 桌面版打开目标文件和页面，从 **Plugins > Development > Import plugin from manifest...** 导入 `plugin/manifest.json`，随后运行 **Figma Codex Local Bridge**。运行 `python scripts/client.py --status`，确认当前文件和页面对应的客户端显示 `connected: true`。之后直接让 Codex 使用 `$figma-desktop-bridge` 操作当前 Figma 文件。

每台电脑会生成自己的本地密钥；请勿把 `scripts/runtime.json`、`plugin/ui.html` 或 `scripts/jobs/` 上传到 GitHub。本仓库只负责同一台电脑上的本地连接，不跨电脑传输 Figma 会话。

## Install on Windows

1. Clone this repository into the Codex skills directory so `SKILL.md` is discoverable:

   ```powershell
   git clone https://github.com/perry1622/codex-figma-desktop-bridge.git "$env:USERPROFILE\.codex\skills\figma-desktop-bridge"
   cd "$env:USERPROFILE\.codex\skills\figma-desktop-bridge"
   ```

2. Confirm Python 3 and Figma Desktop are available. Log in to Figma with access to the target file. Install Noto Sans SC Regular and Bold if you want to use the default Chinese text style.
3. Run `python scripts/setup.py`. This creates a random local token in `scripts/runtime.json` and generates `plugin/ui.html`. Both are ignored by Git. Do not share them.
4. Run `python scripts/server.py` in a terminal that remains open, or run `.\scripts\start.ps1` to launch it in the background.
5. In Figma Desktop, open the target file and page. Use **Plugins > Development > Import plugin from manifest...** to import `plugin/manifest.json`, then run **Figma Codex Local Bridge** from the Development menu.
6. Run `python scripts/client.py --status`. Verify `connected: true` and note the current `fileName`, `pageId`, and `clientId`. The plugin must be started again if it is closed or the Figma page changes.

Give Codex the task and point it to this repository's [SKILL.md](SKILL.md). The skill is intended for a Codex session on the same computer as Figma Desktop. It is not a remote control service between two computers.

## Manual task example

Copy [examples/inspect.json](examples/inspect.json) to a local working file and replace its placeholders with the values from the current client and Figma target. Then run:

```powershell
python scripts/client.py .\inspect-task.json --output .\inspect-result.json
```

The examples also include a minimal editable frame, image export, and named version. See [job format](references/jobs.md) for ownership and result handling. `completed` plus an actual readback/export is the completion check for a write.

## Boundaries

The broker listens only on `127.0.0.1:38473` and requires a random per-install token for every request. Do not expose this port via a proxy or port forward. Figma must remain open and connected to the local broker. This bridge coordinates only jobs sent through it; normal editing and other plugins can still change the same nodes.

The package was adapted from a working local Figma Desktop workflow. On a new computer, setup and a read-only `inspect` should be verified before any write. See [installation](references/installation.md) for troubleshooting.

The local broker protocol can be checked without touching Figma: `python -m unittest discover -s tests -v`.
