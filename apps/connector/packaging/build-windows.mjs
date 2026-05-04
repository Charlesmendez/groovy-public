import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { buildRnnoiseNativeAddon } from "./rnnoiseNative.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const distDir = path.resolve(root, "dist");
const bundleDir = path.resolve(distDir, "windows-bundle");
const zipName = "Groovy-Connector-windows.zip";
const zipPath = path.resolve(distDir, zipName);
const exeName = "Groovy-Connector-windows.exe";
const exePath = path.resolve(distDir, exeName);
const installerStageDir = path.resolve(distDir, "windows-installer-stage");
const installerSedPath = path.resolve(distDir, "windows-installer.sed");

const requiredPaths = [
  "connector.mjs",
  "codexPlans.mjs",
  "browser.mjs",
  "browserTask.mjs",
  "files.mjs",
  "obsidian.mjs",
  "siteDev.mjs",
  "linkdb.mjs",
  "credentials.mjs",
  "sqlitedb.mjs",
  "sqliteProjects.mjs",
  "whatsapp.mjs",
  "aiyraVoice.mjs",
  "aec.mjs",
  "rnnoise.mjs",
  "native",
  "platform",
  "package.json",
  "package-lock.json",
];

const optionalPaths = ["wakewords"];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyRecursive(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function assertExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`[windows-build] Missing required path: ${label}`);
  }
}

function windowsPairingPromptPowerShellFunction() {
  return `
function Show-GroovyPairingPrompt {
  param(
    [string]$Title = 'Groovy Connector',
    [string]$Message = 'Enter your Groovy pairing code:',
    [string]$Hint = 'Get a code from gogroovy.ai -> Dashboard'
  )

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $form = New-Object System.Windows.Forms.Form
  $form.Text = $Title
  $form.ClientSize = New-Object System.Drawing.Size -ArgumentList 440, 184
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true
  $form.ShowInTaskbar = $true

  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Message
  $label.AutoSize = $false
  $label.Location = New-Object System.Drawing.Point -ArgumentList 16, 16
  $label.Size = New-Object System.Drawing.Size -ArgumentList 408, 24
  $label.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 10
  [void]$form.Controls.Add($label)

  $hintLabel = New-Object System.Windows.Forms.Label
  $hintLabel.Text = $Hint
  $hintLabel.AutoSize = $false
  $hintLabel.Location = New-Object System.Drawing.Point -ArgumentList 16, 42
  $hintLabel.Size = New-Object System.Drawing.Size -ArgumentList 408, 20
  $hintLabel.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 8.5
  $hintLabel.ForeColor = [System.Drawing.SystemColors]::GrayText
  [void]$form.Controls.Add($hintLabel)

  $textBox = New-Object System.Windows.Forms.TextBox
  $textBox.Location = New-Object System.Drawing.Point -ArgumentList 16, 74
  $textBox.Size = New-Object System.Drawing.Size -ArgumentList 408, 26
  $textBox.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 10
  [void]$form.Controls.Add($textBox)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'Connect'
  $ok.Location = New-Object System.Drawing.Point -ArgumentList 250, 124
  $ok.Size = New-Object System.Drawing.Size -ArgumentList 82, 30
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Enabled = $false
  [void]$form.Controls.Add($ok)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = 'Cancel'
  $cancel.Location = New-Object System.Drawing.Point -ArgumentList 342, 124
  $cancel.Size = New-Object System.Drawing.Size -ArgumentList 82, 30
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  [void]$form.Controls.Add($cancel)

  $form.AcceptButton = $ok
  $form.CancelButton = $cancel
  $textBox.Add_TextChanged({ $ok.Enabled = $textBox.Text.Trim().Length -gt 0 })
  $form.Add_Shown({
    $form.Activate()
    $form.BringToFront()
    [void]$textBox.Focus()
  })

  $selected = $null
  try {
    if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      $selected = $textBox.Text.Trim()
    }
  } finally {
    $form.Dispose()
  }

  if ($selected) { return $selected }
  return $null
}
`.trim();
}

