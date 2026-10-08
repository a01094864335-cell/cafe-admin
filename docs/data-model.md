# 데이터 모델과 이전 규칙 (W02)

2026-10-08 구현 기준. PRD와 ARCHITECTURE를 구체화한 계약이며 아직 DB migration 실행 결과가 아니다.

## 권한·기록 수명

- 역할은 카페별 owner/admin/staff. 카페 생성은 서버 허용 목록에 있는 사용자만 가능하다. 목록 미설정 시 생성 거부가 기본이다.
- 카페당 활성 owner는 정확히 1명. 소유권 이전 후 이전 owner는 admin이 된다. 마지막 owner 탈퇴/해제는 금지한다.
- 관리자는 직원 초대·해제만 가능하며 관리자·owner의 권한을 바꾸지 못한다.
- 사용자 계정과 직원은 별도다. `(cafe_id, dataset_id, linked_user_id)`는 null을 제외하고 unique. 연결 시 같은 카페의 활성 멤버인지 검증한다.
- 참여 해제는 멤버십 비활성화이며 근무·거래·급여 기록을 지우지 않는다. 재참여 시 직원 연결을 다시 검증한다.
- 기록 삭제는 논리 삭제, 계산에서 제외, 감사 이력 유지. 재고는 반대 이동으로 보정한다. 거래·이력·revision 갱신은 같은 batch다.
- 파일럿 동안 명령·감사 기록은 자동 삭제하지 않는다. 개인정보 삭제 요청 절차와 보존 기간은 W13 운영 절차에서 정하고 출시 전에 확인한다.

## 범위와 제약

| 영역 | 필수 제약 |
| --- | --- |
| auth_identities | UNIQUE(provider, subject), 이메일로 계정 자동 병합 금지 |
| memberships | UNIQUE(cafe_id, user_id), role enum, 활성 owner 부분 unique |
| cafes | timezone은 검증된 IANA 이름, active_dataset_id는 같은 카페 소속 |
| datasets | UNIQUE(cafe_id, id), staging/active/retired 상태 |
| 거래·재고·직원·근무 | 복합키(cafe_id, dataset_id, id), version≥1, 생성/수정자와 UTC 시간 |
| 참조 | 직원·품목·dataset의 복합 외래키에 cafe_id 포함 |
| sales | 활성 기록의 (cafe_id, dataset_id, business_date) unique, 채널별 nullable 정수 |
| work_logs | 활성 기록의 (cafe_id, dataset_id, employee_id, business_date) unique |
| payroll_settings | 직원별 적용 시작일과 연도 시급, 겹치는 유효 기간 차단 |
| commands | UNIQUE(user_id, scope, key), 정규화 본문 해시, 재전송 최소 결과 |
| invitations | 토큰 해시 unique, 검증된 대상 이메일, 7일 만료, 일회용 |
| import_jobs | 카페별 실행 작업 1개, 파일 해시·chunk 번호 중복 방지 |

unique만으로 owner 0명을 막을 수 없다. 카페 생성·소유권 이전은 마지막 assertion에서 owner 수=1을 확인하고 실패 시 전체 롤백한다. W04에서 실제 D1의 0행 갱신, assertion 실패, batch 롤백을 검증한 후 채택한다.

## 원본 데이터 매핑

| v2 | 서버 대상 | 이전 기준 |
| --- | --- | --- |
| sales | sales | 카드·현금·이체 nullable 보존, 빈칸과 0 구분 |
| purchases(group=월별 구매) | purchases | 환불 음수와 구매처·내용 보존 |
| purchases(group=재료 외 지출) | expenses | 손익 중복 계산 금지 |
| incomes | other_incomes | 별도 수익 항목 보존. PRD/아키텍처 개요표에 빠진 기존 기능 |
| comparisons | sales_reconciliations | 월별 대조 전용, 손익 제외 |
| payroll | work_logs | 소유자가 선택한 직원 1명에 연결, 날짜·시각·휴게 보존 |
| employment | employees + payroll_settings | 계정 없는 직원 허용, 원본 시급·기간·기준 보존 |
| weeks | weekly_confirmations | employee_id와 주 시작일에 연결 |
| monthlyExtras | payroll_extras | 직원·월 연결, 월말에 합산 |
| inventory | inventory_items + opening movements | 최초 수량을 기초 재고로 기록; 과거 구매와 임의 연결하지 않음 |
| checks/lastBackup/source metadata | 카페 UI 설정·이전 메타데이터 | 권한·계정 식별 정보로 취급하지 않음 |

추가 테이블도 동일한 cafe/dataset/직원 참조와 이력 규칙을 따른다. 매출 대조·기타수익·기타수당을 버리는 스키마로 이전하지 않는다.

## 날짜·금액·수량

영업일은 카페 시간대의 날짜 문자열, 생성/수정 시각은 UTC다. 기본 카페 시간대는 Asia/Seoul이며 카페 생성 시 저장한다. 기간 필터는 영업일 양 끝 포함. 주휴는 주휴일, 월 수당은 월 마지막 날 기준이다. 저장된 영업일을 클라이언트 시간대로 이동시키지 않는다.

금액은 원 단위 안전한 정수, 기존 채널 미입력은 null. 기존 백업 범위 ±10^12원과 환불 음수를 보존한다. UI의 재고 수량 입력은 소수 2자리지만 백업 검사는 더 긴 소수를 허용한다. 신규 수량은 1/100 단위 정수, 기존 초과 정밀도는 미리보기 오류로 표시하고 사용자 보정 없이 반올림하지 않는다.

## 단계 종료와 남은 운영 설정

W02의 코드 구현 기준은 위 기본안으로 고정한다. 파일럿 생성 허용 계정, 실제 테스트 계정, 배포 주소는 아직 없다. 운영자 제공이 필요한 이 값은 저장소에 가짜 값으로 채우지 않는다. 법적 보존기간·복구 목표·내보내기 잠금 정책은 출시 전 운영 검증 대상이며 구현 완료로 표시하지 않는다.
