/** Fixed internal raster helper. Input is data in the shared runner's single base64 environment variable. */
export const WINDOWS_PDF_RASTER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output '{"version":1,"status":"not-run","error":"powershell-constrained"}'
  exit 0
}
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:UNODE_PDF_JOB)) | ConvertFrom-Json
function Reply($state, $code, $total, $completed) {
  @{ version=1; operation_id=$job.operationId; status=$state; error=$code; page_count=$total; completed_pages=$completed } | ConvertTo-Json -Compress
}
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
  $operationMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation')
  } | Select-Object -First 1
  $actionMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  } | Select-Object -First 1
  if (-not $operationMethod -or -not $actionMethod) { throw 'runtime unavailable' }
} catch { Reply 'not-run' 'windows-pdf-unavailable' 0 0; exit 0 }
function Wait-Result($Operation, [Type]$ResultType) {
  $task = $operationMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  return $task.GetAwaiter().GetResult()
}
function Wait-Action($Action) {
  $task = $actionMethod.Invoke($null, @($Action))
  [void]$task.GetAwaiter().GetResult()
}
try {
  $file = Wait-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($job.source)) ([Windows.Storage.StorageFile])
  $document = Wait-Result ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
} catch { Reply 'failed' 'pdf-load-failed' 0 0; exit 0 }
$total = [int64]$document.PageCount
if ($total -le 0) { Reply 'failed' 'pdf-empty' 0 0; exit 0 }
$completed = 0
for ($index = 0; $index -lt $total; $index++) {
  $page = $null; $stream = $null; $reader = $null
  try {
    $page = $document.GetPage($index)
    $width = [double]$page.Size.Width; $height = [double]$page.Size.Height
    if ($width -le 0 -or $height -le 0 -or [double]::IsInfinity($width * $height) -or [double]::IsNaN($width * $height)) { throw 'invalid page size' }
    $scale = [Math]::Min(1200.0 / [Math]::Max($width, $height), [Math]::Sqrt([double]$job.maxNominalPixels / ($width * $height)))
    $options = [Windows.Data.Pdf.PdfPageRenderOptions]::new()
    $options.DestinationWidth = [uint32][Math]::Max(1, [Math]::Floor($width * $scale))
    $options.DestinationHeight = [uint32][Math]::Max(1, [Math]::Floor($height * $scale))
    $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    Wait-Action ($page.RenderToStreamAsync($stream, $options))
    if ($stream.Size -le 0 -or $stream.Size -gt $job.maxImageBytes -or $stream.Size -gt [uint32]::MaxValue) { throw 'image resource bound' }
    [void]$stream.Seek(0)
    $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
    $count = Wait-Result ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])
    if ($count -ne $stream.Size) { throw 'incomplete stream' }
    $bytes = [byte[]]::new([int]$stream.Size)
    [void]$reader.ReadBytes($bytes)
    [IO.File]::WriteAllBytes([IO.Path]::Combine($job.output, ('page-' + ($index + 1) + '.png')), $bytes)
    $completed++
  } catch {
    if ($completed -gt 0) { Reply 'partial' 'page-raster-failed' $total $completed }
    else { Reply 'failed' 'page-raster-failed' $total 0 }
    exit 0
  } finally {
    if ($reader) { [void]$reader.Dispose() }; if ($stream) { [void]$stream.Dispose() }; if ($page) { [void]$page.Dispose() }
  }
}
Reply 'passed' '' $total $completed
`;
