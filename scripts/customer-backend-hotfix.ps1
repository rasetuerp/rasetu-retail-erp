param(
  [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"

$supabaseUrl = "https://doopelkfucwiogrylysj.supabase.co"
$supabaseAnonKey = "sb_publishable_Fp4R_QUz_d_Hzs0pBA2eKw_986nPQzz"

function New-JwtSecret {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Find-RaSetuInstallDir {
  if ($InstallDir) {
    $resolved = Resolve-Path -LiteralPath $InstallDir -ErrorAction Stop
    return $resolved.Path
  }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\rasetu-retail-erp"),
    (Join-Path $env:LOCALAPPDATA "Programs\RaSetu Retail ERP"),
    (Join-Path $env:ProgramFiles "RaSetu Retail ERP"),
    (Join-Path ${env:ProgramFiles(x86)} "RaSetu Retail ERP")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $candidate "RaSetu Retail ERP.exe")) {
      return $candidate
    }
  }

  $programsDir = Join-Path $env:LOCALAPPDATA "Programs"
  if (Test-Path -LiteralPath $programsDir) {
    $exe = Get-ChildItem -LiteralPath $programsDir -Filter "RaSetu Retail ERP.exe" -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($exe) {
      return $exe.DirectoryName
    }
  }

  throw "RaSetu install folder was not found. Re-run with: -InstallDir `"C:\path\to\RaSetu Retail ERP`""
}

$installPath = Find-RaSetuInstallDir
$resourcesPath = Join-Path $installPath "resources"
$sourceBackend = Join-Path $resourcesPath "app.asar.unpacked\backend"
$targetBackend = Join-Path $resourcesPath "backend"
$exePath = Join-Path $installPath "RaSetu Retail ERP.exe"

if (!(Test-Path -LiteralPath $sourceBackend)) {
  throw "Could not find packaged backend at: $sourceBackend"
}

Write-Host "Closing RaSetu..."
Get-Process "RaSetu Retail ERP" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Write-Host "Copying backend to old expected path..."
if (Test-Path -LiteralPath $targetBackend) {
  Remove-Item -LiteralPath $targetBackend -Recurse -Force
}
Copy-Item -LiteralPath $sourceBackend -Destination $targetBackend -Recurse

$jwtSecret = [Environment]::GetEnvironmentVariable("JWT_SECRET", "User")
if (!$jwtSecret -or $jwtSecret.Length -lt 32) {
  $jwtSecret = New-JwtSecret
}

Write-Host "Saving backend environment..."
[Environment]::SetEnvironmentVariable("JWT_SECRET", $jwtSecret, "User")
[Environment]::SetEnvironmentVariable("JWT_TTL_HOURS", "12", "User")
[Environment]::SetEnvironmentVariable("SUPABASE_URL", $supabaseUrl, "User")
[Environment]::SetEnvironmentVariable("SUPABASE_ANON_KEY", $supabaseAnonKey, "User")

$env:JWT_SECRET = $jwtSecret
$env:JWT_TTL_HOURS = "12"
$env:SUPABASE_URL = $supabaseUrl
$env:SUPABASE_ANON_KEY = $supabaseAnonKey

@"
JWT_SECRET="$jwtSecret"
JWT_TTL_HOURS=12
SUPABASE_URL="$supabaseUrl"
SUPABASE_ANON_KEY="$supabaseAnonKey"
"@ | Set-Content -LiteralPath (Join-Path $installPath ".env") -Encoding UTF8

Write-Host "Starting RaSetu..."
Start-Process -FilePath $exePath -WorkingDirectory $installPath
Start-Sleep -Seconds 8

Write-Host "Checking backend..."
try {
  Invoke-RestMethod "http://127.0.0.1:4100/health" | ConvertTo-Json -Compress
  Write-Host "Hotfix applied successfully."
} catch {
  Write-Host "Backend still did not respond. Restart Windows once, then open RaSetu again."
  Write-Host "If it still fails, send this file:"
  Write-Host (Join-Path $env:APPDATA "RaSetu Retail ERP\backend.log")
  throw
}
