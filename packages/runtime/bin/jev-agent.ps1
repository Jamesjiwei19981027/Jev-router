$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  [Console]::Error.WriteLine("jev-agent: node was not found on PATH")
  exit 127
}

$userEnvironmentNames = @(
  "TYPESAFE_API_KEY",
  "TYPESAFE_API_KEY_FILE",
  "JEV_API_KEY",
  "JEV_BASE_URL",
  "JEV_API_URL",
  "JEV_MODEL",
  "JEV_TIMEOUT_MS",
  "SAVE_TOKEN_JEV_KEEP_THRESHOLD",
  "SAVE_TOKEN_JEV_PRESERVE_RECENT",
  "SAVE_TOKEN_JEV_MIN_REDUCTION",
  "SAVE_TOKEN_JEV_DASHBOARD_PORT"
)
foreach ($name in $userEnvironmentNames) {
  if (-not (Get-Item -Path ("Env:" + $name) -ErrorAction SilentlyContinue)) {
    $userValue = [Environment]::GetEnvironmentVariable($name, "User")
    if ($null -ne $userValue -and $userValue.Length -gt 0) {
      Set-Item -Path ("Env:" + $name) -Value $userValue
    }
  }
}

$keyFile = if ($env:TYPESAFE_API_KEY_FILE) { $env:TYPESAFE_API_KEY_FILE } else { [Environment]::GetEnvironmentVariable("TYPESAFE_API_KEY_FILE", "User") }
if ($keyFile -and (Test-Path -LiteralPath $keyFile)) {
  $fileValue = (Get-Content -Raw -LiteralPath $keyFile).Trim()
  if ($fileValue) { Set-Item -Path "Env:TYPESAFE_API_KEY" -Value $fileValue }
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$entrypoint = Join-Path $scriptRoot "jev-agent.mjs"
& $node.Source $entrypoint @args
exit $LASTEXITCODE
