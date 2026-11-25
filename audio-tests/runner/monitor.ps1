param(
  [Parameter(Mandatory = $true)]
  [string]$RunId,
  [string]$ProjectName,
  [ValidateRange(1, 60)]
  [int]$IntervalSeconds = 1
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $ProjectName) {
  $composeFile = Join-Path $repoRoot "compose.test.yaml"
  $composeJson = @(& docker compose --project-directory $repoRoot -f $composeFile config --format json)
  if ($LASTEXITCODE -ne 0 -or -not $composeJson) {
    throw "Could not read the Compose project name from compose.test.yaml and the root .env file."
  }
  $composeConfig = ($composeJson -join [Environment]::NewLine) | ConvertFrom-Json
  $ProjectName = [string]$composeConfig.name
  if ([string]::IsNullOrWhiteSpace($ProjectName)) {
    throw "Compose did not return a project name. Check COMPOSE_PROJECT_NAME in .env."
  }
}

if ($RunId -notmatch '^[a-zA-Z0-9_-]{1,80}$') {
  throw "RunId may contain only letters, numbers, underscores and hyphens (max 80 characters)."
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker CLI was not found. Run this monitor on the Docker host."
}

$resultsDir = Join-Path $PSScriptRoot "..\results"
New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
$outputPath = Join-Path $resultsDir "$RunId-resources.csv"

Write-Host "Sampling Docker project '$ProjectName' every $IntervalSeconds second(s)."
Write-Host "Writing resource samples to $outputPath"
Write-Host "Press Ctrl+C to stop."

$hasNvidiaSmi = [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)

while ($true) {
  $timestamp = [DateTime]::UtcNow.ToString("o")
  $projectContainers = @(& docker ps --filter "label=com.docker.compose.project=$ProjectName" --format "{{.Names}}")
  if ($LASTEXITCODE -ne 0) {
    throw "docker ps failed. Is Docker Desktop running?"
  }

  $statsLines = @(& docker stats --no-stream --format "{{json .}}")
  if ($LASTEXITCODE -ne 0) {
    throw "docker stats failed."
  }

  $gpu = @()
  if ($hasNvidiaSmi) {
    $gpuLine = & nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    if ($LASTEXITCODE -eq 0 -and $gpuLine) {
      $gpu = @($gpuLine -split ',\s*')
    }
  }

  $gpuUtil = if ($gpu.Count -ge 5) { $gpu[0].Trim() } else { $null }
  $gpuMemoryUsed = if ($gpu.Count -ge 5) { $gpu[1].Trim() } else { $null }
  $gpuMemoryTotal = if ($gpu.Count -ge 5) { $gpu[2].Trim() } else { $null }
  $gpuTemperature = if ($gpu.Count -ge 5) { $gpu[3].Trim() } else { $null }
  $gpuPower = if ($gpu.Count -ge 5) { $gpu[4].Trim() } else { $null }

  foreach ($line in $statsLines) {
    if (-not $line) { continue }
    $stat = $line | ConvertFrom-Json
    if ($projectContainers -notcontains $stat.Name) { continue }

    [pscustomobject]@{
      TimestampUtc = $timestamp
      RunId = $RunId
      Container = $stat.Name
      CpuPercent = $stat.CPUPerc
      MemoryUsage = $stat.MemUsage
      MemoryPercent = $stat.MemPerc
      GpuUtilizationPercent = $gpuUtil
      GpuMemoryUsedMiB = $gpuMemoryUsed
      GpuMemoryTotalMiB = $gpuMemoryTotal
      GpuTemperatureC = $gpuTemperature
      GpuPowerW = $gpuPower
    } | Export-Csv -Path $outputPath -NoTypeInformation -Append:(Test-Path $outputPath)
  }

  Start-Sleep -Seconds $IntervalSeconds
}
