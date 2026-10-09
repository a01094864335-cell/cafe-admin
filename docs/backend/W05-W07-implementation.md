# W05–W07 서버 구현과 UI 연결 안내

2026-10-08. W04 커밋 `993ee02092c566ce4aefe337e5415587671f27c1`의 후속 작업이다. `cafe-admin-backend`에서 서버·서버 테스트·설정만 변경했다. 클라이언트, UX 목업, 공통 API/제품 문서는 수정하지 않았다.

## 구현 상태

| 작업 | 구현 | 외부/통합 대기 |
| --- | --- | --- |
| W05 | Google authorization-code 로그인 시작/콜백, state·브라우저 결합·nonce·PKCE, jose 서명 검증, 사용자/identity 연결, 세션·CSRF·logout·me | 실제 Google 앱/계정, HTTPS 주소의 브라우저 쿠키·redirect 확인 |
| W06 | 허용 목록의 카페 생성, 카페/dataset/owner 원자적 생성, 참여 목록/상세/수정, 카페별 현재 멤버십 검사·페이지 처리 | 카페 전환 UI, 캐시·늦은 응답/미저장 상태 연결 |
| W07 | 역할별 초대·취소·대상 조회·일회용 수락, 역할 변경/참여 해제, 소유권 이전·owner 1명, 중복 요청 재생 | 초대 링크 UI·실제 두 브라우저 검증 |

DB는 W04 스키마를 그대로 사용하며 새 migration이 필요하지 않다. 메일을 전송하지 않는다. 인증 우회 또는 데모 계정 API를 만들지 않았다. 테스트 세션과 가상 제공자는 테스트 코드에서만 주입하며 production Worker는 고정된 Google 제공자를 사용한다.

## 인증 경계

Google ID token은 `jose`의 RS256 서명, Google issuer, client audience, exp/iat, nonce, azp, 검증된 이메일을 확인한다. JWK/token endpoint는 코드에 고정되어 사용자 입력이나 환경 변수로 다른 issuer로 바꿀 수 없다. 신원 키는 `(google, sub)`다. 동일 이메일의 서로 다른 sub를 자동 병합하지 않는다.

OAuth 상태는 10분, 브라우저 cookie hash와 결합하며 콜백에서 조건부 UPDATE RETURNING으로 한 번만 소비한다. 잘못된 state·브라우저·만료는 token exchange 전에 차단한다. token exchange 실패 후에는 새 로그인을 시작해야 한다. Google 요청 timeout/5xx/429는 503, 부적절한 응답/ID token은 인증 실패다. Google live 연결을 확인한 결과는 아니다.

`__Host-session`은 무작위 32바이트, Secure/HttpOnly/SameSite=Lax/Path=/, 절대 만료 7일이다. DB에는 SHA-256 hash만 저장한다. 로그인 성공 시 기존 브라우저 세션을 폐기한다. `__Host-csrf`는 별도의 무작위 값이며 JS에서 읽을 수 있지만 DB에는 hash만 저장한다. `/api/v1/me`도 해당 hash와 일치하는 CSRF 값만 반환한다.

변경 요청은 세션, 정확한 `Origin`, `X-CSRF-Token`을 검사한다. JSON 입력은 16KiB까지 읽으며 지정된 필드 외 `userId`, `role`, `actorId` 같은 신원 주입은 해당 요청 스키마에서 거부한다. API 응답은 no-store/no-referrer이며 SQL·인증 원문을 오류에 넣지 않는다. Worker observability는 기본 비활성으로 두었다. 향후 W13 로깅은 callback query와 invitation token 경로를 반드시 제거해야 한다.

## 카페와 명령 처리

모든 카페 접근은 세션에서 찾은 사용자로 현재 활성 멤버십을 조회한다. 비참여 카페는 404, 참여 카페 내 역할 부족은 403이다. 멤버 목록은 owner/admin만 조회한다. admin은 staff만 초대·해제하고 admin/owner를 변경하지 못한다. 소유자 대상 일반 역할 변경·해제는 거부한다.

