# HOFFICE-NEW-001 — 인증 마감 (Auth Finalization) 공식 접수·결정 영수증

- 문서 종류: 공식 접수·결정 영수증 (intake / decision receipt)
- 작업 ID: `HOFFICE-NEW-001-AUTH`
- 저장소: `/Users/siyoung/projects/hermes-office-bibi-new`
- 브랜치: `bibi-workspace-v1` (혼합 작업본 worktree, 기존 변경 보존 필수)
- 정본 브리프: `/Users/siyoung/Documents/Siyoung-Bibi-Wiki/Bibi-18-Control-Center/05-Work-Intake/HOFFICE-NEW-001-AUTHORITATIVE-BRIEF.md`
- 정책 원장: `/Users/siyoung/Documents/Siyoung-Bibi-Wiki/Bibi-Policy-Enforcement/policy-registry.json` (registry 2.14.0)
- 정본 클라우드: Supabase ref `morvnoyyncluohmwxmuh` / Vercel project `bibi-workspace-18` (`prj_f15FG9Tem1Ios8YSC5CeDG1BUn7Z`)
- Production: https://bibi-workspace-18.vercel.app
- 증거 디렉터리: `docs/bibi-workspace/evidence/HOFFICE-NEW-001-auth/`
- 실행 영수증: `docs/bibi-workspace/evidence/HOFFICE-NEW-001-auth/implementation-receipt.json`

---

## 1. 작업 범위 (Scope)

공식 Supabase 초대(invite)가 이미 발송 성공한 상태를 전제로, **실제 운영 가능한 초대 수락 흐름**을 구현하고 검증해 인증을 마감한다.

### 1.1 구현 대상

| # | 항목 | 내용 |
|---|---|---|
| S1 | 초대 콜백 수신 | 초대 링크 복귀 URL의 fragment(implicit) · query(PKCE `code`) · `token_hash` 3형식과 오류 파라미터를 결정적으로 파싱 |
| S2 | 토큰 위생 | 콜백 토큰을 주소창·히스토리에 남기지 않고 즉시 제거(`history.replaceState`), 로그·에러 문구에 토큰 미노출 |
| S3 | 본인 비밀번호 설정 | 초대/복구 세션에서 사용자가 **자신의** 비밀번호를 직접 설정(`auth.updateUser`), 확인 입력·정책 검증 포함 |
| S4 | 재방문 로그인 | 이후 방문에서는 이메일/비밀번호 로그인(`signInWithPassword`) |
| S5 | 세션 복구 보존 | 지속 세션 복원(`getSession` + `onAuthStateChange`) 동작 유지 |
| S6 | 로그아웃 보존 | `signOut` 동작과 진입점 유지 |
| S7 | 공개 가입 차단 | `signUp`·공개 회원가입 경로 부재 유지 |
| S8 | 안전한 실패 문구 | 계정 존재 여부·토큰 값을 드러내지 않는 일반화(generic) 한국어 문구 |
| S9 | 미완료 설정 복구 | 초대 세션에서 비밀번호 미설정 상태로 새로고침해도 설정 화면으로 복귀 |

### 1.2 검증 대상

| # | 항목 | 방법 |
|---|---|---|
| V1 | 집중 테스트 | 콜백/토큰 파싱, 비밀번호 설정·변경, 이메일/비밀번호 로그인, 로그아웃/세션복구/문구 |
| V2 | 전체 테스트 | `npm test` (기존 420건 회귀 없음) |
| V3 | Lint / Build | `npm run check`, `npm run build`, `npm run verify:package` |
| V4 | RLS 정적 | migration SQL 정적 계약 검사 (`tests/supabaseRlsBoundary.test.js`) |
| V5 | RLS 배포 readback | 연결된 Supabase 프로젝트에 대해 **익명/메타데이터 읽기 전용** 확인 (사람 비밀번호 미사용) |
| V6 | 반응형 렌더 | 실제 브라우저 360px · 390px · 데스크톱 스크린샷 |
| V7 | Production 배포 | 기존 연결된 Vercel 프로젝트로 배포 |
| V8 | 원격 readback | 배포본 HTTP + 실제 브라우저 readback |

---

## 2. 적용 정책 (Policies)

