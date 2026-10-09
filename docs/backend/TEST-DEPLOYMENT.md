# 테스트 배포 현황 — 2026-10-10

## 현재 상태

- 테스트 서비스: https://cafe-admin-test.cafe-admin.workers.dev/cloud
- Worker: `cafe-admin-test`
- 배포 소스: PR #8, `2fc3566a860603b6ac816e45d7df38a605c27481`
- 최종 배포 버전: `c563ddf1-ffe4-487e-a528-f6fa4d5740b0`
- 카페 생성 정책: Google 로그인한 모든 사용자가 생성할 수 있다. 생성자는 해당 카페의 owner이며, 다른 카페 접근에는 멤버십·역할 검사가 계속 적용된다. `CAFE_CREATOR_IDS` 허용 목록은 제거했다.
- Cloudflare 계정: `fd599fd3feefc4b220c2ce49809d3477`
- 테스트 D1: `cafe-admin-test`, `dfa443d6-ce25-49c2-8768-bb4443d99cf4` (APAC)
- Migration 0001–0005 적용 완료. 0005는 5개 추가형 SQL을 1.48ms에 적용했다.
- 0005 직전 D1 복구 북마크: `00000006-0000003a-000050ff-b1c20b367626d60a680dbd1bb0485301`. 복구 실행을 뜻하지 않으며 전체 DB 복구 전 별도 확인이 필요하다.
- 운영 DB, 유료 요금제, 실제 장부 데이터 이전은 수행하지 않았다.

## Google 로그인 설정

- 프로젝트: `cafe-admin-511011`
- 앱 표시 이름: `카페장부`; 최초 설정 시 외부 사용자/테스트 중이었고 계정 소유자 한 명을 테스트 사용자로 등록했다. 10월 10일 사용자가 다른 계정 로그인 성공을 알렸다. 이번 변경은 서비스의 카페 생성 정책이며 Google 콘솔 설정은 변경하지 않았다.
- OAuth 웹 클라이언트 이름: `카페장부 테스트 웹`
- 클라이언트 ID: `98852765052-rvhtrdovsuv20bhjp7fdlp5fl0cpset3.apps.googleusercontent.com`
- 유일한 redirect URI: `https://cafe-admin-test.cafe-admin.workers.dev/auth/google/callback`
- Worker 변수: `APP_ENV=test`, `APP_ORIGIN=https://cafe-admin-test.cafe-admin.workers.dev`, 위 `GOOGLE_CLIENT_ID`.
- `GOOGLE_CLIENT_SECRET`, `INVITATION_TOKEN_KEY`가 Cloudflare의 `secret_text` 설정에 존재함을 CLI와 화면에서 확인했다. 비밀 값은 문서/Git에 기록하지 않았다.
- OAuth JSON 다운로드는 자동 승인 검토가 로컬 비밀 파일 생성을 이유로 거절했다. 다운로드를 실행하지 않고 승인된 목적지의 암호화된 입력창으로 직접 전달해 저장했다. 임시 메모리 값을 비웠고 클립보드의 비밀 값은 공개 클라이언트 ID로 교체했다.
- Google 콘솔은 Codex 브라우저의 목록/생성 화면에서 로딩 오류가 반복됐다. 사용자 승인 후 Chrome 앱의 UI로 생성했다. Cloudflare 저장에는 이미 로그인된 Codex 브라우저를 사용했다.

## 검증 결과와 남은 확인

