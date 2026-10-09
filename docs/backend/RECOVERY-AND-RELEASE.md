# 복구와 배포 절차 (W14–W16)

## 검증된 범위

`scripts/recovery.py`는 **네트워크 연결 없이 별도 SQLite 출력 파일**에 복구를 연습하는 운영자 도구다. 원본 파일은 read-only로 열고, 이미 있는 출력 파일을 덮어쓰지 않는다. 출력 권한은 0600이다. 운영 API나 원격 D1에 자동 적용하는 기능이 아니다.

`python3 tests/recovery_test.py`는 가상 DB 전체 복사, 카페 A v3 복구, B와 멤버십 보존, FK/합계/날짜/소유자/revision 오류 거부를 검증한다. 복구 실패 시 새 출력 파일은 제거하고 원본은 유지한다. 기본 서버 검사에도 이 테스트를 포함했다.

2026-10-09 사용자 승인 후 별도 D1의 전체 Time Travel 및 개별 카페 SQL 복구도 완료했다. [원격 복구 시험 결과](TEST-REPORT-REMOTE-RECOVERY.md)에 DB ID·bookmark·합계·오류 주입 결과를 기록했다. 현재 서비스 DB를 복구한 것은 아니다.

```sh
# 이미 승인받아 격리 환경에 준비한 SQLite 원본만 지정한다.
python3 scripts/recovery.py --source /private/recovery/source.sqlite --output /private/recovery/full-copy.sqlite
python3 scripts/recovery.py --source /private/recovery/source.sqlite --output /private/recovery/cafe-copy.sqlite --backup /private/recovery/cafe-v3.json --cafe CAFE_ID --owner CURRENT_OWNER_ID --revision CURRENT_REVISION
```

카페 복구는 현재 소유자 1명, revision, 열린 쓰기 상태를 확인한다. v3에 명시된 13개 업무 테이블만 받아 staging에 넣고 관계/합계를 검증한 뒤 포인터를 전환한다. 현재 데이터셋은 retired로 보존한다. 원본 명령·세션·계정 연결은 백업에 없으며 멤버십은 대상 DB의 현재 상태를 유지한다. 직원 계정 연결은 재승인 전까지 비워 둔다. 동일 ID의 버전은 이전 모든 버전보다 높여 오래된 입력이 복구 자료를 덮는 일을 막는다.

## 배포 전후

1. 검증할 commit SHA, 배포 대상, DB ID, 스키마 번호를 기록한다. 테스트와 운영 DB ID가 다름을 확인한다. OAuth/세션 비밀은 저장소·화면 캡처·로그·백업 문서에 넣지 않는다.
2. 소유자가 JSON 백업을 다운로드하고 합계를 확인한다. DB 전체 복구가 필요한 변경은 D1 현재 Time Travel bookmark를 확보한다. 전체 SQL export에는 사용자 이메일/인증 식별자/세션 해시가 포함될 수 있으므로 보관 장소와 용도 확인 후 제한된 경로로 내보낸다.
3. `pnpm check:backend`, `pnpm test:cloud`와 CI가 통과한 SHA를 사용한다. 빈 DB migration 및 재적용도 확인한다. 필요한 migration만 명시적으로 적용한 후 Worker를 배포한다. 자동 schema down-migration은 없다.
4. 실제 Google 로그인, A/B 전환, 한 건 저장/이력, 이전 합계, 백업 다운로드, 오류 로그 검색, 사용량/CPU를 확인한다. 사용자 본인만 원격 시험하도록 정해져 있으므로 다른 실제 계정을 임의로 만들거나 초대하지 않는다.
5. 실패 시 새 입력을 멈추고 요청 번호·버전·시각을 확보한다. 앱 코드 문제는 이전 검증 Worker 버전으로 돌린다. DB 문제는 별도의 DB 복구 절차를 사용한다.

migration 0005는 audit_logs nullable request_id 및 별도 요청 카운터/만료 인덱스만 추가한다. 이전 W12 코드로 되돌려도 0005를 제거할 필요가 없다. 0005 이전으로 DB를 복구한 경우 새 코드는 사용하지 말고 구버전 코드 또는 migration 재적용 계획을 함께 확인한다.

