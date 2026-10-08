export function membersScreen({
  root,
  cafe,
  me,
  api,
  escape,
  status,
  valid,
  onChange,
  dirty,
}) {
  const base = `/api/v1/cafes/${cafe.id}/`;
  let rows = [],
    cursor = null,
    busy = false,
    retry = null,
    lastInvite = null;
  root.innerHTML = `<section class="card"><h2>멤버 초대</h2><form id="invite-form"><label class="wide">Google 계정 이메일<input name="email" type="email" required maxlength="320"></label><label>역할<select name="role"><option value="staff">직원</option>${cafe.role === "owner" ? '<option value="admin">관리자</option>' : ""}</select></label><button>초대 링크 만들기</button></form><p>초대받은 이메일로 로그인해야 참여할 수 있습니다. 링크를 직접 전달해 주세요.</p><div id="invite-result"></div></section><section class="card"><h2>함께하는 멤버</h2><div id="member-records"></div><button id="member-more" class="secondary" hidden>더 보기</button></section>${cafe.role === "owner" ? '<section class="card"><h2>카페 설정</h2><form id="cafe-settings"><label>카페 이름<input name="name" required maxlength="100"></label><label>시간대<input name="timezone" required placeholder="Asia/Seoul"></label><button>저장</button></form></section>' : ""}`;
  const form = root.querySelector("#invite-form"),
    records = root.querySelector("#member-records");
  form.oninput = () => dirty(true);
  async function write(path, method, data) {
    const signature = JSON.stringify([path, method, data]);
    if (retry?.signature !== signature)
      retry = { signature, key: crypto.randomUUID() };
    return api(path, { method, data, key: retry.key });
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    try {
      const r = (
        await write(
          base + "invitations",
          "POST",
          Object.fromEntries(new FormData(form)),
        )
      ).data;
      if (!valid()) return;
      lastInvite = r;
      dirty(false);
      retry = null;
      const url = location.origin + "/cloud.html#invite=" + r.token;
      root.querySelector("#invite-result").innerHTML =
        `<label>초대 링크<input readonly value="${escape(url)}"></label><p>만료: ${escape(r.expiresAt)}</p><button id="cancel-invite" class="secondary">이 초대 취소</button>`;
      root.querySelector("#cancel-invite").onclick = async () => {
        try {
          await write(base + "invitations/" + lastInvite.id, "DELETE", {});
          if (valid()) {
            root.querySelector("#invite-result").textContent =
              "초대를 취소했습니다.";
            retry = null;
          }
        } catch (e) {
          if (valid()) status(e.message, true);
        }
      };
      status("초대 링크를 만들었습니다.");
    } catch (e) {
      if (valid()) status(e.message, true);
    } finally {
      busy = false;
    }
  };
  let read = 0;
  async function refresh(append = false) {
    const ticket = ++read;
    try {
      const r = await api(
        base +
          "members" +
          (append && cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      );
      if (!valid() || ticket !== read) return;
      rows = append ? [...rows, ...r.data] : r.data;
      cursor = r.nextCursor;
      draw();
      status("현재 멤버 권한입니다.");
    } catch (e) {
      if (valid()) {
        if (["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"].includes(e.code))
          records.replaceChildren();
        status(e.message, true);
      }
    }
  }
  function draw() {
    records.innerHTML = `<ul class="members">${rows.map((r) => `<li><strong>${escape(r.name)}</strong><span>${escape(r.email)}</span><b>${escape({ owner: "소유자", admin: "관리자", staff: "직원" }[r.role])} · ${r.status === "active" ? "참여 중" : "참여 해제"}</b>${r.status === "active" && r.role !== "owner" && (cafe.role === "owner" || r.role === "staff") ? `<button class="text-button danger" data-remove="${r.userId}">참여 해제</button>${cafe.role === "owner" ? `<button class="text-button" data-role="${r.userId}">${r.role === "staff" ? "관리자로" : "직원으로"}</button><button class="text-button" data-owner="${r.userId}">소유권 이전</button>` : ""}` : ""}</li>`).join("")}</ul>`;
    root.querySelector("#member-more").hidden = !cursor;
    records.querySelectorAll("[data-remove],[data-role],[data-owner]").forEach(
      (b) =>
        (b.onclick = async () => {
          if (busy) return;
          const action = b.dataset.remove
              ? "remove"
              : b.dataset.role
                ? "role"
                : "owner",
            target = rows.find((r) => r.userId === b.dataset[action]);
          if (
            !confirm(
              `${target.name}님의 ${action === "remove" ? "참여를 해제" : action === "owner" ? "계정으로 소유권을 이전" : "역할을 변경"}할까요?`,
            )
          )
            return;
          busy = true;
          let success = false;
          try {
            if (action === "owner") {
              const owner = rows.find((r) => r.userId === me.id);
              if (!owner) throw new Error("소유자 정보를 새로 불러와 주세요.");
              await write(base + "ownership-transfer", "POST", {
                userId: target.userId,
                expectedVersion: owner.version,
              });
            } else
              await write(
                base + "members/" + target.userId,
                action === "remove" ? "DELETE" : "PATCH",
                {
                  expectedVersion: target.version,
                  ...(action === "role"
                    ? { role: target.role === "staff" ? "admin" : "staff" }
                    : {}),
                },
              );
            retry = null;
            success = true;
          } catch (e) {
            if (valid()) status(e.message, true);
          } finally {
            busy = false;
            if (success && valid()) {
              if (action === "owner") onChange();
              else refresh();
            }
          }
        }),
    );
  }
  root.querySelector("#member-more").onclick = () => refresh(true);
  const settings = root.querySelector("#cafe-settings");
  if (settings) {
    let version = null;
    api(base.slice(0, -1))
      .then((r) => {
        if (!valid()) return;
        version = r.data.version;
        settings.elements.name.value = r.data.name;
        settings.elements.timezone.value = r.data.timezone;
      })
      .catch((e) => status(e.message, true));
    settings.oninput = () => dirty(true);
    settings.onsubmit = async (event) => {
      event.preventDefault();
      if (busy || version === null) return;
      busy = true;
      try {
        await write(base.slice(0, -1), "PATCH", {
          ...Object.fromEntries(new FormData(settings)),
          expectedVersion: version,
        });
        dirty(false);
        if (valid()) onChange();
      } catch (e) {
        if (valid()) status(e.message, true);
      } finally {
        busy = false;
      }
    };
  }
  refresh();
  return refresh;
}
