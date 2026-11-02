export function googleSheetPanel({ root, base, api, valid, status }) {
  root.innerHTML =
    '<h2>구글 시트 자동 동기화</h2><p>연결하면 기존 전체 기록을 14개 탭에 옮기고, 저장·수정·삭제도 자동 반영합니다. 연결이 끊기면 재시도합니다.</p><p>사이트 기록이 기준입니다. 자동 동기화 탭을 직접 수정하면 다음 동기화 때 덮어씁니다. 분석은 별도 탭을 추가해 주세요.</p><p id="google-sheet-status" role="status">연결 확인 중…</p><div class="form-actions"><button id="google-sheet-connect">구글 시트 만들고 연결</button><a id="google-sheet-open" target="_blank" rel="noopener noreferrer" hidden>구글 시트 열기</a><button id="google-sheet-sync" class="secondary" hidden>지금 동기화</button><button id="google-sheet-disconnect" class="secondary" hidden>연결 해제</button></div>';
  const el = (id) => root.querySelector("#google-sheet-" + id);
  let busy = false;
  const errors = {
    RECONNECT_REQUIRED: "구글 권한이 만료됐어요. 다시 연결해 주세요.",
    GOOGLE_PERMISSION_REQUIRED:
      "구글 시트 API 또는 파일 접근 권한을 확인한 뒤 다시 연결해 주세요.",
    SHEET_NOT_FOUND:
      "연결된 시트를 찾을 수 없어요. 연결 해제 후 새로 만들어 주세요.",
    OWNER_CHANGED:
      "매장 소유자가 바뀌었어요. 현재 소유자 계정으로 다시 연결해 주세요.",
    SHEET_TOO_LARGE:
      "자동 동기화 처리 용량을 초과했어요. 엑셀 다운로드를 이용해 주세요.",
    GOOGLE_RETRY: "구글 연결이 지연되어 자동 재시도 중이에요.",
  };
  async function refresh() {
    try {
      const { data } = await api(base + "/google-sheet");
      if (!valid()) return;
      el("connect").textContent = data.connected
        ? "구글 권한 다시 연결"
        : "구글 시트 만들고 연결";
      for (const id of ["open", "sync", "disconnect"])
        el(id).hidden = !data.connected;
      if (data.connected) el("open").href = data.url;
      el("status").textContent = data.error
        ? errors[data.error] || "연결 상태를 확인해 주세요."
        : data.connected
          ? (data.pending ? "동기화 대기 중 · " : "자동 동기화 연결됨 · ") +
            (data.lastSuccess
              ? "마지막 반영: " +
                new Date(data.lastSuccess).toLocaleString("ko-KR")
              : "첫 동기화를 기다리고 있어요.")
          : "아직 연결된 시트가 없습니다. 현재 로그인한 구글 계정으로 연결해 주세요.";
    } catch (error) {
      if (valid()) el("status").textContent = error.message;
    }
  }
  async function action(name) {
    if (busy) return;
    busy = true;
    for (const id of ["connect", "sync", "disconnect"]) el(id).disabled = true;
    try {
      const result = await api(base + "/google-sheet/" + name, {
        method: "POST",
        data: {},
      });
      if (!valid()) return;
      if (name === "connect") window.location.assign(result.data.url);
      else {
        status(
          name === "disconnect"
            ? "자동 동기화를 해제했습니다. 구글 시트 파일은 남아 있습니다."
            : "동기화를 요청했습니다. 잠시 후 상태가 갱신됩니다.",
        );
        await refresh();
      }
    } catch (error) {
      if (valid()) status(error.message, true);
    } finally {
      busy = false;
      if (valid())
        for (const id of ["connect", "sync", "disconnect"])
          el(id).disabled = false;
    }
  }
  for (const name of ["connect", "sync", "disconnect"])
    el(name).onclick = () => action(name);
  refresh();
  return refresh;
}
