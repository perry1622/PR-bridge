$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "PR-bridge: shared service on http://127.0.0.1:38471"
node (Join-Path $root "start-shared.mjs")
exit $LASTEXITCODE
