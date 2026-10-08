# W04 로컬 실행·CI·환경 설정

## 외부 계정 없이 실행

Node 22.22 이상과 package.json의 pnpm 11.19.0을 사용한다. 이 작업의 로컬 실행은 Node 24.19.0이었다.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check:backend
pnpm db:migrate:local
pnpm dev:worker
```

설치 스크립트는 실행하지 않는다. lockfile의 플랫폼별 esbuild/workerd 바이너리를 사용한다. `check:backend`는 기존 단위 → 서버 단위 → D1 → 클라이언트/서버 타입·Vite → 실제 Worker 라우팅 → dry-run bundle을 실행한다. 기존 브라우저 UI 파일은 변경하지 않았으며 이 PR의 필수 검증에 Playwright를 새로 추가하지 않았다.

로컬 CLI D1는 `/tmp/cafe-admin-w04-local`에 저장된다. 통합 테스트 D1는 각 테스트의 일회용 Miniflare 인스턴스이며 CLI DB와 공유하지 않는다. 라우팅 테스트도 별도 임시 디렉터리를 만들고 종료 시 정리한다. 로컬 초기화는 자신이 만든 해당 임시 디렉터리만 지운 뒤 migration을 다시 적용한다. 가상 seed는 자동 migration에 포함하지 않았고, 테스트 harness가 준비한 DB에만 넣는다.

`pnpm build:worker`는 `--dry-run`만 수행한다. 실제 배포 명령이 아니다. 현재 `/api`와 `/auth`는 404가 정상이다. 로그인 없는 샘플 API를 요청하거나 운영 인증을 우회해서 확인하지 않는다.

## 환경 격리

`wrangler.toml` 기본 설정은 `remote=false`, `database_id=local-only`인 로컬 전용이다. `test`, `production`은 DB 바인딩을 빈 배열로 명시한다. 임의 원격 UUID·계정·OAuth 비밀 값을 저장소에 채우지 않았다. 두 환경에서 DB가 없다는 Wrangler 경고는 현재 의도된 미설정 상태다.

D1 바인딩/vars는 환경별로 별도 설정한다. 테스트에서 운영 DB ID·API 토큰을 사용하지 않는다. 미리보기 URL과 workers.dev는 기본적으로 비활성이다. PR CI에는 Cloudflare secrets가 전달되지 않으며 `pull_request_target`을 사용하지 않는다.

실제 계정이 준비되면 운영자가 다음을 수행해야 한다.

1. 서로 다른 테스트/운영 D1를 만들고 실제 database ID/name을 확인한다. 무료 계정 범위와 한도를 확인하며 자동 요금제 변경을 설정하지 않는다.
2. GitHub `test`, `production` environments를 만들고 필수 승인자와 배포 branch/tag 제한을 설정한다. branch protection 필수 검사에는 `Backend foundation / required-checks`를 추가한다. 이 PR이 GitHub 설정을 변경한 것은 아니다.
3. 각 environment vars에 `D1_DATABASE_ID`, 반대 환경의 `OTHER_D1_DATABASE_ID`, `D1_DATABASE_NAME`, `CLOUDFLARE_ACCOUNT_ID`를 넣는다. environment secret `CLOUDFLARE_API_TOKEN`은 해당 환경의 최소 권한 토큰으로 설정한다. PR CI와 저장소 전역 secret으로 운영 토큰을 제공하지 않는다.
4. 별도 승인된 도메인/route를 환경별로 연결한다. 현재 generator는 route를 임의 생성하지 않고 workers.dev/preview_urls도 열지 않는다. 따라서 코드 업로드 자체가 접근 가능한 테스트 주소를 의미하지 않는다.
5. OAuth callback, 허용 Origin, 카페 생성 허용 목록과 역할별 계정은 W05 이후 별도 연결한다. 지금의 Worker에는 해당 인증 구현이 없다.
6. 테스트 DB의 빈 migration 적용, 샘플 명령·실패 복구, 백업 및 운영 migration 계획을 승인한다. 원격 migration은 이 저장소 workflow가 자동 실행하지 않는다. 코드 롤백은 DB rollback이 아니다.
7. 위 준비가 완료된 뒤에만 repository variable `ENABLE_CLOUDFLARE_DEPLOY=true`를 명시적으로 설정한다. 기본은 미설정/비활성이다.

## 검증된 커밋의 명시적 배포

`Explicit verified deployment` workflow는 수동 실행만 지원한다. 대상 environment와 전체 40자리 commit SHA를 입력한다. 먼저 해당 SHA를 checkout해 필수 검증을 실행하고, 성공한 동일 SHA를 배포 job에서 다시 checkout/build한다. 배포 job은 enable 변수와 GitHub environment 승인을 거친 뒤에만 토큰에 접근한다. 검토하지 않은 SHA를 승인하지 않는다.

`tests/server/deployment-config.mjs`는 제공된 설정으로 임시 파일을 생성할 뿐 외부 API를 호출하지 않는다. 두 DB ID가 누락되거나 같으면 실패한다. 실제 계정에서 두 ID가 존재하고 환경별로 올바르게 매핑되었는지는 운영자가 확인해야 한다. generator는 다른 환경의 DB binding·비밀을 출력하지 않는다.

이번 작업에서는 enable 변수·GitHub environment·secret·DB·domain을 생성하거나 배포 workflow를 실행하지 않았다. 실제 원격 DB isolation, OAuth, 테스트 주소의 읽기/쓰기, 운영 백업/복구는 미검증이다. 향후 스키마 변경은 배포 전 별도 migration 순서·호환성·백업 승인을 받아야 한다.
