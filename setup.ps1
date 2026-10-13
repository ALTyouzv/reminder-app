# Reminders - one-time cloud setup (run on ONE PC only)
# Deploys the app to your free Cloudflare account and connects your Telegram bot.
# Safe to run again: steps that are already done are skipped.
$ErrorActionPreference = 'Continue'
$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$worker  = Join-Path $root 'worker'
$cfgFile = Join-Path $root 'windows\config.json'
$log     = Join-Path $root 'setup-log.txt'
Set-Location $worker
try { Start-Transcript -Path $log -Force | Out-Null } catch {}

function Step($n, $text) { Write-Host ""; Write-Host "[$n] $text" -ForegroundColor Cyan }
function Fail($text) { throw $text }
# Run wrangler with live output (for prompts / browser login). Returns exit code.
function WrLive {
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ("npx --yes wrangler@4 " + ($args -join ' ')) -NoNewWindow -Wait -PassThru
  return $p.ExitCode
}
# Run wrangler and capture all output as text (stderr warnings included, never fatal).
function WrText { $o = & cmd /c "npx --yes wrangler@4 $($args -join ' ') 2>&1"; return ($o -join "`n") }

try {
  Write-Host "=== Reminders setup ===" -ForegroundColor Green

  # 1. Node.js
  Step 1 "Checking Node.js"
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js is not installed. Installing it with winget..."
    & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Fail "Close this window and run setup again (Node.js needs a fresh window). If winget failed, install Node.js LTS from https://nodejs.org first."
  }
  Write-Host ("Node " + (node -v))

  # 2. Cloudflare login
  Step 2 "Signing in to Cloudflare (a browser tab will open - sign in and click Allow)"
  Write-Host "(The first run downloads Cloudflare's tool - this can take a minute.)"
  $who = WrText whoami
  if ($who -match 'You are logged in') {
    Write-Host "Already signed in."
  } else {
    if ((WrLive login) -ne 0) { Fail "Cloudflare login did not finish. Run setup again and click Allow in the browser." }
    $who = WrText whoami
    if ($who -notmatch 'You are logged in') { Write-Host $who; Fail "Still not signed in to Cloudflare." }
  }
  Write-Host "Signed in to Cloudflare." -ForegroundColor Green

  # 3. Database
  Step 3 "Creating the database"
  $tomlPath = Join-Path $worker 'wrangler.toml'
  $toml = [IO.File]::ReadAllText($tomlPath)
  if ($toml -match 'PASTE_DATABASE_ID_HERE') {
    function Find-DbId {
      $txt = WrText d1 list --json
      $s = $txt.IndexOf('['); $e = $txt.LastIndexOf(']')
      if ($s -lt 0 -or $e -le $s) { return $null }
      try { $list = $txt.Substring($s, $e - $s + 1) | ConvertFrom-Json } catch { return $null }
      $db = $list | Where-Object { $_.name -eq 'reminders-db' } | Select-Object -First 1
      if ($db) { if ($db.uuid) { return $db.uuid } else { return $db.database_id } }
      return $null
    }
    $id = Find-DbId
    if (-not $id) {
      $out = WrText d1 create reminders-db
      Write-Host $out
      $id = Find-DbId
      if (-not $id -and $out -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') { $id = $Matches[1] }
    }
    if (-not $id) { Fail "Could not create or find the database." }
    $toml = $toml -replace 'PASTE_DATABASE_ID_HERE', $id
    [IO.File]::WriteAllText($tomlPath, $toml)
    Write-Host "Database id: $id"
  } else { Write-Host "Database already set up." }

  Write-Host "Creating tables (type y and press Enter if asked to confirm)..."
  if ((WrLive d1 execute reminders-db --remote --file schema.sql) -ne 0) { Fail "Creating the tables failed. Scroll up to see why." }

  # 4. Deploy
  Step 4 "Publishing the app"
  Write-Host "If asked to pick a workers.dev subdomain, type a name you like (e.g. sara) and press Enter."
  if ((WrLive deploy) -ne 0) { Fail "Publishing failed. Scroll up to see why." }

  $url = $null
  if (Test-Path $cfgFile) { try { $url = (Get-Content $cfgFile -Raw | ConvertFrom-Json).url } catch {} }
  Write-Host ""
  Write-Host "Look above for a line like:  https://reminders.<name>.workers.dev" -ForegroundColor Yellow
  $prompt = if ($url) { "Paste that address (or press Enter to keep $url)" } else { "Paste that address here" }
  $ans = (Read-Host $prompt).Trim().TrimEnd('/')
  if ($ans) { $url = $ans }
  if ($url -notmatch '^https://') { Fail "That does not look like an https:// address. Run setup again." }
  New-Item -ItemType Directory -Force -Path (Split-Path $cfgFile) | Out-Null
  @{ url = $url } | ConvertTo-Json | Set-Content -Encoding ASCII $cfgFile

  # 5. Secrets
  Step 5 "Setting your app password"
  do {
    $pw = Read-Host "Choose an app password (at least 8 characters; you'll type it once on each device)"
  } while ($pw.Length -lt 8)
  $pw | & cmd /c "npx --yes wrangler@4 secret put APP_KEY"
  if ($LASTEXITCODE -ne 0) { Fail "Saving the password failed." }

  Step 6 "Connecting your Telegram bot"
  Write-Host "Copy the token from your BotFather chat. It looks like: 123456789:AAH...xyz"
  do { $tok = (Read-Host "Paste the bot token").Trim() } while ($tok -notmatch '^\d+:[\w-]{30,}$')
  $tok | & cmd /c "npx --yes wrangler@4 secret put TELEGRAM_TOKEN"
  if ($LASTEXITCODE -ne 0) { Fail "Saving the token failed." }

  Write-Host ""
  Write-Host "=== Done! ===" -ForegroundColor Green
  Write-Host "Your app: $url"
  Write-Host "Next:"
  Write-Host "  1. Sign in with your password, open Settings (gear), and tap Connect Telegram."
  Write-Host "  2. Run windows\install-startup.cmd on this PC and on your laptop."
  Start-Process $url
}
catch {
  Write-Host ""
  Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host "A log was saved to: $log"
}
finally {
  try { Stop-Transcript | Out-Null } catch {}
  Read-Host "Press Enter to close"
}
