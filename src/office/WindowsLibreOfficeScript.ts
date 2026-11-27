/** Fixed conversion of one passive host copy in a fresh private profile. Never touches the user's profile,
 * global Office settings or other processes. On a stop request or the native deadline it ends only the conversion
 * processes it identified itself: children of its own live loader whose arguments carry this operation's exact
 * private profile, held by process handle, then the loader. The host never signals this helper. */
export const WINDOWS_LIBREOFFICE_RENDER_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output '{"version":1,"status":"not-run","error":"powershell-constrained","native_app":"not-started","stage_released":true}'
  exit 0
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:UNODE_OFFICE_RENDER_JOB)) | ConvertFrom-Json
$state = 'failed'; $errorCode = $null; $closed = $false; $appVersion = 'unknown'; $proc = $null
$launched = $false; $loaderTicks = [int64]0; $children = @{}; $scanComplete = $true; $stopReason = $null
$nativeApp = 'not-started'; $nativeReason = 'application-not-created'; $stageReleased = $false
$nativeClock = [Diagnostics.Stopwatch]::StartNew()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace UnodeLibreOffice {
  public static class Argv {
    [DllImport("shell32.dll", SetLastError = true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    // The exact parsed argument, compared ordinally: a longer path that merely contains the profile never matches.
    public static bool HasExact(string commandLine, string expected) {
      if (String.IsNullOrEmpty(commandLine)) return false;
      int count; IntPtr list = CommandLineToArgvW(commandLine, out count);
      if (list == IntPtr.Zero) return false;
      try {
        for (int i = 0; i < count; i++) {
          if (String.Equals(Marshal.PtrToStringUni(Marshal.ReadIntPtr(list, i * IntPtr.Size)), expected, StringComparison.Ordinal)) return true;
        }
        return false;
      } finally { LocalFree(list); }
    }
  }
}
'@
function Write-Receipt([string]$phase) {
  if (-not $job.receipt) { return }
  try {
    $data = [ordered]@{ version = 1; operation_id = [string]$job.operationId; host_pid = [int]$job.hostPid; helper_pid = $PID; process_name = 'soffice'; phase = $phase; native_app = $nativeApp; native_reason = $nativeReason; children_complete = $scanComplete }
    if ($proc -and $loaderTicks -gt 0) { $data.loader_pid = $proc.Id; $data.loader_start_ticks = $loaderTicks }
    $data.children = @($children.Keys | ForEach-Object { [ordered]@{ pid = [int]$_; start_ticks = $children[$_].ticks } })
    $temporary = [string]$job.receipt + '.' + $PID + '.tmp'
    [IO.File]::WriteAllText($temporary, ($data | ConvertTo-Json -Compress -Depth 4), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($job.receipt)) { [IO.File]::Replace($temporary, $job.receipt, [NullString]::Value) } else { [IO.File]::Move($temporary, $job.receipt) }
  } catch { }
}
function Scan-Children {
  # Identification only while the held loader is alive; a dead loader's number is never used to adopt a process.
  if ($proc.HasExited) { return }
  try {
    $rows = @(Get-CimInstance -ClassName Win32_Process -Filter ('ParentProcessId=' + $proc.Id) -ErrorAction Stop)
    foreach ($row in $rows) {
      $id = [int]$row.ProcessId
      if ($children.ContainsKey($id) -or -not [UnodeLibreOffice.Argv]::HasExact([string]$row.CommandLine, $profileArgument)) { continue }
      $child = $null; try { $child = [Diagnostics.Process]::GetProcessById($id) } catch { continue }
      $ticks = [int64]0; try { $ticks = $child.StartTime.ToUniversalTime().Ticks } catch { $child.Dispose(); continue }
      # The same process as the queried row, started after the loader, while the loader is still alive.
      if ($proc.HasExited -or $ticks -lt $loaderTicks -or [Math]::Abs($row.CreationDate.ToUniversalTime().Ticks - $ticks) -gt 10000000) { $child.Dispose(); continue }
      $children[$id] = @{ process = $child; ticks = $ticks }
      Write-Receipt 'started'
    }
  } catch { $script:scanComplete = $false }
}
try {
  if ($job.kind -notin @('docx','pptx')) { throw 'invalid-kind' }
  if ((Get-FileHash -LiteralPath $job.executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $job.executableSha256) { throw 'renderer-changed' }
  if ($job.passiveChartCopy -eq $true -and ((Get-FileHash -LiteralPath $job.source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $job.renderCopySha256)) { throw 'render-copy-changed' }
  if ($job.stop -and [IO.File]::Exists($job.stop)) { $stopReason = 'stop'; throw 'native-stop-requested' }
  # UserInstallation is the fresh operation profile, not the person's normal LibreOffice profile.
  $profile = Join-Path ([IO.Path]::GetDirectoryName($job.source)) 'libreoffice-profile'
  if ([IO.Directory]::Exists($profile) -or [IO.File]::Exists($profile)) { throw 'profile-already-exists' }
  [void][IO.Directory]::CreateDirectory((Join-Path $profile 'user'))
  # LibreOffice implements its own chart model through the embedded-object engine. Only the host's
  # verified passive chart copy needs it; package/OLE/external filtering and macro blocking stay in force.
  $disableActiveContent = if ($job.passiveChartCopy -eq $true) { 'false' } else { 'true' }
  $config = '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="DisableActiveContent" oor:op="fuse"><value>' + $disableActiveContent + '</value></prop><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item><item oor:path="/org.openoffice.Office.Common/Filter/PDF/Export"><prop oor:name="ExportHiddenSlides" oor:op="fuse"><value>true</value></prop></item></oor:items>'
  [IO.File]::WriteAllText((Join-Path $profile 'user\registrymodifications.xcu'), $config, [Text.UTF8Encoding]::new($false))
  $profileUri = [Uri]::new($profile).AbsoluteUri
  $profileArgument = '-env:UserInstallation=' + $profileUri
  $inputFilter = if ($job.kind -eq 'docx') { 'Office Open XML Text' } else { 'Impress MS PowerPoint 2007 XML' }
  $outputFilter = if ($job.kind -eq 'docx') { 'pdf:writer_pdf_Export' } else { 'pdf:impress_pdf_Export' }
  $nativeArgs = @($profileArgument, '--headless', '--invisible', '--nodefault', '--nologo', '--norestore', '--nofirststartwizard', ('--infilter=' + $inputFilter), '--convert-to', $outputFilter, '--outdir', $job.output, $job.source)
  # These fixed arguments have no embedded quotes or trailing backslashes. No shell/eval/extra flags.
  foreach ($arg in $nativeArgs) { if ($arg.Contains('"') -or $arg.EndsWith('\')) { throw 'invalid-argument' } }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $job.executable
  $start.Arguments = ($nativeArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $start.WorkingDirectory = $job.helperHome
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.WindowStyle = 'Hidden'
  $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  $proc = [Diagnostics.Process]::new(); $proc.StartInfo = $start
  [IO.File]::WriteAllText($job.phase, 'starting-private-profile', [Text.UTF8Encoding]::new($false))
  $nativeApp = 'unknown'; $nativeReason = 'loader-start-unconfirmed'; Write-Receipt 'launching'
  $launched = $proc.Start(); if (-not $launched) { throw 'start-failed' }
  $loaderTicks = $proc.StartTime.ToUniversalTime().Ticks; $nativeReason = 'conversion-running'; Write-Receipt 'started'
  # Drain both streams without retaining arbitrary document/app text or deadlocking on full pipes.
  $stdoutDrain = $proc.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
  $stderrDrain = $proc.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
  while ($true) {
    Scan-Children
    if ($proc.WaitForExit(500)) { break }
    if ($job.stop -and [IO.File]::Exists($job.stop)) { $stopReason = 'stop'; break }
    if ([int64]$job.nativeTimeoutMs -gt 0 -and $nativeClock.ElapsedMilliseconds -ge [int64]$job.nativeTimeoutMs) { $stopReason = 'timeout'; break }
  }
  if ($stopReason) {
    # Recorded conversion processes first (same process and start time), then the held loader.
    foreach ($entry in @($children.Values)) {
      try { if (-not $entry.process.HasExited -and $entry.process.StartTime.ToUniversalTime().Ticks -eq $entry.ticks) { $entry.process.Kill() } } catch { }
    }
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
    throw ('native-' + $stopReason)
  }
  [void]$stdoutDrain.GetAwaiter().GetResult(); [void]$stderrDrain.GetAwaiter().GetResult()
  # LibreOffice's Windows loader waits for its own .bin process; no global Quit or process kill.
  $closed = $true
  if ($proc.ExitCode -ne 0) { throw 'export-failed' }
  $pdf = Join-Path $job.output 'render-copy.pdf'
  $info = [IO.FileInfo]::new($pdf)
  if (-not $info.Exists -or $info.Length -le 0 -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'pdf-missing' }
  [IO.File]::Move($pdf, $job.pdf)
  $appVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($job.executable).ProductVersion
  [IO.File]::WriteAllText($job.phase, 'private-profile-process-exited', [Text.UTF8Encoding]::new($false))
  $state = 'passed'
} catch { $state = 'failed' }
finally {
  if ($null -ne $proc -and $loaderTicks -gt 0) {
    # Every recorded conversion process and the loader must be seen to exit (at most five seconds) before the
    # stage is released. Not finding a child is not proof that all exited when the scan itself failed.
    $wait = [Diagnostics.Stopwatch]::StartNew(); $allExited = $true
    foreach ($process in @(@($children.Values | ForEach-Object { $_.process }) + $proc)) {
      try { if (-not $process.WaitForExit([int][Math]::Max(0, 5000 - $wait.ElapsedMilliseconds))) { $allExited = $false } } catch { $allExited = $false }
    }
    if (-not $allExited) { $nativeApp = 'left-running'; $nativeReason = 'exit-unconfirmed' }
    elseif (-not $scanComplete) { $nativeApp = 'unknown'; $nativeReason = 'conversion-process-scan-failed' }
    else { $nativeApp = 'ended'; $nativeReason = if ($stopReason) { 'ended-at-' + $stopReason } else { 'conversion-exited' } }
  } elseif ($launched) { $nativeApp = 'unknown'; $nativeReason = 'loader-start-unconfirmed' }
  else { $nativeApp = 'not-started'; $nativeReason = 'application-not-created' }
  $stageReleased = @('ended', 'not-started') -contains $nativeApp
  if ($nativeApp -eq 'not-started') { Write-Receipt 'not-started' } elseif ($stageReleased) { Write-Receipt 'closed' } else { Write-Receipt 'unknown' }
  foreach ($entry in @($children.Values)) { $entry.process.Dispose() }
  if ($null -ne $proc) { $proc.Dispose() }
}
if ($stopReason -eq 'timeout') { $errorCode = 'native-stage-timeout' } elseif ($stopReason -eq 'stop') { $errorCode = 'native-stop-requested' }
@{version=1; operation_id=$job.operationId; status=$state; error=$errorCode; document_closed=$closed; app_version=$appVersion; page_count=0; completed_pages=0; native_app=$nativeApp; native_reason=$nativeReason; stage_released=$stageReleased} | ConvertTo-Json -Compress
`;
