$ErrorActionPreference = "Stop"
$bridgeUrl = if ($env:FIGMA_BRIDGE_URL) { $env:FIGMA_BRIDGE_URL } else { "http://127.0.0.1:38471" }
$health = Invoke-RestMethod -Uri "$bridgeUrl/health" -TimeoutSec 5
$health | ConvertTo-Json -Depth 5
if (-not $health.ok -or $health.service -ne 'PR-bridge' -or $health.protocol -ne 2) { throw "The endpoint is not PR-bridge 2.0" }
if (-not $health.pluginConnected) { Write-Warning "Open PR-bridge in the target Figma file." }
