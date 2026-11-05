# 배포와 운영

서버가 없다. 배포 = 빌드한 정적 파일(`dist-web/`)을 아무 정적 호스팅에 올리는 것. 유지비가 0이다.

## 빌드

```bash
npm install
npm test                 # 검사 66개
npm run e2e              # 크롬 시험 57개 (크롬 필요)
npm run build            # → dist-web/
```

결과물:

| 경로 | 내용 |
|---|---|
| `dist-web/app/index.html` | 앱 첫 화면 |
| `dist-web/app/sw.js` · `manifest.webmanifest` · `icon.svg` | 오프라인·설치형 앱 |
| `dist-web/assets/` | 앱 코드, SQLite(WebAssembly), 글꼴 |
| `dist-web/*.arp` · `legacy-sample.xlsx` | 예시 파일("예시 프로젝트로 둘러보기") |
| `dist-web/bench/` | 측정 페이지(배포하지 않아도 된다) |

## 올리기

- 모든 경로가 상대 경로(`base: './'`)라서 어떤 하위 폴더에 올려도 된다. 예: `https://사내주소/arp/app/index.html`.
- **HTTPS가 필요하다.** 서비스 워커와 파일 바로 저장(File System Access API)은 HTTPS나 localhost에서만 동작한다.
- 특별한 응답 헤더(COOP/COEP)는 필요 없다. 브라우저 저장소(OPFS)에 SQLite를 두지 않고 메모리에서 쓰기 때문이다.
- **후보:** 사내 정적 웹 서버, 사내 GitHub Pages(비공개 저장소), 공유 드라이브 웹 게시 등. 유지비가 없는 곳을 쓴다.

## 새 버전 배포

1. `npm test` → `npm run e2e` → `npm run build`
2. `dist-web/`를 통째로 바꿔 올린다. 파일 이름에 해시가 붙어 옛 파일과 섞이지 않는다.
3. 사용자는 다음에 열 때(또는 한 번 새로 고칠 때) 새 버전을 받는다. 서비스 워커가 새 캐시를 만들고 옛 캐시를 지운다.
4. **파일 구조가 바뀌는 배포라면:**
   - [core/migrate.ts](../core/migrate.ts)에 단계를 더한다.
   - 옛 파일은 열 때 자동으로 바뀌고, 사용자에게 원본 받기를 알린다.
   - 새 앱이 쓴 파일은 옛 앱이 열지 않는다(더 새 구조 거절). 그래서 **모두 같은 버전을 쓰도록 공지한다.**

## 운영 점검표

| 언제 | 할 일 |
|---|---|
| 배포 전 | 검사·크롬 시험 통과, 예시 파일로 화면 한 번 확인(`npm run capture`) |
| 매주 | 공유 드라이브의 `.arp` 파일 백업(드라이브 버전 기록으로 충분하면 생략) |
| 문제 보고가 오면 | 그 파일을 받아 `npm run validate -- 파일.arp`, `npm run plan -- 파일.arp`로 재현 |
| 옛 도구와 결과가 다르다는 보고 | `npm run compare-legacy`로 같은 데이터를 대조. [09-import-legacy.md](09-import-legacy.md) |

## 의존 패키지 (모두 버전 고정)

| 패키지 | 쓰임 | 비고 |
|---|---|---|
| `@sqlite.org/sqlite-wasm` 3.53.4-build2 | 브라우저 SQLite | 앱에 들어감 |
| `preact` 10.29.8 | 화면 | 앱에 들어감 |
| `pretendard` 1.3.9 | 글꼴(OFL) | 앱에 들어감 |
| `vite` 7.3.7 | 빌드 | 개발용 |

Node 24 이상이 필요하다(내장 SQLite, TypeScript 바로 실행). 브라우저는 크롬·엣지 최신 버전을 기준으로 한다.
