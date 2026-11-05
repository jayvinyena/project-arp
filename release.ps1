<#
  ARP 한 번에 실행: 준비 확인 → 검사 → 배포용 빌드 → 운영 시트 대조 → (선택) Cloudflare Pages 올리기

  더블클릭:      release.cmd          (검사 · 빌드 · 대조)
                 release-deploy.cmd   (위 + Cloudflare Pages 올리기)
  PowerShell:    powershell -ExecutionPolicy Bypass -File .\release.ps1 [-E2E] [-Deploy] [-SkipTests] [-ProjectName arp]

  -E2E          크롬 시험까지(1분 안팎, 크롬 필요)
  -Deploy       빌드 결과(dist-web)를 Cloudflare Pages에 올림. 처음 한 번은 브라우저로 Cloudflare 로그인
  -SkipTests    검사를 건너뜀(급할 때만)
  -ProjectName  Cloudflare Pages 프로젝트 이름(기본 arp → https://arp-32g.pages.dev, 2026-11-05 만듦)
  -AccountId    올릴 Cloudflare 계정 ID. 초대받은 팀원처럼 계정이 여럿이면 넣는다(대시보드 주소 dash.cloudflare.com/<계정 ID>/...)
#>
param(
  [switch]$E2E,
  [switch]$Deploy,
  [switch]$SkipTests,
  [string]$ProjectName = 'arp',
  [string]$AccountId = ''
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$root = $PSScriptRoot
Set-Location $root

$results = New-Object System.Collections.Generic.List[object]
$failed = $false
function Add-Result([string]$step, [string]$state, [string]$detail) {
  $results.Add([pscustomobject]@{ '단계' = $step; '결과' = $state; '내용' = $detail })
  if ($state -eq '실패') { $script:failed = $true }
}
function Write-Step([string]$n, [string]$title) {
  Write-Host ''
  Write-Host "[$n] $title" -ForegroundColor Cyan
}
function Show-Summary {
  Write-Host ''
  Write-Host '================ 요약 ================' -ForegroundColor Cyan
  foreach ($r in $results) {
    $color = 'Green'
    if ($r.'결과' -eq '실패') { $color = 'Red' } elseif ($r.'결과' -eq '건너뜀') { $color = 'Yellow' }
    Write-Host ("  {0,-14} {1,-5} {2}" -f $r.'단계', $r.'결과', $r.'내용') -ForegroundColor $color
  }
  Write-Host ''
}
function Stop-Run([string]$message) {
  Write-Host "  $message" -ForegroundColor Red
  Show-Summary
  exit 1
}

Write-Host 'ARP 한 번에 실행' -ForegroundColor Cyan
Write-Host "폴더: $root"

# 1. 준비 확인 ------------------------------------------------------------
Write-Step '1/5' '준비 확인(Node · 패키지)'
$nodeVersion = $null
try { $nodeVersion = (& node -v) 2>$null } catch { $nodeVersion = $null }
if (-not $nodeVersion) {
  Add-Result '준비 확인' '실패' 'Node가 없어요'
  Stop-Run 'Node 24 이상을 설치해 주세요: https://nodejs.org (LTS 아님, 24 이상)'
}
$major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($major -lt 24) {
  Add-Result '준비 확인' '실패' "Node $nodeVersion (24 이상 필요)"
  Stop-Run "Node $nodeVersion 은 너무 오래됐어요. 24 이상이 필요해요(내장 SQLite·TypeScript 실행)."
}
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host '  패키지를 설치해요(처음 한 번)...'
  if (Test-Path (Join-Path $root 'package-lock.json')) { & npm ci } else { & npm install }
  if ($LASTEXITCODE -ne 0) {
    Add-Result '준비 확인' '실패' '패키지 설치 실패'
    Stop-Run '패키지를 설치하지 못했어요. 인터넷 연결을 확인해 주세요.'
  }
}
Add-Result '준비 확인' '통과' "Node $nodeVersion"

# 2. 검사 ------------------------------------------------------------------
Write-Step '2/5' '검사'
if ($SkipTests) {
  Add-Result '검사' '건너뜀' '-SkipTests'
} else {
  & npm test
  if ($LASTEXITCODE -ne 0) {
    Add-Result '검사' '실패' 'npm test 실패(위 출력 참고)'
    Stop-Run '검사가 실패해서 빌드하지 않았어요.'
  }
  Add-Result '검사' '통과' 'npm test'
  if ($E2E) {
    Write-Host '  크롬 시험(1분 안팎)...'
    & npm run e2e
    if ($LASTEXITCODE -ne 0) {
      Add-Result '크롬 시험' '실패' 'npm run e2e 실패(위 출력 참고)'
      Stop-Run '크롬 시험이 실패해서 빌드하지 않았어요.'
    }
    Add-Result '크롬 시험' '통과' 'npm run e2e'
  }
}

# 3. 배포용 빌드 -----------------------------------------------------------
Write-Step '3/5' '배포용 빌드(dist-web)'
& npm run build
$dist = Join-Path $root 'dist-web'
if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $dist 'app\index.html'))) {
  Add-Result '빌드' '실패' 'npm run build 실패'
  Stop-Run '빌드하지 못했어요.'
}
$size = (Get-ChildItem $dist -Recurse -File | Measure-Object -Property Length -Sum).Sum
Add-Result '빌드' '통과' ("{0} ({1:N1}MB)" -f $dist, ($size / 1MB))

