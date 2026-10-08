# 테스트 배포 현황 — 2026-10-08

## 현재 상태

- 테스트 서비스: https://cafe-admin-test.cafe-admin.workers.dev/cloud
- Worker: `cafe-admin-test`
- 배포 소스: PR #4, `54b22aa1411c66948553595629537ee46920f4a0`
- 최종 배포 버전: `2f70e09f-7461-480d-a09a-e7139f20d7fc`
- Cloudflare 계정: `fd599fd3feefc4b220c2ce49809d3477`
- 테스트 D1: `cafe-admin-test`, `dfa443d6-ce25-49c2-8768-bb4443d99cf4` (APAC)
- 새 빈 DB에 migration 0001–0003 적용 완료. W12의 미완성 0004는 배포하지 않았다.
- 운영 DB, 유료 요금제, 실제 장부 데이터 이전은 수행하지 않았다.

## Google 로그인 설정

- 프로젝트: `cafe-admin-511011`
- 앱 표시 이름: `카페장부`; 외부 사용자/테스트 중; 계정 소유자 한 명을 테스트 사용자로 등록했다.
- OAuth 웹 클라이언트 이름: `카페장부 테스트 웹`
- 클라이언트 ID: `98852765052-rvhtrdovsuv20bhjp7fdlp5fl0cpset3.apps.googleusercontent.com`
- 유일한 redirect URI: `https://cafe-admin-test.cafe-admin.workers.dev/auth/google/callback`
- Worker 변수: `APP_ENV=test`, `APP_ORIGIN=https://cafe-admin-test.cafe-admin.workers.dev`, 위 `GOOGLE_CLIENT_ID`.
- `GOOGLE_CLIENT_SECRET`, `INVITATION_TOKEN_KEY`가 Cloudflare의 `secret_text` 설정에 존재함을 CLI와 화면에서 확인했다. 비밀 값은 문서/Git에 기록하지 않았다.
- OAuth JSON 다운로드는 자동 승인 검토가 로컬 비밀 파일 생성을 이유로 거절했다. 다운로드를 실행하지 않고 승인된 목적지의 암호화된 입력창으로 직접 전달해 저장했다. 임시 메모리 값을 비웠고 클립보드의 비밀 값은 공개 클라이언트 ID로 교체했다.
- Google 콘솔은 Codex 브라우저의 목록/생성 화면에서 로딩 오류가 반복됐다. 사용자 승인 후 Chrome 앱의 UI로 생성했다. Cloudflare 저장에는 이미 로그인된 Codex 브라우저를 사용했다.

## 검증 결과와 남은 확인

- 격리된 PR #4 소스의 `pnpm build` 성공. 기존 PR #4 CI도 통과한 버전이다.
- 원격 D1 migration 3개와 Worker 배포 성공.
- Chrome과 Codex 브라우저에서 공유 장부 첫 화면 확인.
- 실제 배포의 Google 로그인 버튼 → Google 계정 선택 → 계정 소유자의 이름/프로필 사진/이메일 제공 동의 화면까지 정상 도달.
- 2026-10-08 재개 시 사용자가 Google 동의를 완료한 상태였다. 실제 Chrome에서 로그인 유지 → 로그아웃 → 같은 Google 계정 재로그인 → `/api/v1/me` 성공을 확인했다. 내부 사용자 ID는 `535179a6-205c-4535-b1b5-0dbeed56f131`이며, 승인 후 `CAFE_CREATOR_IDS`에 적용하고 `canCreateCafe=true`를 확인했다. 세션/CSRF 토큰 원문은 기록하지 않았다.
- 승인된 본인 계정으로 `테스트 카페 A`, `테스트 카페 B`를 생성했다. B에 가상 매출(카드 12,300원, 현금 2,000원, 이체 미입력)을 저장하고 손익 14,300원을 확인했다. A의 매출은 0건이며 B로 돌아오면 저장 내용이 유지된다. A는 가져오기 검증용으로 비워 두었다.
- 사용자는 두 번째 계정 없이 본인 계정만 테스트하도록 지정했다. 실제 두 계정 검증은 미수행이며, 역할 격리·초대·동시성은 가상 계정 자동 테스트로 검증한다.
- Python HTTP 클라이언트 요청은 Cloudflare 1010으로 거절됐다. 브라우저 실제 화면 확인 결과와 구분한다.

## 재배포와 작업 보존

- 오늘 배포에 사용한 격리 폴더: `/tmp/cafe-admin-pr4-deploy.bHFl5B`, 설정: `wrangler.test.json` (비밀 값 없음).
- 임시 폴더가 없어지면 위 정확한 커밋을 별도 폴더에 export/build하고 위 테스트 DB/변수만 바인딩한다. `workers_dev=true`, `preview_urls=false`, `observability.enabled=false`, assets 및 API routing은 PR #4 설정을 따른다.
- 기존 두 환경용 generator에 가짜 운영 DB ID를 넣지 않았다. 운영 DB는 미생성이다.
- 재배포 때 Cloudflare의 기존 두 secret을 보존한다. 새 키를 임의 생성해 기존 키를 덮어쓰지 않는다.
- 현재 작업 브랜치 `codex/cloud-data-transfer`에는 미커밋 W12 작업이 있다. 해당 변경을 검증 없이 현재 테스트 서버에 배포하지 않는다.
- 사용자가 중단 후 다시 남은 작업 진행을 요청했다. 현재 작업 재개가 승인되어 있다. 다음 작업은 `NEXT-2026-10-09.md`의 순서를 따르되 완료된 실제 로그인 검증을 반복하지 않는다.

재개 시 원격 D1 직접 조회 한 건은 Cloudflare 7403으로 거절됐지만, 동일하게 승인된 연결로 `wrangler d1 migrations list cafe-admin-test --remote --config wrangler.test.json` 재확인에 성공했다. 새 권한은 추가하지 않았다.
