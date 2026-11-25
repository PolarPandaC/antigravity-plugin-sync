param(
  [ValidateSet('Install', 'Uninstall')][string]$Mode = 'Install',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
)
$ErrorActionPreference = 'Stop'

$candidates = @()
$nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if ($nodeCmd) { $candidates += $nodeCmd.Source }
$appData = [Environment]::GetFolderPath('ApplicationData')
$candidates += (Join-Path $appData 'Antigravity/bin/agy-node.cmd')

$runtime = $null
foreach ($cand in $candidates) {
  if (-not (Test-Path -LiteralPath $cand)) { continue }
  $verStr = & $cand --version 2>$null
  if ($LASTEXITCODE -eq 0 -and "$verStr".Trim() -match '^v?(\d+)\.(\d+)') {
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    if ($major -gt 22 -or ($major -eq 22 -and $minor -ge 13)) {
      $runtime = $cand
      break
    }
  }
}

if (-not $runtime) {
  throw '未找到可用的 Node.js 22.13+。请先启动一次 Antigravity 桌面端或安装 Node.js 22.13+。'
}

$scriptFile = if ($Mode -eq 'Uninstall') { 'scripts/uninstall.mjs' } else { 'scripts/install.mjs' }
& $runtime (Join-Path $PSScriptRoot $scriptFile) @Arguments
exit $LASTEXITCODE
