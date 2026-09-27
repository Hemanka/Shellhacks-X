param([string]$PhoneUrl = '', [switch]$Tunnel, [switch]$NoTunnel, [int]$Port = 8000)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$useTunnel = $Tunnel -or (-not $NoTunnel -and -not $PhoneUrl)
$pythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 or newer, then run the launcher again.' }
}
& $pythonPath -m pip install -r requirements-web.txt
if ($LASTEXITCODE -ne 0) { throw 'Dashboard dependency installation failed.' }
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