| 정책 ID | 버전 | 이 작업에 대한 구속력 |
|---|---|---|
| `POL-CORE-CERTAINTY-001` | 1.0.0 | 모든 사실·수치·완료 판정은 직접 확인한 도구 증거에 연결한다. 근거 없으면 `UNKNOWN`/`BLOCKED`. 검증 게이트 전부 `PASS`일 때만 완료 선언. 실패는 `fail_closed`. |
| `POL-WORK-INTAKE-EXECUTION-001` | 1.1.0 | 업무 접수·실행 경계를 유지한다. 전제조건 미충족 상태에서 후속 단계를 착수하지 않으며, 단계 상태와 필수 영수증을 실제 산출물로 남긴다. |

- 기본 모드: `fail_closed`
- 허용 판정값: `PASS` / `FAIL` / `UNKNOWN` / `BLOCKED`
- 완료 조건: 필수 산출물 전부 존재 + 검증 게이트 전부 `PASS` + 금지 조건 위반 0건

### 2.1 정본 브리프에서 승계한 금지 조건

- service-role 키를 브라우저 번들에 포함 금지
- 기존 `bibi-command-center` Vercel/Supabase 재사용 금지 — 본 작업은 **이미 연결된** 신규 `bibi-workspace-18` / `morvnoyyncluohmwxmuh` 만 사용
- Preview/검증 실패 상태에서 Production 배포 금지
- 과거 에이전트의 완료 자기보고를 현재 증거로 재사용 금지

---

## 3. 제약 (Constraints)

### 3.1 비밀 취급 — 절대 규칙

- 채팅으로 전달된 평문 비밀번호는 **금지되며 제공되지 않았다**.
- 구현자는 그 값을 **탐색·추론·열람·출력·로그·저장·재사용하지 않는다**.
- `.env` 및 자격증명 파일의 **내용을 읽지 않는다**. 존재 여부·CLI 자체 사용까지만 허용.
- 브라우저 번들에 anon/publishable 키 외 어떤 키도 넣지 않는다 (`src/cloud/env.js`가 런타임·테스트에서 차단).
- 따라서 **실제 사람 비밀번호 입력과 그 자격증명으로의 인증된 Production 동작은 이 작업에서 수행 불가**이며 `BLOCKED`로 분류한다.

### 3.2 Git 절대 금지

`commit` / `push` / PR / `fetch` / `pull` / `checkout` / `reset` / `restore` / `clean` / `stash` / 브랜치 변경 / worktree 변경 / remote 변경 / 기존 작업 삭제 — **전부 금지**.
허용: `git status`, `git diff` **조회만**.

### 3.3 작업본 보존

혼합 worktree의 기존 변경(수정 9건 + 미추적 다수)은 **전부 보존**한다. 선행 세션 `f80ae803-fe10-443e-ae4b-15a222eb06a6`이 남긴 `src/App.jsx`, `src/ProfileChat.jsx`, `src/legacyRealtime.js`, `tests/bibiLegacyRealtimeGate.test.js` 변경도 보존한다.

### 3.4 인프라

- Supabase: ref `morvnoyyncluohmwxmuh` 만 사용. 신규 생성·타 프로젝트 재사용 금지.
- Vercel: 이미 링크된 `bibi-workspace-18` 만 사용. 신규 생성 금지.
- 공식 초대는 이미 발송 성공 — 재발송하지 않는다.

---

## 4. 인수 기준 매트릭스 (Acceptance Matrix)

판정은 실제 실행 증거로만 채운다. 증거 없으면 `UNKNOWN`, 수행 불가면 `BLOCKED`.

