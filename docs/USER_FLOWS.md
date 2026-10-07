# Cafe Admin 사용자 플로우차트

- 버전: 0.1
- 작성일: 2026-10-07
- 상태: MVP 사용자 흐름 설계안
- 기준: [PRD](https://github.com/a01094864335-cell/cafe-admin/blob/main/docs/PRD.md), [작업 계획서](https://github.com/a01094864335-cell/cafe-admin/blob/main/docs/WORK_PLAN.md)
- 화면 ID: [IA](https://github.com/a01094864335-cell/cafe-admin/blob/main/docs/IA.md)의 G01–G06, C01–C13 사용

Mermaid 코드 블록으로 작성한 흐름이다. 각 그림 아래에 화면, 조건, 예외를 명시한다. 신규 화면과 분기는 설계 제안이며 실제 구현 여부는 작업 계획서에서 추적한다.

## F01 로그인과 최초 진입

```mermaid
flowchart TD
    visit["서비스 또는 직접 URL 진입"] --> session{"유효한 세션인가"}
    session -->|"아니요"| login["G01 Google 로그인"]
    login --> auth{"로그인 성공인가"}
    auth -->|"아니요"| retry["실패 안내와 재시도"]
    retry --> login
    auth -->|"예"| destination{"복귀할 초대 또는 카페 경로가 있는가"}
    session -->|"예"| destination
    destination -->|"예"| check["해당 흐름에서 유효성과 권한 재검증"]
    destination -->|"아니요"| list["G02 내 카페 목록"]
    list --> exists{"참여한 카페가 있는가"}
    exists -->|"예"| select["카페 선택 후 역할별 진입 F04"]
    exists -->|"아니요"| allowed{"카페 생성 허용 사용자인가"}
    allowed -->|"예"| create["G03 카페 만들기 F02"]
    allowed -->|"아니요"| empty["참여 카페 없음과 초대 링크 안내"]
```

- 연결 작업: W05–W06. 복귀 경로는 서비스 내부의 허용된 경로로 제한한다.
- 초대 링크를 통한 로그인은 F03으로 돌아가고, 카페 직접 URL은 F04의 멤버십 검증을 거친다.
- 로그인 실패는 빈 카페나 신규 계정 생성 성공으로 처리하지 않는다.

## F02 카페 생성

```mermaid
flowchart TD
    start["G02 카페 만들기 선택"] --> allowed{"서버가 생성 권한을 허용하는가"}
    allowed -->|"아니요"| blocked["생성 불가 안내와 목록 복귀"]
    allowed -->|"예"| form["G03 매장명과 시간대 입력"]
    form --> valid{"입력값이 유효한가"}
    valid -->|"아니요"| field["오류 표시와 입력 유지"]
    field --> form
    valid -->|"예"| save["카페와 소유자 멤버십을 함께 저장"]
    save --> result{"저장 결과"}
    result -->|"실패"| fail["실패 안내와 재시도"]
    fail --> save
    result -->|"응답 불명"| reconcile["동일 요청으로 결과 확인"]
    reconcile --> result
    result -->|"성공"| home["C01 빈 대시보드"]
    home --> next{"다음 작업 선택"}
    next -->|"장부 입력"| ledger["F05 기록 등록"]
    next -->|"기존 자료"| data["F08 JSON 가져오기"]
    next -->|"사용자 초대"| invite["F03 사용자 초대"]
```

- 연결 작업: W06. 생성 재시도로 카페가 중복 생성되지 않게 요청을 식별한다.
- 생성과 소유자 연결은 함께 성공해야 한다. 소유자 없는 카페를 사용자에게 노출하지 않는다.

## F03 초대 생성과 수락

### 초대하는 사용자

```mermaid
flowchart TD
    members["C10 멤버 관리"] --> role{"현재 역할"}
    role -->|"소유자"| owner["대상 이메일과 관리자 또는 직원 선택"]
    role -->|"관리자"| manager["대상 이메일과 직원 역할 선택"]
    role -->|"직원 또는 비참여"| deny["접근 차단"]
    owner --> generate["서버 검증 후 일회용 초대 생성"]
    manager --> generate
    generate --> link["7일 만료 링크 복사"]
    link --> share["사용자가 대상자에게 직접 전달"]
    link --> cancel["필요 시 초대 취소"]
```

### 초대받은 사용자

```mermaid
flowchart TD
    visit["G04 초대 링크 열기"] --> login{"로그인했는가"}
    login -->|"아니요"| auth["G01 로그인 후 초대로 복귀"]
    auth --> valid{"초대가 유효한가"}
    login -->|"예"| valid
    valid -->|"아니요"| invalid["만료 또는 취소 또는 사용 상태 안내"]
    valid -->|"예"| email{"검증된 이메일이 대상과 같은가"}
    email -->|"아니요"| change["대상 계정으로 전환 안내"]
    change --> auth
    email -->|"예"| existing{"이미 카페 멤버인가"}
    existing -->|"예"| keep["기존 역할 유지 후 카페 진입"]
    existing -->|"아니요"| accept["참여 수락"]
    accept --> commit["초대 재검증 후 소비와 멤버십 생성"]
    commit --> outcome{"처리 결과"}
    outcome -->|"성공"| enter["F04 역할별 카페 진입"]
    outcome -->|"상태 변경"| invalid
    outcome -->|"통신 오류"| retry["같은 초대로 현재 처리 상태 확인"]
    retry --> valid
```

- 연결 작업: W07, 검증 T04. 서버가 수락 직전에 초대 상태·대상 이메일·역할 부여 권한을 다시 검증한다.
- 동시 수락은 멤버십 중복을 만들지 않는다. 첫 수락 성공 후 응답만 유실된 경우에는 기존 참여 사실을 확인해 카페 진입을 안내한다.
- 초대 생성자의 권한이 회수되면 남은 초대의 수락도 차단하는 것을 기본 설계로 한다.
- 자동 이메일 발송은 MVP에 포함하지 않는다.

## F04 카페 진입과 전환

```mermaid
flowchart TD
    request["카페 선택 또는 직접 URL"] --> dirty{"다른 카페에 미저장 입력이 있는가"}
    dirty -->|"예"| choice{"현재 화면 유지 또는 입력 폐기"}
    choice -->|"유지"| stay["현재 카페에서 계속 편집"]
    choice -->|"폐기"| check["대상 카페 멤버십 조회"]
    dirty -->|"아니요"| check
    check --> member{"참여 중인가"}
    member -->|"아니요"| denied["G06 접근 불가 후 G02 목록"]
    member -->|"예"| clear["이전 카페 데이터와 늦은 응답 차단"]
    clear --> role{"대상 카페 역할"}
    role -->|"소유자 또는 관리자"| admin["C01 대시보드 또는 허용된 직접 경로"]
    role -->|"직원"| staff["C09 내 근무 또는 허용된 직접 경로"]
```

- 연결 작업: W06, 검증 T01·T02·T09. 역할에 맞지 않는 직접 경로는 접근 불가 안내 후 해당 역할의 기본 화면으로 이동한다.
- 전환 시 현재 카페명·내 역할·메뉴를 함께 갱신한다. 기록 ID가 존재하더라도 다른 카페 소속이면 접근을 허용하지 않는다.

## F05 장부 등록과 저장 결과 확인

```mermaid
flowchart TD
    list["C02부터 C05까지 장부 목록"] --> form["등록 또는 편집"]
    form --> submit["저장 요청"]
    submit --> auth{"세션과 카페 권한이 유효한가"}
    auth -->|"아니요"| denied["F10 세션 또는 권한 처리"]
    auth -->|"예"| valid{"입력과 참조 데이터가 유효한가"}
    valid -->|"아니요"| field["필드 오류 표시와 입력 유지"]
    field --> form
    valid -->|"예"| write["중복 요청 확인과 조건부 저장"]
    write --> result{"처리 결과"}
    result -->|"버전 충돌"| conflict["F06 동시 수정 처리"]
    result -->|"실패"| fail["미저장 안내와 입력 유지"]
    fail --> form
    result -->|"응답 불명"| unknown["동일 요청 식별 값으로 결과 확인 또는 재시도"]
    unknown --> write
    result -->|"성공 또는 이미 처리됨"| done["완료 안내와 목록 및 집계 갱신"]
```

- 연결 작업: W08·W09·W11, 검증 T06·T07·T08. 재시도 시에도 세션과 권한을 다시 확인한다.
- 구매와 재고 이동 등 연결 작업은 함께 성공하거나 실패해야 한다. 삭제도 서버 권한·버전 검증을 거친다.
- 직원은 이 흐름에 접근할 수 없다. 내 근무 입력은 F07을 따른다.

## F06 동시 수정 충돌

```mermaid
flowchart TD
    conflict["저장 요청에 버전 충돌 반환"] --> compare["내 입력과 최신 서버 기록 표시"]
    compare --> choice{"사용자 선택"}
    choice -->|"최신 기록 사용"| discard["내 변경 폐기 확인"]
    discard --> reload["최신 기록으로 갱신"]
    choice -->|"수정 계속"| edit["차이를 확인하고 입력 다시 편집"]
    edit --> save["최신 버전을 기준으로 저장 요청"]
    save --> result{"다시 충돌했는가"}
    result -->|"예"| compare
    result -->|"아니요"| normal["F05 일반 저장 결과 처리"]
```

- 연결 작업: W11, 검증 T06. 최신 버전으로 저장해도 충돌 검사를 생략하지 않는다.
- 서버에서 기록이 삭제되었거나 접근 권한이 사라졌다면 재편집 저장을 막고 목록으로 안내한다.
- 자동 병합·강제 덮어쓰기는 MVP에 포함하지 않는다.

## F07 직원의 본인 근무 입력

```mermaid
flowchart TD
    home["C09 내 근무"] --> linked{"계정에 연결된 카페 직원이 있는가"}
    linked -->|"아니요"| help["소유자 또는 관리자에게 연결 요청 안내"]
    linked -->|"예"| list["본인 근무 목록"]
    list --> form["근무 날짜와 출퇴근 및 휴게 입력"]
    form --> save["서버가 본인 연결과 입력 재검증"]
    save --> result{"처리 결과"}
    result -->|"입력 오류"| form
    result -->|"세션 또는 권한 오류"| denied["F10 공통 처리"]
    result -->|"통신 오류"| retry["입력 유지와 같은 요청으로 결과 확인"]
    retry --> save
    result -->|"성공"| done["본인 근무 목록 갱신"]
```

- 연결 작업: W10, 검증 T03. 본인 직원 연결은 서버가 결정하며 클라이언트가 임의로 바꾸지 못한다.
- 계정 미연결은 장부 데이터가 없는 상태와 구분한다. 직원에게 급여·전체 근무를 응답하지 않는다.

## F08 기존 JSON 가져오기와 백업

```mermaid
flowchart TD
    data["C12 데이터 관리"] --> action{"작업 선택"}
    action -->|"내보내기"| export["소유자 권한 확인 후 카페 JSON 다운로드"]
    action -->|"가져오기"| empty{"장부가 비어 있는 카페인가"}
    empty -->|"아니요"| blocked["가져오기 불가와 새 카페 안내"]
    empty -->|"예"| file["기존 JSON 파일 선택"]
    file --> validate["형식과 금액 및 참조 검증"]
    validate --> valid{"유효한 파일인가"}
    valid -->|"아니요"| errors["오류 항목 표시"]
    errors --> file
    valid -->|"예"| preview["카페명과 항목 수 및 합계 미리보기"]
    preview --> confirm{"실행할 것인가"}
    confirm -->|"취소"| data
    confirm -->|"실행"| recheck["소유자와 빈 상태 재검증 후 작업 시작"]
    recheck --> process["일반 쓰기를 제한하고 임시 데이터 처리"]
    process --> result{"처리 결과"}
    result -->|"실패"| fail["부분 기록 비공개와 작업 상태 안내"]
    fail --> retry{"재시도 또는 정리"}
    retry -->|"재시도"| recheck
    retry -->|"정리"| cleanup["임시 기록 정리 후 데이터 관리"]
    result -->|"성공"| verify["건수와 합계 검증 후 장부에 반영"]
    verify --> done["완료 결과와 대시보드 이동"]
```

- 연결 작업: W12·W14, 검증 T10·T11. 진행 중 새로고침하면 새 작업을 만들지 않고 기존 작업 상태를 조회한다.
- 재시도 시 기존 임시 작업을 식별해 중복 반영을 막는다. 일반 장부와 집계에는 완료된 데이터만 노출한다.
- 가져오기·내보내기는 소유자 전용이며 관리자·직원은 접근할 수 없다. 다운로드 요청과 실제 파일 확보를 구분해 안내한다.

## F09 역할 변경과 소유권 이전

```mermaid
flowchart TD
    settings["C10 멤버 관리 또는 C11 카페 설정"] --> action{"작업 선택"}
    action -->|"역할 변경 또는 참여 해제"| allowed{"현재 역할이 대상 변경을 허용하는가"}
    allowed -->|"아니요"| deny["변경 차단"]
    allowed -->|"예"| confirm["대상 사용자와 카페 및 변경 내용 확인"]
    confirm --> apply["권한 재검증 후 변경과 이력 저장"]
    apply --> refresh["다음 API부터 새 권한 적용"]
    action -->|"소유권 이전"| owner{"현재 소유자인가"}
    owner -->|"아니요"| deny
    owner -->|"예"| target["현재 카페의 활성 멤버 선택"]
    target --> transfer["이전 대상과 기존 소유자의 변경 역할 확인"]
    transfer --> atomic["소유자 1명 제약을 유지하며 함께 변경"]
    atomic --> result{"변경 성공인가"}
    result -->|"아니요"| unchanged["기존 권한 유지와 오류 안내"]
    result -->|"예"| refresh
```

- 연결 작업: W07, 검증 T05. 관리자에게 소유자·다른 관리자 변경을 허용하지 않는다.
- 소유권 이전 후 기존 소유자는 관리자로 전환하는 것을 제안한다. 구현 전에 W02에서 이 정책을 확정하고 PRD에 반영한다.
- 소유자는 이전 없이 탈퇴할 수 없다. 참여 해제는 과거 거래·근무 기록 삭제를 의미하지 않는다.

## F10 세션 만료와 권한 회수

```mermaid
flowchart TD
    response["조회 또는 저장 요청에서 접근 오류"] --> type{"오류 종류"}
    type -->|"세션 만료"| login["로그인 필요 안내"]
    login --> auth["G01 재로그인"]
    auth --> check["사용자와 원래 카페 권한 재확인"]
    check --> access{"접근 가능한가"}
    access -->|"예"| restore["허용된 화면으로 복귀"]
    access -->|"아니요"| list["카페 데이터 제거 후 G02 목록"]
    type -->|"멤버십 회수"| list
    type -->|"역할 변경으로 화면 접근 불가"| home["보호된 화면을 비우고 역할별 기본 화면"]
    type -->|"대상 없음"| missing["없음 안내 후 허용된 목록"]
```

- 연결 작업: W05–W07. 재로그인 후 저장을 자동 재실행하지 않는다. 동일 사용자·카페인지 확인하고 사용자 확인을 거쳐 재시도한다.
- 사용자나 카페가 달라졌다면 이전 장부 입력을 자동 복원하지 않는다. 권한이 사라진 데이터는 화면과 캐시에 남기지 않는다.

## 화면과 흐름 연결표

| 흐름 | 주요 화면 | 작업 | 검증 |
| --- | --- | --- | --- |
| F01 로그인 | G01·G02·G06 | W05–W06 | 세션·로그인·안전한 복귀 |
| F02 생성 | G03·C01 | W06 | 카페와 소유자 함께 생성 |
| F03 초대 | G04·C10 | W07 | T04 |
| F04 전환 | G02·C01·C09 | W06 | T01·T02·T09 |
| F05 저장 | C02–C05 | W08·W09·W11 | T06·T07·T08 |
| F06 충돌 | C02–C05 편집 상태 | W11 | T06 |
| F07 내 근무 | C09 | W10 | T03 |
| F08 자료 이전 | C12 | W12·W14 | T10·T11 |
| F09 역할 관리 | C10·C11 | W07 | T05 |
| F10 접근 오류 | G01·G02·G06·카페 공통 | W05–W07 | T02·T05 |

PRD의 제품 범위를 바꾸는 신규 정책은 확정 사항처럼 구현하지 않는다. IA와 이 문서가 제안하는 세부 정책을 W02에서 정리한 뒤 관련 문서를 함께 갱신한다.
