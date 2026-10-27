<#
    Local host testing - start the backend (keeping its data) and the app.

        powershell -ExecutionPolicy Bypass -File docs/local-host-testing/start.ps1

    Press Ctrl+C to stop the dev server; the backend keeps running until
    stop.ps1 (or `supabase stop`).
#>
[CmdletBinding()]
param([string]$SupabaseVersion = '2.122.0')

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$dockerVersion = $null
try { $dockerVersion = (docker info --format '{{.ServerVersion}}' 2>$null) } catch { }
if (-not $dockerVersion) {
    Write-Host "Docker is not running. Start Docker Desktop first." -ForegroundColor Red
    exit 1
}

Push-Location $repoRoot
try {
    Write-Host "==> Starting the local Supabase stack" -ForegroundColor Cyan
    & npx --yes "supabase@$SupabaseVersion" start
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host "==> Starting the dev server on http://localhost:3000" -ForegroundColor Cyan
    & npm run dev
} finally { Pop-Location }