| ID | 인수 기준 | 검증 방법 | 증거 | 판정 |
|---|---|---|---|---|
| A1 | 초대 링크 콜백의 3형식 + 오류형을 결정적으로 파싱 | 집중 단위 테스트 | `tests/bibiAuthCallback.test.js` 24/24 | **PASS** |
| A2 | 콜백 토큰이 주소창/히스토리에 잔류하지 않음 | 단위 테스트 + 실제 브라우저 URL 확인 | `bibiAuthCallback.test.js`, `responsive-capture.json` (`tokenInUrl=false` ×9), `prod-browser-readback.json` (`authParamsRemaining=false` ×6) | **PASS** |
| A3 | 초대 세션에서 본인 비밀번호 설정 가능 | 정책 검증 + 배선 계약 + 실제 브라우저 렌더 | `tests/bibiPasswordSetup.test.js` 28/28, `screenshots/invite-password-setup-{360,390,desktop}.png` | **PASS** |
| A4 | 비밀번호 정책(길이·구성·이메일 포함 금지·확인 일치·bcrypt 72바이트) 강제 | 단위 테스트 | `tests/bibiPasswordSetup.test.js` | **PASS** |
| A5 | 재방문 시 이메일/비밀번호 로그인 동작 배선 | 계약 테스트 + 운영 브라우저 제출 | `tests/bibiAuthSurface.test.js`, `prod-signin-rejected-390.png` | **PASS** |
| A6 | 세션 복구(지속 세션 복원) 보존 | 계약 테스트 | `tests/bibiAuthSurface.test.js` | **PASS** |
| A7 | 로그아웃 보존 (워크스페이스 + 설정 화면 양쪽) | 계약 테스트 | `tests/bibiAuthSurface.test.js` | **PASS** |
| A8 | **앱** 공개 가입 경로 부재 | 계약 테스트 + 운영 브라우저 본문 스캔 | `bibiAuthSurface.test.js`, `prod-browser-readback.json` (`hasSignUpControl=false` ×6) | **PASS** |
| A9 | 실패 문구가 계정 존재 여부·토큰을 누설하지 않음 | 단위 테스트 + 실제 운영 응답 | `bibiAuthCallback.test.js`, `prod-browser-readback.json` (`disclosesAccountExistence=false`) | **PASS** |
| A10 | 비밀번호 미설정 상태 새로고침 복구 | 단위 테스트 | `tests/bibiPasswordSetup.test.js` | **PASS** |
| A11 | 전체 테스트 회귀 0건 | `npm run verify` (모든 writer 종료 후 독립 재검증) | 587 tests / 587 pass / 0 fail / 0 skipped / exit 0, 패키지 스캔 267 파일, `git diff --check` PASS. 기준선 420 → 본 작업 +60 = 480, 나머지는 동시 세션의 connector·launch-agent·keychain·realtime·warning·scroll 테스트다. 그 증가분은 본 작업 성과가 아니다 | **PASS** |
| A12 | Lint · Build · 패키지 검증 통과 | `npm run check` / `build` / `verify:package` | exit 0 / 0 / 0, 260 files scanned | **PASS** |
| A13 | RLS **정적** 계약 통과 | `tests/supabaseRlsBoundary.test.js` | 14/14 | **PASS** |
| A14 | RLS **배포 readback** — 익명 접근 차단 확인 | 익명 PostgREST 읽기 전용 프로브 | `rls-readback.json`: 보호 테이블 10/10 존재 + 0행, 익명 INSERT `42501` 거부, apikey 없으면 401 | **PASS** |
| A15 | 360px 렌더 증거 | 실제 브라우저 스크린샷 | `signin-360.png`, `invite-password-setup-360.png`, `invite-expired-360.png`, `prod-*-360.png` | **PASS** |
| A16 | 390px 렌더 증거 | 실제 브라우저 스크린샷 | `*-390.png` (로컬 3 + 운영 3) | **PASS** |
| A17 | 데스크톱(1440×900) 렌더 증거 | 실제 브라우저 스크린샷 | `*-desktop.png` (로컬 3 + 운영 3) | **PASS** |
| A18 | Production 배포 완료 | Vercel 배포 + alias readback | 현재 Production `dpl_43ELGvgfUJm6SjRw4YkZqzzH93xp` `READY` (`https://bibi-workspace-18-iyev4n76z-sam-s-hello.vercel.app`), alias `https://bibi-workspace-18.vercel.app` HTTP 200. 현재 Preview `dpl_53zzoSuFPeczwJNA358HXokRhm1e` `READY` (`https://bibi-workspace-18-2i30ht5l5-sam-s-hello.vercel.app`). 이전 배포들은 모두 대체됐고, 대체본에도 동일 구현이 실려 있음을 번들 readback으로 확인 | **PASS** |
| A19 | 원격 HTTP readback | `curl` 상태·본문 확인 | alias 200, SPA fallback 200, `/api/chat/send` 401 `MISSING_TOKEN`. 현재 배포 번들 `index-CPviD0US`에 `exchangeCodeForSession`·`verifyOtp`·`updateUser`·`detectSessionInUrl`·`token_hash`와 한국어 초대 문구 3종 존재 | **PASS** |
| A20 | 원격 브라우저 readback | 실제 브라우저로 Production 접속 | writer: `prod-browser-readback.json` 7/7 scene. orchestrator: Chrome 360·390·1440에서 7/7 scene, overflow 0, console error 0, 가입 컨트롤 없음 | **PASS** |
| A21 | 브라우저 번들에 privileged 키 부재 | 배포 번들 스캔 | `sb_secret_` 0건, service_role JWT 0건. `service_role` 문자열 2건은 이를 **거부하는** `src/cloud/env.js` 자체 가드 | **PASS** |
| A24 | Supabase 프로젝트 레벨 공개 가입 차단 | 공개 auth 설정 readback + 합성 signup 프로브 | `rls-readback.json`: `disable_signup: true`, signup 프로브 `422 signup_disabled`, 계정 미생성. 기대값 7/7 PASS (§4.1) | **PASS** |
| **A22** | **실제 사람 비밀번호 설정 및 그 자격증명 로그인** | 사람만 수행 가능 | 초대 계정 레코드 `ksy50934@gmail.com`는 Auth에 존재(orchestrator 확인). 그러나 초대 수락·비밀번호 설정·로그인은 **여전히 미증명** | **BLOCKED** |
| **A23** | **인증된 Production 동작(대화·업무 접수) 왕복** | A22 선행 필요 | 서버 신원은 독립 증명됨(폐기 자격증명이 401 `REVOKED_TOKEN` 반환, 정리 후 0/0). 그래도 실제 세션이 없어 왕복 불가 | **BLOCKED** |

