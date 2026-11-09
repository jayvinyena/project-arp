# ARP 새 설계 (arp-next)

아트 리소스 플래너를 처음부터 다시 설계한다. 지금 Apps Script 도구(`../arp`)와 코드를 공유하지 않는다.

## 확정한 방향 (2026-11-05)

| 항목 | 결정 |
|---|---|
| 핵심 기능 | 런칭 물량 설계 · 다양한 시뮬레이션 · 빠른 속도 · 업데이트 계획 |
| 성격 | 범용(어떤 게임에도), 판매용 아님 |
| 비용 | 유지비 0. 서버·DB·로그인 없음 |
| 구성 | 정적 브라우저 앱(PWA) + 프로젝트 파일(SQLite `.arp`) + 브라우저 계산 엔진 |
| 사용자 | 일정 관리 권한이 있는 소수. 동시 편집 없음(편집 중 표시 + 저장 전 확인) |
| 속도 목표 | 첫 화면 1초 · 재계산 0.1초 · 저장 즉시 |

## 단계

| 단계 | 상태 |
|---|---|
| 0. 기반: 용어, 데이터 모델, 파일 형식, 검증 규칙, 샘플 | 완료 (2026-11-05) |
| 1. 계산 엔진 | 완료 (2026-11-05): 엔진, 계산 흐름, 검사 23개, 브라우저 측정 |
| 2. 런칭 물량 설계 (첫 출시) | 기능 완료 (2026-11-05): 화면·역산·저장 흐름·새 프로젝트 만들기. 실제 사용 확인 대기 |
| 3. 업데이트 계획 | 기능 완료 (2026-11-05): 타임라인·부하 지도·만들기·상세, 작업 진척(옛 이름 진행 실적), 유형 템플릿, 인력·계획 기간. 실제 사용 확인 대기 |
| 4. 시뮬레이션 | 기능 완료 (2026-11-05): 시나리오·동작 9가지·나란히 비교·민감도·거꾸로 계산·원본에 반영, 파일 구조 v2 |
| 4.5 기존 시트 데이터 가져오기 | 기능 완료 (2026-11-05): .xlsx 읽기, 옛 → 새 변환·보고서, 옛 엔진과 대조(같음). 실제 시트로 확인 대기 |
| 5. 안정화 | 완료 (2026-11-05): 변경 이력·되돌리기, 작업 복구, 최근 파일, 엑셀 내보내기, 오프라인·설치형 앱, 오류 처리, 사용 가이드·배포 문서 |
| 6. 확장 | 완료 (2026-11-05): 실투입 공수·공수 보정 제안, 실적 엑셀 양식·넣기, 열 때 변화 알림, 시나리오 비교 빠르게(파일 구조 v3) |
| 7. 마감 일정 맞춤 제안 | 완료 (2026-11-05): 모든 업데이트가 마감을 지키도록 인원·외주·물량·우선순위 조합을 제안(아무도 늦추지 않는 걸음만), 시나리오로 만들어 비교·반영 |

## 0단계 산출물

| 파일 | 내용 |
|---|---|
| [docs/00-glossary.md](docs/00-glossary.md) | 용어 사전, 계산 식 |
| [docs/01-data-model.md](docs/01-data-model.md) | 표 구성과 이유, 시나리오 변수, 지금 도구와 다른 점 |
| [docs/02-file-format.md](docs/02-file-format.md) | 파일 열기·저장, 편집 중 표시, 구조 전환, 내보내기 |
| [docs/03-validation-rules.md](docs/03-validation-rules.md) | 검증 규칙 36개: 오류 21 · 주의 15 (규칙 원본에서 생성) |
| [schema/schema-v1.sql](schema/schema-v1.sql) | 파일 구조 원본 |
| [rules/validation-rules.mjs](rules/validation-rules.mjs) | 검증 규칙 원본 (SQL) |
| [samples/](samples/) | 샘플 3벌: 정상, 과부하, 빈 값 |

