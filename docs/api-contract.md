# API 계약과 검증 위치 (W02)

2026-10-08. 구현 예정 API이며 현재 브라우저 로컬 앱에는 서버가 없다.
기본 경로 `/api/v1`, 카페 경로 `/api/v1/cafes/:cafeId`.

## 공통 요청 처리

1. 라우터: 허용된 메서드·JSON 형식·본문 크기 검사, requestId 부여.
2. 인증: 해시로 조회한 서버 세션의 만료·폐기 검사. 초기 기본은 세션 7일, OAuth 임시 상태 10분이다.
3. 변경 요청: 허용 Origin과 CSRF 토큰 검사. OAuth callback은 일회용 state/nonce/PKCE 검증을 별도 적용한다.
4. 카페 middleware: 경로의 cafeId에 대한 현재 활성 멤버십·역할 확인. 응답에 전달할 현재 데이터 범위를 서버에서 결정한다.
5. 서비스: 입력 스키마, 직원·품목·대상 범위 및 업무 규칙 검증. 본인 직원 ID는 서버에서 찾는다.
6. Repository: cafe_id+active_dataset_id 필수 조건. 쓰기는 현재 역할·잠금·version도 SQL 안에서 재검증한다.
7. batch: command 예약, 거래·이동·이력·revision·응답 결과를 원자적으로 저장. 실패 후에만 오류를 반환한다.

클라이언트의 role/userId/actorId/datasetId는 권한 근거로 받지 않는다. 미참여 카페와 타 카페 기록은 404, 참여 카페 내 역할 부족은 403. 직원 응답 DTO에 전체 장부·타인 급여 필드를 포함하지 않는다.

## 엔드포인트별 계약

O=owner, A=admin, S=staff. 모든 카페 행에 위 공통 검증이 적용된다.

| 요청 | 허용 | 추가 검증·동시성 |
| --- | --- | --- |
| GET /me, POST /auth/logout | 로그인 | 로그아웃도 CSRF, 서버 세션 폐기 |
| GET /cafes | 로그인 | 본인의 활성 참여 카페만 |
| POST /cafes | 생성 허용 사용자 | 카페·dataset·owner 생성 batch, 중복 요청 키 |
| GET/PATCH /cafes/:cafeId | GET O/A/S, PATCH O | version, 시간대 검증, 감사 이력 |
| GET /members | O/A | 권한에 맞는 멤버 정보만 |
| POST /invitations | O/A | A는 staff만, 대상 이메일·7일 만료, 중복 요청 키 |
| DELETE /invitations/:id | O/A | A는 staff 초대만, cafe 범위와 현재 초대 권한 재검증 |
| GET/POST /invitations/:token[/accept] | 대상 로그인 사용자 | 해시·검증 이메일·만료·취소·초대자 현재 권한, 수락은 소비+멤버십 batch |
| PATCH/DELETE /members/:userId | O/A | A는 staff만, owner 대상 거부, version |
| POST /ownership-transfer | O | 활성 대상 멤버, 기존 O→A, 최종 O 1명 assertion, 중복 요청 키 |
| GET/POST /sales, /purchases, /expenses, /other-incomes | O/A | 날짜·정수·nullable 계약, 생성에 중복 요청 키 |
| GET/PATCH/DELETE 위 경로/:id | O/A | cafe/dataset 대상 조회, PATCH/DELETE version·중복 요청 키 |
| GET/POST /inventory/items, PATCH/DELETE /inventory/items/:id | O/A | 단위·정밀도, 참조된 품목 이력 보존, version |
| GET/POST /inventory/movements | O/A | 같은 카페 품목, append only, 관련 거래와 동일 batch |
| GET/POST /employees, PATCH /employees/:id | O/A | 계정 연결 시 현재 멤버 확인·중복 차단, version |
| GET/POST /work-logs, PATCH/DELETE /work-logs/:id | O/A | 동일 카페 직원, 직원별 일자 중복 차단, version |
| GET/POST /my/work-logs | O/A/S | 서버에서 연결 직원 결정, 무연결 시 403, 타 직원 ID 입력 거부 |
| GET/PATCH /employees/:id/payroll-settings | O/A | 같은 카페 직원, 유효기간·시급, version |
| GET/PUT /employees/:id/weekly-confirmations/:date | O/A | 직원·주 시작일·확인 enum, version |
| GET/PUT /employees/:id/payroll-extras/:month | O/A | 직원·월·nullable 금액, version |
| GET/PUT /sales-reconciliations/:month | O/A | 대조 전용 값, 월 검증, version |
| GET /payroll, /dashboard | O/A | 카페·기간별 집계, 미확정 계산 상태 포함 |
| GET /changes?since= | O/A/S | 직원에는 허용 변경 여부만, 기록·급여 값 제외 |
| POST /imports, PUT /imports/:id/chunks/:no | O | 빈 카페, 20MiB v2, 항목별 검사, 작업·chunk 중복 방지 |
| POST /imports/:id/validate,/commit,/cancel, GET /imports/:id | O | 작업 범위·상태, 임시 dataset 비공개, 중복 commit 안전 |
| POST /exports, GET /exports/:id[/pages] | O | 매 페이지 권한·만료 확인, 일관된 revision, 상태 전이 검사 |
| GET /audit-logs | O/A | 카페 범위, 페이지 처리, 민감 원문 제외 |

