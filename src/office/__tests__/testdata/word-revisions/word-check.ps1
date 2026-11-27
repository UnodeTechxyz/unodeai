# Test-only Microsoft Word check. Not part of the product. Windows only.
# Starts ONE new hidden Word instance, uses it only when it is identified as newly created by this script
# (same rule as the product's native render helper), never ends any other Word process, and quits only
# the owned instance after its own documents are closed.
#
# Job JSON (UTF-8 file named by -JobFile):
#   { "source": <docx>, "saveAs": <docx or null>, "result": <json output path> }
# Result JSON: owned, quit, opened, error, revisions, comments, accepted/rejected text per story.
param([Parameter(Mandatory = $true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
$result = [ordered]@{ owned = $false; quit = $false; opened = $false; error = $null; app_version = $null
  revisions = @(); comments = @(); accepted = $null; rejected = $null; saved = $false }
$app = $null; $documents = New-Object System.Collections.ArrayList
$before = @{}
foreach ($existing in [Diagnostics.Process]::GetProcessesByName('WINWORD')) { $before[$existing.Id] = $true; $existing.Dispose() }
function Open-Owned([string]$path, [bool]$readOnly) {
  $missing = [Type]::Missing
  $doc = $app.Documents.Open($path, $false, $readOnly, $false, $missing, $missing, $false, $missing, $missing, $missing, $missing, $true)
  # A document window inside the hidden application: revision decisions need one; the application stays hidden.
  [void]$documents.Add($doc); return $doc
}
function Close-Owned($doc) {
  try { [void]$doc.Close(0) } catch { }
  [void]$documents.Remove($doc)
  try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) } catch { }
}
function Decide-All($doc, [bool]$accept) {
  if ($accept) { $doc.AcceptAllRevisions() } else { $doc.RejectAllRevisions() }
}
function Story-Texts($doc) {
  $header = ''
  try { $header = [string]$doc.Sections.Item(1).Headers.Item(1).Range.Text } catch { $header = '' }
  return [ordered]@{ body = [string]$doc.Content.Text; header = $header }
}
try {
  $started = [DateTime]::UtcNow
  $app = New-Object -ComObject Word.Application
  $fresh = @([Diagnostics.Process]::GetProcessesByName('WINWORD') | Where-Object { -not $before.ContainsKey($_.Id) })
  try {
    if ($fresh.Count -eq 1 -and $fresh[0].StartTime.ToUniversalTime() -ge $started.AddSeconds(-2) -and $app.Documents.Count -eq 0 -and -not $app.Visible) {
      $result.owned = $true
    }
  } finally { foreach ($process in $fresh) { $process.Dispose() } }
  if (-not $result.owned) { throw 'word-instance-not-owned' }
  $app.DisplayAlerts = 0
  $result.app_version = [string]$app.Version
  $doc = Open-Owned $job.source ($null -eq $job.saveAs)
  $result.opened = $true
  if ($job.saveAs) {
    [void]$doc.SaveAs2([string]$job.saveAs, 16)
    $result.saved = $true
    Close-Owned $doc
    $doc = Open-Owned ([string]$job.saveAs) $true
  }
  $revisions = @()
  $stories = @(@{ name = 'body'; range = $doc.Content })
  try { $stories += @{ name = 'header'; range = $doc.Sections.Item(1).Headers.Item(1).Range } } catch { }
  foreach ($story in $stories) {
    $collection = $story.range.Revisions
    for ($i = 1; $i -le $collection.Count; $i++) {
      $item = $collection.Item($i)
      $revisions += [ordered]@{ story = $story.name; type = [int]$item.Type; author = [string]$item.Author; text = [string]$item.Range.Text }
    }
  }
  $result.revisions = $revisions
  $result.documents_open = [int]$app.Documents.Count
  $comments = @(); $starts = @()
  for ($i = 1; $i -le $doc.Comments.Count; $i++) { $starts += [int]$doc.Comments.Item($i).Range.Start }
  for ($i = 1; $i -le $doc.Comments.Count; $i++) {
    $comment = $doc.Comments.Item($i); $ancestor = 0
    try { $parent = $comment.Ancestor; if ($parent) { $ancestor = [array]::IndexOf($starts, [int]$parent.Range.Start) + 1 } } catch { $ancestor = -1 }
    $done = $null; try { $done = [bool]$comment.Done } catch { $done = $null }
    $comments += [ordered]@{ author = [string]$comment.Author; initial = [string]$comment.Initial; text = [string]$comment.Range.Text
      scope = [string]$comment.Scope.Text; done = $done; ancestor = $ancestor }
  }
  $result.comments = $comments
  Decide-All $doc $true; $result.accepted = Story-Texts $doc
  Close-Owned $doc
  $doc = Open-Owned ([string]$(if ($job.saveAs) { $job.saveAs } else { $job.source })) $true
  Decide-All $doc $false; $result.rejected = Story-Texts $doc
  Close-Owned $doc
} catch {
  $result.error = [string]$_.Exception.Message
} finally {
  foreach ($doc in @($documents)) { Close-Owned $doc }
  if ($app -and $result.owned) {
    # The instance is this script's own: any document still open in it (for example one Word opened itself) is closed unsaved.
    try { while ($app.Documents.Count -gt 0) { [void]$app.Documents.Item(1).Close(0) } } catch { $result.error = [string]$result.error + ' close-remaining-failed' }
    try { if ($app.Documents.Count -eq 0) { $quitSave = [object]0; [void]$app.Quit([ref]$quitSave); $result.quit = $true } } catch { }
  }
  if ($app) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) } catch { } }
}
[IO.File]::WriteAllText([string]$job.result, ($result | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
