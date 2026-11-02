# Installation and connection

Use the repository root as the working directory. Windows PowerShell commands:

```powershell
python --version
python scripts/setup.py
python scripts/server.py
```

Keep the last terminal open. As an alternative, `.\scripts\start.ps1` starts the broker in a hidden window and checks its health. If PowerShell script execution is disabled, use the direct `python scripts/server.py` command. Do not restart an already connected shared broker without checking its users.

In Figma Desktop, open the target file and page. Import `plugin/manifest.json` via **Plugins > Development > Import plugin from manifest...**, then run **Figma Codex Local Bridge**. Import registers the plugin; running it creates the connection. Re-run after closing the plugin or changing pages.

Read `python scripts/client.py --status`. A healthy broker can report zero connected Figma clients; that means the Figma plugin still needs to run. If connection is absent, confirm the file and page are open and the plugin has not been closed. Do not infer Figma connection from a server process alone.

The setup script retains an existing token and regenerates the local `plugin/ui.html` from it. If the token is intentionally replaced, close the plugin, regenerate the UI, restart the broker, and re-import/re-run the plugin. Never put the token in a task JSON, screenshot, commit, or support message.

Default Chinese text nodes use Noto Sans SC. If that font is unavailable, install it or supply an installed font name in the job's `fontName` field and verify the export.
