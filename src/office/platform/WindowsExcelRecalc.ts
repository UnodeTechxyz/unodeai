import { encodePowerShellScript, runDocumentWindowsPowerShell, windowsPowerShellPath, WINDOWS_POWERSHELL_ARGS } from '../../host/windowsPowerShell';
import { resolveHostExecutable } from '../../security/HostExecutableResolver';

/**
 * Windows platform adapter: fixed Excel recalculation of one private copy. The helper creates its own Excel instance,
 * proves it is new, hidden and empty before setting any application property, and only then opens the copy read-only
 * with link updates off and macros force-disabled. Stop and the time limit are honoured at checkpoints; nobody ends
 * the Excel process. The helper closes its own workbook and quits only an instance holding nothing else.
 * Write-Receipt replaces the helper's receipt atomically in the host's staging ledger (launching, started, then
 * closed / not-started / unknown), so a host that exits still leaves the facts a later sweep needs.
 */
export const WINDOWS_EXCEL_RECALC_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output '{"version":1,"status":"not-run","error":"powershell-constrained"}'
  exit 0
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:UNODE_WORKBOOK_RECALC_JOB)) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace UnodeExcelNative {
  public static class Window {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  }
}
'@
$clock = [Diagnostics.Stopwatch]::StartNew()
$app = $null; $book = $null; $bookIdentity = [IntPtr]::Zero; $owned = $false; $nativePid = 0
$state = 'failed'; $errorCode = 'native-start-failed'; $nativeApp = 'not-started'; $appVersion = 'unknown'; $calcState = $null
$values = [Collections.Generic.List[object]]::new()
function Write-Receipt([string]$phase) {
  if (-not $job.receipt) { return }
  try {
    $data = [ordered]@{ version = 1; operation_id = [string]$job.operationId; host_pid = [int]$job.hostPid; helper_pid = $PID; process_name = 'EXCEL'; phase = $phase; native_app = $nativeApp }
    if ($nativePid -gt 0) { $data.native_pid = [int]$nativePid }
    $temporary = [string]$job.receipt + '.' + $PID + '.tmp'
    [IO.File]::WriteAllText($temporary, ($data | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($job.receipt)) { [IO.File]::Replace($temporary, $job.receipt, [NullString]::Value) } else { [IO.File]::Move($temporary, $job.receipt) }
  } catch { }
}
function Stop-Requested { return ([IO.File]::Exists($job.stop) -or $clock.ElapsedMilliseconds -ge [int64]$job.nativeTimeoutMs) }
function Checkpoint { if (Stop-Requested) { throw 'stop-requested' } }
function Own-Present {
  # A fresh inventory of this same instance, taken through the helper's own reference.
  $found = $false; $other = $false
  for ($i = 1; $i -le $app.Workbooks.Count; $i++) {
    $item = $app.Workbooks.Item($i); $identity = [Runtime.InteropServices.Marshal]::GetIUnknownForObject($item)
    try { if ($identity -eq $bookIdentity) { $found = $true } else { $other = $true } }
    finally { [void][Runtime.InteropServices.Marshal]::Release($identity); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($item) }
  }
  return @{ found = $found; other = $other; visible = [bool]$app.Visible }
}
try {
  [IO.File]::WriteAllText($job.phase, 'start-invoked')
  $before = @{}
  foreach ($existing in [Diagnostics.Process]::GetProcessesByName('EXCEL')) { $before[$existing.Id] = $true; $existing.Dispose() }
  Write-Receipt 'launching'
  $app = New-Object -ComObject Excel.Application
  $nativeApp = 'unknown'
  $window = [IntPtr]::new([long]$app.Hwnd); $id = [uint32]0
  [void][UnodeExcelNative.Window]::GetWindowThreadProcessId($window, [ref]$id); $nativePid = [int]$id
  if ($nativePid -gt 0 -and -not $before.ContainsKey($nativePid)) {
    $process = [Diagnostics.Process]::GetProcessById($nativePid)
    try {
      if ($process.ProcessName -eq 'EXCEL' -and $app.Workbooks.Count -eq 0 -and -not [UnodeExcelNative.Window]::IsWindowVisible($window)) { $owned = $true }
    } finally { $process.Dispose() }
  }
  Write-Receipt 'started'
  if (-not $owned) { $state = 'not-run'; $errorCode = 'office-instance-not-private'; throw 'not-private' }
  [IO.File]::WriteAllText($job.phase, 'owned')
  $app.DisplayAlerts = $false; $app.EnableEvents = $false; $app.AutomationSecurity = 3; $app.AskToUpdateLinks = $false; $app.ScreenUpdating = $false
  Checkpoint
  $missing = [Type]::Missing; $errorCode = 'native-open-failed'
  $book = $app.Workbooks.Open($job.source, 0, $true, $missing, $missing, $missing, $true, $missing, $missing, $false, $false, $missing, $false)
  $bookIdentity = [Runtime.InteropServices.Marshal]::GetIUnknownForObject($book)
  [IO.File]::WriteAllText($job.phase, 'opened')
  if (-not [String]::Equals([IO.Path]::GetFullPath($book.FullName), $job.source, [StringComparison]::OrdinalIgnoreCase)) { throw 'owned-workbook-unavailable' }
  $appVersion = [string]$app.Version; if ($appVersion -notmatch '^[0-9.]{1,64}$') { $appVersion = 'unknown' }
  Checkpoint
  $errorCode = 'native-calculation-failed'
  $app.CalculateFull()
  $calcState = [int]$app.CalculationState
  Checkpoint
  if ($calcState -ne 0) { $errorCode = 'recalc-incomplete'; throw 'calculation-not-done' }
  $errorCode = 'native-read-failed'
  foreach ($target in $job.targets) {
    $sheet = $book.Sheets.Item([int]$target.position); $range = $sheet.Range([string]$target.cell)
    try {
      $value = $range.Value2
      if ($null -eq $value) { $values.Add(@{ i = [int]$target.i; kind = 'blank' }) }
      elseif ($value -is [double]) { $values.Add(@{ i = [int]$target.i; kind = 'n'; value = $value.ToString('R', [Globalization.CultureInfo]::InvariantCulture) }) }
      elseif ($value -is [string]) { $values.Add(@{ i = [int]$target.i; kind = 'str'; value = $value }) }
      elseif ($value -is [bool]) { $values.Add(@{ i = [int]$target.i; kind = 'b'; value = $(if ($value) { '1' } else { '0' }) }) }
      elseif ($value -is [int]) { $values.Add(@{ i = [int]$target.i; kind = 'e'; code = ([int64]$value + 2146828288) }) }
      else { $values.Add(@{ i = [int]$target.i; kind = 'unknown' }) }
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($range); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($sheet) }
  }
  Checkpoint
  [IO.File]::WriteAllText($job.phase, 'read')
  $state = 'passed'; $errorCode = $null
} catch {
  if ($_.Exception.Message -eq 'stop-requested' -or ($state -ne 'not-run' -and (Stop-Requested))) {
    $state = 'stopped'; $errorCode = $(if ([IO.File]::Exists($job.stop)) { 'cancelled' } else { 'native-stage-timeout' })
  }
} finally {
  if ($app -and $owned) {
    try {
      $present = Own-Present
      if ($book -and $present.found) { [void]$book.Close($false); $present = Own-Present }
      if (-not $present.found -and -not $present.other -and -not $present.visible) { [void]$app.Quit(); $nativeApp = 'quit-by-helper' }
      else { $nativeApp = 'left-running' }
    } catch { $nativeApp = 'unknown' }
  }
  if ($bookIdentity -ne [IntPtr]::Zero) { [void][Runtime.InteropServices.Marshal]::Release($bookIdentity) }
  if ($book) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($book) } catch {} }
  if ($app) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) } catch {} }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  if ($nativeApp -eq 'quit-by-helper' -and $nativePid -gt 0) {
    # Observe the exit after Quit; a process still running is reported, never ended.
    try { $process = [Diagnostics.Process]::GetProcessById($nativePid); try { if (-not $process.WaitForExit(15000)) { $nativeApp = 'left-running' } } finally { $process.Dispose() } } catch {}
  }
  if ($nativeApp -eq 'not-started') { Write-Receipt 'not-started' } elseif ($nativeApp -eq 'quit-by-helper') { Write-Receipt 'closed' } else { Write-Receipt 'unknown' }
}
@{ version=1; operation_id=$job.operationId; status=$state; error=$errorCode; app_version=$appVersion; calculation_state=$calcState; native_app=$nativeApp; native_pid=$nativePid; values=$values } | ConvertTo-Json -Compress -Depth 4
`;

export interface WindowsExcelRecalcLaunch {
  /** The process the command approval binds: Windows PowerShell from the system folder. */
  program: string;
  /** Exact text shown and bound by the ordinary command approval. */
  command: string;
  /** Runs the fixed helper once. It is never given an abort signal: Stop and the deadline use the helper's stop marker. */
  run(input: object, folders: { cwd: string; tmp: string; onSpawn?: (pid: number) => void }): ReturnType<typeof runDocumentWindowsPowerShell>;
}
/**
 * The Windows launch of the fixed Excel helper; undefined when Windows PowerShell is not available here. All Windows
 * PowerShell paths, encoding and execution of the recalculation stay in this adapter.
 */
export function windowsExcelRecalcLaunch(ports: { env?: NodeJS.ProcessEnv; resolve?: (command: string) => string; execute?: typeof runDocumentWindowsPowerShell } = {}): WindowsExcelRecalcLaunch | undefined {
  const env = ports.env ?? process.env; const root = env.SystemRoot ?? env.SYSTEMROOT; if (!root) return undefined;
  let program: string; try { program = (ports.resolve ?? resolveHostExecutable)(windowsPowerShellPath(root)); } catch { return undefined; }
  const encoded = encodePowerShellScript(WINDOWS_EXCEL_RECALC_SCRIPT); const execute = ports.execute ?? runDocumentWindowsPowerShell;
  return { program, command: `& "${program.replace(/"/g, '""')}" ${WINDOWS_POWERSHELL_ARGS.join(' ')} ${encoded}`,
    run: (input, folders) => execute({ encodedCommand: encoded, inputVariable: 'UNODE_WORKBOOK_RECALC_JOB', input: Buffer.from(JSON.stringify(input)).toString('base64'),
      maxInputChars: 4_000_000, maxStdoutBytes: 16 * 1024 * 1024, cwd: folders.cwd, tmp: folders.tmp, signal: new AbortController().signal,
      // Only the helper may close its Excel: an output overflow stops collecting output, never the helper itself.
      helperClosesApplication: true, ...(folders.onSpawn ? { onSpawn: folders.onSpawn } : {}) }) };
}
