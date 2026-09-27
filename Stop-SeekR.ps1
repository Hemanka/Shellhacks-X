$ErrorActionPreference = 'Stop'
$runtimePath = Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $runtimePath 'stop') -Force | Out-Null
Write-Host 'Requested shutdown of the SeekR server and phone tunnel.'
