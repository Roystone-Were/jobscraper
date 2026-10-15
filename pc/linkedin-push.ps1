# Fetches the LinkedIn job searches from this PC and pushes the result pages to
# the Worker (POST /linkedin). LinkedIn answers Cloudflare's IPs with HTTP 429,
# but not a normal PC. Run by Task Scheduler (see install-task.ps1).
# Works with Windows PowerShell 5.1; no installs needed.

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# Office networks often need the signed-in user's proxy credentials.
[Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials

$dir = $PSScriptRoot
$logFile = Join-Path $dir "linkedin-push.log"
function Log($msg) {
  $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $msg
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

# linkedin-push.config.json: { "worker": "https://....workers.dev", "key": "<LINKEDIN_PUSH_KEY>" }
$config = Get-Content (Join-Path $dir "linkedin-push.config.json") -Raw | ConvertFrom-Json
$worker = $config.worker.TrimEnd("/")
$key = [Uri]::EscapeDataString($config.key)

$userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

try {
  # The searches live in wrangler.jsonc (LINKEDIN_KEYWORDS), so they are only set in one place.
  $searches = Invoke-RestMethod -Uri "$worker/linkedin?key=$key" -UseBasicParsing -TimeoutSec 30
  $total = 0
  $pushed = 0
  $first = $true
  foreach ($keyword in $searches.keywords) {
    # A few seconds apart, not a burst.
    if (-not $first) { Start-Sleep -Seconds (Get-Random -Minimum 8 -Maximum 20) }
    $first = $false

    $q = "keywords=" + [Uri]::EscapeDataString($keyword) +
      "&location=" + [Uri]::EscapeDataString($searches.location) +
      "&f_TPR=r86400&sortBy=DD&start=0"
    try {
      $page = Invoke-WebRequest -Uri "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?$q" `
        -UseBasicParsing -TimeoutSec 30 -UserAgent $userAgent -Headers @{ "Accept-Language" = "en-US,en;q=0.9" }
    } catch {
      $status = $_.Exception.Response.StatusCode.value__
      Log "LinkedIn '$keyword' failed: HTTP $status $($_.Exception.Message)"
      # Rate-limited: the rest would fail too, so try again next time.
      if ($status -eq 429 -or $status -eq 999) { break }
      continue
    }

    # Send the raw bytes so the page's UTF-8 survives untouched.
    $body = $page.RawContentStream.ToArray()
    $result = Invoke-RestMethod -Method Post -Uri "$worker/linkedin?key=$key&keyword=$([Uri]::EscapeDataString($keyword))" `
      -Body $body -ContentType "text/html; charset=utf-8" -UseBasicParsing -TimeoutSec 30
    $total += $result.parsed
    $pushed++
    Log "LinkedIn '$keyword': $($result.parsed) jobs pushed"
  }
  Log "Done: $total jobs pushed from $pushed of $($searches.keywords.Count) searches"
  if ($pushed -eq 0) { exit 2 }
} catch {
  Log "Run failed: $($_.Exception.Message)"
  exit 1
} finally {
  # Keep the log small.
  if (Test-Path $logFile) {
    $lines = Get-Content $logFile -Encoding UTF8
    if ($lines.Count -gt 500) { $lines | Select-Object -Last 300 | Set-Content $logFile -Encoding UTF8 }
  }
}
