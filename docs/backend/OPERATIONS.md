# 운영 점검과 오류 대응 (W13)

2026-10-09 기준. 테스트 운영자/계정 소유자는 사용자 본인, 코드·쿼리 분석 담당은 개발 작업 담당자다. 실제 파일럿의 연락 채널과 백업 보관 위치는 사용자가 정해야 한다.

## 이력과 요청 추적

- `GET /api/v1/cafes/:id/audit`: 현재 소유자·관리자만 조회. 최신 시간/ID 순서, 기본 50·최대 100, 카페별 cursor. 작업자 표시 이름, 내부 대상 번호, 동작, 성공 여부, 시간, 요청 번호를 반환한다. 명령 payload/result, 초대·세션 토큰, 이메일, 원본 메모는 반환하지 않는다.
- 저장·수정·삭제·멤버십·가져오기·백업의 성공 이력은 업무 변경과 같은 트랜잭션이다. 실패한 저장은 성공 이력을 만들지 않는다. 0005 이전 이력에는 요청 번호가 없다.
- 서버가 만든 UUID를 모든 API/auth 응답 `X-Request-ID`와 JSON에 싣고, 새 성공 이력에도 연결한다. 사용자가 보낸 요청 번호는 무시한다.
- 앱 오류 로그 필드는 event/requestId/method/route/status/code/durationMs만 허용한다. URL, query, 헤더, body, 쿠키, SQL 예외 원문/stack을 로그에 넣지 않는다. 오래된 초대 토큰이 경로에 포함될 수 있으므로 원격 tail 원문을 복사·공유하지 않는다.
- 배포 설정은 `observability.logs.invocation_logs=false`, `redact_query_string=true`, traces 비활성화다. 자동 URL 로그와 OAuth query를 방지하며 사용자 정의 로그만 사용한다. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [설정 API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/).
- Cloudflare → Workers & Pages → cafe-admin-test → Observability에서 요청 번호를 검색한다. 오류 종류·동작·시각·배포 버전과 함께 확인한다. 로그가 없으면 요청이 Worker 도달 전 차단되었거나 로그 수집 한도를 넘었는지도 확인한다.

## 실패와 요청 제한

인증·CSRF 검증 후 같은 사용자의 모든 변경 요청을 분당 120회로 제한한다. 카페·세션을 바꿔도 같은 카운터를 사용한다. 121회째부터 429, D1 용량/과부하 관련 예외는 503과 Retry-After 60초를 보낸다. 경계 분에서는 두 구간의 요청이 몰릴 수 있는 fixed window이며 DDoS 차단이나 전체 계정 예산 보장 기능은 아니다. 인증 전 로그인 요청과 읽기는 Cloudflare 플랫폼 보호·사용량 점검 대상이다.

브라우저는 429/502/503/504에서 최소 5초~최대 1시간(헤더가 없으면 60초) 대기한다. HTML 한도 오류도 저장 성공으로 처리하지 않는다. 자동 쓰기 재시도는 없고 수동 재시도 시 같은 입력의 Idempotency-Key를 재사용한다. 재고 저장 실패 메시지를 조회 성공 메시지가 덮지 않으며 삭제 응답을 잃어도 동일 키로 재확인한다.

## 사용량과 대응

무료 한도는 계정/DB 단위로 공유한다. UTC 00:00(한국 09:00)에 일별 할당량이 초기화된다. 인덱스 갱신도 D1 쓰기 사용량에 포함된다. 아래는 2026-10-09 확인 기준이며 확대 전 다시 확인한다. [D1 가격](https://developers.cloudflare.com/d1/platform/pricing/), [D1 한도](https://developers.cloudflare.com/d1/platform/limits/), [Workers 한도](https://developers.cloudflare.com/workers/platform/limits/).

| 항목 | 무료 기준 | 70% | 85% |
| --- | ---: | ---: | ---: |
| Workers 요청/일 | 100,000 | 70,000 | 85,000 |
| D1 읽은 행/일 | 5,000,000 | 3,500,000 | 4,250,000 |
| D1 쓴 행/일 | 100,000 | 70,000 | 85,000 |
| D1 계정 저장 | 5GB | 3.5GB | 4.25GB |
| D1 DB별 저장 | 500MB | 350MB | 425MB |

1. 운영자는 파일럿 시작/마감 때 Workers Metrics의 요청, 오류, CPU와 D1 Metrics의 읽기·쓰기·저장량을 기록한다. CPU는 무료 요청당 10ms, D1은 호출당 SQL 50개 제한도 별도 확인한다. 로컬 응답 시간은 원격 CPU 측정을 대신하지 않는다.
2. 70% 도달 시 당일 증가율, 무한 조회/재시도, 가져오기 양을 확인하고 개발 담당자가 쿼리·인덱스·화면 갱신을 최적화한다.
3. 85% 도달 시 운영자는 카페·사용자 확대와 대량 가져오기를 중단하고 기존 사용자의 입력 보존·백업을 우선한다. 다음 UTC 초기화까지 기다릴지, 유료 전환을 검토할지 사용자 결정이 필요하다. 자동 결제·자동 요금제 변경은 하지 않는다.
4. 저장 오류가 발생하면 입력과 요청 번호를 보관하고 연속 클릭을 멈춘다. 저장 응답을 못 받은 경우 같은 입력으로 재확인한 뒤 목록·이력을 확인한다. 수동으로 새 거래를 만들기 전에 중복 여부를 먼저 확인한다.

D1 카운터도 허용된 변경마다 쓰기 1회가 필요하다. CI의 D1 meter는 batch 내부 SQL도 각각 계산하며 가져오기·검증·취소·적용·백업 최대 43개를 확인했다. `first()`의 소비 행은 현재 로컬 meter 합계에서 제외되므로 meter 행 수는 청구량 추정치로 쓰지 않는다.

## 임시 정보 수명

매시 17분 UTC scheduled handler가 만료 OAuth transaction과 만료 session을 각각 오래된 순서로 최대 500개 정리한다. 로그인 중인 세션, 사용자, 멤버십, 거래, 명령 재시도·감사 이력은 지우지 않는다. 초과 적체는 다음 실행에서 처리한다. 실패는 `cleanup_failed`로 확인한다.

백업 잠금은 기존 5분 만료 후 다음 관련 요청에서 해제한다. 가져오기 중단은 소유자가 화면에서 취소하면 staging 업무 행·청크·원본 ID 매핑을 정리한다. 아직 진행 중인 가져오기를 시간만으로 삭제하지 않는다. 장기 업무/이력 보존 정책은 운영 데이터 확보 후 별도 결정한다.
