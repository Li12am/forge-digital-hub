# Minimal local static server for the ONE-TIME cleanup tool.
# Serves the REPO ROOT (not public/) so cleanup-leads-ONETIME.html can import
# ./public/forge-shared.js by relative path while staying outside public/
# itself — it must never be reachable via `firebase deploy`.
#
# Run:   powershell -ExecutionPolicy Bypass -File serve-root.ps1
# Open:  http://localhost:8899/cleanup-leads-ONETIME.html
# Stop:  close this window, or Ctrl+C

$root = $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://localhost:8899/')
$listener.Start()
Write-Host "Serving $root on http://localhost:8899/"
Write-Host "Open http://localhost:8899/cleanup-leads-ONETIME.html"

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'cleanup-leads-ONETIME.html' }
    $path = Join-Path $root $rel

    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($path).ToLower()
      $ct = $types[$ext]
      if (-not $ct) { $ct = 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($path)
      $ctx.Response.ContentType = $ct
      $ctx.Response.StatusCode = 200
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Host "200 $rel"
    } else {
      $ctx.Response.StatusCode = 404
      Write-Host "404 $rel"
    }
    $ctx.Response.OutputStream.Close()
  } catch {
    Write-Host ("ERR " + $_.Exception.Message)
  }
}