- 2026-10-10 PR #8의 GitHub Actions `37951523983` required-checks 성공: backend 75개, 신규 가상 사용자 카페 생성 포함 cloud 시나리오, 빌드, 빈 D1 migration 및 no-op 재적용. 신규 사용자의 owner·active dataset 생성, 중복 요청 재생, 카페 간 접근 차단을 검증했다. 로컬 브라우저 증거: `/tmp/cafe-any-user-create.png`.
- 위 커밋을 기존 테스트 Worker에 배포했다. DB migration 없이 기존 D1 및 두 secrets를 유지했다. 원격 `/cloud` 200과 새 자산 `cloud-BDyi8CFt.js` 제공, 비로그인 POST `/api/v1/cafes`의 401 `UNAUTHENTICATED`, 두 secret 이름 보존을 확인했다. Codex 브라우저에서 기존 로그인·테스트 카페 A/B·생성 버튼 유지도 확인했다. 원격 화면 증거: `/tmp/cafe-any-user-deployed.png`. 신규 실제 Google 계정의 생성 클릭은 대신 실행하지 않았으며 신규 계정 흐름은 격리된 가상 세션으로 검증했다.
- PR #6의 GitHub Actions `37916749663` required-checks 성공: backend 75개/cloud 시나리오, 빌드, 빈 D1 migration 및 no-op 재적용 포함. 이전 PR #5의 `37794385307`도 성공했다.
- 원격 D1 migration 0005와 W13 Worker 배포 성공. 매시 17분 정리 Cron 등록을 배포 출력에서 확인했다. 정리 작업의 실제 예약 실행 결과는 아직 별도로 관찰하지 않았다.
- Chrome과 Codex 브라우저에서 공유 장부 첫 화면 확인.
- 실제 배포의 Google 로그인 버튼 → Google 계정 선택 → 계정 소유자의 이름/프로필 사진/이메일 제공 동의 화면까지 정상 도달.
- 2026-10-08 재개 시 사용자가 Google 동의를 완료한 상태였다. 실제 Chrome에서 로그인 유지 → 로그아웃 → 같은 Google 계정 재로그인 → `/api/v1/me` 성공을 확인했다. 내부 사용자 ID는 `535179a6-205c-4535-b1b5-0dbeed56f131`이며, 승인 후 `CAFE_CREATOR_IDS`에 적용하고 `canCreateCafe=true`를 확인했다. 세션/CSRF 토큰 원문은 기록하지 않았다.
- 승인된 본인 계정으로 `테스트 카페 A`, `테스트 카페 B`를 생성했다. B에 가상 매출(카드 12,300원, 현금 2,000원, 이체 미입력)을 저장하고 손익 14,300원을 확인했다. 초기 A는 비어 있었으며 10월 9일 승인된 가상 v2 자료를 적용했다.
- 사용자는 두 번째 계정 없이 본인 계정만 테스트하도록 지정했다. 실제 두 계정 검증은 미수행이며, 역할 격리·초대·동시성은 가상 계정 자동 테스트로 검증한다.
- W12 배포 후 같은 Chrome 세션에서 B의 v3 백업 생성·다운로드까지 성공했다. `/tmp/cafe-admin-test-b-20261008.json`을 읽어 매출 1건/14,300원, 이체 미입력 유지, 계정 ID 제외를 확인했다. 파일은 1,158바이트이며 가상 매출만 들어 있다.
- A에 가상 v2 파일을 실제 Chrome에서 업로드·서버 검증·적용했다. 매출 4건/110,000원, 매입 28,000원, 비용 5,000원, 기타 수입 3,000원 일치. `/tmp/cafe-admin-test-a-20261009.json`(6,334바이트) v3 다운로드의 합계·비공개 계정 식별자 제외를 검증했고 B의 14,300원도 유지된다. 다운로드한 A 백업을 별도 가상 SQLite DB에 복구해 13개 테이블 요약 일치도 확인했다. 이는 원격 D1 복구 결과가 아니다.
- W13 배포 후 실제 계정의 Chrome에서 `변경 이력`을 조회했다. B의 카페 등록·매출 등록·백업 등록/완료가 작업자·시간·결과와 함께 표시된다. 화면 증거: `/tmp/cafe-operations-remote.png`.
- 인증 없는 `/api/v1/me` 요청의 401 응답과 Wrangler tail의 안전한 `request_failed` 로그를 요청 번호 `8e0df426-d6e9-4930-90c4-b8929e3536b2`로 연결했다. 새 권한 없이 기존 연결을 사용했다. 저장 로그의 대시보드 검색과 원격 CPU/동시 사용 지연은 별도 미확인이다.
- Python HTTP 클라이언트 요청은 Cloudflare 1010으로 거절됐다. 브라우저 실제 화면 확인 결과와 구분한다.

## 재배포와 작업 보존

- 현재 배포에 사용한 격리 폴더: `/tmp/cafe-open-creation-deploy.snVeFb`, 설정: `wrangler.test.json` (비밀 값 없음). 이전 W13 폴더는 `/tmp/cafe-admin-w13-deploy.x452pnob`, W12 폴더는 `/tmp/cafe-admin-w12-deploy.Wrjaix`, PR #4 폴더는 `/tmp/cafe-admin-pr4-deploy.bHFl5B`이다.
- 임시 폴더가 없어지면 위 정확한 커밋을 별도 폴더에 export/build하고 위 테스트 DB/변수만 바인딩한다. `workers_dev=true`, `preview_urls=false`, `observability.enabled=true`, `observability.redact_query_string=true`, `observability.logs.enabled=true`, `observability.logs.invocation_logs=false`, `observability.traces.enabled=false`, `triggers.crons=["17 * * * *"]`를 적용한다. assets 및 API routing은 deployment generator를 따른다.
- 기존 두 환경용 generator에 가짜 운영 DB ID를 넣지 않았다. 운영 DB는 미생성이다.
- 재배포 때 Cloudflare의 기존 두 secret을 보존한다. 새 키를 임의 생성해 기존 키를 덮어쓰지 않는다.
- 현재 변경은 `codex/open-cafe-creation`의 draft PR #8이며 base는 원격 복구 검증 PR #7(`codex/cloud-recovery`)이다. 검증된 위 커밋을 archive/build한 폴더에서 배포했다. 이후 문서만 바꾼 커밋은 재배포하지 않는다. PR merge 및 운영 배포는 하지 않았다.
- 사용자가 중단 후 다시 남은 작업 진행을 요청했다. 현재 작업 재개가 승인되어 있다. 다음 작업은 `NEXT-2026-10-09.md`의 순서를 따르되 완료된 실제 로그인 검증을 반복하지 않는다.

재개 시 원격 D1 직접 조회 한 건은 Cloudflare 7403으로 거절됐지만, 동일하게 승인된 연결로 `wrangler d1 migrations list cafe-admin-test --remote --config wrangler.test.json` 재확인에 성공했다. 새 권한은 추가하지 않았다.
