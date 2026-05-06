<#
.SYNOPSIS
    Start, stop, and run tests against MongoDB or DocumentDB local.

.DESCRIPTION
    Manages podman compose for the two local targets and runs the driver
    harness against the selected target.

.PARAMETER Action
    build   – compile out-of-process adapters (e.g. Rust shim)
    start   – bring the container up and wait until healthy
    stop    – tear the container down
    test    – run the harness against a running target
    ci      – start → test → stop in one step (builds adapters first)

.PARAMETER Target
    mongodb     – MongoDB 7 on port 27017
    documentdb  – DocumentDB local on port 10260

.PARAMETER Adapters
    Comma-separated list of adapters to test. Defaults to "nodejs".
    Use "nodejs,rust" to test both adapters against the same target.

.EXAMPLE
    .\run.ps1 start mongodb
    .\run.ps1 test  mongodb
    .\run.ps1 stop  mongodb

.EXAMPLE
    .\run.ps1 ci documentdb

.EXAMPLE
    .\run.ps1 build
    .\run.ps1 ci mongodb -Adapters nodejs,rust
#>
param(
    [Parameter(Mandatory)][ValidateSet('build','start','stop','test','ci')]
    [string]$Action,

    [ValidateSet('mongodb','documentdb')]
    [string]$Target,

    [string[]]$Adapters = @('nodejs')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Configuration ─────────────────────────────────────────────────────────────

$RuntimeDir  = Join-Path $PSScriptRoot 'runtime'
$EnvFile     = Join-Path $RuntimeDir '.env'

$Targets = @{
    mongodb = @{
        ComposeFile    = Join-Path $RuntimeDir 'mongodb-docker-compose.yml'
        Uri            = 'mongodb://testuser:testpassword@localhost:27017/?authSource=admin'
        ServiceName    = 'mongodb'
        ServerVersion  = $null   # harness will skip version gating
    }
    documentdb = @{
        ComposeFile    = Join-Path $RuntimeDir 'documentdb-docker-compose.yml'
        Uri            = 'mongodb://testuser:testpassword@localhost:10260/?tls=true&tlsAllowInvalidCertificates=true&directConnection=true'
        ServiceName    = 'documentdb'
        ServerVersion  = $null
    }
}

$Cfg = $Targets[$Target]

# ── Helpers ───────────────────────────────────────────────────────────────────

function Invoke-Compose {
    param([string[]]$ExtraArgs)
    $base = @('compose', '--env-file', $EnvFile, '-f', $Cfg.ComposeFile)
    podman @($base + $ExtraArgs)
    if ($LASTEXITCODE -ne 0) { throw "podman compose exited with code $LASTEXITCODE" }
}

function Wait-Healthy {
    Write-Host "Waiting for $Target to become healthy..."
    $service = $Cfg.ServiceName
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        $status = podman inspect --format '{{.State.Health.Status}}' `
            (podman compose --env-file $EnvFile -f $Cfg.ComposeFile ps -q $service 2>$null) 2>$null
        if ($status -eq 'healthy') {
            Write-Host "$Target is healthy."
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "$Target did not become healthy within 90 seconds."
}

# ── Actions ───────────────────────────────────────────────────────────────────

function Start-Target {
    Write-Host "Starting $Target..."
    Invoke-Compose @('up', '-d', '--pull', 'missing')
    Wait-Healthy
}

function Stop-Target {
    Write-Host "Stopping $Target..."
    Invoke-Compose @('down', '--remove-orphans')
}

function Invoke-Tests {
    Write-Host ""
    Write-Host "Running harness against $Target ($($Cfg.Uri))..."
    Write-Host "Adapters: $Adapters"
    Write-Host ""

    $harnessArgs = @(
        'ts-node', 'src/index.ts',
        '--adapters', ($Adapters -join ','),
        '--tests',   'tests/**/*.yml',
        '--uri',     $Cfg.Uri,
        '--reporter', 'tap'
    )

    if ($Cfg.ServerVersion) {
        $harnessArgs += @('--server-version', $Cfg.ServerVersion)
    }

    & npx @harnessArgs
    if ($LASTEXITCODE -ne 0) { throw "Harness reported test failures (exit $LASTEXITCODE)" }
}

function Invoke-Build {
    Write-Host "Building out-of-process adapters..."

    # ── Rust ──────────────────────────────────────────────────────────────────
    # Build the canonical "rust" adapter plus any versioned variants (rust-2.x, rust-3.6, …)
    $rustDirs = Get-ChildItem -Path (Join-Path $PSScriptRoot 'adapters') -Directory |
        Where-Object { $_.Name -eq 'rust' -or $_.Name -match '^rust-' }

    foreach ($dir in $rustDirs) {
        if (Test-Path (Join-Path $dir.FullName 'Cargo.toml')) {
            Write-Host "  Building Rust shim ($($dir.Name)) (cargo build --release)..."
            Push-Location $dir.FullName
            try {
                cargo build --release
                if ($LASTEXITCODE -ne 0) { throw "cargo build failed in $($dir.Name) (exit $LASTEXITCODE)" }
            } finally {
                Pop-Location
            }
            Write-Host "  Rust shim built: adapters/$($dir.Name)/target/release/shim"
        }
    }
}

# ── Entry point ───────────────────────────────────────────────────────────────

switch ($Action) {
    'build' { Invoke-Build }
    'start' {
        if (-not $Target) { throw "-Target is required for 'start'" }
        Start-Target
    }
    'stop'  {
        if (-not $Target) { throw "-Target is required for 'stop'" }
        Stop-Target
    }
    'test'  {
        if (-not $Target) { throw "-Target is required for 'test'" }
        Invoke-Tests
    }
    'ci' {
        if (-not $Target) { throw "-Target is required for 'ci'" }
        Invoke-Build
        try {
            Start-Target
            Invoke-Tests
        } finally {
            Stop-Target
        }
    }
}
