<#
.SYNOPSIS
    WARDOGS 投票站 —— 本地一键启停脚本（Windows / PowerShell）

.EXAMPLE
    .\run.ps1 start      # 后台启动（默认端口 8000）
    .\run.ps1 start -Port 9000 -Fg
    .\run.ps1 stop       # 关闭
    .\run.ps1 restart    # 重启
    .\run.ps1 status     # 看状态（进程 / 端口 / 票数）
    .\run.ps1 logs       # 跟踪日志（Ctrl+C 退出跟踪，不会停服务）
    .\run.ps1 open       # 浏览器打开
    .\run.ps1 reset      # 清空所有投票（会二次确认）
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'open', 'reset', 'ip')]
    [string]$Action = 'status',

    [int]$Port = 8000,
    [switch]$Fg   # 前台运行（日志直接打屏，Ctrl+C 停止）
)

$ErrorActionPreference = 'Stop'
$Root    = $PSScriptRoot
$PidFile = Join-Path $Root '.run.pid'
$LogFile = Join-Path $Root 'server.log'
$EnvFile = Join-Path $Root '.env.ps1'

# ---------- 环境变量：如存在 .env.ps1 则加载（里面写 $env:SECRET_KEY = '...' 之类） ----------
if (Test-Path $EnvFile) { . $EnvFile }
if (-not $env:SECRET_KEY)  { $env:SECRET_KEY  = 'local-dev-key-change-me' }
if (-not $env:ADMIN_TOKEN) { $env:ADMIN_TOKEN = 'admin123' }
$env:PORT = "$Port"

function Get-Python {
    foreach ($c in @('python', 'py')) {
        $cmd = Get-Command $c -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    throw '找不到 python，请先安装 Python 3.10+'
}

function Get-ServerProcess {
    # 1) 优先用 pid 文件
    if (Test-Path $PidFile) {
        $savedPid = (Get-Content $PidFile -Raw).Trim()
        $p = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -like 'python*') { return $p }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
    # 2) 兜底：按端口找占用者
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($conn) { return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue }
    return $null
}

function Test-Health {
    try {
        $r = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
        return $r
    } catch { return $null }
}

function Get-LanIP {
    (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
}

function Ensure-Deps {
    $py = Get-Python
    & $py -c "import flask" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host '首次运行：正在安装 Flask ...' -ForegroundColor Yellow
        & $py -m pip install --quiet --disable-pip-version-check flask
    }
}

# ---------------------------------------------------------------- actions
function Do-Start {
    $existing = Get-ServerProcess
    if ($existing) {
        Write-Host "已经在运行了 (PID $($existing.Id))，地址 http://127.0.0.1:$Port" -ForegroundColor Yellow
        return
    }
    Ensure-Deps
    $py = Get-Python

    if ($Fg) {
        Write-Host "前台启动，Ctrl+C 停止 →  http://127.0.0.1:$Port`n" -ForegroundColor Cyan
        & $py (Join-Path $Root 'app.py')
        return
    }

    # 后台启动 + 日志重定向
    $proc = Start-Process -FilePath $py `
        -ArgumentList (Join-Path $Root 'app.py') `
        -WorkingDirectory $Root `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError  "$LogFile.err" `
        -WindowStyle Hidden -PassThru
    $proc.Id | Set-Content $PidFile -Encoding ascii

    # 等健康检查
    $ok = $null
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 300
        $ok = Test-Health
        if ($ok) { break }
    }
    if (-not $ok) {
        Write-Host '启动失败，日志尾部：' -ForegroundColor Red
        if (Test-Path "$LogFile.err") { Get-Content "$LogFile.err" -Tail 20 }
        return
    }

    $lan = Get-LanIP
    Write-Host ''
    Write-Host '  ✅ WARDOGS 投票站已启动' -ForegroundColor Green
    Write-Host "  PID      : $($proc.Id)"
    Write-Host "  本机     : http://127.0.0.1:$Port"
    if ($lan) { Write-Host "  局域网   : http://${lan}:$Port   (同 WiFi 的朋友可直接投票)" -ForegroundColor Cyan }
    Write-Host "  管理口令 : $env:ADMIN_TOKEN"
    Write-Host "  当前票数 : $($ok.total)"
    Write-Host "  日志     : .\run.ps1 logs      关闭: .\run.ps1 stop"
    Write-Host ''
}

function Do-Stop {
    $p = Get-ServerProcess
    if (-not $p) {
        Write-Host '没有在运行的服务。' -ForegroundColor DarkGray
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        return
    }
    Stop-Process -Id $p.Id -Force
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "🛑 已关闭 (PID $($p.Id))" -ForegroundColor Yellow
}

function Do-Status {
    $p  = Get-ServerProcess
    $hp = Test-Health
    if ($p -and $hp) {
        $lan = Get-LanIP
        Write-Host "● 运行中  PID $($p.Id)  端口 $Port  已投 $($hp.total) 票" -ForegroundColor Green
        Write-Host "  http://127.0.0.1:$Port"
        if ($lan) { Write-Host "  http://${lan}:$Port" }
    } elseif ($p) {
        Write-Host "● 进程在 (PID $($p.Id))，但 /healthz 无响应，建议 .\run.ps1 restart" -ForegroundColor Yellow
    } else {
        Write-Host "○ 未运行 —— 用 .\run.ps1 start 启动" -ForegroundColor DarkGray
    }
}

function Do-Logs {
    if (-not (Test-Path $LogFile)) { Write-Host '还没有日志文件。' -ForegroundColor DarkGray; return }
    Write-Host "跟踪 $LogFile （Ctrl+C 退出跟踪，服务不会停）`n" -ForegroundColor DarkGray
    Get-Content $LogFile -Tail 30 -Wait
}

function Do-Reset {
    if (-not (Test-Health)) { Write-Host '服务没在运行。' -ForegroundColor Yellow; return }
    $ans = Read-Host '确定清空所有投票？输入 yes 确认'
    if ($ans -ne 'yes') { Write-Host '已取消。'; return }
    Invoke-RestMethod "http://127.0.0.1:$Port/api/admin/reset" -Method Post `
        -Headers @{ 'X-Admin-Token' = $env:ADMIN_TOKEN } | Out-Null
    Write-Host '🧹 已清空全部投票' -ForegroundColor Green
}

switch ($Action) {
    'start'   { Do-Start }
    'stop'    { Do-Stop }
    'restart' { Do-Stop; Start-Sleep -Milliseconds 600; Do-Start }
    'status'  { Do-Status }
    'logs'    { Do-Logs }
    'open'    { Start-Process "http://127.0.0.1:$Port" }
    'reset'   { Do-Reset }
    'ip'      { "局域网地址: http://$(Get-LanIP):$Port" }
}
