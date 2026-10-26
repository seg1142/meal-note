param([string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$mealRoot = Split-Path -Parent $PSScriptRoot
if (-not $ConfigPath) { $ConfigPath = Join-Path $mealRoot 'data\local-sync\service-config.json' }
$mealConfig = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$mealServer = Join-Path $mealRoot 'server\local-sync.cjs'
if (-not (Test-Path -LiteralPath $mealServer)) { throw 'Meal Note server source was not found.' }
if (-not (Test-Path -LiteralPath $mealConfig.nodePath)) { throw 'Configured Node.js executable was not found.' }
$mealArgs = @(
    ('"' + $mealServer + '"'), '--port', [string]$mealConfig.port,
    '--public-origin', ('"' + $mealConfig.publicOrigin + '"'),
    '--data-dir', ('"' + $mealConfig.dataDir + '"')
)
$mealProcess = Start-Process -FilePath $mealConfig.nodePath -ArgumentList $mealArgs -WorkingDirectory $mealRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $mealConfig.dataDir 'server-output.log') -RedirectStandardError (Join-Path $mealConfig.dataDir 'server-error.log')
exit $mealProcess.ExitCode