### 4.1 A24 — 프로젝트 레벨 공개 가입 차단 (PASS)

**현재 상태: 닫힘.** 연결된 Supabase 프로젝트 `morvnoyyncluohmwxmuh`의 공개 가입이 차단되었다. orchestrator가 인증된 공식 Supabase CLI로 처리했고, 이 문서 작성자는 보고를 그대로 받아쓰지 않고 **자격증명이 전혀 개입하지 않는 공개 readback으로 독립 재검증**했다.

| 검증 | 결과 |
|---|---|
| `GET /auth/v1/settings` | `disable_signup: true` |
| `POST /auth/v1/signup` (합성 `.invalid` 주소) | `422`, `error_code: signup_disabled`, `"Signups not allowed for this instance"` |
| 계정 생성 여부 | **없음** |
| readback 기대값 | **7/7 PASS** |

설정 플래그와 실제 엔드포인트 동작을 **일부러 두 갈래로** 확인한다. 앞은 프로젝트가 무엇으로 설정됐는지를, 뒤는 엔드포인트가 실제로 무엇을 하는지를 말한다. 둘이 어긋나면 설정이 덜 적용된 것이고, 여기서는 일치한다.

재현:
```
node docs/bibi-workspace/evidence/HOFFICE-NEW-001-auth/tools/rls-readback.mjs
# verdict: PASS, failed_expectations: []
# 회귀 시 exit code 1
```

#### 4.1.1 일시적 오설정과 복원 — 전체 공개

의도한 것보다 넓은 변경이 라이브 프로젝트에 잠시 적용되었다가 같은 작업 안에서 되돌려졌다. 같은 결과에 도달했더라도 이 사실을 빼고 기록하면 프로젝트에 실제로 일어난 일을 왜곡하게 되므로 명시한다.

- **무슨 일이 있었나.** 최초의 임시 `supabase config push`가 non-TTY 환경에서 **자동 확인**되어, 한 개가 아니라 **auth 필드 7개**를 변경했다.
- **어떻게 바로잡았나.** orchestrator가 CLI의 unified diff에서 변경 전 값을 정확히 복원해 두 번째 push로 되돌렸고, 의도한 변경 하나만 남겼다.
- **복원된 값 (orchestrator 보고):** `site_url` `http://localhost:3000`, redirect 허용목록 `[]`, TOTP enroll `true`, TOTP verify `true`, email confirmations `true`, `max_frequency` `1m0s`, `otp_length` `8`.
  - 이 중 `site_url`과 redirect 허용목록은 **이후 의도적·대화형으로 다시 변경**되어 production을 가리킨다. §4.1.3 참조.
