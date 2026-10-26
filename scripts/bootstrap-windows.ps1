param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$scriptDir = $PSScriptRoot
$root = Split-Path -Parent $scriptDir
Set-Location -LiteralPath $root

$versionFile = Join-Path $scriptDir 'node-version.txt'
if (-not (Test-Path -LiteralPath $versionFile)) {
  throw '缺少 scripts/node-version.txt，无法确定 Node.js 版本。'
}
$nodeVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim()
if (-not $nodeVersion) {
  throw 'scripts/node-version.txt 内容为空。'
}

function Get-NodeVersion([string]$exe) {
  try {
    $output = & $exe --version 2>$null
    $code = $LASTEXITCODE
    if ($code -eq 0 -and $output) {
      return "$(@($output)[0])".Trim()
    }
  } catch {
    # Not a usable Node.js executable.
  }
  return $null
}

function Test-NodeRuntime([string]$exe) {
  try {
    & $exe -e "process.exit(process.features.typescript ? 0 : 1)" 2>$null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Get-PortableArch {
  switch ($env:PROCESSOR_ARCHITECTURE.ToUpperInvariant()) {
    'ARM64' { return 'arm64' }
    default { return 'x64' }
  }
}

$arch = Get-PortableArch
$runtimeRoot = Join-Path $root '.runtime'
$portableDir = Join-Path $runtimeRoot "node-$nodeVersion-win-$arch"
$portableNode = Join-Path $portableDir 'node.exe'
$nodeExe = $null

if (Test-Path -LiteralPath $portableNode) {
  if (Test-NodeRuntime $portableNode) {
    $nodeExe = $portableNode
  } else {
    Write-Host '便携版 Node.js 不完整，正在重新准备 ...'
    Remove-Item -LiteralPath $portableDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (-not $nodeExe) {
  $systemNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($systemNode) {
    $systemVersion = Get-NodeVersion $systemNode.Source
    if (Test-NodeRuntime $systemNode.Source) {
      Write-Host "使用系统 Node.js $systemVersion"
      $nodeExe = $systemNode.Source
    } elseif ($systemVersion) {
      Write-Host "系统 Node.js $systemVersion 版本过低，需要 22.18 或更高，将使用便携版。"
    }
  }
}

if (-not $nodeExe) {
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

  $zipName = "node-$nodeVersion-win-$arch.zip"
  $zipPath = Join-Path $runtimeRoot $zipName
  $checksumPath = Join-Path $runtimeRoot "SHASUMS256-$arch.txt"
  $official = "https://nodejs.org/dist/$nodeVersion"
  $mirror = "https://npmmirror.com/mirrors/node/$nodeVersion"

  Write-Host "首次运行：正在下载便携版 Node.js $nodeVersion ($arch) ..."
  $downloaded = $false
  foreach ($base in @($official, $mirror)) {
    try {
      Write-Host "  正在连接 $base"
      Invoke-WebRequest -Uri "$base/$zipName" -OutFile $zipPath -UseBasicParsing
      Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -OutFile $checksumPath -UseBasicParsing
      $downloaded = $true
      break
    } catch {
      Write-Host '  下载失败，尝试备用线路 ...'
      Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $checksumPath -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not $downloaded) {
    throw 'Node.js 下载失败。请检查网络，或手动安装 Node.js 22.18+ 后重试：https://nodejs.org/'
  }

  $expected = Get-Content -LiteralPath $checksumPath |
    Where-Object { $_ -match "\s$([regex]::Escape($zipName))$" } |
    ForEach-Object { ($_ -split '\s+')[0] } |
    Select-Object -First 1
  if (-not $expected) {
    throw 'Node.js 校验文件中没有找到对应条目。'
  }
  $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected.ToLowerInvariant()) {
    throw 'Node.js 下载文件校验失败，请删除 .runtime 后重试。'
  }

  Write-Host '正在准备 Node.js ...'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entry = $archive.Entries |
      Where-Object { $_.FullName -eq "node-$nodeVersion-win-$arch/node.exe" } |
      Select-Object -First 1
    if (-not $entry) {
      throw 'Node.js 压缩包中未找到 node.exe。'
    }
    New-Item -ItemType Directory -Path $portableDir -Force | Out-Null
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $portableNode, $true)
  } finally {
    $archive.Dispose()
  }
  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $checksumPath -Force -ErrorAction SilentlyContinue

  if (-not (Test-Path -LiteralPath $portableNode)) {
    throw 'Node.js 解压失败，未找到 node.exe。'
  }
  $nodeExe = $portableNode
}

if ($NoBrowser -or $env:VIDEO_DOWNLOADER_NO_BROWSER -eq '1') {
  Remove-Item Env:OPEN_BROWSER -ErrorAction SilentlyContinue
} else {
  $env:OPEN_BROWSER = '1'
}

Write-Host '正在启动视频下载器 ...'
Write-Host '使用期间请保持此窗口开启；按 Ctrl+C 可停止服务。'
& $nodeExe 'src/server.ts'
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
  Write-Host "服务异常退出（代码 $exitCode）。"
  exit $exitCode
}
