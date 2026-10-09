# 원격 복구 시험 — 2026-10-09

사용자가 별도 `cafe-admin-recovery-test` DB 생성과 가상 자료의 전체/개별 복구 시험을 승인했다. Cloudflare 계정 `fd599fd3feefc4b220c2ce49809d3477`에 D1 `94d36f71-b515-40b3-8a7e-240d395a7383`을 APAC로 생성하고 migration 0001–0005를 적용했다. 서비스 DB `cafe-admin-test`에는 복구 명령을 보내지 않았다. Worker 연결이나 공개 주소는 만들지 않았다.

## 자료와 비교 방법

- Node 24.19, Wrangler 4.148.0, Python 3.9.6. `tests/server/fixtures/synthetic.sql`과 `recovery.sql`의 가상 자료만 사용했다. 가상 사용자 이메일은 `example.invalid`이며 OAuth 계정/세션을 만들지 않았다.
- 초기 DB: 30개 사용자 테이블(마이그레이션 이력 포함), 35개 행, 약 0.42MB. A에는 13개 업무 테이블이 각각 한 행씩 있다. B에는 별도 매출·직원·멤버십이 있다.
- 원격 SQL export를 새 SQLite 파일에 읽고 `integrity_check`/`foreign_key_check`를 통과시켰다. 테이블별 모든 행을 정렬한 JSON으로 비교했다. 값 비교 대상에서 SQLite 내부 테이블은 제외했다.
- 작업 폴더: `/var/folders/9q/83h7cd353175sl12y12rlfh00000gn/T/cafe-recovery-remote.157pqo8s`. 임시 내보내기 서명 URL은 문서나 Git에 보관하지 않는다. 원본 가상 SQL/JSON과 비교 파일도 Git에 넣지 않는다.

## 전체 DB 복구

1. 기준본 `baseline.sql`과 bookmark `00000001-00000007-000050ff-63631849abe7d5578fb129bc29684c29`를 확보했다.
2. A 카드 금액을 999,999원, B 카드 금액을 333,333원으로 바꾸고 A 관리자 역할을 직원으로 변경했다. 원격 추출본으로 변경을 확인했다.
3. **시험 DB만** 위 bookmark로 Time Travel 복구했다. 복구 명령의 왕복 시간은 3.069초였다. 이는 서비스 RTO 보장이 아니다.
4. `after-full.sql`의 30개 테이블·35개 행이 기준본과 모두 같았다. 정규화 JSON SHA-256은 두 파일 모두 `839b30b07d34f3429c71ae8ed4835aaac7e7a11b695890cfe00791595981da34`다.

복구 API가 반환한 되돌리기 bookmark: `00000001-ffffffff-000050ff-6d4db88fe129df4b9a1e4c006f39aae4`. 이 되돌리기는 실행하지 않았다. bookmark는 보존 기간이 지나면 사용할 수 없다.

## 카페 A만 복구

전체 복구 기준본에서 A의 v3 업무 백업을 추출했다. 이후 A 카드 금액 999,999원/기록 버전 9, B 카드 금액 22,222원, A 관리자의 현재 역할을 직원으로 변경했다. 이 시점의 원격 export가 개별 복구 입력 원본이다.

`scripts/recovery_sql.py`가 원본의 별도 메모리 복사본에서 소유자·revision·관계·합계를 검증한 후 단일 SQL 파일을 생성했다. SQL 파일은 현재 카페 상태/멤버십/자료 버전 비교, 쓰기 제한, staging 적재, 합계/FK 검증, 이전 dataset 보존, 활성 포인터 교체, 감사 이력을 같은 D1 file-import 작업으로 적용한다. 로그인 연결은 복구하지 않는다.

| 검증 | 결과 |
| --- | --- |
| 정상 복구 | 60개 SQL, DB 실행 9.9879ms, 읽기 133행·쓰기 174행. CLI 왕복 3.294초 |
| A 합계 | 매출 120,000원, 매입 28,000원, 비용 5,000원, 기타 수입 3,000원, 재고 250/100, 기타 수당 1,000원, 대조 금액 120,000원. 13종 건수/합계 일치 |
| 버전/이력 | A 매출 버전 10, 이전 dataset retired 보존, 복구 감사 이력 1건, 임시 검증 행 0건 |
| 다른 카페 | B 매출 22,222원과 B의 모든 업무 행·카페·dataset·멤버십 동일 |
| 권한/인증 | 전체 현재 멤버십 동일. users·auth identities·sessions·OAuth transactions·invitations 동일. 직원 계정 연결은 새 dataset에서 비워 둠 |
| 중간 오류 | staging 적재 후 고의 CHECK 오류를 주입한 파일이 실패. Cloudflare는 `D1_RESET_DO`를 반환했으며 30개 테이블·35개 행이 실행 전과 동일함을 재추출로 확인 |
| 재실행 | 이미 끝난 계획을 다시 실행해 revision 검사에서 CHECK 실패. 완료 후 30개 테이블·52개 행이 전부 동일 |

재실행 시 D1 업로드 캐시와 구분하기 위해 SQL에 주석만 추가했다. 성공 후/재실행 후 정규화 JSON SHA-256은 `b814a5171e0c662e9d57d8212433d1b64fc6416931e37dd271ddf87b13865e5c`로 같다. 중간 오류 전후는 `2503ae2b0ae8344920c6c8d90ebf5e3118327dad5c46af6d1e8561697f7a61fe`로 같다.

## 범위와 다음 단계

이 결과는 작은 가상 DB의 복구 검증이다. DB 실행 시간은 Workers CPU나 앱 응답 시간으로 취급하지 않는다. 원격 10명 동시 요청/CPU 측정과 실제 파일럿은 별도다. 시험 DB는 복구 후 상태로 보존하며 서비스 Worker에 연결하지 않았다.

로컬 Python 복구 검증은 8개 시나리오로 확대했다. 원본/다른 카페/현재 권한 보존, 버전 변경 거부, staging 후 실패 롤백, 재실행, SQL처럼 보이는 Unicode/NUL 업무 메모 보존, 카페 카운터 초과 거부, 기존 출력 덮어쓰기 거부를 확인했다.

운영 적용 전에는 해당 DB와 자료, 전체 SQL export 보관 위치, 잠시 쿼리가 차단되는 작업 시간을 별도로 확인한다. 생성 SQL을 한 문장씩 나눠 실행하면 검증된 원자성을 잃는다. [Cloudflare SQL 가져오기·내보내기](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [Time Travel 절차](https://developers.cloudflare.com/d1/reference/time-travel/)를 따른다.