- **의도적으로 유지한 변경:** 전역 `enable_signup=false`.
- **자격증명·계정:** 실제 자격증명·비밀번호·계정은 **전혀 사용되거나 생성되지 않았다.**

#### 4.1.2 증거 경계 — 무엇을 직접 확인했고 무엇은 아닌가

이 구분을 흐리지 않는 것이 중요하다.

**직접 확인함** (공개 `/auth/v1/settings`): `disable_signup: true`, `external.email: true`, `mailer_autoconfirm: false`(이메일 확인 여전히 필수), OAuth 공급자 0개, 익명 사용자 비활성.

**직접 확인하지 못함:** `site_url`, redirect 허용목록, `totp_enroll`, `totp_verify`, `max_frequency`, `otp_length`. 공개 엔드포인트가 노출하지 않으며, 읽으려면 Management API가 필요한데 이 작성자는 의도적으로 호출하지 않는다. 따라서 이 값들은 **orchestrator 보고**로 기록하며 작성자 자신의 증거로 취급하지 않는다.

#### 4.1.3 redirect 대상 — 해소됨 (이전 판의 localhost 위험은 폐기)

앞선 판은 복원된 `site_url`이 `http://localhost:3000`이고 redirect 허용목록이 비어 있다는 점을 **A22에 영향을 주는 위험으로 플래그**했다. **그 위험은 해소되었고 이 문서에서 폐기한다.**

**최종 상태**

| 필드 | 값 |
|---|---|
| `site_url` | `https://bibi-workspace-18.vercel.app` |
| `additional_redirect_urls` | `[https://bibi-workspace-18.vercel.app]` |

**어떻게 확인되었나.** 정확히 ref `morvnoyyncluohmwxmuh`를 대상으로 **대화형** 공식 Supabase CLI `config push`를 실행했다.

- 적용 **전에** 표시된 unified diff에 차이가 **정확히 두 개**였고 **그 외에는 없었다.**
  - `site_url`: `http://localhost:3000` → `https://bibi-workspace-18.vercel.app`
  - `additional_redirect_urls`: `[]` → `[https://bibi-workspace-18.vercel.app]`
- 명시적으로 **Yes**를 입력해 승인했다.
- **exit 0.**
- 직후 다시 `config push`로 읽어보니 **`Remote API, DB, Auth, Storage config is up to date`** — 원격이 로컬 선언 **전체** 설정과 정확히 일치하며 남은 pending이 없다는 뜻이다. 즉 변경이 부분 적용된 것이 아니다.
- 공개 auth 설정은 그대로 **HTTP 200, `disable_signup: true`** — A24는 흔들리지 않았다.
- 이 과정에서 **어떤 비밀도 읽거나 출력하지 않았다.**

**왜 이번엔 대화형이었나.** 앞선 사고가 바로 non-TTY에서 push가 자동 확인되어 벌어진 일이었다. 대화형으로 돌렸기 때문에 **전체 설정 비교가 화면에 뜬 상태에서 의식적으로 승인**했고, 그래서 "차이가 정확히 둘뿐"이라는 진술이 의미를 갖는다. 확인 프롬프트는 필터된 일부가 아니라 **전체 config 비교**를 보여주므로, TOTP enroll·verify, email confirmations, `max_frequency`, `otp_length`, 그리고 A24로 닫은 가입 설정까지 **무관한 auth 설정은 이미 선언값과 동일했고 건드려지지 않았다.** 이것이 7개 필드를 조용히 움직였던 이전 non-TTY push와의 결정적 차이다.

**검증 경계.** `site_url`과 `additional_redirect_urls`는 공개 `/auth/v1/settings`가 노출하지 않으므로 이 작성자가 재실행해 확인할 수는 없고, 확인했다고 주장하지도 않는다. 근거는 CLI 자신의 적용 전 diff와 곧바로 이어진 "up to date" readback이며, 이는 추론이 아니라 직접 증거지만 **orchestrator가 생산한 것**으로 기록한다.

따라서 **초대 수락 전에 사용자가 확인할 사전 점검 항목은 없다.**

