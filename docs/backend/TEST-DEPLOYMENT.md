# 테스트 배포 현황 — 2026-10-08

## 현재 상태

- 테스트 서비스: https://cafe-admin-test.cafe-admin.workers.dev/cloud
- Worker: `cafe-admin-test`
- 배포 소스: PR #5, `eba338e8d34f931cade8fdc8df546aad562df019`
- 최종 배포 버전: `4d82def3-77f2-46cb-9eed-1e0424322fec`
- Cloudflare 계정: `fd599fd3feefc4b220c2ce49809d3477`
- 테스트 D1: `cafe-admin-test`, `dfa443d6-ce25-49c2-8768-bb4443d99cf4` (APAC)
- Migration 0001–0004 적용 완료. 0004는 10개 추가형 SQL을 3.73ms에 적용했다.
- 0004 직전 D1 복구 북마크: `00000004-0000000e-000050fe-8f8349daea015704be880c46fc7a0bb0`. 복구 실행을 뜻하지 않으며 전체 DB 복구 전 별도 확인이 필요하다.
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

- PR #5의 GitHub Actions `37794385307` required-checks 성공: backend/cloud 테스트, 빌드, 빈 D1 migration 및 no-op 재적용 포함.
- 원격 D1 migration 3개와 Worker 배포 성공.
- Chrome과 Codex 브라우저에서 공유 장부 첫 화면 확인.
- 실제 배포의 Google 로그인 버튼 → Google 계정 선택 → 계정 소유자의 이름/프로필 사진/이메일 제공 동의 화면까지 정상 도달.
- 2026-10-08 재개 시 사용자가 Google 동의를 완료한 상태였다. 실제 Chrome에서 로그인 유지 → 로그아웃 → 같은 Google 계정 재로그인 → `/api/v1/me` 성공을 확인했다. 내부 사용자 ID는 `535179a6-205c-4535-b1b5-0dbeed56f131`이며, 승인 후 `CAFE_CREATOR_IDS`에 적용하고 `canCreateCafe=true`를 확인했다. 세션/CSRF 토큰 원문은 기록하지 않았다.
- 승인된 본인 계정으로 `테스트 카페 A`, `테스트 카페 B`를 생성했다. B에 가상 매출(카드 12,300원, 현금 2,000원, 이체 미입력)을 저장하고 손익 14,300원을 확인했다. A의 매출은 0건이며 B로 돌아오면 저장 내용이 유지된다. A는 가져오기 검증용으로 비워 두었다.
- 사용자는 두 번째 계정 없이 본인 계정만 테스트하도록 지정했다. 실제 두 계정 검증은 미수행이며, 역할 격리·초대·동시성은 가상 계정 자동 테스트로 검증한다.
- W12 배포 후 같은 Chrome 세션에서 B의 v3 백업 생성·다운로드까지 성공했다. `/tmp/cafe-admin-test-b-20261008.json`을 읽어 매출 1건/14,300원, 이체 미입력 유지, 계정 ID 제외를 확인했다. 파일은 1,158바이트이며 가상 매출만 들어 있다.
- A에 가상 v2 파일을 업로드·적용하는 원격 확인은 브라우저 파일 업로드 승인을 받은 뒤 진행한다. 로컬 자동 브라우저에서는 같은 파일의 업로드·적용·다운로드가 통과했다.
- Python HTTP 클라이언트 요청은 Cloudflare 1010으로 거절됐다. 브라우저 실제 화면 확인 결과와 구분한다.

## 재배포와 작업 보존

- 현재 배포에 사용한 격리 폴더: `/tmp/cafe-admin-w12-deploy.Wrjaix`, 설정: `wrangler.test.json` (비밀 값 없음). 이전 PR #4 폴더는 `/tmp/cafe-admin-pr4-deploy.bHFl5B`이다.
- 임시 폴더가 없어지면 위 정확한 커밋을 별도 폴더에 export/build하고 위 테스트 DB/변수만 바인딩한다. `workers_dev=true`, `preview_urls=false`, `observability.enabled=false`, assets 및 API routing은 PR #4 설정을 따른다.
- 기존 두 환경용 generator에 가짜 운영 DB ID를 넣지 않았다. 운영 DB는 미생성이다.
- 재배포 때 Cloudflare의 기존 두 secret을 보존한다. 새 키를 임의 생성해 기존 키를 덮어쓰지 않는다.
- W12는 `codex/cloud-data-transfer`에 커밋하고 draft PR #5로 올렸다. 검증된 위 커밋을 archive/build한 폴더에서 배포했다. PR merge 및 운영 배포는 하지 않았다.
- 사용자가 중단 후 다시 남은 작업 진행을 요청했다. 현재 작업 재개가 승인되어 있다. 다음 작업은 `NEXT-2026-10-09.md`의 순서를 따르되 완료된 실제 로그인 검증을 반복하지 않는다.

재개 시 원격 D1 직접 조회 한 건은 Cloudflare 7403으로 거절됐지만, 동일하게 승인된 연결로 `wrangler d1 migrations list cafe-admin-test --remote --config wrangler.test.json` 재확인에 성공했다. 새 권한은 추가하지 않았다.
