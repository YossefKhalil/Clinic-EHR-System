<#
    Local host testing - stop the backend, keeping the local data.

        powershell -ExecutionPolicy Bypass -File docs/local-host-testing/stop.ps1

    Pass -NoBackup to also drop the local database volume.
#>
[CmdletBinding()]
param(
    [switch]$NoBackup,
    [string]$SupabaseVersion = '2.122.0'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

Push-Location $repoRoot
try {
    $commandArgs = @('stop')
    if ($NoBackup) { $commandArgs += '--no-backup' }
    & npx --yes "supabase@$SupabaseVersion" @commandArgs
} finally { Pop-Location }