쓰기 batch는 command 예약 → 세션 재검증 → 현재 역할/대상/version 조건부 쓰기 및 즉시 changes assertion → 결과/감사/revision → 최종 owner/dataset assertion 순이다. 권한이나 version 실패 시 부분 command/감사/revision을 남기지 않는다. 소유권 이전은 write_mode=open이어야 하고, 이전 owner는 admin이 된다.

`Idempotency-Key`는 8–128자 `[A-Za-z0-9_-]`로 생성한다(UUID 권장). 범위는 사용자+메서드+자원 경로다. 정규화 payload hash가 다르면 409 IDEMPOTENCY_MISMATCH다. 동일 요청은 최소 결과를 재생하되 현재 권한을 다시 확인한다. 소유권 이전이 끝난 이전 owner는 admin이 되므로 새 재시도는 현재 권한 계약에 따라 403이다. 응답을 잃었다면 카페/멤버 목록을 재조회해 현재 소유자를 확인한다. 이를 예외적으로 재생 허용하는 정책은 추가하지 않았다. 참여가 해제되면 재생도 차단한다.

## 초대 토큰

초대는 지정 이메일·admin/staff 역할·7일 만료에 연결한다. 수락 시 계정의 검증된 현재 이메일, 초대 소비/취소/만료, 초대자의 현재 부여 권한을 재검증한다. SQL 안에서도 이를 확인한다. 이미 활성 참여 중인 사용자는 다른 초대로 역할을 덮어쓸 수 없다. 비활성 멤버십은 초대 역할로 재활성화한다. 직원 계정 연결 재검증은 직원 API가 추가되는 W10에서 구현해야 한다.

초대 링크 생성/재생용 토큰은 별도의 `INVITATION_TOKEN_KEY`로 초대 ID에 HMAC-SHA256을 적용한다. DB invitation에는 token hash만 저장하고 command 결과에는 token을 넣지 않는다. 수락 command scope의 경로 토큰도 hash로 치환한다. 키 없이 초대를 생성할 수 없다. 기존 발급 링크는 DB hash로 검증하므로 키 회전만으로 폐기되지 않는다. 키 회전 후 과거 생성 명령의 링크 재생은 409가 되며, 기존 초대의 명시적 취소와 새 초대 발급이 필요하다. 운영 키는 secret manager에서 32바이트 이상의 난수로 생성하고 43자 base64url 형식으로 설정한다.

## UI가 연결할 HTTP 계약

모든 API는 같은 출처로 호출한다. 쿠키를 localStorage로 복사하지 않는다. 요청별 응답 requestId를 오류 추적에 사용하되 토큰 URL·백업 원문을 기록하지 않는다.

| 요청 | 핵심 입력/출력 |
| --- | --- |
| GET `/auth/google/start` | 브라우저 이동으로 시작, Google로 302 |
| GET `/api/v1/me` | `{data:{id,name,email,csrfToken},requestId}` |
| POST `/auth/logout` | Origin/CSRF 필요, 세션 폐기·쿠키 삭제 |
| GET `/api/v1/cafes` | 현재 참여 카페 `{id,name,timezone,version,role}` |
| POST `/api/v1/cafes` | `{name,timezone?}`, 생성 허용 사용자만, 201 |
| GET/PATCH `/api/v1/cafes/:id` | PATCH `{name?,timezone?,expectedVersion}`, owner만 수정 |
| GET `/api/v1/cafes/:id/members` | `{userId,name,email,role,status,version}` |
| PATCH/DELETE `/api/v1/cafes/:id/members/:userId` | `{role,expectedVersion}` / `{expectedVersion}` |
| POST `/api/v1/cafes/:id/ownership-transfer` | `{userId,expectedVersion}`; version은 현재 owner 멤버십의 version |
| POST `/api/v1/cafes/:id/invitations` | `{email,role}`, 201 `{id,email,role,expiresAt,token}` |
| DELETE `/api/v1/cafes/:id/invitations/:id` | 본문 불필요, 중복 요청 키 필요 |
| GET `/api/v1/invitations/:token` | 로그인한 대상 사용자만 최소 초대 상태 조회 |
| POST `/api/v1/invitations/:token/accept` | 본문 불필요, 현재 세션 이메일 기준 수락 |