## 1단계 산출물

| 파일 | 내용 |
|---|---|
| [docs/04-engine-rules.md](docs/04-engine-rules.md) | 엔진 규칙: 영업일, 스테이지, 겹침률, 하루 배정 순서, 판정, 근거, 검사, 속도 |
| [engine/](engine/) | 계산 엔진 (TypeScript, 의존 패키지 없음). 입구 `runPlan` |
| [tools/lib/pipeline.mjs](tools/lib/pipeline.mjs) | 계산 흐름: 시나리오 얹기 → 검증 → 읽기 → 엔진 |
| [tools/plan.mjs](tools/plan.mjs) | 계산 결과를 터미널에 보여주는 도구 |
| [test/engine.test.mjs](test/engine.test.mjs) | 엔진 검사 17개 |
| [core/](core/) | Node와 브라우저가 같이 쓰는 계산 흐름. `ProjectSession`: 고친 표만 다시 읽기 |
| [web/lib/wasm-db.ts](web/lib/wasm-db.ts) | 브라우저: SQLite WebAssembly로 `.arp` 열기·내보내기 |
| [docs/05-browser-bench.md](docs/05-browser-bench.md) | 브라우저 측정 결과와 판단 |

## 2단계 산출물

| 파일 | 내용 |
|---|---|
| [docs/06-launch-design.md](docs/06-launch-design.md) | 런칭 물량 설계 화면, 디자인 기준, 저장 흐름, 역산 방식 |
| [core/launch.ts](core/launch.ts) | 런칭 요약 · 고치기(변경 이력) · 구간 비교 · 최대 물량 · 필요 인원 |
| [web/app/](web/app/) | 앱: 화면(Preact) + 계산 스레드(Web Worker) |
| [test/launch.test.mjs](test/launch.test.mjs) · [test/new-project.test.mjs](test/new-project.test.mjs) | 런칭 로직 검사 9개 · 새 프로젝트 검사 4개 |
| [core/new-project.ts](core/new-project.ts) · [web/app/ui/NewProject.tsx](web/app/ui/NewProject.tsx) | 새 프로젝트 만들기(4단계 마법사) |
| [tools/e2e-save.mjs](tools/e2e-save.mjs) · [tools/e2e-new.mjs](tools/e2e-new.mjs) · [tools/capture.mjs](tools/capture.mjs) | 저장 흐름 시험 6개 · 새 프로젝트 시험 8개 · 화면 캡처 |

## 한 번에 실행 (Windows)

`arp-next` 폴더에서 더블클릭한다.

| 파일 | 하는 일 |
|---|---|
| `release.cmd` | 준비 확인(Node 24 이상, 패키지 설치) → 검사 → 배포용 빌드(`dist-web`) → `private\*.xlsx` 운영 시트를 옛 엔진과 대조 |
| `release-deploy.cmd` | 위 + Cloudflare Pages에 올리기(처음 한 번은 브라우저로 Cloudflare 로그인) |

PowerShell에서 옵션을 줄 수도 있다.

```bash
powershell -ExecutionPolicy Bypass -File .\release.ps1 -E2E -Deploy -ProjectName arp
```

- `-E2E` 크롬 시험까지(1분 안팎) · `-Deploy` 올리기 · `-SkipTests` 검사 건너뜀 · `-ProjectName` Cloudflare 프로젝트 이름(기본 `arp`)
- 마지막에 단계별 통과·실패·건너뜀 요약이 나온다. 검사나 빌드가 실패하면 그 자리에서 멈추고, 앞 단계에 실패가 있으면 올리지 않는다.
- 대조는 "옛 계산 방식 흉내"에서 모두 같아야 통과다(`compare-legacy --check`).

## 명령

