import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import readline from "readline";
import { isDarwin, isWindows } from "../detect.mjs";

const execFileAsync = promisify(execFile);

function singleQuotePowerShell(text) {
  return String(text || "").replace(/'/g, "''");
}

function windowsPairingPromptScript(title, promptText) {
  const winTitle = singleQuotePowerShell(title);
  const winPrompt = singleQuotePowerShell(promptText);
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "[System.Windows.Forms.Application]::EnableVisualStyles()",
    "$form = New-Object System.Windows.Forms.Form",
    `$form.Text = '${winTitle}'`,
    "$form.ClientSize = New-Object System.Drawing.Size -ArgumentList 440, 184",
    "$form.StartPosition = 'CenterScreen'",
    "$form.FormBorderStyle = 'FixedDialog'",
    "$form.MaximizeBox = $false",
    "$form.MinimizeBox = $false",
    "$form.TopMost = $true",
    "$form.ShowInTaskbar = $true",
    "$label = New-Object System.Windows.Forms.Label",
    `$label.Text = '${winPrompt}'`,
    "$label.AutoSize = $false",
    "$label.Location = New-Object System.Drawing.Point -ArgumentList 16, 16",
    "$label.Size = New-Object System.Drawing.Size -ArgumentList 408, 24",
    "$label.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 10",
    "[void]$form.Controls.Add($label)",
    "$hintLabel = New-Object System.Windows.Forms.Label",
    "$hintLabel.Text = 'Get a code from gogroovy.ai -> Dashboard'",
    "$hintLabel.AutoSize = $false",
    "$hintLabel.Location = New-Object System.Drawing.Point -ArgumentList 16, 42",
    "$hintLabel.Size = New-Object System.Drawing.Size -ArgumentList 408, 20",
    "$hintLabel.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 8.5",
    "$hintLabel.ForeColor = [System.Drawing.SystemColors]::GrayText",
    "[void]$form.Controls.Add($hintLabel)",
    "$textBox = New-Object System.Windows.Forms.TextBox",
    "$textBox.Location = New-Object System.Drawing.Point -ArgumentList 16, 74",
    "$textBox.Size = New-Object System.Drawing.Size -ArgumentList 408, 26",
    "$textBox.Font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', 10",
    "[void]$form.Controls.Add($textBox)",
    "$ok = New-Object System.Windows.Forms.Button",
    "$ok.Text = 'Connect'",
    "$ok.Location = New-Object System.Drawing.Point -ArgumentList 250, 124",
    "$ok.Size = New-Object System.Drawing.Size -ArgumentList 82, 30",
    "$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK",
    "$ok.Enabled = $false",
    "[void]$form.Controls.Add($ok)",
    "$cancel = New-Object System.Windows.Forms.Button",
    "$cancel.Text = 'Cancel'",
    "$cancel.Location = New-Object System.Drawing.Point -ArgumentList 342, 124",
    "$cancel.Size = New-Object System.Drawing.Size -ArgumentList 82, 30",
    "$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel",
    "[void]$form.Controls.Add($cancel)",
    "$form.AcceptButton = $ok",
    "$form.CancelButton = $cancel",
    "$textBox.Add_TextChanged({ $ok.Enabled = $textBox.Text.Trim().Length -gt 0 })",
    "$form.Add_Shown({ $form.Activate(); $form.BringToFront(); [void]$textBox.Focus() })",
    "$selected = $null",
    "try { if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $selected = $textBox.Text.Trim() } } finally { $form.Dispose() }",
    "if ($selected) { Write-Output $selected }",
  ].join("; ");
}

