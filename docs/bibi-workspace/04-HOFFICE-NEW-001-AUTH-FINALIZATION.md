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
| A1 | 초대 링크 콜백의 3형식 + 오류형을 결정적으로 파싱 | 집중 단위 테스트 | `tests/bibiAuthCallback.test.js` | 대기 |
| A2 | 콜백 토큰이 주소창/히스토리에 잔류하지 않음 | 단위 테스트 + 소스 계약 | `tests/bibiAuthCallback.test.js` | 대기 |
| A3 | 초대 세션에서 본인 비밀번호 설정 가능 | 정책 검증 + 배선 계약 테스트 | `tests/bibiPasswordSetup.test.js` | 대기 |
| A4 | 비밀번호 정책(길이·구성·이메일 포함 금지·확인 일치) 강제 | 단위 테스트 | `tests/bibiPasswordSetup.test.js` | 대기 |
| A5 | 재방문 시 이메일/비밀번호 로그인 동작 배선 | 계약 테스트 | `tests/bibiAuthSurface.test.js` | 대기 |
| A6 | 세션 복구(지속 세션 복원) 보존 | 계약 테스트 | `tests/bibiAuthSurface.test.js` | 대기 |
| A7 | 로그아웃 보존 (워크스페이스 + 설정 화면 양쪽) | 계약 테스트 | `tests/bibiAuthSurface.test.js` | 대기 |
| A8 | 공개 가입 경로 부재 | 계약 테스트 | `tests/bibiAuthSurface.test.js` | 대기 |
| A9 | 실패 문구가 계정 존재 여부·토큰을 누설하지 않음 | 단위 테스트 | `tests/bibiAuthCallback.test.js`, `tests/bibiAuthSurface.test.js` | 대기 |
| A10 | 비밀번호 미설정 상태 새로고침 복구 | 단위 테스트 | `tests/bibiPasswordSetup.test.js` | 대기 |
| A11 | 전체 테스트 회귀 0건 | `npm test` | 실행 영수증 | 대기 |
| A12 | Lint · Build · 패키지 검증 통과 | `npm run check` / `build` / `verify:package` | 실행 영수증 | 대기 |
| A13 | RLS **정적** 계약 통과 | `tests/supabaseRlsBoundary.test.js` | 실행 영수증 | 대기 |
| A14 | RLS **배포 readback** — 익명 접근 차단 확인 | 익명 PostgREST 읽기 전용 프로브 | `rls-readback.json` | 대기 |
| A15 | 360px 렌더 증거 | 실제 브라우저 스크린샷 | `evidence/.../*360*.png` | 대기 |
| A16 | 390px 렌더 증거 | 실제 브라우저 스크린샷 | `evidence/.../*390*.png` | 대기 |
| A17 | 데스크톱 렌더 증거 | 실제 브라우저 스크린샷 | `evidence/.../*desktop*.png` | 대기 |
| A18 | Production 배포 완료 | Vercel CLI 배포 | 실행 영수증 deployment_url | 대기 |
| A19 | 원격 HTTP readback | `curl` 상태·본문 확인 | `remote-http-readback.json` | 대기 |
| A20 | 원격 브라우저 readback | 실제 브라우저로 Production 접속 | `evidence/.../prod-*.png` | 대기 |
| A21 | 브라우저 번들에 privileged 키 부재 | 번들 스캔 | `bundle-key-scan.json` | 대기 |
| **A22** | **실제 사람 비밀번호 설정 및 그 자격증명 로그인** | 사람만 수행 가능 | — | **BLOCKED** |
| **A23** | **인증된 Production 동작(대화·업무 접수) 왕복** | A22 선행 필요 | — | **BLOCKED** |

---

## 5. BLOCKED — 사람 비밀번호 단계

### 5.1 무엇이 막혀 있는가

`A22`, `A23`은 **실제 사람의 비밀번호 입력**을 요구한다. 이 작업의 절대 비밀 규칙상 구현자는 그 값을 받지도, 찾지도, 만들지도, 재사용하지도 않는다. 따라서 구현자는:

- 초대 수락 화면이 렌더되고 배선되었음을 **PASS**로 증명할 수 있다.
- 실제 자격증명이 **수락**되었다는 것, 그리고 그 자격증명으로 로그인한 뒤의 인증된 Production 동작은 **증명할 수 없다** → `BLOCKED`.

이 둘을 섞어 `PASS`로 보고하는 것은 `POL-CORE-CERTAINTY-001` 위반이다.

### 5.2 해제 절차 (사용자가 직접 수행)

1. 발송된 공식 Supabase 초대 메일의 링크를 브라우저에서 연다.
2. 자동으로 열리는 **비밀번호 설정** 화면에서 본인만 아는 비밀번호를 입력하고 확인란에 동일하게 입력한다.
3. 저장되면 워크스페이스로 진입한다.
4. 로그아웃 후 https://bibi-workspace-18.vercel.app 에서 이메일 + 방금 설정한 비밀번호로 로그인한다.
5. 로그인 성공 여부만 알려주면 된다. **비밀번호 자체는 어떤 채널로도 전달하지 않는다.**

### 5.3 해제 후 자동 확정되는 항목

`A22`, `A23`. 그 전까지 이 두 항목은 `BLOCKED`로 고정하며, 다른 항목의 `PASS`로 대체하지 않는다.

---

## 6. 판정 규칙

- 이 문서와 `implementation-receipt.json`의 판정이 다르면 **영수증의 실제 실행 증거가 우선**한다.
- `A22`/`A23`이 `BLOCKED`인 동안 전체 작업 판정은 `PASS_WITH_BLOCKED`를 넘지 않는다.
- 정적 migration 검사(`A13`)와 배포 RLS readback(`A14`)은 **서로 대체하지 않는다**. 각각 별도 증거를 갖는다.
