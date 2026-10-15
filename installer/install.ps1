# SPDX-License-Identifier: GPL-3.0-or-later
param(
    [ValidateSet('', 'discord', 'vesktop')][string]$Client,
    [string]$Source
)
$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    throw 'Este instalador suporta Windows x64.'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$base = Join-Path $env:LOCALAPPDATA 'FockyTV\bootstrap'
$stage = Join-Path ([IO.Path]::GetTempPath()) ('fockytv-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
    $env:PATH = (Join-Path $base 'node') + ';' + $env:PATH
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $supported = $false
    if ($node -and $npm) {
        & $node.Source -e 'process.exit(parseInt(process.versions.node) >= 22 ? 0 : 1)'
        $supported = $LASTEXITCODE -eq 0
    }
    if (-not $supported) {
        Write-Host 'Baixando Node.js LTS para compilar o plugin (sem alterar o Node do sistema)...'
        $manifest = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt').Content
        $match = [regex]::Match($manifest, '(?m)^([a-fA-F0-9]{64})\s+(node-v[0-9.]+-win-x64.zip)\s*$')
        if (-not $match.Success) { throw 'Manifesto Node invalido.' }
        $archive = $match.Groups[2].Value
        $zip = Join-Path $stage $archive
        Invoke-WebRequest -UseBasicParsing ('https://nodejs.org/dist/latest-v24.x/' + $archive) -OutFile $zip
        if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $match.Groups[1].Value) { throw 'Checksum Node invalido.' }
        Expand-Archive -Path $zip -DestinationPath $stage
        New-Item -ItemType Directory -Path $base -Force | Out-Null
        $target = Join-Path $base 'node'
        if (Test-Path $target) { Remove-Item -Recurse -Force $target }
        Move-Item (Join-Path $stage $archive.Replace('.zip', '')) $target
        $node = Get-Command node.exe -ErrorAction Stop
    }
    $installer = Join-Path $stage 'install.mjs'
    Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/FelipeMayerDev/fockytv-vencord-plugin/main/installer/install.mjs' -OutFile $installer
    $options = @()
    if ($Client) { $options += @('--client', $Client) }
    if ($Source) { $options += @('--source', $Source) }
    & $node.Source $installer @options
    if ($LASTEXITCODE -ne 0) { throw "Instalacao falhou (codigo $LASTEXITCODE)." }
} finally {
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}
