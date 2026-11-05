# 배포와 운영

서버가 없다. 배포 = 빌드한 정적 파일(`dist-web/`)을 아무 정적 호스팅에 올리는 것. 유지비가 0이다.

## 빌드

```bash
npm install
npm test                 # 검사 80개
npm run e2e              # 크롬 시험 91개 (크롬 필요, 20분 안팎)
npm run build            # → dist-web/
```

결과물:

| 경로 | 내용 |
|---|---|
| `dist-web/app/index.html` | 앱 첫 화면 |
| `dist-web/app/sw.js` · `manifest.webmanifest` · `icon.svg` | 오프라인·설치형 앱 |
| `dist-web/assets/` | 앱 코드, SQLite(WebAssembly), 글꼴 |
| `dist-web/*.arp` · `legacy-sample.xlsx` | 예시 파일("예시 프로젝트로 둘러보기"). `samples/out` 맨 위의 `.arp`·`.xlsx`만 넣고, 검사·시험 결과 폴더는 넣지 않는다. 오프라인 미리 받기에서도 뺀다 |
| `dist-web/bench/` | 측정 페이지(배포하지 않아도 된다) |
| `dist-web/index.html` · `_headers` | 맨 위 주소 → 앱, 응답 헤더(Cloudflare Pages 형식) |

## 올리기

- 모든 경로가 상대 경로(`base: './'`)라서 어떤 하위 폴더에 올려도 된다. 예: `https://사내주소/arp/app/`.
- **HTTPS가 필요하다.** 서비스 워커와 파일 바로 저장(File System Access API)은 HTTPS나 localhost에서만 동작한다.
- 특별한 응답 헤더(COOP/COEP)는 필요 없다. 브라우저 저장소(OPFS)에 SQLite를 두지 않고 메모리에서 쓰기 때문이다.
- 맨 위 주소(`/`)는 앱(`/app/`)으로 보낸다(`dist-web/index.html`).
- **올라가는 것은 앱 코드와 예시 파일뿐이다.** 프로젝트 데이터(`.arp`)는 각자 파일로만 있고 서버로 가지 않는다.

### Cloudflare Pages (정한 곳, 2026-11-05)

무료이고 HTTPS가 자동이다. 빌드는 이 PC에서 하고 결과물만 올린다(Cloudflare 쪽 빌드 설정이 필요 없다).

**처음 한 번**

1. `npm run build` → `D:\00.Project\Dev_N\arp-next\dist-web` 이 생긴다.
2. Cloudflare 대시보드 → **Workers & Pages** → **Create** → **Pages** → **Upload assets**(직접 올리기).
3. 프로젝트 이름(예: `arp`)을 넣고 `dist-web` 폴더를 통째로 끌어다 놓는다 → **Deploy**.
4. 주소는 `https://<프로젝트 이름>.pages.dev/` 이다. 팀에 이 주소를 알린다. 크롬·엣지에서 열고 주소창의 **설치** 버튼으로 앱처럼 쓸 수 있다.
5. (선택) 회사 사람만 열게 하려면 Cloudflare **Zero Trust → Access**에서 이 주소에 회사 메일 도메인 규칙을 건다(50명까지 무료).

**새 버전**: `npm run build` 후 같은 프로젝트에서 **Create deployment** → `dist-web`을 다시 올린다. 이전 배포로 되돌리기도 대시보드에서 한 번에 된다.

**명령으로 올리기(선택)**: `npx wrangler login` 한 번 → `npx wrangler pages deploy dist-web --project-name arp`. wrangler는 Cloudflare 공식 도구다.

**Cloudflare가 하는 일과 대응(검사로 고정)**

| Cloudflare 동작 | 대응 |
|---|---|
| `…/index.html`을 `…/`로 옮김(308) | 서비스 워커가 첫 페이지를 `./`로 담고, 옮겨진 응답은 새 응답으로 담는다. 설치 시작 주소도 `./` |
| `_headers` 파일로 응답 헤더 | 서비스 워커·첫 페이지·manifest는 `no-cache`, 해시 붙은 `assets/`는 1년 `immutable` |

[tools/e2e-deploy.mjs](../tools/e2e-deploy.mjs)는 이 동작을 흉내 내는 서버([tools/lib/pages-server.mjs](../tools/lib/pages-server.mjs))에서 크롬으로 10가지를 확인한다. 확인 항목은 맨 위 주소, 옮겨진 주소로 예시 열기, 헤더, 설치 시작 주소, 오프라인 세 주소, 서비스 워커가 켜진 채 열기다.

### 다른 곳

사내 정적 웹 서버 등 HTTPS 정적 호스팅이면 어디든 된다. `_headers`는 Cloudflare·Netlify 형식이라 다른 서버에서는 같은 헤더를 그 서버 설정으로 걸어 준다(없어도 동작은 한다).

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
