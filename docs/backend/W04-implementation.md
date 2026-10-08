# W04 Workers·D1 기반 구현 및 통합 안내

2026-10-08. 기준 커밋 `cd40a8130d14896aef8fa61cd35c9992b07b723e`의 W01–W03 후속 작업이다. 공통 WORK_PLAN 및 기존 설계 문서는 수정하지 않았다.

## 구현 범위

- `0001_identity_and_cafes.sql`: 계정·세션/OAuth 저장 영역, 카페·dataset·멤버십·초대, 명령 중복 방지, 감사, assertion.
- `0002_ledger.sql`: 매출·구매·비용·기타수익, 재고·이동, 직원·근무, 급여 설정·연도별 시급, 주휴 확인·월수당·매출 대조.
- `0003_import_export.sql`: 가져오기 작업·chunk·내보내기 잠금 저장 영역, 활성 매출 view.
- 모든 장부 참조는 cafe/dataset 복합키를 사용한다. 재고 이동의 품목·구매 참조도 같은 범위다. 직원 계정 연결은 해당 카페 멤버십을 참조하며 dataset 내 중복 연결을 차단한다. 활성 여부는 W06/W10 서비스에서 추가 검증해야 한다.
- `atomicCafeBatch`는 마지막에 활성 owner 정확히 1명과 같은 카페의 active dataset 포인터를 검사한다. `assertChanged`는 조건부 쓰기 바로 다음에 `changes()=1`을 검사한다. 실패는 CHECK 오류가 되어 D1 batch 전체가 롤백된다.
- `/api`, `/api/*`, `/auth`, `/auth/*`는 Worker가 처리하고 현재는 공통 형식의 no-store JSON 404를 반환한다. 나머지는 Static Assets다. HTTP로 DB를 읽거나 쓰는 데모 경로는 없다.

## DB 보장과 서비스가 담당할 경계

부분 unique 인덱스는 활성 owner 최대 1명만 보장한다. **0명 금지는 raw SQL 전체에 적용되는 DB 제약이 아니라 `atomicCafeBatch`의 최종 assertion이다.** 카페 생성·소유권 이전·멤버 변경은 반드시 이 공통 경로를 사용해야 한다. 생성 시 pointer NULL은 같은 batch의 중간 상태에서만 허용한다. raw SQL로 이 함수를 우회하면 owner 0명 또는 미완료 포인터를 만들 수 있다. 이 제한을 W06/W07 리뷰 항목으로 유지한다.

`assertChanged`와 해당 UPDATE 사이에 다른 쓰기를 넣지 않는다. assertion ID는 요청마다 고유하게 생성하고 `atomicCafeBatch`의 정리 목록에도 전달한다. 조건부 쓰기는 현재 멤버십·역할·활성 dataset·잠금·version을 SQL 안에서 재검증해야 한다. 공통 helper 자체가 인증/인가를 제공하지는 않는다.

`commands`는 `(user_id, scope, key)` unique로 중복 적용을 막는다. 정규화 payload hash 생성, 같은 키 다른 본문의 409, 현재 권한을 재검증한 응답 재생은 W08/W11 서비스 작업으로 남는다. 이번 테스트의 동시 명령 경쟁에서는 한 batch만 적용되는 DB 기반을 검증했다.

`active_sales` view는 공개 포인터와 state를 함께 검사하지만 cafe별 접근 권한은 제공하지 않는다. Repository는 항상 검증된 cafe ID로 조회해야 한다. 다른 장부도 이 공개 조건을 사용해야 한다. SQL 상태 전환 테스트는 원자적 공개의 기반 증명이며, W12 빈 카페·소유자·파일/건수/합계 검증, chunk 완료 여부, 실패 재시도·취소 흐름 전체의 구현은 아니다.

날짜/시간 문법, IANA timezone, JSON 본문 크기, 초대 7일 만료와 소비 조건, 세션 만료, 계정 연결의 현재 활성 멤버십, 수량 정밀도 등은 후속 서버 입력 검증과 조건부 SQL의 책임이다. enum/금액 정수·범위/version/unique/복합 참조/급여 기간 겹침은 DB에서도 검사한다. 인증정보 원문은 테스트 자료에 없다.

## 기존 자료 이전 누락 방지

