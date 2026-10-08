# W12 자료 이전과 카페 백업

## 제공 범위

소유자는 빈 카페에 기존 v2 장부를 가져오고 현재 카페를 v3 JSON으로 백업할 수 있다. UI는 원본 건수·합계 → 임시 업로드 → 서버 검증 → 사용자의 최종 적용으로 진행한다. 일반 장부 조회는 active dataset만 읽으므로 임시 자료는 보이지 않는다. 테스트 자료 이외의 실제 장부는 아직 이전하지 않았다.

### v2 가져오기

- 원본 파일 및 정규화 자료 합계 20MiB, manifest 4MiB, chunk 128KiB/최대 10행. 첫 chunk는 metadata이며 이후 종류 순서는 고정한다.
- `POST /api/v1/cafes/:cafe/imports`에는 version과 manifest(kind/count/bytes/hash)를 보낸다. 동일한 canonical manifest의 SHA-256이 파일 식별자다. 원본 JSON의 공백·들여쓰기는 중복 식별에 영향을 주지 않는다.
- chunk 해시는 전송 JSON의 직렬화 바이트와 비교한다. `PUT /imports/:job/chunks/:no`는 명시한 건수·길이·해시를 전부 확인하고 SQL batch로 기록한다. 중복 전송과 종류를 넘는 원본 ID 중복을 처리한다.
- `GET /imports`에서 진행 중인 본인 작업을 찾고 동일 파일을 선택해 받은 chunk를 건너뛸 수 있다. 변경 요청의 재시도 키는 응답 성공까지 보존한다.
- validate는 모든 chunk와 급여 시급 행을 확인하고 건수·합계를 저장한다. commit은 검증 당시 revision과 빈 active dataset을 재검사한 뒤 active 포인터를 원자적으로 바꾼다.
- 취소는 해당 staging 업무 행·chunk·원본 ID 매핑을 정리한다. 활성 장부를 삭제하지 않는다. 취소 이후 같은 파일을 새 요청 키로 다시 시작할 수 있다. 이전 시도의 요청 키를 다시 사용하지 않는다.
- legacy 단일 직원은 계정 없는 `기존 장부 직원`으로 옮긴다. 휴게시간/주간 시간의 미입력(null)은 별도 플래그로 보존한다. 기존 계산 모듈은 수정하지 않았다.
- 재고 수량은 소수 두 자리, 단가는 정수 원만 지원한다. 범위를 벗어나면 반올림 대신 거절한다. 안전한 정수 범위를 넘는 합계도 적용하지 않는다.

### v3 내보내기

- `POST /exports`, `GET /exports`, `GET /exports/:job`, `GET /exports/:job/pages?table=...&cursor=...`, `POST /exports/:job/complete|cancel`.
- 카페 업무 쓰기를 잠그고 active dataset/revision과 건수·합계를 고정한다. 페이지당 최대 50행을 읽는다. 소유자, 세션, 작업 만료, dataset/revision을 데이터 조회와 같은 DB batch에서 재확인한다.
- 상태 조회는 유효한 작업의 5분 lease를 연장한다. 완료·취소·만료된 작업은 페이지를 반환하지 않는다. 만료 후 첫 장부 쓰기 또는 export 요청에서 해당 카페의 잠금만 해제한다. 다른 import나 새 export 잠금을 해제하지 않는다.
- 멤버 변경 등으로 revision이 달라지면 진행 중 백업은 거절한다. 읽기는 계속 가능하며 소유권 이전은 잠금 중 차단한다.
- 출력은 `{version:3,format:"cafe-admin-cloud",exportedAt,cafe,metadata,summary,tables}`. 다중 직원, 유효기간별 급여, 재고 이동 및 삭제된 업무 행을 보존한다. summary는 활성 행 기준이며 재고 이동·시급은 전체 행 수다.
- 로그인/세션/초대/명령/감사 이력, actor ID, 직원 계정 연결은 파일에 넣지 않는다. 계정 연결은 복구 이후 재확인한다. v3은 기존 PC 장부의 v2 가져오기와 호환되지 않는다. v3 복구 도구와 별도 복구 환경 연습은 W14에서 제공한다.
- 브라우저의 20MiB 크기 검사를 통과하고 서버가 최종 일관성을 확인한 뒤 다운로드 링크를 만든다. 링크 생성과 사용자의 실제 파일 보관은 구분한다.

## 스키마와 검증

Migration 0004는 null 보존 열 2개, import manifest/export snapshot 열, 원본 ID 매핑 테이블, 기간/참조 인덱스를 추가한다. 기존 열이나 업무 행을 삭제하지 않는다. 이전 코드로 롤백하면 가져온 null 값의 의미를 해석하지 못하므로 W12 이전 코드로의 복귀는 데이터/계산 확인이 필요하다.

로컬 검증: `pnpm check:backend` 67개(기존 계산 20, 서버 단위 4, D1 41, Worker 통합 2), build 및 Worker dry-run 통과. `PLAYWRIGHT_CHANNEL=chrome pnpm test:cloud`도 통과했다. 브라우저 시나리오는 공유/권한/모바일 검증과 함께 빈 카페 생성 → v2 업로드 → 원본·서버 합계 일치 → 적용 → v3 다운로드 → 파일의 건수·합계 확인을 수행한다.

추가 D1 검증에는 staging 비노출, hash 오류 rollback, 취소·재시작, 원본 ID 중복, 크기 초과, null 계산 보존, 다중 페이지 cursor 범위, 권한 회수, revision 변경, 만료 후 쓰기 재개가 포함된다. 이 결과는 실제 다중 Google 계정 또는 대규모 원격 부하 검증을 대신하지 않는다.
