param([string]$PhoneUrl = '', [switch]$Tunnel, [switch]$NoTunnel, [int]$Port = 8000)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$useTunnel = $Tunnel -or (-not $NoTunnel -and -not $PhoneUrl)
$pythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 or newer, then run the launcher again.' }
}
$venvHasPip = $false
& $pythonPath -m pip --version *> $null
if ($LASTEXITCODE -eq 0) { $venvHasPip = $true }
if ($venvHasPip) {
    & $pythonPath -m pip install -r requirements-web.txt
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard dependency installation failed.' }
} else {
    $systemPython = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $systemPython) { throw 'The project virtual environment has no pip and system Python was not found.' }
    & $systemPython -c 'import fastapi, uvicorn, dotenv, requests, multipart, qrcode, numpy, httpx, PIL' *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'The project virtual environment has no pip and system Python is missing SeekR dependencies. Repair pip in .venv or install requirements-web.txt, then retry.'
    }
    $pythonPath = $systemPython
    Write-Host 'Using system Python because .venv has no pip and the SeekR web dependencies are already installed.'
}
if ($useTunnel -and -not $NoTunnel -and -not $PhoneUrl) {
    $tunnelPath = Join-Path $PSScriptRoot 'cloudflared.exe'
    $signature = Get-AuthenticodeSignature -LiteralPath $tunnelPath
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Cloudflare') {
        throw 'The bundled phone tunnel signature could not be verified. Use -PhoneUrl with an existing HTTPS tunnel.'
    }
}
$launchArguments = @('-m', 'backend.launch', '--port', "$Port")
if ($PhoneUrl) { $launchArguments += @('--phone-url', $PhoneUrl) }
if ($useTunnel) { $launchArguments += '--tunnel' }
if ($NoTunnel) { $launchArguments += '--no-tunnel' }
Write-Host 'Starting SeekR. Keep this window open; press Ctrl+C to stop.'
& $pythonPath @launchArguments