`/auth/*`는 API prefix 밖의 인증 경로다. 위 logout은 `/auth/logout`, 로그인 시작·콜백은 `/auth/google/start`, `/auth/google/callback`을 사용한다. 초대 token 경로는 `/api/v1/invitations/:token`으로 카페 경로 밖이다.

## 입출력·오류·목록

성공: `{data: ..., requestId}`. 목록: `{data: [...], nextCursor: string|null, requestId}`.
날짜 양 끝 포함 `from`/`to`, 기본 limit=50, 최대 100. 날짜+ID 커서와 동일 카페/필터 조건으로 조회하고 잘못된 커서는 400이다.

매출 생성 예: `{businessDate:"2026-10-08",card:12000,cash:0,transfer:null,note:""}`.
수정·삭제: 현재 `version`을 `expectedVersion`으로 전달한다. 금액·ID·버전은 서버 입력 스키마로 검사한다.

오류: `{error:{code,message,details?},requestId}`. 원문 SQL·토큰·전체 백업은 details에 넣지 않는다.

| 상태 | code 예 | 처리 |
| --- | --- | --- |
| 400 | VALIDATION_ERROR | 필드별 오류, 쓰기 없음 |
| 401 | UNAUTHENTICATED | 로그인 안내, 자동 재전송 금지 |
| 403 | FORBIDDEN / CSRF_INVALID | 역할·계정 연결·Origin·CSRF 재검토 |
| 404 | NOT_FOUND | 비참여 카페·다른 범위 기록 존재 비공개 |
| 409 | VERSION_CONFLICT | 허용된 최신 기록만 details.latest로 제공, 입력 보존 |
| 409 | IDEMPOTENCY_MISMATCH / CAFE_WRITE_LOCKED | 같은 키 다른 본문 거부 / 잠금 해제 뒤 재시도 |
| 413 | PAYLOAD_TOO_LARGE | 가져오기 크기 제한 안내 |
| 429 / 503 | RATE_LIMITED / TEMPORARILY_UNAVAILABLE | 실패 안내, 제한된 백오프, 무한 반복 금지 |
| 500 | INTERNAL_ERROR | requestId로 추적, 민감 원문 제외 |

생성·수정·삭제·상태 전이에는 `Idempotency-Key`를 사용한다. scope는 카페(또는 계정)+메서드+자원 경로다. 동일 키·본문은 저장된 결과를 반환하되 현재 권한을 먼저 검증한다. 같은 키·다른 본문은 409. version 불일치/0행 변경은 assertion으로 batch 전체를 실패시키고 감사/재고만 남기지 않는다.

W04는 실제 D1 실패 전파를, W05–W08은 인증·격리·첫 매출 공유를 검증한다. 이 계약 문서만으로 T01–T12를 통과한 것으로 보지 않는다.