```bash
npm run dev                               # 앱 개발 서버 → /app/index.html?sample=normal
npm test                                  # 검사 132개
npm run e2e                               # 크롬 시험 141개(동시 3개, 30초 안팎): 저장 9 · 새 프로젝트 9 · 업데이트 계획 14 · 작업 진척 5 · 에셋 20 · 시뮬레이션 11 · 가져오기 15 · 안정화 10 · 확장 10 · 마감 맞추기 14 · 만든 뒤 고치기 13 · 배포 11
npm run build                             # 배포용 → dist-web/ → Cloudflare Pages에 올리기 (docs/12-deploy.md)
npm run compare-legacy -- private/운영시트.xlsx   # 옛 엔진 ↔ 새 엔진 대조 (../arp 필요, 파일 없으면 옛 샘플)
npm run review-data -- private/운영시트.xlsx      # 운영 시트 → .arp + PM 데이터 점검 엑셀(docs/15-operating-sheet.md)
npm run capture                           # 화면 캡처 (크롬)
npm run samples                           # samples/out/*.arp 만들기
npm run validate -- samples/out/broken.arp
npm run scale                             # 현실 규모 파일 만들기와 크기·읽기·검증 시간
npm run scale -- --stress                 # 과부하 규모(엔진 최악 조건)
npm run plan -- samples/out/normal.arp    # 계산 결과 (뒤에 STRETCH, --scenario SC1 등)
npm run rules-doc                         # 규칙 문서 다시 만들기
npm run bench:browser                     # 크롬으로 브라우저 측정 (먼저 npm run samples, npm run scale, npm run scale -- --stress)
```

Node 24 이상(내장 `node:sqlite`, TypeScript 바로 실행)과 `npm install`. 패키지: `@sqlite.org/sqlite-wasm`(브라우저 SQLite), `preact`(화면), `pretendard`(글꼴), `vite`(빌드, 개발용). 모두 버전 고정. 브라우저 측정에는 크롬이 필요하다.

## 측정 (Node 24, 이 PC)

| 데이터 | 파일 | 물량 행 | 스테이지 | 한 번 계산(검증 + 읽기 + 엔진) |
|---|---|---|---|---|
| 정상 샘플 | 작음 | 21 | 44 | 6ms |
| 현실 규모 (파트 8 · 리소스 500 · 업데이트 50 · 36개월) | 496KB | 2,379 | 4,956 | 15–30ms |
| 과부하 규모 (필요 공수가 작업 가능량의 수십 배) | 924KB | 9,643 | 19,979 | 74ms |

**브라우저(크롬) 현실 규모:** 첫 화면 70–98ms, 재계산 10ms. CPU를 4배 느리게 해도 첫 화면 약 210ms, 재계산 45ms. 목표(첫 화면 1초, 재계산 0.1초) 충족. 자세한 내용: [docs/05-browser-bench.md](docs/05-browser-bench.md)

## 3단계 산출물

| 파일 | 내용 |
|---|---|
| [docs/07-update-plan.md](docs/07-update-plan.md) | 업데이트 계획 · 작업 진척 · 유형 템플릿 · 인력 화면과 로직 |
| [core/edits.ts](core/edits.ts) · [core/plan.ts](core/plan.ts) | 모든 고치기 20종 · 계획/상세/실적/유형/인력 보기 |
| [web/app/ui/PlanPage.tsx](web/app/ui/PlanPage.tsx) · [ProgressPage.tsx](web/app/ui/ProgressPage.tsx) · [TemplatesPage.tsx](web/app/ui/TemplatesPage.tsx) · [CapacityPage.tsx](web/app/ui/CapacityPage.tsx) | 화면 |
| [test/plan.test.mjs](test/plan.test.mjs) · [test/progress.test.mjs](test/progress.test.mjs) · [tools/e2e-plan.mjs](tools/e2e-plan.mjs) · [tools/e2e-progress.mjs](tools/e2e-progress.mjs) | 검사 7+5개 · 크롬 시험 14+5개 |