logout을 제외한 모든 변경 명령에 Idempotency-Key를 보낸다. logout은 세션 폐기로 반복 효과가 제한되며 폐기 후 요청은 401이다. 목록은 기본 50/최대100의 `limit`, 불투명 `cursor`, 응답 `nextCursor`를 사용한다. cursor는 사용자/카페 범위가 바뀌면 재사용할 수 없다. 클라이언트가 활성 dataset이나 actor를 지정하지 않는다.

API 오류 형식은 기존 계약 `{error:{code,message},requestId}`다. 현재 message는 안정적인 오류 코드 문자열이며 UI에서 안내 문구를 연결해야 한다. VERSION_CONFLICT 응답에는 아직 latest DTO를 제공하지 않으므로 재조회해서 비교한다. 예전 성공 key를 다른 body에 재사용하지 않는다.

## 필요한 환경 설정

- vars: `APP_ORIGIN`(path 없는 정확한 HTTPS origin), 실제 `GOOGLE_CLIENT_ID`.
- 2026-10-10 사용자 요청으로 생성 허용 목록을 제거했다. 로그인한 모든 사용자가 카페를 생성하고 해당 카페의 owner가 된다. 다른 카페에는 기존 멤버십·초대·역할 검사가 그대로 적용되며 비로그인 생성은 거부한다.
- 환경별 Worker secrets: 실제 `GOOGLE_CLIENT_SECRET`, 별도의 `INVITATION_TOKEN_KEY`.
- Google callback URI: `${APP_ORIGIN}/auth/google/callback`을 테스트/운영 OAuth 앱에 정확히 등록한다.
- 배포 config generator와 수동 workflow에 공개 vars 전달을 추가했다. secrets는 파일·GitHub PR·로그에 넣지 않고 환경별 Worker secret 저장소에서 관리한다.
- 기존 DB 분리·수동 배포 enable/승인 gate는 유지한다. 로컬 합성 테스트에는 실제 계정이나 위 운영 설정이 필요하지 않다. 실제 브라우저 로그인은 HTTPS 환경을 준비한 뒤 확인한다.

## 검증 및 남은 작업

로컬 D1에서 OAuth 상태 소비, 세션 만료/로그아웃/CSRF, 동일 이메일 다른 sub, 카페별 권한·생성 허용 목록, version 충돌 rollback, 권한 회수, 소유권 동시 재생, 초대 동시 수락·만료·취소·잘못된 이메일·초대자 권한 회수, 목록 페이지 처리, 입력/크기 제한을 검증한다. 합성 RSA 토큰으로 서명·issuer·audience·nonce·expiry·azp·email_verified 실패를 검증한다. 기존 계산 회귀와 Worker 라우팅도 함께 실행한다.

검증 결과: 기존 단위/회귀 20개, 서버 단위 4개, 로컬 D1 24개, Worker 통합 2개 등 총 50개와 타입·Vite·Worker dry-run 빌드 통과.

Google 실계정/실제 JWK 네트워크, 원격 D1·테스트 주소, UI 브라우저 흐름은 계정 미제공으로 미검증이다. W05–W07 전체 제품 완료가 아닌 서버 구현 완료다. W08 매출 공유 API와 UI 연결, W10 직원 연결 재검증, W13 요청 제한/민감정보 제거 관측 및 OAuth 임시 상태 정리, 외부 파일럿 검증이 뒤따라야 한다. 원격 배포·운영 migration·메일 발송·유료 전환은 실행하지 않았다.

공식 참고: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/). 2026-10-08 확인.
