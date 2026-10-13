# Reminders - remove the startup popup and shortcuts from this PC
$taskName = 'Reminders popup'
try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop; Write-Host "Startup task removed." }
catch { Write-Host "No startup task found." }
foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
  $p = Join-Path $dir 'Reminders.lnk'
  if (Test-Path $p) { Remove-Item $p; Write-Host "Removed $p" }
}
Write-Host "Done. Your tasks are still saved in the cloud."
Read-Host "Press Enter to close"