## 4단계 산출물

| 파일 | 내용 |
|---|---|
| [docs/08-simulation.md](docs/08-simulation.md) | 시뮬레이션 화면, 동작 9가지, 원본에 반영, 파일 구조 v2, 속도 |
| [core/scenarios.ts](core/scenarios.ts) · [core/migrate.ts](core/migrate.ts) | 시나리오 로직 · 구조 전환 |
| [web/app/ui/SimulationPage.tsx](web/app/ui/SimulationPage.tsx) | 화면 |
| [test/scenarios.test.mjs](test/scenarios.test.mjs) · [tools/e2e-sim.mjs](tools/e2e-sim.mjs) | 검사 14개 · 크롬 시험 11개 |

## 4.5단계 산출물

| 파일 | 내용 |
|---|---|
| [docs/09-import-legacy.md](docs/09-import-legacy.md) | 쓰는 법, 옛 → 새 변환표, 옛 엔진과 대조 결과 |
| [core/xlsx.ts](core/xlsx.ts) · [core/import-legacy.ts](core/import-legacy.ts) | 엑셀 읽기(라이브러리 없음) · 변환과 보고서 |
| [web/app/ui/ImportReport.tsx](web/app/ui/ImportReport.tsx) | 가져오기 보고서 화면 |
| [tools/compare-legacy.mjs](tools/compare-legacy.mjs) · [test/import.test.mjs](test/import.test.mjs) · [tools/e2e-import.mjs](tools/e2e-import.mjs) | 대조 도구 · 검사 5개 · 크롬 시험 7개 |

## 5단계 산출물

| 파일 | 내용 |
|---|---|
| [docs/10-stabilization.md](docs/10-stabilization.md) | 안정화 기능과 규칙 |
| [docs/11-user-guide.md](docs/11-user-guide.md) | **사용 가이드** (사용자용) |
| [docs/12-deploy.md](docs/12-deploy.md) | **배포와 운영** (운영자용) |
| [core/history.ts](core/history.ts) · [core/export.ts](core/export.ts) · [core/xlsx-write.ts](core/xlsx-write.ts) | 이력·되돌리기 · 엑셀 내보내기 |
| [web/app/lib/idb.ts](web/app/lib/idb.ts) · [web/app/ui/HistoryPage.tsx](web/app/ui/HistoryPage.tsx) | 작업 복구·최근 파일 · 변경 이력 화면 |
| [test/history.test.mjs](test/history.test.mjs) · [tools/e2e-stable.mjs](tools/e2e-stable.mjs) | 검사 5개 · 크롬 시험 9개 |

## 6단계 산출물

| 파일 | 내용 |
|---|---|
| [docs/13-extensions.md](docs/13-extensions.md) | 실투입 공수·공수 보정, 실적 엑셀, 변화 알림, 비교 속도 |
| [core/calibration.ts](core/calibration.ts) · [core/progress-io.ts](core/progress-io.ts) · [core/notice.ts](core/notice.ts) | 공수 보정 · 실적 엑셀 · 변화 알림 |
| [web/app/ui/CalibrationPage.tsx](web/app/ui/CalibrationPage.tsx) | 공수 보정 화면 |
| [test/calibration.test.mjs](test/calibration.test.mjs) · [tools/e2e-ext.mjs](tools/e2e-ext.mjs) | 검사 5개 · 크롬 시험 10개 |

## 7단계 산출물

| 파일 | 내용 |
|---|---|
| [docs/14-deadline-fit.md](docs/14-deadline-fit.md) | 마감 맞추기: 수단·상한, 고르는 방법, 시나리오 연결, 한계 |
| [core/advisor.ts](core/advisor.ts) | 제안 로직 `adviseDeadlines` · 시나리오로 만들기 `adviceToScenario` |
| [web/app/ui/AdvisorPage.tsx](web/app/ui/AdvisorPage.tsx) | 화면 |
| [test/advisor.test.mjs](test/advisor.test.mjs) · [tools/e2e-advisor.mjs](tools/e2e-advisor.mjs) | 검사 8개 · 크롬 시험 14개 |

