$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$python = Get-Command python -ErrorAction Stop
& $python.Source (Join-Path $scriptDir 'setup.py')
if ($LASTEXITCODE -ne 0) { throw 'Bridge setup failed.' }

try {
    & $python.Source (Join-Path $scriptDir 'client.py') --status
    if ($LASTEXITCODE -eq 0) { exit 0 }
} catch { }

$portUsed = $false
$socket = [Net.Sockets.TcpClient]::new()
try {
    $socket.Connect('127.0.0.1', 38473)
    $portUsed = $true
} catch [Net.Sockets.SocketException] {
} finally {
    $socket.Dispose()
}
if ($portUsed) { throw 'Port 38473 is in use by a different or incompatible local service.' }

$broker = Start-Process -FilePath $python.Source -ArgumentList 'server.py' -WorkingDirectory $scriptDir -WindowStyle Hidden -PassThru
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 300
    if ($broker.HasExited) { throw 'Bridge server exited during startup.' }
    try {
        & $python.Source (Join-Path $scriptDir 'client.py') --status
        if ($LASTEXITCODE -eq 0) { exit 0 }
    } catch { }
}
throw 'Bridge server did not become ready.'
