/**
 * Fixed Word helper for PDF -> DOCX conversion (convert_pdf_to_docx). It follows the passive-copy helper's ownership
 * rules (WindowsOfficeScript.ts): a newly created Word process is accepted only while it is empty and hidden; only
 * then are DisplayAlerts set; the helper closes only its own document and quits only that empty private instance after
 * a fresh inventory. Nothing here or in the host force-ends Word; a stop request or the native deadline is acted on at
 * the next checkpoint.
 *
 * Word shows a "convert your PDF" notice that DisplayAlerts and ConfirmConversions do not suppress; in a hidden
 * instance it blocks Documents.Open. The helper therefore reads (never writes) the user's own Word setting that turns
 * the notice off, right before Word starts, and does not start Word unless it is on.
 * After SaveAs2 the document's FullName is the new .docx path, so the own-document check accepts the copy or that path.
 */
export const WINDOWS_WORD_PDF_CONVERT_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output '{"version":1,"status":"not-run","error":"powershell-constrained","native_app":"not-started","stage_released":true}'
  exit 0
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:UNODE_OFFICE_RENDER_JOB)) | ConvertFrom-Json
$app = $null; $document = $null; $ownedIdentity = [IntPtr]::Zero; $ownedProcess = $null; $window = [IntPtr]::Zero
$applicationOwned = $false; $applicationQuit = $false; $stopRequested = $false; $timedOut = $false
$nativePid = [uint32]0; $nativeTicks = [int64]0; $processName = 'WINWORD'
$nativeClock = [Diagnostics.Stopwatch]::StartNew(); $M = [Runtime.InteropServices.Marshal]
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace UnodeWordPdf {
  public static class Window {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  }
}
'@
$shared = 'unknown'; $closed = $false; $appVersion = 'unknown'
$state = 'failed'; $errorCode = 'native-start-failed'; $total = 0; $completed = 0
$nativeApp = 'not-started'; $nativeReason = 'application-not-created'; $stageReleased = $false
function Write-Receipt([string]$phase) {
  if (-not $job.receipt) { return }
  try {
    $data = [ordered]@{ version = 1; operation_id = [string]$job.operationId; host_pid = [int]$job.hostPid; helper_pid = $PID; process_name = $processName; phase = $phase; native_app = $nativeApp; native_reason = $nativeReason }
    if ($nativePid -gt 0) { $data.native_pid = [int]$nativePid; $data.native_start_ticks = $nativeTicks; $data.application_owned = $applicationOwned }
    $temporary = [string]$job.receipt + '.' + $PID + '.tmp'
    [IO.File]::WriteAllText($temporary, ($data | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($job.receipt)) { [IO.File]::Replace($temporary, $job.receipt, [NullString]::Value) } else { [IO.File]::Move($temporary, $job.receipt) }
  } catch { }
}
function Test-Stop {
  if ($job.stop -and [IO.File]::Exists($job.stop)) { $script:stopRequested = $true; throw 'native-stop-requested' }
  if ([int64]$job.nativeTimeoutMs -gt 0 -and $nativeClock.ElapsedMilliseconds -ge [int64]$job.nativeTimeoutMs) { $script:timedOut = $true; throw 'native-stage-timeout' }
}
function Test-Own([string]$name) {
  foreach ($path in @($job.source, $job.docx)) { if ([String]::Equals($name, $path, [StringComparison]::OrdinalIgnoreCase)) { return $true } }
  return $false
}
function Own-Present {
  $found = $false; $other = $false
  try {
    $collection = $app.Documents
    for ($i = 1; $i -le $collection.Count; $i++) {
      $item = $collection.Item($i); $identity = $M::GetIUnknownForObject($item)
      try {
        if ($identity -eq $ownedIdentity) {
          if (-not (Test-Own ([IO.Path]::GetFullPath($item.FullName)))) { $script:shared = 'unknown'; return $false }
          $found = $true
        } else { $other = $true }
      } finally { [void]$M::Release($identity) }
    }
    $script:shared = if ($other) { 'shared' } else { 'owned-only-at-enumeration' }
    return $found
  } catch { $script:shared = 'unknown'; return $false }
}
function Get-Inventory {
  try { if ([int]$app.Documents.Count -eq 0) { return 'empty' } else { return 'documents' } } catch { return 'error' }
}
try {
  [IO.File]::WriteAllText($job.phase, 'open-invoked')
  $notice = $null
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Office\16.0\Word\Options', $false)
    if ($key) { try { $notice = $key.GetValue('DisableConvertPdfWarning', $null) } finally { $key.Dispose() } }
  } catch { $notice = $null }
  if (-not ($notice -is [int]) -or $notice -ne 1) { $state = 'not-run'; $errorCode = 'word-pdf-prompt-on'; throw 'word-pdf-notice-on' }
  $beforeNative = @{}
  foreach ($existing in [Diagnostics.Process]::GetProcessesByName($processName)) {
    $beforeNative[$existing.Id] = $true; $existing.Dispose()
  }
  Test-Stop
  $nativeReason = 'launch-unconfirmed'; Write-Receipt 'launching'
  $creationStarted = [DateTime]::UtcNow
  $app = New-Object -ComObject Word.Application
  $nativeApp = 'unknown'; $nativeReason = 'ownership-not-confirmed'
  $window = [IntPtr]::new([long]$app.Hwnd)
  [void][UnodeWordPdf.Window]::GetWindowThreadProcessId($window, [ref]$nativePid)
  if ($nativePid -eq 0 -and $app.Documents.Count -eq 0 -and -not $app.Visible) {
    $newNative = @([Diagnostics.Process]::GetProcessesByName($processName) | Where-Object { -not $beforeNative.ContainsKey($_.Id) })
    try {
      if ($newNative.Count -eq 1 -and $newNative[0].StartTime.ToUniversalTime() -ge $creationStarted -and
        [String]::Equals($newNative[0].MainModule.FileName, [IO.Path]::Combine($app.Path, 'WINWORD.EXE'), [StringComparison]::OrdinalIgnoreCase)) {
        $nativePid = [uint32]$newNative[0].Id
      }
    } finally { foreach ($candidateProcess in $newNative) { $candidateProcess.Dispose() } }
  }
  if ($nativePid -gt 0 -and -not $beforeNative.ContainsKey([int]$nativePid)) {
    $nativeProcess = [Diagnostics.Process]::GetProcessById([int]$nativePid)
    $keepProcess = $false
    try {
      if ($nativeProcess.ProcessName -eq $processName -and $app.Documents.Count -eq 0 -and -not [UnodeWordPdf.Window]::IsWindowVisible($window)) {
        $applicationOwned = $true; $nativeTicks = $nativeProcess.StartTime.ToUniversalTime().Ticks
        $ownedProcess = $nativeProcess; $keepProcess = $true
        $app.DisplayAlerts = 0
      }
    } finally { if (-not $keepProcess) { $nativeProcess.Dispose() } }
  }
  if ($applicationOwned) { $nativeReason = 'private-application' }
  elseif ($nativePid -gt 0 -and $beforeNative.ContainsKey([int]$nativePid)) { $nativeApp = 'left-running'; $nativeReason = 'existing-application' }
  else { $nativeApp = 'unknown'; $nativeReason = 'ownership-not-confirmed' }
  Write-Receipt 'started'
  # A shared or unidentified Word keeps its own alert settings, so the conversion never runs there.
  if (-not $applicationOwned) { $state = 'not-run'; $errorCode = 'office-instance-not-private'; throw 'word-not-private' }
  Test-Stop
  $missing = [Type]::Missing
  $document = $app.Documents.Open($job.source, $false, $true, $false, $missing, $missing, $false, $missing, $missing, $missing, $missing, $false)
  $ownedIdentity = $M::GetIUnknownForObject($document)
  [IO.File]::WriteAllText($job.phase, 'opened')
  Test-Stop
  $appVersion = [string]$app.Version
  if ($appVersion -notmatch '^[0-9.]{1,64}$') { $appVersion = 'unknown' }
  $errorCode = 'native-export-failed'
  if (-not (Own-Present)) { throw 'owned-document-unavailable' }
  Test-Stop
  [void]$document.SaveAs2($job.docx, 16)
  Test-Stop
  if (-not (Own-Present)) { throw 'owned-document-unavailable' }
  $state = 'passed'
} catch { }
finally {
  $documentOpened = $document -and $ownedIdentity -ne [IntPtr]::Zero
  if ($documentOpened) {
    try {
      if (Own-Present) {
        [void]$document.Close(0)
        $closed = -not (Own-Present)
        if ($shared -eq 'unknown') { $closed = $false }
      }
    } catch { $closed = $false }
  }
  if ($ownedIdentity -ne [IntPtr]::Zero) { [void]$M::Release($ownedIdentity) }
  $ownDocumentGone = $closed -or -not $document
  $quitRequested = $false
  if ($app -and $applicationOwned) {
    $inventory = Get-Inventory
    $visible = $null; try { $visible = [bool]$app.Visible -or [UnodeWordPdf.Window]::IsWindowVisible($window) } catch { $visible = $null }
    if (-not $ownDocumentGone) { $nativeApp = 'unknown'; $nativeReason = 'own-document-not-closed' }
    elseif ($inventory -eq 'error' -or $null -eq $visible) { $nativeApp = 'unknown'; $nativeReason = 'inventory-failed' }
    elseif ($inventory -eq 'documents') { $nativeApp = 'left-running'; $nativeReason = if ($stopRequested -or $timedOut) { 'shared-at-stop' } else { 'shared' } }
    elseif ($visible) { $nativeApp = 'left-running'; $nativeReason = 'visible-adopted' }
    else {
      try { $quitSave = [object]0; [void]$app.Quit([ref]$quitSave); $quitRequested = $true }
      catch { $nativeApp = 'unknown'; $nativeReason = 'quit-failed' }
    }
  } elseif ($app) {
    if (-not $ownDocumentGone) { $nativeApp = 'unknown'; $nativeReason = 'own-document-not-closed' }
  }
  if ($document) { try { [void]$M::FinalReleaseComObject($document) } catch {} }
  if ($app) { try { [void]$M::FinalReleaseComObject($app) } catch {} }
  $document = $null; $app = $null; [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  if ($quitRequested) {
    $exited = $false; try { $exited = $ownedProcess.WaitForExit(15000) } catch { $exited = $false }
    if ($exited) { $applicationQuit = $true; $nativeApp = 'quit-by-helper'; $nativeReason = 'inventory-empty-at-close' }
    else { $nativeApp = 'unknown'; $nativeReason = 'quit-exit-unconfirmed' }
  }
  if ($ownedProcess) { $ownedProcess.Dispose() }
  $stageReleased = $ownDocumentGone -and @('quit-by-helper', 'left-running', 'not-started') -contains $nativeApp
  if ($nativeApp -eq 'not-started') { Write-Receipt 'not-started' } elseif ($stageReleased) { Write-Receipt 'closed' } else { Write-Receipt 'unknown' }
}
if ($timedOut) { $state = 'failed'; $errorCode = 'native-stage-timeout' }
elseif ($stopRequested) { $state = 'failed'; $errorCode = 'native-stop-requested' }
if ($state -eq 'passed') { $errorCode = $null }
@{ version=1; operation_id=$job.operationId; status=$state; error=$errorCode; app_version=$appVersion; application_state=$shared; application_owned=$applicationOwned; application_quit=$applicationQuit; document_closed=$closed; page_count=$total; completed_pages=$completed; native_app=$nativeApp; native_reason=$nativeReason; stage_released=$stageReleased } | ConvertTo-Json -Compress
`;