## 실사용 준비 (2026-11-05)

| 파일 | 내용 |
|---|---|
| [docs/20-asset-management.md](docs/20-asset-management.md) · [core/assets.ts](core/assets.ts) · [web/app/ui/AssetsPage.tsx](web/app/ui/AssetsPage.tsx) | **에셋 관리**(2026-11-09 요청): 에셋 리스트 · 트렐로식 보드(끌어서 단계 변경) · 카드 창(썸네일 · 설명 · 체크리스트 · 링크 · 댓글) · 배치 · 작업 진척 자동 집계 · 에셋 엑셀 · 검사 11개 · 크롬 시험 20개 · 저장 시간 측정 [tools/bench-assets.mjs](tools/bench-assets.mjs) |
| [docs/19-import-template.md](docs/19-import-template.md) · [core/import-spec.ts](core/import-spec.ts) | **엑셀 가져오기 양식 · 편집용 엑셀 내보내기**(2026-11-06 요청): 규격 한 곳 정의 → 양식 파일 · 한글 머리글 읽기 · 가져오기 창 규격 표 · 지금 프로젝트를 양식으로(왕복) |
| [docs/18-layout-help.md](docs/18-layout-help.md) · [tools/capture-pages.mjs](tools/capture-pages.mjs) · [tools/find-overflow.mjs](tools/find-overflow.mjs) | **화면 배치 점검 · 화면 안내 · 용어(작업 진척)**(2026-11-06 요청) · 메뉴별 캡처 · 좁은 화면 넘침 찾기 |
| [docs/17-setup-templates-ai.md](docs/17-setup-templates-ai.md) | **만든 뒤 고치기 · 물량 템플릿 · AI 공수**(2026-11-05 요청) |
| [docs/16-review.md](docs/16-review.md) | **전체 점검**: 독립 점검 3개(계산·데이터·화면)로 찾은 문제와 고친 것 |
| [docs/15-operating-sheet.md](docs/15-operating-sheet.md) | **운영 시트 준비 가이드**: 읽는 시트·칸, 점검표, 옛 도구와 달라지는 곳, 운영 규모 시험 결과 |
| [tools/gen-operating-sheet.mjs](tools/gen-operating-sheet.mjs) | 운영 규모 합성 시트(옛 구조, 엑셀 날짜·보조 시트·운영 흔적) → `samples/out/operating-sheet.xlsx` |
| [docs/12-deploy.md](docs/12-deploy.md) · [tools/e2e-deploy.mjs](tools/e2e-deploy.mjs) · [tools/lib/pages-server.mjs](tools/lib/pages-server.mjs) | Cloudflare Pages 배포(결과물 정리, 주소 옮김 대응, `_headers`) · 배포 시험 10개 |

## 0단계 결정 (2026-11-05, 추천안대로 확정)

| 질문 | 결정 |
|---|---|
| 공수 단위 | 리소스 1개를 그 파트가 만드는 데 드는 인·일 |
| 런칭 | 프로젝트당 0개 또는 1개 (규칙 U05) |
| 휴일 | 공휴일과 회사 휴무일 모두 근무일에서 뺀다 (`holidays.kind` = PUBLIC / COMPANY) |
| 외주 | 수량 외주(`volumes.outsource_qty`)와 인력 외주(`capacity.outsource_days`) 둘 다 유지 |
| 우선순위 | 숫자 순위 (1이 먼저) |
| 추가·취소·이월 수량 | 별도 칸 없음. 물량을 고치고 이유를 변경 이력에 남긴다 |
| 실측 데이터 | 1단계는 샘플로 진행. 운영 데이터 실측은 4.5단계(기존 데이터 가져오기)에서 |
