param([string]$PhoneUrl = '', [switch]$Tunnel, [switch]$NoTunnel, [int]$Port = 8000)
$legacyArgs = @{}
if ($PhoneUrl) { $legacyArgs.PhoneUrl = $PhoneUrl }
if ($Tunnel) { $legacyArgs.Tunnel = $true }
if ($NoTunnel) { $legacyArgs.NoTunnel = $true }
if ($Port -ne 8000) { $legacyArgs.Port = $Port }
& (Join-Path $PSScriptRoot 'Start-SeekR.ps1') @legacyArgs
exit $LASTEXITCODE
