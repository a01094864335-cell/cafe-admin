export function auditScreen({ root, cafe, api, escape, status, valid }) {
  let cursor = null,
    rows = [],
    loading = false;
  root.innerHTML =
    '<section class="card"><h2>변경 이력</h2><p>저장된 변경과 작업자를 확인합니다. 실패한 요청은 화면에 표시된 요청 번호로 문의해 주세요.</p><div id="audit-rows"></div><button id="audit-more" class="secondary" hidden>이전 이력</button></section>';
  const resources = {
    sales: "매출",
    purchases: "매입",
    expenses: "비용",
    "other-incomes": "기타 수입",
    inventory: "재고",
    employee: "직원",
    employees: "직원",
    work: "근무",
    "work-logs": "근무",
    "payroll-settings": "급여 설정",
    "weekly-confirmations": "주별 확인",
    "payroll-extras": "기타 수당",
    export: "백업",
    import: "자료 이전",
    cafe: "카페",
    member: "멤버",
    invitation: "초대",
    ownership: "소유권",
  };
  const actions = {
    create: "등록",
    update: "수정",
    delete: "삭제",
    accept: "수락",
    cancel: "취소",
    commit: "적용",
    complete: "완료",
    save: "저장",
    role: "권한 변경",
    remove: "참여 해제",
    transfer: "이전",
    resume: "다시 시작",
    chunk: "자료 업로드",
    validate: "합계 검증",
    adjust: "수량 조정",
  };
  const label = (action) =>
    action
      .split(".")
      .map(
        (part) =>
          resources[part] ??
          actions[part] ??
          (part === "replay" ? "재확인" : part),
      )
      .join(" · ");
  async function refresh(append = false) {
    if (loading) return;
    loading = true;
    try {
      const result = await api(
        `/api/v1/cafes/${cafe.id}/audit` +
          (append && cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      );
      if (!valid()) return;
      rows = append ? rows.concat(result.data) : result.data;
      cursor = result.nextCursor;
      root.querySelector("#audit-rows").innerHTML = rows.length
        ? `<div class="table-scroll"><table><thead><tr><th>시간</th><th>작업자</th><th>변경</th><th>결과</th><th>상세</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${escape(new Date(r.createdAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }))}</td><td>${escape(r.actorName)}</td><td>${escape(label(r.action))}</td><td>저장 완료</td><td><details><summary>기록 정보</summary><small>대상: ${escape(r.target)}<br>요청 번호: ${escape(r.requestId ?? "이전 기록")}</small></details></td></tr>`).join("")}</tbody></table></div>`
        : "<p>아직 저장된 변경이 없습니다.</p>";
      root.querySelector("#audit-more").hidden = !cursor;
      status("변경 이력을 불러왔습니다.");
    } catch (error) {
      if (valid()) status(error.message, true);
    } finally {
      loading = false;
    }
  }
  root.querySelector("#audit-more").onclick = () => refresh(true);
  refresh();
  return refresh;
}