function promptInTerminal(promptText) {
  return new Promise((resolve) => {
    if (!process.stdin?.isTTY || !process.stdout?.isTTY) {
      resolve({ ok: false, error: "pairing_prompt_not_tty" });
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const done = (result) => {
      try {
        rl.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    rl.on("SIGINT", () => done({ ok: false, error: "pairing_prompt_cancelled" }));
    rl.question(`${promptText} `, (answer) => {
      const value = String(answer || "").trim();
      if (!value) {
        done({ ok: false, error: "empty_pairing_code" });
        return;
      }
      done({ ok: true, value });
    });
  });
}

export async function promptForPairingCode(options = {}) {
  const envCode = String(process.env.GROOVY_PAIRING_CODE || "").trim();
  if (envCode) return { ok: true, value: envCode };

  const title = String(options.title || "Groovy Connector");
  const promptText = String(options.prompt || "Enter your Groovy pairing code:");

  if (isDarwin) {
    const script = [
      `display dialog "${promptText.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}" default answer "" buttons {"Cancel","Connect"} default button "Connect"`,
      "set enteredText to text returned of result",
      "return enteredText",
    ].join("\n");
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 180_000 });
      const value = String(stdout || "").trim();
      if (!value) return { ok: false, error: "empty_pairing_code" };
      return { ok: true, value };
    } catch {
      return { ok: false, error: "pairing_prompt_cancelled" };
    }
  }

  if (isWindows) {
    const script = windowsPairingPromptScript(title, promptText);
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-Command", script],
        { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }
      );
      const value = String(stdout || "").trim();
      if (!value) {
        const terminalFallback = await promptInTerminal(`${promptText}:`);
        if (terminalFallback?.ok) return terminalFallback;
        return { ok: false, error: terminalFallback?.error || "pairing_prompt_cancelled" };
      }
      return { ok: true, value };
    } catch (error) {
      const terminalFallback = await promptInTerminal(`${promptText}:`);
      if (terminalFallback?.ok) return terminalFallback;
      const detail = error instanceof Error ? error.message : String(error || "");
      return {
        ok: false,
        error: detail ? `pairing_prompt_failed:${detail}` : "pairing_prompt_failed",
      };
    }
  }

  return { ok: false, error: "pairing_prompt_not_supported" };
}

export async function pickFolder(options = {}) {
  const envPath = String(process.env.GROOVY_SHARED_ROOT || "").trim();
  if (envPath) return { ok: true, path: envPath };

  const promptText = String(options.prompt || "Select a folder to share with Groovy");

  if (isDarwin) {
    const script = [
      `set pickedFolder to choose folder with prompt "${promptText.replace(/"/g, '\\"')}"`,
      "set posixPath to POSIX path of pickedFolder",
      "return posixPath",
    ].join("\n");
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 180_000 });
      const selected = String(stdout || "").trim();
      if (!selected) return { ok: false, error: "no_folder_selected" };
      return { ok: true, path: selected };
    } catch {
      return { ok: false, error: "folder_picker_cancelled" };
    }
  }

  if (isWindows) {
    const winPrompt = singleQuotePowerShell(promptText);
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `$dialog = New-Object System.Windows.Forms.FolderBrowserDialog`,
      `$dialog.Description = '${winPrompt}'`,
      "$dialog.ShowNewFolderButton = $true",
      `$dialog.RootFolder = [System.Environment+SpecialFolder]::Desktop`,
      "$result = $dialog.ShowDialog()",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {",
      "  Write-Output $dialog.SelectedPath",
      "}",
    ].join("; ");
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        { windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 }
      );
      const selected = String(stdout || "").trim();
      if (!selected) return { ok: false, error: "folder_picker_cancelled" };
      return { ok: true, path: selected };
    } catch {
      return { ok: false, error: "folder_picker_failed" };
    }
  }

  return { ok: false, error: "folder_picker_not_supported_on_this_os" };
}