## 원격 복구 연습 — 별도 시험 DB 검증 완료

로컬 복구 테스트 통과가 원격 D1 Time Travel 통과를 의미하지 않는다. D1 Time Travel은 **DB 전체를 해당 시점으로 덮어쓰고 진행 중 요청을 취소**한다. 카페 하나만 되돌리려고 공유 DB 전체를 복구하지 않는다. 무료 보존 기간은 7일이다. [공식 복구 절차](https://developers.cloudflare.com/d1/reference/time-travel/).

별도 `cafe-admin-recovery-test` D1 생성과 가상 자료의 전체/개별 복구 시험을 승인받아 완료했다. 시험용 DB의 소유자·멤버십·합계 기준을 저장하고, bookmark → 가상 변경 → restore → 전체 값 비교 및 A만 복구/B 보존까지 확인했다. 현재 서비스 DB를 대상으로 할 경우 A/B 모두 영향받는 점과 허용 중단 시간을 별도 확인한다.

개별 카페 SQL 계획은 `scripts/recovery_sql.py`로 생성한다. 네트워크 연결 없이 격리 SQLite 원본과 v3 백업을 검증하고 새 0600 SQL 파일만 만든다. 현재 소유자·카페 상태·멤버십·행 버전이 달라지면 적용을 거부한다. 원격 반영은 운영자가 대상 DB를 명시해 **파일 전체를 한 번에** 실행한다. D1 file import는 실행 동안 DB 쿼리를 막고 실패 시 원래 상태로 돌아간다. 작은 가상 DB에서 이를 검증했으며 큰 자료는 별도 시험이 필요하다.

```sh
python3 scripts/recovery_sql.py --source /private/recovery/current.sqlite --backup /private/recovery/cafe-v3.json --cafe CAFE_ID --owner CURRENT_OWNER_ID --revision CURRENT_REVISION --output /private/recovery/reviewed-cafe.sql
# DB 이름/UUID와 승인된 중단 시간을 확인하고, 생성된 계획과 합계를 검토한 뒤에만 실행한다.
pnpm exec wrangler d1 execute RECOVERY_DB --remote --config /private/recovery/wrangler.json --file /private/recovery/reviewed-cafe.sql
```

출력 SQL에 BEGIN/COMMIT을 덧붙이거나 여러 CLI 명령으로 쪼개지 않는다. 중간 실패/모호한 통신 결과는 원격 export와 operation ID/감사 이력으로 결과부터 확인한다. 성공한 계획 재실행은 카페 상태 검사에서 거부되므로 중복 반영하지 않는다. 현재 offline 전체 복구본을 공유 원격 DB에 덮어쓰지 않는다.

## 파일럿/출시 확인표

- [x] 로컬 T01–T10, 모바일/데스크톱, 전체/개별 복구 연습 및 10명 동시 사용 시험
- [x] 테스트 배포 W13 코드/스키마, 실제 이력 화면, tail 오류 추적과 정리 트리거 등록 확인
- [ ] 저장 로그 대시보드 검색 및 정리 예약 실행 결과 확인
- [x] 원격 가상 v2 업로드·적용·합계 비교 및 v3 다운로드, 다른 카페 보존
- [x] 원격 격리 D1 전체/개별 복구 및 중간 실패/재실행 검증
- [ ] 원격 CPU/동시 사용 응답 시간 측정
- [ ] 실제 파일럿 카페 1~2개, 업무 시작일, 본인 계정의 역할 확인
- [ ] 개인정보를 제거한 실제 장부 또는 가상 자료를 계속 쓸지 결정
- [ ] 소유자의 일일 JSON 백업 보관 위치·보존 기간과 장애 연락 채널 결정
- [ ] 실자료 전환 직전 백업·합계 확인 및 입력 위치 전환 공지
- [ ] 운영 전용 DB·OAuth·주소·공개 범위·배포 승인
- [ ] 파일럿 마감 오류/사용량/장부 불일치 검토 후 출시 여부 결정

W16은 실제 업무 참여와 자료 확인 없이는 완료 처리하지 않는다. 현재 테스트 주소 승인만으로 운영 공개나 실자료 이전을 실행하지 않는다.