function writeWindowsPairingPromptHelper(targetDir) {
  const ps1Path = path.resolve(targetDir, "prompt-pairing.ps1");
  const ps1 = [
    "$ErrorActionPreference = 'Stop'",
    windowsPairingPromptPowerShellFunction(),
    "Show-GroovyPairingPrompt",
    "",
  ].join("\n");
  fs.writeFileSync(ps1Path, ps1.replace(/\n/g, "\r\n"), "utf8");
}

function writeLauncher() {
  writeWindowsPairingPromptHelper(bundleDir);
  const launcherPath = path.resolve(bundleDir, "Groovy Connector.cmd");
  const script = [
    "@echo off",
    "setlocal",
    "set ROOT=%~dp0",
    "set NODE_EXE=%ROOT%node\\node.exe",
    "if not exist \"%NODE_EXE%\" set NODE_EXE=node",
    "set CONNECTOR=%ROOT%connector.mjs",
    "set PAIRING_PROMPT=%ROOT%prompt-pairing.ps1",
    "set EXIT_CODE=0",
    "if not exist \"%USERPROFILE%\\.groovy\" mkdir \"%USERPROFILE%\\.groovy\" >nul 2>&1",
    "set LOG_FILE=%USERPROFILE%\\.groovy\\connector.log",
    "set CONFIG_EXISTS=0",
    "set PROMPT_HELPER_EXISTS=0",
    "set AUTH_CHECK_EXIT=",
    "if exist \"%USERPROFILE%\\.groovy\\connector.json\" set CONFIG_EXISTS=1",
    "if exist \"%PAIRING_PROMPT%\" set PROMPT_HELPER_EXISTS=1",
    "echo [launcher] %date% %time% launch begin root=%ROOT% >> \"%LOG_FILE%\"",
    "set NEED_PAIR=1",
    "set AUTH_READY=",
    "if exist \"%USERPROFILE%\\.groovy\\connector.json\" call :check_existing_auth",
    "if \"%AUTH_READY%\"==\"1\" set NEED_PAIR=0",
    "set ARGS=%*",
    "set ARGS_HAS_PAIR=0",
    "if not \"%ARGS:--pair=%\"==\"%ARGS%\" set ARGS_HAS_PAIR=1",
    "if \"%ARGS_HAS_PAIR%\"==\"1\" set NEED_PAIR=0",
    "set ENV_PAIR_PRESENT=0",
    "if not \"%GROOVY_PAIRING_CODE%\"==\"\" set ENV_PAIR_PRESENT=1",
    "echo [launcher] pairing decision before prompt config_exists=%CONFIG_EXISTS% auth_ready=%AUTH_READY% auth_check_exit=%AUTH_CHECK_EXIT% args_has_pair=%ARGS_HAS_PAIR% env_pair_present=%ENV_PAIR_PRESENT% prompt_helper_exists=%PROMPT_HELPER_EXISTS% need_pair=%NEED_PAIR% >> \"%LOG_FILE%\"",
    "if \"%NEED_PAIR%\"==\"1\" if \"%GROOVY_PAIRING_CODE%\"==\"\" call :prompt_for_pairing_code",
    "if \"%NEED_PAIR%\"==\"1\" if not \"%GROOVY_PAIRING_CODE%\"==\"\" echo [launcher] pairing prompt returned value >> \"%LOG_FILE%\"",
    "if \"%NEED_PAIR%\"==\"1\" if \"%GROOVY_PAIRING_CODE%\"==\"\" (",
    "  echo [launcher] pairing prompt returned empty; falling back to console input >> \"%LOG_FILE%\"",
    "  echo.",
    "  set /p GROOVY_PAIRING_CODE=Enter your Groovy pairing code: ",
    ")",
    "if \"%NEED_PAIR%\"==\"1\" if \"%GROOVY_PAIRING_CODE%\"==\"\" (",
    "  echo [connector-launcher] Pairing code is required on first run.",
    "  echo [launcher] missing pairing code on first run >> \"%LOG_FILE%\"",
    "  set EXIT_CODE=1",
    "  goto _postrun",
    ")",
    "set PAIR_ARGS=",
    "if \"%NEED_PAIR%\"==\"1\" if not \"%GROOVY_PAIRING_CODE%\"==\"\" set PAIR_ARGS=--pair \"%GROOVY_PAIRING_CODE%\"",
    "if \"%NEED_PAIR%\"==\"1\" if not \"%GROOVY_PAIRING_CODE%\"==\"\" echo [launcher] pairing code captured; starting with --pair >> \"%LOG_FILE%\"",
    "if not \"%NEED_PAIR%\"==\"1\" echo [launcher] pairing not required; starting with stored auth or explicit args >> \"%LOG_FILE%\"",
    // Read WhatsApp config from connector.json for subsequent launches
    "set WA_GROUP=",
    "if exist \"%USERPROFILE%\\.groovy\\connector.json\" call :load_whatsapp_group",
    "set WA_ARGS=",
    "if defined WA_GROUP set WA_ARGS=--whatsapp --whatsapp-group \"%WA_GROUP%\" --app-url \"https://gogroovy.ai\"",
    "echo [launcher] %date% %time% starting connector >> \"%LOG_FILE%\"",
    "\"%NODE_EXE%\" \"%CONNECTOR%\" %* %PAIR_ARGS% %WA_ARGS% >> \"%LOG_FILE%\" 2>&1",
    "set EXIT_CODE=%errorlevel%",
    ":_postrun",
    "if not \"%EXIT_CODE%\"==\"0\" (",
    "  echo.",
    "  echo [connector-launcher] Connector exited with code %EXIT_CODE%.",
    "  echo [connector-launcher] If this is first run, get a pairing code from gogroovy.ai dashboard and relaunch.",
    "  echo [connector-launcher] Log file: %LOG_FILE%",
    "  pause",
    ")",
    "exit /b %EXIT_CODE%",
    "",
    ":prompt_for_pairing_code",
    "set \"PAIRING_CODE_TMP=%TEMP%\\groovy-pairing-code.txt\"",
    "del \"%PAIRING_CODE_TMP%\" >nul 2>&1",
    "if exist \"%PAIRING_PROMPT%\" echo [launcher] invoking pairing prompt helper >> \"%LOG_FILE%\"",
    "if not exist \"%PAIRING_PROMPT%\" echo [launcher] pairing prompt helper missing: %PAIRING_PROMPT% >> \"%LOG_FILE%\"",
    "if exist \"%PAIRING_PROMPT%\" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File \"%PAIRING_PROMPT%\" > \"%PAIRING_CODE_TMP%\" 2>> \"%LOG_FILE%\"",
    "set PROMPT_EXIT=%errorlevel%",
    "if exist \"%PAIRING_PROMPT%\" echo [launcher] pairing prompt helper exited code=%PROMPT_EXIT% >> \"%LOG_FILE%\"",
    "if exist \"%PAIRING_CODE_TMP%\" set /p GROOVY_PAIRING_CODE=<\"%PAIRING_CODE_TMP%\"",
    "del \"%PAIRING_CODE_TMP%\" >nul 2>&1",
    "goto :eof",
    "",
    ":check_existing_auth",
    "set \"AUTH_READY_TMP=%TEMP%\\groovy-auth-ready.txt\"",
    "del \"%AUTH_READY_TMP%\" >nul 2>&1",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"$ErrorActionPreference='SilentlyContinue'; try { $configPath = Join-Path $env:USERPROFILE '.groovy\\connector.json'; $j=Get-Content $configPath -Raw | ConvertFrom-Json; $token=[string]$j.device_token; $userId=[string]$j.paired_user_id; if(-not [string]::IsNullOrWhiteSpace($token) -and -not [string]::IsNullOrWhiteSpace($userId)){ [Console]::Out.Write('1') } } catch {}\" > \"%AUTH_READY_TMP%\" 2>nul",
    "set AUTH_CHECK_EXIT=%errorlevel%",
    "if exist \"%AUTH_READY_TMP%\" set /p AUTH_READY=<\"%AUTH_READY_TMP%\"",
    "del \"%AUTH_READY_TMP%\" >nul 2>&1",
    "goto :eof",
    "",
    ":load_whatsapp_group",
    "set \"WA_GROUP_TMP=%TEMP%\\groovy-wa-group.txt\"",
    "del \"%WA_GROUP_TMP%\" >nul 2>&1",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"$ErrorActionPreference='SilentlyContinue'; try { $configPath = Join-Path $env:USERPROFILE '.groovy\\connector.json'; $j=Get-Content $configPath -Raw | ConvertFrom-Json; if($j.whatsapp_enabled -eq $true -and $j.whatsapp_group_name){ [Console]::Out.Write($j.whatsapp_group_name) } } catch {}\" > \"%WA_GROUP_TMP%\" 2>nul",
    "if exist \"%WA_GROUP_TMP%\" set /p WA_GROUP=<\"%WA_GROUP_TMP%\"",
    "del \"%WA_GROUP_TMP%\" >nul 2>&1",
    "goto :eof",
    "",
  ].join("\r\n");
  fs.writeFileSync(launcherPath, script, "utf8");
}

