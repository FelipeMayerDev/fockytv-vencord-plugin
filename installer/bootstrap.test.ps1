# SPDX-License-Identifier: GPL-3.0-or-later
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('fockytv-bootstrap-test-' + [Guid]::NewGuid())
$bin = Join-Path $root 'bin'
$originalPath = $env:PATH
$originalLocal = $env:LOCALAPPDATA
New-Item -ItemType Directory $bin -Force | Out-Null
try {
    Add-Type -TypeDefinition 'public class OldNodeFixture { public static int Main(string[] args) { return 1; } }' -OutputAssembly (Join-Path $bin 'node.exe') -OutputType ConsoleApplication
    [IO.File]::WriteAllText((Join-Path $bin 'npm.cmd'), '@exit /b 0')
    $env:PATH = $bin + ';' + $env:PATH
    $env:LOCALAPPDATA = $root
    function Invoke-WebRequest {
        param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
        if ($Uri.EndsWith('SHASUMS256.txt')) {
            return [PSCustomObject]@{ Content = ('0' * 64) + "  node-v24.0.0-win-x64.zip`n" }
        }
        [IO.File]::WriteAllText($OutFile, 'tampered archive')
    }
    $Client = ''
    $rejected = $false
    try { Get-Content -Raw (Join-Path $PSScriptRoot 'install.ps1') | Invoke-Expression }
    catch {
        if ($_.Exception.Message -notmatch 'Checksum Node invalido') { throw }
        $rejected = $true
    }
    if ($Client -ne '') { throw 'Bootstrap must preserve the caller Client variable.' }
    if (-not $rejected) { throw 'A bad checksum must stop installation.' }
    if (Test-Path (Join-Path $root 'FockyTV\bootstrap\node')) { throw 'Unverified Node must not be installed.' }
    Write-Output 'PowerShell bootstrap: bad Node checksum rejected before extraction.'
} finally {
    $env:PATH = $originalPath
    $env:LOCALAPPDATA = $originalLocal
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