#### 4.1.4 이 항목의 판단 이력

이 항목은 `FAIL / BLOCKED`였고 그 **사유 자체가 한 번 정정**된 뒤 최종적으로 `PASS`가 되었다. 이력은 `implementation-receipt.json`의 `corrections_log`에 남아 있다.

1. 최초 판단: "이 머신에 Supabase 자격증명이 없다" — **틀림.** 레거시 파일·환경변수만 보고 OS 키링을 확인하지 않았다.
2. 정정된 판단: 자격증명은 키체인에 있고 CLI는 정상 사용하지만, 항목 ACL이 `/usr/bin/security`를 허용하지 않아 비대화형 읽기가 GUI 대화상자에서 정지한다. 따라서 이 프로세스는 사용할 수 없다.
3. 최종: orchestrator가 인증된 공식 CLI로 처리했고, 위와 같이 공개 readback으로 독립 재검증되어 **PASS**.

`A24`는 더 이상 전체 판정을 제약하지 않는다. 전체 판정이 `PASS_WITH_BLOCKED`에 머무는 이유는 이제 **오직 `A22`·`A23`** 이다.

---

## 5. BLOCKED — 사람 비밀번호 단계

### 5.1 무엇이 막혀 있는가

`A22`, `A23`은 **실제 사람의 비밀번호 입력**을 요구한다. 이 작업의 절대 비밀 규칙상 구현자는 그 값을 받지도, 찾지도, 만들지도, 재사용하지도 않는다. 따라서 구현자는:

- 초대 수락 화면이 렌더되고 배선되었음을 **PASS**로 증명할 수 있다.
- 실제 자격증명이 **수락**되었다는 것, 그리고 그 자격증명으로 로그인한 뒤의 인증된 Production 동작은 **증명할 수 없다** → `BLOCKED`.

이 둘을 섞어 `PASS`로 보고하는 것은 `POL-CORE-CERTAINTY-001` 위반이다.

### 5.2 해제 절차 (사용자가 직접 수행)

**사전 점검 없이 바로 1번부터 시작하면 된다.** redirect 대상은 이미 production으로 확정되어 있다(§4.1.3).

1. **이미 발송된** 공식 Supabase 초대 링크를 브라우저에서 연다.
2. 자동으로 열리는 **비밀번호 설정** 화면에서 본인만 아는 비밀번호를 입력하고 확인란에 동일하게 입력한다.
3. 저장되면 워크스페이스로 진입한다.
4. 로그아웃 후 https://bibi-workspace-18.vercel.app 에서 이메일 + 방금 설정한 비밀번호로 로그인한다.
5. 로그인 성공 여부만 알려주면 된다. **비밀번호 자체는 어떤 채널로도 전달하지 않는다.**

만약 **이미 발급된 링크 자체가 동작하지 않으면** 새 초대를 요청하면 된다. 링크는 만료되거나 이미 사용되면 그렇게 되는 것이 정상이며, **이는 이 작업의 실패가 아니다.**

### 5.3 해제 후 자동 확정되는 항목

`A22`, `A23`. 그 전까지 이 두 항목은 `BLOCKED`로 고정하며, 다른 항목의 `PASS`로 대체하지 않는다.

---

## 5.4 개정 2 — 후속 증거 반영 (문서·상태 전용)

이 개정은 원 구현 실행 이후 확보된 증거를 반영한다. **제품 코드·테스트·클라우드 상태·git 상태·환경변수·비밀은 이 개정에서 변경하지 않았다.**

### 증거 출처 구분

`POL-CORE-CERTAINTY-001@1.0.0`은 보고를 확인된 사실로 승격하는 것을 금지한다. 따라서 증거를 생산 주체별로 나눈다.

**writer가 이번 세션에서 직접 재실행한 것**

| 항목 | 결과 |
|---|---|
| `npm run verify` | 587/587 pass, 0 fail, 0 skipped, 패키지 스캔 267 파일, exit 0 |
| 집중 auth·scroll·warning·realtime 스위트 | 130/130 pass, 0 fail |
| `git diff --check` | exit 0 |
| Production alias | HTTP 200 |
| Preview 배포 | HTTP 200 |
| 배포 번들 내용 | 초대 수락 코드·한국어 문구 존재, `sb_secret_` 0건·service_role JWT 0건 |
| 미인증 API | `/api/chat/send` → 401 `MISSING_TOKEN` |