function copyNodeRuntimeIfPresent() {
  try {
    const nodeExe = process.execPath;
    if (!nodeExe || !fs.existsSync(nodeExe)) return false;
    const nodeDir = path.resolve(bundleDir, "node");
    ensureDir(nodeDir);
    fs.copyFileSync(nodeExe, path.resolve(nodeDir, path.basename(nodeExe)));
    return true;
  } catch {
    return false;
  }
}

function zipBundle() {
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });

  if (process.platform === "win32") {
    const sourceGlob = path.resolve(bundleDir, "*");
    const script = `Compress-Archive -Path "${sourceGlob.replace(/"/g, '""')}" -DestinationPath "${zipPath.replace(/"/g, '""')}" -Force`;
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: "inherit" }
    );
    return;
  }

  execFileSync("zip", ["-r", zipPath, "."], { cwd: bundleDir, stdio: "inherit" });
}

function toWindowsPath(p) {
  return p.replace(/\//g, "\\");
}

function writeWindowsSetupPs1(stageDir) {
  // Separate PowerShell helper that handles extraction, shortcuts, and pairing dialog.
  // Avoids cmd.exe line-length limits and COM object failures from inline commands.
  const ps1Path = path.resolve(stageDir, "setup-helper.ps1");
  const ps1 = `
$ErrorActionPreference = 'Stop'
$zip = Join-Path $PSScriptRoot '${zipName}'
$target = Join-Path $env:LOCALAPPDATA 'GroovyConnector'
$groovyDir = Join-Path $env:USERPROFILE '.groovy'
$logFile = Join-Path $groovyDir 'connector.log'
$installLogFile = Join-Path $groovyDir 'connector-install.log'
$launcherCmd = Join-Path $target 'Groovy Connector.cmd'

if (!(Test-Path $groovyDir)) { New-Item -ItemType Directory -Path $groovyDir -Force | Out-Null }

function Write-InstallLog($msg) {
  $line = '[installer] ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + [string]$msg
  try { Add-Content -Path $installLogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch {}
  Write-Host $line
}

Write-InstallLog "installer started target=$target"

# --- Progress window (non-blocking) ---
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$progressForm = New-Object System.Windows.Forms.Form
$progressForm.Text = 'Groovy Connector'
$progressForm.Size = New-Object System.Drawing.Size(380, 140)
$progressForm.StartPosition = 'CenterScreen'
$progressForm.FormBorderStyle = 'FixedDialog'
$progressForm.MaximizeBox = $false
$progressForm.MinimizeBox = $false
$progressForm.TopMost = $true
$progressLabel = New-Object System.Windows.Forms.Label
$progressLabel.Text = 'Installing Groovy Connector...'
$progressLabel.AutoSize = $false
$progressLabel.Size = New-Object System.Drawing.Size(340, 30)
$progressLabel.Location = New-Object System.Drawing.Point(15, 15)
$progressLabel.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$progressBar = New-Object System.Windows.Forms.ProgressBar
$progressBar.Style = 'Marquee'
$progressBar.MarqueeAnimationSpeed = 30
$progressBar.Size = New-Object System.Drawing.Size(340, 22)
$progressBar.Location = New-Object System.Drawing.Point(15, 50)
$progressForm.Controls.Add($progressLabel)
$progressForm.Controls.Add($progressBar)
$progressForm.Show()
$progressForm.Refresh()

function Update-Progress($msg) {
  $progressLabel.Text = $msg
  $progressForm.Refresh()
  Write-InstallLog $msg
}

${windowsPairingPromptPowerShellFunction()}

# 0) Stop any running connector so we can overwrite files cleanly
Update-Progress 'Stopping previous instance...'
schtasks /end /tn 'Groovy Connector' 2>$null | Out-Null
# Kill node processes running connector.mjs via CIM (Get-Process has no reliable CommandLine)
try {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'connector\\.mjs' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}
# Also kill any node.exe whose parent path is the install target (covers bundled node runtime)
try {
  $targetPrefix = $target.ToLower()
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($targetPrefix) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}
# Remove stale lock so the new process can start
$lockFile = Join-Path $groovyDir 'connector.lock'
if (Test-Path $lockFile) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# 1) Extract (robust: retry if files are locked; if that still fails, wipe + retry once)
if (!(Test-Path $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
Update-Progress 'Extracting files (this may take a minute)...'
# Proactively delete the launcher .cmd so a locked old copy can't block extraction
$launcherExisting = Join-Path $target 'Groovy Connector.cmd'
if (Test-Path $launcherExisting) { Remove-Item $launcherExisting -Force -ErrorAction SilentlyContinue }
$extractAttempt = 0
$extractOk = $false
while (-not $extractOk -and $extractAttempt -lt 3) {
  $extractAttempt++
  try {
    Expand-Archive -Path $zip -DestinationPath $target -Force -ErrorAction Stop
    $extractOk = $true
  } catch {
    Write-Host "[installer] Extract attempt $extractAttempt failed: $_"
    Start-Sleep -Seconds 2
    if ($extractAttempt -eq 2) {
      # Last-ditch: wipe target and retry once so a locked/corrupted file can't keep blocking
      Update-Progress 'Cleaning previous install and retrying...'
      try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
          ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      } catch {}
      Start-Sleep -Seconds 1
      Remove-Item -Path (Join-Path $target '*') -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
if (-not $extractOk) {
  $progressForm.Hide()
  $nl = [Environment]::NewLine
  $msg = 'Failed to install Groovy Connector files. Please close any running Groovy/Node processes, restart Windows, and run the installer again.' + $nl + $nl + 'If the problem persists, delete the folder:' + $nl + $target + $nl + 'and try again.'
  [System.Windows.Forms.MessageBox]::Show(
    $msg,
    'Groovy Connector installer',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}
# Verify the launcher was actually written so we don't silently ship a half-installed state
if (!(Test-Path $launcherExisting)) {
  $progressForm.Hide()
  $nl = [Environment]::NewLine
  $msg = "Installer could not write 'Groovy Connector.cmd' to:" + $nl + $target + $nl + $nl + 'Please restart Windows and run the installer again.'
  [System.Windows.Forms.MessageBox]::Show(
    $msg,
    'Groovy Connector installer',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}

# 1b) Ensure Puppeteer Chrome is installed (WhatsApp Web needs it)
$nodeExe = Join-Path $target 'node\\node.exe'
if (!(Test-Path $nodeExe)) { $nodeExe = 'node' }
Update-Progress 'Ensuring browser runtime for WhatsApp...'
try {
  $npxCmd = Join-Path $target 'node_modules\\.bin\\puppeteer.cmd'
  if (Test-Path $npxCmd) {
    & $npxCmd browsers install chrome 2>$null | Out-Null
  } else {
    & $nodeExe (Join-Path $target 'node_modules\\puppeteer\\install.mjs') 2>$null | Out-Null
  }
  Write-Host '[installer] Puppeteer Chrome ready.'
} catch {
  Write-InstallLog "Warning: Chrome download failed (WhatsApp will use Edge fallback): $_"
}

# 2) Create shortcuts (Start Menu + Desktop)
try {
  $shell = New-Object -ComObject WScript.Shell
  $iconPath = Join-Path $env:SystemRoot 'System32\\SHELL32.dll'

  # Start Menu
  $startMenu = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'
  if (!(Test-Path $startMenu)) { New-Item -ItemType Directory -Path $startMenu -Force | Out-Null }
  $lnk = $shell.CreateShortcut((Join-Path $startMenu 'Groovy Connector.lnk'))
  $lnk.TargetPath = $launcherCmd
  $lnk.WorkingDirectory = $target
  $lnk.IconLocation = "$iconPath,2"
  $lnk.Save()
  Update-Progress 'Creating shortcuts...'

  # Desktop
  $desktop = [Environment]::GetFolderPath('Desktop')
  $dlnk = $shell.CreateShortcut((Join-Path $desktop 'Groovy Connector.lnk'))
  $dlnk.TargetPath = $launcherCmd
  $dlnk.WorkingDirectory = $target
  $dlnk.IconLocation = "$iconPath,2"
  $dlnk.Save()
  Write-InstallLog 'Shortcuts created.'
} catch {
  Write-InstallLog "Warning: shortcut creation failed: $_"
}

# 3) Check if pairing is needed
if (!(Test-Path $groovyDir)) { New-Item -ItemType Directory -Path $groovyDir -Force | Out-Null }
$needPair = $true
$configFile = Join-Path $groovyDir 'connector.json'
$configExists = Test-Path $configFile
$hasDeviceToken = $false
$hasPairedUserId = $false
if (Test-Path $configFile) {
  try {
    $j = Get-Content $configFile -Raw -ErrorAction Stop | ConvertFrom-Json
    $token = [string]$j.device_token
    $pairedUserId = [string]$j.paired_user_id
    $hasDeviceToken = -not [string]::IsNullOrWhiteSpace($token)
    $hasPairedUserId = -not [string]::IsNullOrWhiteSpace($pairedUserId)
    if ((-not [string]::IsNullOrWhiteSpace($token)) -and (-not [string]::IsNullOrWhiteSpace($pairedUserId))) {
      $needPair = $false
    } else {
      Write-InstallLog 'Existing connector auth is incomplete; pairing code required.'
    }
  } catch {
    Write-InstallLog "Existing connector config could not be read; pairing code required: $_"
  }
}
$envPairPresent = -not [string]::IsNullOrWhiteSpace([string]$env:GROOVY_PAIRING_CODE)
if ($envPairPresent) { $needPair = $false }
Write-InstallLog ("pairing check: config_exists={0} has_device_token={1} has_paired_user_id={2} env_pair_present={3} need_pair={4}" -f $configExists, $hasDeviceToken, $hasPairedUserId, $envPairPresent, $needPair)

# 4) Show pairing dialog if needed
if ($needPair) {
  $progressForm.Hide()
  Write-InstallLog 'First run - pairing code required; showing pairing dialog.'
  $code = $null
  try {
    $code = Show-GroovyPairingPrompt
    if ($code) {
      Write-InstallLog 'Pairing dialog returned value.'
    } else {
      Write-InstallLog 'Pairing dialog returned empty; trying console fallback.'
    }
  } catch {
    Write-InstallLog "GUI dialog failed: $_"
  }
  if ($code) {
    $env:GROOVY_PAIRING_CODE = $code
  } else {
    Write-InstallLog 'Prompting for pairing code in console fallback.'
    $code = Read-Host 'Enter your Groovy pairing code'
    if ($code) { $env:GROOVY_PAIRING_CODE = $code }
  }
  if (!$env:GROOVY_PAIRING_CODE) {
    Write-InstallLog 'Pairing code is required to finish setup; exiting.'
    Read-Host 'Press Enter to exit'
    exit 1
  }
  $progressForm.Show()
  $progressForm.Refresh()
}

# 5) Start connector (WhatsApp is configured later via the dashboard onboarding)
Update-Progress 'Starting Groovy Connector...'
if ($env:GROOVY_PAIRING_CODE) {
  Write-InstallLog 'Starting launcher with --pair.'
  Start-Process -FilePath $launcherCmd -ArgumentList @('--pair', $env:GROOVY_PAIRING_CODE) -WorkingDirectory $target -WindowStyle Hidden
} else {
  Write-InstallLog 'Starting launcher without --pair.'
  Start-Process -FilePath $launcherCmd -WorkingDirectory $target -WindowStyle Hidden
}
Update-Progress 'Done! Groovy Connector is running.'
Start-Sleep -Seconds 2
$progressForm.Close()
$progressForm.Dispose()
exit 0
`.trim();
  fs.writeFileSync(ps1Path, ps1.replace(/\n/g, "\r\n"), "utf8");
}

function writeWindowsSetupCmd(stageDir) {
  // Thin cmd wrapper that launches the PowerShell helper.
  writeWindowsSetupPs1(stageDir);
  const setupPath = path.resolve(stageDir, "setup.cmd");
  const script = [
    "@echo off",
    "setlocal",
    // Use 'start /WAIT' with a title to force a visible console window on all Windows configs.
    // IExpress sometimes runs setup.cmd in a hidden window; this overrides that.
    'start "Groovy Connector Setup" /WAIT powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-helper.ps1"',
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
  fs.writeFileSync(setupPath, script, "utf8");
}

function writeIexpressSed(stageDir) {
  const sed = [
    "[Version]",
    "Class=IEXPRESS",
    "SEDVersion=3",
    "[Options]",
    "PackagePurpose=InstallApp",
    "ShowInstallProgramWindow=1",
    "HideExtractAnimation=0",
    "UseLongFileName=1",
    "InsideCompressed=1",
    "CAB_FixedSize=0",
    "CAB_ResvCodeSigning=0",
    "RebootMode=N",
    "InstallPrompt=",
    "DisplayLicense=",
    "FinishMessage=",
    `TargetName=${toWindowsPath(exePath)}`,
    "FriendlyName=Groovy Connector Installer",
    "AppLaunched=setup.cmd",
    "PostInstallCmd=<None>",
    "AdminQuietInstCmd=setup.cmd",
    "UserQuietInstCmd=setup.cmd",
    "SourceFiles=SourceFiles",
    "",
    "[Strings]",
    'FILE0="setup.cmd"',
    'FILE1="setup-helper.ps1"',
    `FILE2="${zipName}"`,
    "",
    "[SourceFiles]",
    `SourceFiles0=${toWindowsPath(stageDir)}`,
    "",
    "[SourceFiles0]",
    "%FILE0%=",
    "%FILE1%=",
    "%FILE2%=",
    "",
  ].join("\r\n");
  fs.writeFileSync(installerSedPath, sed, "utf8");
}

function buildWindowsInstallerExe() {
  if (process.platform !== "win32") {
    console.warn("[windows-build] Skipping .exe installer build (requires Windows host).");
    return false;
  }
  if (!fs.existsSync(zipPath)) throw new Error("[windows-build] Missing ZIP bundle for installer.");
  if (fs.existsSync(exePath)) fs.rmSync(exePath, { force: true });
  if (fs.existsSync(installerStageDir)) fs.rmSync(installerStageDir, { recursive: true, force: true });
  ensureDir(installerStageDir);
  fs.copyFileSync(zipPath, path.resolve(installerStageDir, zipName));
  writeWindowsSetupCmd(installerStageDir);
  writeIexpressSed(installerStageDir);

  const iexpressPath = path.resolve(process.env.SystemRoot || "C:\\Windows", "System32", "iexpress.exe");
  const iexpressCmd = fs.existsSync(iexpressPath) ? iexpressPath : "iexpress.exe";
  execFileSync(iexpressCmd, ["/N", toWindowsPath(installerSedPath)], { stdio: "inherit" });

  if (!fs.existsSync(exePath)) {
    throw new Error("[windows-build] Expected installer .exe was not generated.");
  }
  return true;
}

function main() {
  ensureDir(distDir);
  buildRnnoiseNativeAddon(root);
  if (fs.existsSync(bundleDir)) fs.rmSync(bundleDir, { recursive: true, force: true });
  ensureDir(bundleDir);

  for (const rel of requiredPaths) {
    const src = path.resolve(root, rel);
    assertExists(src, rel);
    const dest = path.resolve(bundleDir, rel);
    copyRecursive(src, dest);
  }

  for (const rel of optionalPaths) {
    const src = path.resolve(root, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.resolve(bundleDir, rel);
    copyRecursive(src, dest);
  }

  const nodeModules = path.resolve(root, "node_modules");
  assertExists(nodeModules, "node_modules");
  copyRecursive(nodeModules, path.resolve(bundleDir, "node_modules"));

  const bundledNode = copyNodeRuntimeIfPresent();
  writeLauncher();

  zipBundle();
  const builtExe = buildWindowsInstallerExe();

  console.log(`[windows-build] Built ${zipPath}`);
  console.log(
    `[windows-build] Built installer EXE: ${builtExe && fs.existsSync(exePath) ? "yes" : "no"}`
  );
  console.log(`[windows-build] Bundled Node runtime: ${bundledNode ? "yes" : "no"}`);
}

main();
