param([int]$Port = 4319, [int]$HttpsPort = 8443)
$ErrorActionPreference = 'Stop'
$mealRoot = Split-Path -Parent $PSScriptRoot
$mealTailscale = (Get-Command tailscale.exe -ErrorAction Stop).Source
$mealNode = (Get-Command node.exe -ErrorAction Stop).Source
$mealStatusText = & $mealTailscale status --json
if ($LASTEXITCODE -ne 0) { throw 'Could not read Tailscale status.' }
$mealStatus = $mealStatusText | ConvertFrom-Json
if ($mealStatus.BackendState -ne 'Running') { throw 'Connect this PC to Tailscale first.' }
$mealDns = [string]$mealStatus.Self.DNSName
if (-not $mealDns) { throw 'Tailscale DNS name is missing.' }
$mealPublicOrigin = 'https://' + $mealDns.TrimEnd('.') + ':' + $HttpsPort
$mealServeText = & $mealTailscale serve status --json
if ($LASTEXITCODE -ne 0) { throw 'Could not read existing Tailscale Serve configuration.' }
$mealServe = $mealServeText | ConvertFrom-Json
$mealServeKey = $mealDns.TrimEnd('.') + ':' + $HttpsPort
$mealExistingWeb = if ($mealServe.Web) { $mealServe.Web.PSObject.Properties[$mealServeKey] } else { $null }
$mealExistingTcp = if ($mealServe.TCP) { $mealServe.TCP.PSObject.Properties[[string]$HttpsPort] } else { $null }
if ($mealExistingTcp -and -not $mealExistingWeb) { throw ('Port ' + $HttpsPort + ' is already assigned to another Tailscale service.') }
if ($mealServe.AllowFunnel -and $mealServe.AllowFunnel.PSObject.Properties[$mealServeKey] -and $mealServe.AllowFunnel.PSObject.Properties[$mealServeKey].Value) { throw 'The selected endpoint is configured for Funnel. Choose a private endpoint instead.' }
if ($mealExistingWeb) {
    $mealHandlers = @($mealExistingWeb.Value.Handlers.PSObject.Properties)
    if ($mealHandlers.Count -ne 1 -or $mealHandlers[0].Name -ne '/' -or $mealHandlers[0].Value.Proxy -ne ('http://127.0.0.1:' + $Port)) {
        throw ('HTTPS port ' + $HttpsPort + ' is already assigned to another service.')
    }
}
$mealDataDir = Join-Path $mealRoot 'data\local-sync'
New-Item -ItemType Directory -Path $mealDataDir -Force | Out-Null
$mealServeText | Set-Content -LiteralPath (Join-Path $mealDataDir 'serve-before-install.json') -Encoding UTF8
$mealConfigPath = Join-Path $mealDataDir 'service-config.json'
@{ publicOrigin = $mealPublicOrigin; port = $Port; nodePath = $mealNode; dataDir = $mealDataDir } | ConvertTo-Json | Set-Content -LiteralPath $mealConfigPath -Encoding UTF8
$mealStartScript = Join-Path $PSScriptRoot 'start-local-sync.ps1'
$mealTaskName = 'MealNoteLocalSync'
$mealPowerShell = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $mealPowerShell)) { $mealPowerShell = Join-Path $PSHOME 'pwsh.exe' }
$mealTaskArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $mealStartScript + '" -ConfigPath "' + $mealConfigPath + '"'
$mealExistingTask = Get-ScheduledTask -TaskName $mealTaskName -ErrorAction SilentlyContinue
if ($mealExistingTask -and @($mealExistingTask.Actions)[0].Arguments -ne $mealTaskArgs) { throw 'A different task already uses the MealNoteLocalSync name.' }
$mealAction = New-ScheduledTaskAction -Execute $mealPowerShell -Argument $mealTaskArgs -WorkingDirectory $mealRoot
$mealTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$mealPrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$mealSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $mealTaskName -Action $mealAction -Trigger $mealTrigger -Principal $mealPrincipal -Settings $mealSettings -Description 'Meal Note private recipe synchronization server' -Force | Out-Null
Start-ScheduledTask -TaskName $mealTaskName
$mealReady = $false
for ($mealTry = 0; $mealTry -lt 20; $mealTry++) {
    try {
        $mealResponse = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/api/sync') -TimeoutSec 2
        $mealReady = $true
        break
    } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $mealReady) { throw 'The local server did not become ready. Check data/local-sync/server-error.log.' }
& $mealTailscale serve --bg ('--https=' + $HttpsPort) ('http://127.0.0.1:' + $Port)
if ($LASTEXITCODE -ne 0) { throw 'Could not configure the private Tailscale endpoint.' }
Write-Output ('Meal Note: ' + $mealPublicOrigin + '/')
Write-Output ('Task: ' + $mealTaskName)
Write-Output ('Data: ' + $mealDataDir)