export async function promptForCredentials(options = {}) {
  const domain = String(options.domain || "site").trim();
  const reason = String(options.reason || "authentication required").trim();
  const securityNote = String(options.securityNote || "").trim();

  if (isDarwin) {
    const userScript = [
      `display dialog "Groovy needs login for ${domain.replace(/"/g, '\\"')}\\n\\nReason: ${reason.replace(/"/g, '\\"')}" with title "Credential Required" default answer "" buttons {"Cancel","Continue"} default button "Continue"`,
      "set enteredUser to text returned of result",
      "return enteredUser",
    ].join("\n");

    try {
      const { stdout: userOut } = await execFileAsync("osascript", ["-e", userScript], { timeout: 180_000 });
      const username = String(userOut || "").trim();
      if (!username) return { ok: false, error: "cancelled" };

      const passScript = [
        `display dialog "Enter password for ${username.replace(/"/g, '\\"')} @ ${domain.replace(/"/g, '\\"')}" with title "Password Required" default answer "" with hidden answer buttons {"Cancel","Submit"} default button "Submit"`,
        "set enteredPass to text returned of result",
        "return enteredPass",
      ].join("\n");
      const { stdout: passOut } = await execFileAsync("osascript", ["-e", passScript], { timeout: 180_000 });
      const password = String(passOut || "").trim();
      if (!password) return { ok: false, error: "cancelled" };
      return { ok: true, username, password };
    } catch {
      return { ok: false, error: "cancelled" };
    }
  }

  if (isWindows) {
    const d = singleQuotePowerShell(domain);
    const r = singleQuotePowerShell(reason);
    const note = singleQuotePowerShell(securityNote || "Credentials are used locally and never echoed.");
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$form = New-Object System.Windows.Forms.Form",
      "$form.Text = 'Groovy Connector - Credentials'",
      "$form.Width = 460",
      "$form.Height = 260",
      "$form.StartPosition = 'CenterScreen'",
      "$form.TopMost = $true",
      `$lbl = New-Object System.Windows.Forms.Label; $lbl.Text = 'Login required for ${d}'; $lbl.Left = 14; $lbl.Top = 12; $lbl.Width = 420; $form.Controls.Add($lbl)`,
      `$reason = New-Object System.Windows.Forms.Label; $reason.Text = 'Reason: ${r}'; $reason.Left = 14; $reason.Top = 34; $reason.Width = 420; $form.Controls.Add($reason)`,
      `$sec = New-Object System.Windows.Forms.Label; $sec.Text = '${note}'; $sec.Left = 14; $sec.Top = 54; $sec.Width = 420; $form.Controls.Add($sec)`,
      "$uLbl = New-Object System.Windows.Forms.Label; $uLbl.Text = 'Username'; $uLbl.Left = 14; $uLbl.Top = 84; $uLbl.Width = 80; $form.Controls.Add($uLbl)",
      "$u = New-Object System.Windows.Forms.TextBox; $u.Left = 100; $u.Top = 80; $u.Width = 320; $form.Controls.Add($u)",
      "$pLbl = New-Object System.Windows.Forms.Label; $pLbl.Text = 'Password'; $pLbl.Left = 14; $pLbl.Top = 118; $pLbl.Width = 80; $form.Controls.Add($pLbl)",
      "$p = New-Object System.Windows.Forms.TextBox; $p.Left = 100; $p.Top = 114; $p.Width = 320; $p.UseSystemPasswordChar = $true; $form.Controls.Add($p)",
      "$ok = New-Object System.Windows.Forms.Button; $ok.Text = 'Submit'; $ok.Left = 264; $ok.Top = 160; $ok.Width = 75; $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK; $form.Controls.Add($ok)",
      "$cancel = New-Object System.Windows.Forms.Button; $cancel.Text = 'Cancel'; $cancel.Left = 345; $cancel.Top = 160; $cancel.Width = 75; $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel; $form.Controls.Add($cancel)",
      "$form.AcceptButton = $ok; $form.CancelButton = $cancel",
      "$result = $form.ShowDialog()",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $u.Text -and $p.Text) {",
      "  @{ username = $u.Text; password = $p.Text } | ConvertTo-Json -Compress",
      "}",
    ].join("; ");

    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        { windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 }
      );
      const parsed = JSON.parse(String(stdout || "{}"));
      const username = String(parsed?.username || "").trim();
      const password = String(parsed?.password || "");
      if (!username || !password) return { ok: false, error: "cancelled" };
      return { ok: true, username, password };
    } catch {
      return { ok: false, error: "cancelled" };
    }
  }

  return {
    ok: false,
    error: "credentials_prompt_not_supported",
    suggestion: `Set credentials manually on ${os.homedir()} via connector config`,
  };
}