**orchestrator가 보고했고 writer가 재실행할 수 없는 것**

Supabase service-role 키 또는 Vercel 자격증명이 필요하고, 이 작업은 자격증명 내용 열람이 금지되어 있다. 따라서 **출처를 명시한 보고**로 기록하며 writer 검증 사실로 취급하지 않는다.

- Supabase service-role 관리 readback HTTP 200
- Auth 사용자 정확히 1명, 초대 신원 `ksy50934@gmail.com` 존재
- Vercel Production·Preview의 `SUPABASE_SERVICE_ROLE_KEY`를 현재 Supabase 프로젝트 service_role로 stdin 경유 덮어쓰기(값 미출력)
- 최신 Production 서버 신원 증명: 임시 폐기 자격증명이 401 `REVOKED_TOKEN` 반환, 정리 후 자격증명 0건 / 노드 0건
- 최신 Production(`dpl_43ELGvgfUJm6SjRw4YkZqzzH93xp`) Chrome QA 360·390·1440에서 7/7 scene, overflow 0, console error 0, 가입 컨트롤 없음. **미인증 화면 한정** — 로그인 상태 브라우저 QA는 없으며 A23에 속한다

### 초대 계정 존재가 의미하는 것과 의미하지 않는 것

Auth에 `ksy50934@gmail.com` 레코드가 있다는 사실은 **공식 초대가 계정 레코드를 만들었다**는 뜻이다. 초대가 **수락**됐다거나 비밀번호가 설정됐다거나 누가 로그인했다는 뜻이 **아니다**. 그러므로 A22는 PASS 쪽으로 움직이지 않고 그대로 `BLOCKED`이다.

### 이 개정에서도 바뀌지 않은 것

- A24는 그 개정 시점에는 `FAIL / BLOCKED`였다. service-role 키 교체는 프로젝트 auth 설정을 바꾸지 않으며 바꿀 수도 없기 때문이다. **이후 별도 작업으로 해소되어 지금은 `PASS`다** — §4.1 참조.
- 전체 판정은 `PASS_WITH_BLOCKED`이며 **완료를 주장하지 않는다**.

### 트리 안정성 — 재검증 완료

앞선 개정에는 **트리 불안정 경고**가 붙어 있었다. 공유 작업본에서 다른 세션이 제품 코드를 쓰는 동안 수치를 측정했기 때문이다. **그 경고는 이제 무효이며 삭제한다.**

모든 writer가 작업을 멈춘 뒤 트리를 독립적으로 재검증했다.

| 확인 | 결과 |
|---|---|
| `npm run verify` | 587 / 587 pass, 0 fail, exit 0 |
| 패키지 스캔 | 267 파일 |
| `git diff --check` | PASS |

따라서 이 개정의 수치는 **측정 직후 흘러가 버린 스냅샷이 아니라 지금 디스크 위의 트리를 그대로 서술한다.**

### 후속 작업 미착수

`bibi-06` 디자인 접수와 `bibi-10` 독립 검토는 **착수하지 않았다** (`NOT_STARTED`).

과업 전제조건이 계정·인증 안정화를 선행으로 둔다. `A24`는 해소되어 더 이상 이 둘을 막지 않지만, **`A22`와 `A23`이 여전히 `BLOCKED`** 다 — 소유자의 초대 수락·비밀번호 설정·실제 로그인/로그아웃·인증된 대화/업무 왕복·로그인 상태 브라우저 QA가 모두 미수행이다. 계정·인증이 **완전히 안정되었다고 볼 수 없으므로** 두 후속 작업 모두 착수 조건을 충족하지 않는다.

---

## 6. 판정 규칙

- 이 문서와 `implementation-receipt.json`의 판정이 다르면 **영수증의 실제 실행 증거가 우선**한다.
- `A22`/`A23`이 `BLOCKED`인 동안 전체 작업 판정은 `PASS_WITH_BLOCKED`를 넘지 않는다.
- 정적 migration 검사(`A13`)와 배포 RLS readback(`A14`)은 **서로 대체하지 않는다**. 각각 별도 증거를 갖는다.