# 4. 운영 시트 대조 --------------------------------------------------------
Write-Step '4/5' '운영 시트 대조(private\*.xlsx ↔ 옛 엔진)'
$private = Join-Path $root 'private'
$sheets = @()
if (Test-Path $private) { $sheets = @(Get-ChildItem $private -Filter *.xlsx -File | Where-Object { -not $_.Name.StartsWith('~$') }) }
$legacyHarness = Join-Path $root '..\arp\tests\harness\gas-runtime.js'
if ($sheets.Count -eq 0) {
  Add-Result '운영 시트 대조' '건너뜀' 'private 폴더에 .xlsx가 없어요(구글 시트 → 파일 → 다운로드 → Microsoft Excel)'
} elseif (-not (Test-Path $legacyHarness)) {
  Add-Result '운영 시트 대조' '건너뜀' '옛 도구 폴더(..\arp)가 없어요'
} else {
  foreach ($f in $sheets) {
    Write-Host "  - $($f.Name)"
    & node tools/compare-legacy.mjs $f.FullName --check
    if ($LASTEXITCODE -eq 0) {
      Add-Result '운영 시트 대조' '통과' "$($f.Name): 옛 계산 방식 흉내에서 모두 같음"
    } elseif ($LASTEXITCODE -eq 3) {
      Add-Result '운영 시트 대조' '건너뜀' "$($f.Name): 옛 도구 시트가 아니에요(데이터 점검 엑셀 등)"
    } else {
      Add-Result '운영 시트 대조' '실패' "$($f.Name): 다른 곳이 있어요(위 출력 · samples\out\compare-legacy.json)"
    }
  }
}

# 5. Cloudflare Pages 올리기 -----------------------------------------------
Write-Step '5/5' 'Cloudflare Pages 올리기'
if (-not $Deploy) {
  Add-Result '올리기' '건너뜀' "직접 올리려면 Cloudflare 대시보드 → Pages → Upload assets → $dist (또는 release-deploy.cmd)"
} elseif ($failed) {
  Add-Result '올리기' '건너뜀' '앞 단계에 실패가 있어 올리지 않았어요'
} else {
  Write-Host "  wrangler(Cloudflare 공식 도구)로 올려요. 처음이면 브라우저에서 Cloudflare 로그인 창이 열려요."
  if ($AccountId) { $env:CLOUDFLARE_ACCOUNT_ID = $AccountId; Write-Host "  계정: $AccountId" }
  # --branch main: 운영 브랜치로 올린다(주지 않으면 git 브랜치 이름으로 올라가 미리보기 주소에만 나온다)
  # wrangler는 진행 메시지를 오류 출력으로 낸다. PowerShell 5.1이 빨간 오류처럼 보이지 않게 cmd 안에서 합쳐 받는다
  & cmd /c "npx --yes wrangler@4 pages deploy ""$dist"" --project-name $ProjectName --branch main --commit-dirty=true 2>&1" | Tee-Object -Variable deployLog | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Add-Result '올리기' '실패' 'wrangler pages deploy 실패(위 출력 참고). 처음이면 Cloudflare 로그인과 이메일 인증을 확인해 주세요'
  } else {
    $urls = [regex]::Matches(($deployLog | Out-String), 'https://[A-Za-z0-9.-]+\.pages\.dev') | ForEach-Object { $_.Value } | Select-Object -Unique
    $detail = '운영 주소 https://arp-32g.pages.dev'
    if ($urls) { $detail = "$detail · 이번 배포 $($urls -join ', ')" }
    Add-Result '올리기' '통과' $detail
  }
}

Show-Summary
if ($failed) { exit 1 }
exit 0
