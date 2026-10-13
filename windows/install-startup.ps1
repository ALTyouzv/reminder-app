# Reminders - make the app pop up when you sign in or unlock this PC (run on EACH PC)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgFile = Join-Path $here 'config.json'
$taskName = 'Reminders popup'

Write-Host "=== Reminders: startup popup ===" -ForegroundColor Green

# App address
$url = $null
if (Test-Path $cfgFile) { try { $url = (Get-Content $cfgFile -Raw | ConvertFrom-Json).url } catch {} }
if ($url) {
  $ans = Read-Host "App address: $url  - press Enter to use it, or paste a different one"
  if ($ans.Trim()) { $url = $ans.Trim() }
} else {
  $url = (Read-Host "Paste your app address (https://reminders.<name>.workers.dev)").Trim()
}
$url = $url.TrimEnd('/')
if ($url -notmatch '^https://') { Write-Host "That is not an https:// address." -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }
@{ url = $url } | ConvertTo-Json | Set-Content -Encoding ASCII $cfgFile

# Find a browser that supports app windows (Edge is on every Windows PC)
$candidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LocalAppData\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)
$browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) { Write-Host "Could not find Microsoft Edge or Chrome." -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }
$appArgs = "--app=$url --window-size=520,780"
Write-Host "Using: $browser"

# Scheduled task: at sign-in (after a short delay so Wi-Fi is up) and at every unlock (e.g. waking from sleep)
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
function X([string]$s) { [System.Security.SecurityElement]::Escape($s) }
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Opens the Reminders app at sign-in and unlock.</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$(X $user)</UserId><Delay>PT8S</Delay></LogonTrigger>
    <SessionStateChangeTrigger><Enabled>true</Enabled><StateChange>SessionUnlock</StateChange><UserId>$(X $user)</UserId><Delay>PT2S</Delay></SessionStateChangeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$(X $user)</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>$(X $browser)</Command><Arguments>$(X $appArgs)</Arguments></Exec></Actions>
</Task>
"@

try {
  Register-ScheduledTask -TaskName $taskName -Xml $xml -Force | Out-Null
} catch {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Write-Host "Windows needs permission to add the startup task. Approve the prompt..." -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
    exit 0
  }
  Write-Host "Could not create the startup task: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host "Press Enter to close"; exit 1
}
Write-Host "Startup task created: '$taskName'"

# Start Menu + Desktop shortcuts so you can open it any time
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
  $lnk = $shell.CreateShortcut((Join-Path $dir 'Reminders.lnk'))
  $lnk.TargetPath = $browser
  $lnk.Arguments = $appArgs
  $lnk.Description = 'Reminders'
  $lnk.Save()
}
Write-Host "Added 'Reminders' to the Start Menu and Desktop."

# Open it now
Start-Process -FilePath $browser -ArgumentList $appArgs
Write-Host ""
Write-Host "Done. Reminders will pop up every time you sign in or unlock this PC." -ForegroundColor Green
Write-Host "To remove it later, run uninstall-startup.cmd"
Read-Host "Press Enter to close"
