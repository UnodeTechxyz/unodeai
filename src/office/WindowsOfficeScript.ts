/**
 * Fixed passive-copy helper. Only this helper may close Word/PowerPoint: it closes its own document and quits only a
 * newly created, identified private application after a fresh inventory of that same instance. Nothing here or in the
 * host force-ends an Office application; a stop request or the native deadline is acted on at the next checkpoint.
 *
 * Notes kept out of the script, whose encoded form must stay within the Windows command-line limit:
 * - Write-Receipt replaces the receipt atomically in the host's ledger, so a host that exits still leaves the facts.
 * - Test-Stop is the checkpoint, after the previous COM call returned, for the stop marker and the native deadline.
 * - COM collections are assigned directly: emitting one from an if pipeline can enumerate it into its items.
 * - Word has no HWND before its first document. CoCreateInstance creates a new Word process; the unique newly started
 *   matching server is accepted only while its COM instance is empty and hidden.
 * - The held process handle later confirms this exact process exited; its number cannot be reused meanwhile.
 * - A person's already-running application is never ours to quit; an unidentified new one stays unknown.
 * - The same close path serves completion, stop and deadline: a fresh inventory of this instance decides what is
 *   closed, and an enumeration failure is never taken as proof of close.
 */
export const WINDOWS_OFFICE_RENDER_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output '{"version":1,"status":"not-run","error":"powershell-constrained","native_app":"not-started","stage_released":true}'
  exit 0
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:UNODE_OFFICE_RENDER_JOB)) | ConvertFrom-Json
$app = $null; $document = $null; $ownedIdentity = [IntPtr]::Zero; $ownedProcess = $null; $window = [IntPtr]::Zero
$applicationOwned = $false; $applicationQuit = $false; $stopRequested = $false; $timedOut = $false
$nativePid = [uint32]0; $nativeTicks = [int64]0; $processName = if ($job.kind -eq 'docx') { 'WINWORD' } else { 'POWERPNT' }
$nativeClock = [Diagnostics.Stopwatch]::StartNew(); $M = [Runtime.InteropServices.Marshal]
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace UnodeOfficeNative {
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
function Own-Present {
  $found = $false; $other = $false
  try {
    $collection = $null
    if ($job.kind -eq 'docx') { $collection = $app.Documents } else { $collection = $app.Presentations }
    for ($i = 1; $i -le $collection.Count; $i++) {
      $item = $collection.Item($i); $identity = $M::GetIUnknownForObject($item)
      try {
        if ($identity -eq $ownedIdentity) {
          if (-not [String]::Equals([IO.Path]::GetFullPath($item.FullName), $job.source, [StringComparison]::OrdinalIgnoreCase)) { $script:shared = 'unknown'; return $false }
          $found = $true
        } else { $other = $true }
      } finally { [void]$M::Release($identity) }
    }
    $script:shared = if ($other) { 'shared' } else { 'owned-only-at-enumeration' }
    return $found
  } catch { $script:shared = 'unknown'; return $false }
}
function Get-Inventory {
  try {
    $collection = $null
    if ($job.kind -eq 'docx') { $collection = $app.Documents } else { $collection = $app.Presentations }
    if ([int]$collection.Count -eq 0) { return 'empty' } else { return 'documents' }
  } catch { return 'error' }
}
try {
  [IO.File]::WriteAllText($job.phase, 'open-invoked')
  $beforeNative = @{}
  foreach ($existing in [Diagnostics.Process]::GetProcessesByName($processName)) {
    $beforeNative[$existing.Id] = $true; $existing.Dispose()
  }
  if ($job.kind -eq 'pptx' -and $job.requirePrivateApplication -and $beforeNative.Count -gt 0) {
    $state = 'not-run'; $errorCode = 'powerpoint-already-running'; throw 'automatic-powerpoint-in-use'
  }
  Test-Stop
  $nativeReason = 'launch-unconfirmed'; Write-Receipt 'launching'
  $creationStarted = [DateTime]::UtcNow
  if ($job.kind -eq 'docx') {
    $app = New-Object -ComObject Word.Application
  } elseif ($job.kind -eq 'pptx') {
    $app = New-Object -ComObject PowerPoint.Application
  } else { throw 'invalid fixed operation' }
  $nativeApp = 'unknown'; $nativeReason = 'ownership-not-confirmed'
  $window = [IntPtr]::new([long]$app.Hwnd)
  [void][UnodeOfficeNative.Window]::GetWindowThreadProcessId($window, [ref]$nativePid)
  if ($job.kind -eq 'docx' -and $nativePid -eq 0 -and $app.Documents.Count -eq 0 -and -not $app.Visible) {
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
      $count = if ($job.kind -eq 'docx') { $app.Documents.Count } else { $app.Presentations.Count }
      if ($nativeProcess.ProcessName -eq $processName -and $count -eq 0 -and -not [UnodeOfficeNative.Window]::IsWindowVisible($window)) {
        $applicationOwned = $true; $nativeTicks = $nativeProcess.StartTime.ToUniversalTime().Ticks
        $ownedProcess = $nativeProcess; $keepProcess = $true
        if ($job.kind -eq 'docx') { $app.DisplayAlerts = 0 } else { $app.DisplayAlerts = 1 }
      }
    } finally { if (-not $keepProcess) { $nativeProcess.Dispose() } }
  }
  if ($applicationOwned) { $nativeReason = 'private-application' }
  elseif ($nativePid -gt 0 -and $beforeNative.ContainsKey([int]$nativePid)) { $nativeApp = 'left-running'; $nativeReason = 'existing-application' }
  else { $nativeApp = 'unknown'; $nativeReason = 'ownership-not-confirmed' }
  Write-Receipt 'started'
  if ($job.kind -eq 'pptx' -and $job.requirePrivateApplication -and -not $applicationOwned) {
    $state = 'not-run'; $errorCode = 'powerpoint-shared-application'; throw 'automatic-powerpoint-not-private'
  }
  Test-Stop
  if ($job.kind -eq 'docx') {
    $missing = [Type]::Missing
    $document = $app.Documents.Open($job.source, $false, $true, $false, $missing, $missing, $false, $missing, $missing, $missing, $missing, $false)
  } elseif ($job.kind -eq 'pptx') {
    $document = $app.Presentations.Open($job.source, -1, 0, 0)
  } else { throw 'invalid fixed operation' }
  $ownedIdentity = $M::GetIUnknownForObject($document)
  [IO.File]::WriteAllText($job.phase, 'opened')
  Test-Stop
  $appVersion = [string]$app.Version
  if ($appVersion -notmatch '^[0-9.]{1,64}$') { $appVersion = 'unknown' }
  $errorCode = 'native-export-failed'
  if (-not (Own-Present)) { throw 'owned-document-unavailable' }
  Test-Stop
  if ($job.kind -eq 'docx') {
    [void]$document.ExportAsFixedFormat($job.pdf, 17, $false)
    Test-Stop
  } elseif ($job.intent -eq 'deliver-pdf') {
    [void]$document.SaveAs($job.pdf, 32)
    Test-Stop
  } else {
    $total = [int64]$document.Slides.Count
    if ($total -le 0) { throw 'empty presentation' }
    $width = [double]$document.PageSetup.SlideWidth; $height = [double]$document.PageSetup.SlideHeight
    if ($width -le 0 -or $height -le 0 -or [double]::IsInfinity($width * $height) -or [double]::IsNaN($width * $height)) { throw 'invalid slide dimensions' }
    $scale = [Math]::Min(1200.0 / [Math]::Max($width, $height), [Math]::Sqrt([double]$job.maxNominalPixels / ($width * $height)))
    $pixelsWide = [int][Math]::Max(1, [Math]::Floor($width * $scale)); $pixelsHigh = [int][Math]::Max(1, [Math]::Floor($height * $scale))
    for ($i = 1; $i -le $total; $i++) {
      [void]$document.Slides.Item($i).Export([IO.Path]::Combine($job.output, ('page-' + $i + '.png')), 'PNG', $pixelsWide, $pixelsHigh)
      $completed++
      Test-Stop
    }
  }
  Test-Stop
  $state = 'passed'
} catch { if ($completed -gt 0) { $state = 'partial' } }
finally {
  $documentOpened = $document -and $ownedIdentity -ne [IntPtr]::Zero
  if ($documentOpened) {
    try {
      if (Own-Present) {
        if ($job.kind -eq 'docx') { [void]$document.Close(0) }
        elseif ($document.Saved -eq -1) { [void]$document.Close() }
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
    $visible = $null; try { $visible = [bool]$app.Visible -or [UnodeOfficeNative.Window]::IsWindowVisible($window) } catch { $visible = $null }
    if (-not $ownDocumentGone) { $nativeApp = 'unknown'; $nativeReason = 'own-document-not-closed' }
    elseif ($inventory -eq 'error' -or $null -eq $visible) { $nativeApp = 'unknown'; $nativeReason = 'inventory-failed' }
    elseif ($inventory -eq 'documents') { $nativeApp = 'left-running'; $nativeReason = if ($stopRequested -or $timedOut) { 'shared-at-stop' } else { 'shared' } }
    elseif ($visible) { $nativeApp = 'left-running'; $nativeReason = 'visible-adopted' }
    else {
      try {
        if ($job.kind -eq 'docx') { $quitSave = [object]0; [void]$app.Quit([ref]$quitSave) } else { [void]$app.Quit() }
        $quitRequested = $true
      } catch { $nativeApp = 'unknown'; $nativeReason = 'quit-failed' }
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
if ($timedOut) { $state = if ($completed -gt 0) { 'partial' } else { 'failed' }; $errorCode = 'native-stage-timeout' }
elseif ($stopRequested) { $state = 'failed'; $errorCode = 'native-stop-requested' }
if ($state -eq 'passed') { $errorCode = $null }
@{ version=1; operation_id=$job.operationId; status=$state; error=$errorCode; app_version=$appVersion; application_state=$shared; application_owned=$applicationOwned; application_quit=$applicationQuit; document_closed=$closed; page_count=$total; completed_pages=$completed; native_app=$nativeApp; native_reason=$nativeReason; stage_released=$stageReleased } | ConvertTo-Json -Compress
`;