| 기존 v2 항목 | 저장 영역 | 보존 및 검증 |
| --- | --- | --- |
| sales | sales | null·0·환불 구분, 가상 합계 110,000원 |
| purchases 월별 구매/재료 외 지출 | purchases/expenses | 각각 28,000원/5,000원, 중복 손익 반영 금지 |
| incomes | other_incomes | 3,000원 보존 |
| comparisons | sales_reconciliations | reported 999,999원 및 note 보존, 손익 제외 |
| payroll | work_logs | 소유자가 지정할 직원에 연결, 출퇴근·휴게·메모 |
| employment | employees/payroll_settings/payroll_rates | 입퇴사·계산 기간·약정시간·주휴일·기준·연도별 시급 |
| weeks | weekly_confirmations | agreed null 및 네 가지 원본 confirmation 상태·메모 |
| monthlyExtras | payroll_extras | 직원·월·nullable 금액, 가상 1,000원 |
| inventory | inventory_items/inventory_movements | 2.5kg를 250 단위로 저장, opening 이동; 과거 구매에 임의 연결하지 않음 |
| checks/lastBackup/source metadata | datasets.metadata_json | 원본 메타데이터 보존용이며 신원·권한 근거로 사용 금지 |

`tests/server/schema.d1.mjs`의 변환은 가상 W01 fixture만 대상으로 하는 검증 코드다. 운영 importer로 사용하면 안 된다. 실제 가져오기는 W12에서 전체 필드·정밀도·크기·복구 검증을 구현한다. 원본 기준 주휴 40,000원·급여 91,167원·간이 잔액 -11,167원은 기존 계산 회귀 테스트가 별도로 확인한다.

## 검증 결과

로컬 macOS arm64, Node 24.19.0, pnpm 11.19.0, Wrangler 4.148.0, Miniflare 5.20261006.0-alpha/workerd 1.20261006.1. Wrangler가 사용하는 Miniflare 버전과 lockfile을 고정했다. SQLite mock이 아니라 로컬 D1 binding의 `batch()`를 실행했다. 원격 Cloudflare D1의 검증 결과는 아니다.

| 검증 | 결과 |
| --- | --- |
| 기존 단위/계산 회귀 | 20개 통과 |
| 서버 라우팅/배포 설정 단위 | 3개 통과 |
| 로컬 D1 | 12개 통과: 중간 실패·0행 전체 롤백, 중복 명령 경쟁, owner 생성/이전/실패, dataset 공개, 범위·금액·기간·이전 항목·SQL 권한/잠금 재검증 |
| 실제 Workers Static Assets 및 환경 설정 | 2개 통과: HTML/JS/SPA, API/auth JSON 404, test/production DB 비상속 |
| 타입·Vite build 및 Worker dry-run | 통과, 원격 업로드 없음 |
| Wrangler 빈 로컬 DB migration | 0001 → 0002 → 0003 적용 통과, 재적용 시 No migrations to apply |

조건부 UPDATE 0행은 성공 응답과 `meta.changes=0`을 반환했고, 바로 다음 CHECK assertion으로 실패시킨 경우 앞선 command·재고·audit·revision까지 남지 않았다. 초기 deferred 외래키 실험은 로컬 런타임에서 불명확한 internal error를 반환했다. 불필요한 deferred 설정을 제거하고, NULL pointer → dataset 생성 → pointer 지정의 순서와 즉시 외래키 검사로 최종 테스트를 통과했다.

## 통합 대기

W04의 **외부 테스트 주소에서 샘플 읽기/쓰기** 완료 기준은 대기다. Cloudflare 계정·별도 원격 DB·도메인·OAuth 앱·실계정이 제공되지 않았다. 원격 배포, 운영 migration, 실제 Google OAuth, UI 연결, 유료 전환을 실행하지 않았다. 기존 화면은 여전히 브라우저 로컬 저장 앱이다. 이 PR만으로 공유 장부 사용이 가능하다고 표시하지 않는다.

W05–W08에서 인증·세션·CSRF·카페 권한을 연결한 후 테스트 환경의 첫 공유 매출 흐름을 검증한다. W12에서 모든 장부의 dataset 공개 조건과 import/export 수명 주기를 연결한다. WORK_PLAN의 W04 전체 완료 표시는 그 외부 검증 후 통합 담당자가 갱신해야 한다.

공식 참고: [D1 batch 원자성](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 외래키](https://developers.cloudflare.com/d1/sql-api/foreign-keys/), [Workers 정적 자산 라우팅](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/). 2026-10-08 확인.
