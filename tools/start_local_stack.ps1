# Starts the authenticated Ollama relay and a Cloudflare Quick Tunnel in front of it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\start_local_stack.ps1
#
# Ollama must already be running on 127.0.0.1:11434 (do NOT set OLLAMA_HOST=0.0.0.0 or OLLAMA_ORIGINS=*).
# The token lives in .env.relay at the repo root (gitignored); it is created on first run.
# The script prints the tunnel URL; give it and the token to whoever sets the Railway variables
# CQA_LOCAL_RELAY_URL / CQA_LOCAL_RELAY_TOKEN, over a private channel, never through Git.
# Ctrl+C stops the tunnel and the relay.
param(
    [int]$Port = 11435,
    [switch]$NewToken
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env.relay'
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { $python = (Get-Command python).Source }
$relay = Join-Path $PSScriptRoot 'ollama_relay.py'

$cloudflared = $null
$cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cmd) { $cloudflared = $cmd.Source }
foreach ($p in @("C:\cloudflared\cloudflared.exe", "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe")) {
    if (-not $cloudflared -and (Test-Path $p)) { $cloudflared = $p }
}
if (-not $cloudflared) { throw 'cloudflared not found. Install: winget install --id Cloudflare.cloudflared' }

try { Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5 | Out-Null }
catch { throw 'Ollama is not answering on 127.0.0.1:11434. Start Ollama first.' }

if ($NewToken -or -not (Test-Path $envFile)) {
    $token = (& $python $relay --gen-token).Trim()
    Set-Content -Path $envFile -Value "CQA_RELAY_TOKEN=$token" -Encoding ascii
    Write-Host "New relay token written to .env.relay. Set the same value as CQA_LOCAL_RELAY_TOKEN on Railway." -ForegroundColor Yellow
}

$relayProc = Start-Process -FilePath $python -ArgumentList @("`"$relay`"", '--port', $Port) -PassThru -NoNewWindow
Start-Sleep -Seconds 1
if ($relayProc.HasExited) { throw 'Relay failed to start (see message above).' }
Write-Host "Relay running on http://127.0.0.1:$Port (pid $($relayProc.Id)). Starting tunnel..." -ForegroundColor Green
Write-Host 'Look for https://<words>.trycloudflare.com below. It changes on every restart.' -ForegroundColor Green
try {
    & $cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$Port"
}
finally {
    if (-not $relayProc.HasExited) { Stop-Process -Id $relayProc.Id -Force }
    Write-Host 'Relay stopped.'
}
