import { membersScreen } from "./members.js";
import { payrollScreen } from "./payroll.js";
import { workScreen } from "./work.js";
import { inventoryScreen } from "./inventory.js";
import "./styles.css";
const app = document.querySelector("#cloud-app");
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const labels = {
  sales: "매출",
  purchases: "매입",
  expenses: "비용",
  "other-incomes": "기타 수입",
};
const entryKeys = () =>
  view === "sales"
    ? ["businessDate", "card", "cash", "transfer", "note"]
    : ["businessDate", "vendor", "item", "amount", "note"];
const amount = (v) =>
  v === null ? "미입력" : Number(v).toLocaleString("ko-KR") + "원";
let pendingInvite = new URLSearchParams(location.hash.slice(1)).get("invite");
if (!/^[A-Za-z0-9_-]{43}$/.test(pendingInvite ?? "")) pendingInvite = null;
let me = null,
  cafes = [],
  current = null,
  generation = 0,
  controller = null,
  dirty = false,
  saving = false,
  retry = null,
  editing = null;
const messages = {
  EMPLOYEE_NOT_LINKED:
    "연결된 직원 기록이 없습니다. 소유자에게 계정 연결을 요청해 주세요.",
  UNAUTHENTICATED: "로그인이 만료되었습니다. 다시 로그인해 주세요.",
  FORBIDDEN: "이 작업을 할 권한이 없습니다.",
  NOT_FOUND: "접근할 수 없거나 삭제된 자료입니다.",
  VERSION_CONFLICT:
    "다른 사용자가 먼저 수정했습니다. 입력은 보존했습니다. 최신 자료를 확인해 주세요.",
  IDEMPOTENCY_MISMATCH: "요청 정보가 달라졌습니다. 내용을 확인해 주세요.",
  CAFE_WRITE_LOCKED:
    "백업 또는 자료 이전 중입니다. 완료 후 다시 저장해 주세요.",
  VALIDATION_ERROR: "날짜와 금액 등 입력 내용을 확인해 주세요.",
  CSRF_INVALID: "로그인을 새로 확인한 뒤 다시 시도해 주세요.",
  TEMPORARILY_UNAVAILABLE:
    "일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  RATE_LIMITED: "요청이 많습니다. 잠시 후 다시 시도해 주세요.",
};
function status(message, error = false) {
  const el = document.querySelector("#status");
  if (el) {
    el.textContent = message;
    el.classList.toggle("error", error);
  }
}
async function api(path, { method = "GET", data, key, signal } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    signal,
    headers: {
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "GET" ? {} : { "X-CSRF-Token": me?.csrfToken ?? "" }),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const value = await response.json();
  if (!response.ok) {
    const e = new Error(
      messages[value.error?.code] ?? "처리하지 못했습니다. 다시 시도해 주세요.",
    );
    e.code = value.error?.code;
    e.details = value.error?.details;
    throw e;
  }
  return value;
}
function clear() {
  controller?.abort();
  generation++;
  current = null;
  cafes = [];
  me = null;
  dirty = false;
  editing = null;
  retry = null;
}
function signedOut(message = "") {
  app.innerHTML = `<main class="login"><div class="mark">c</div><p class="eyebrow">CAFE ADMIN</p><h1>같이 기록하는<br>우리 카페 장부</h1><p>카페의 매출과 운영 기록을<br>허용된 멤버와 함께 관리합니다.</p><a class="button" href="/auth/google/start${pendingInvite ? "?invite=" + pendingInvite : ""}">Google로 로그인</a><p role="status">${escape(message)}</p><a href="/">기존 내 PC 장부 열기</a></main>`;
}
async function init() {
  try {
    me = (await api("/api/v1/me")).data;
    cafes = [];
    let cursor = null;
    do {
      const r = await api(
        "/api/v1/cafes" +
          (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      );
      cafes.push(...r.data);
      cursor = r.nextCursor;
    } while (cursor);
    render();
    if (cafes.length) await selectCafe(cafes[0].id);
    if (pendingInvite) await showInvite();
  } catch (e) {
    clear();
    signedOut(e.code === "UNAUTHENTICATED" ? "" : e.message);
  }
}
function render() {
  app.innerHTML = `<div class="layout"><aside><a class="brand" href="/cloud.html"><span class="mark">c</span><span>Cafe Admin<small>함께 쓰는 운영 장부</small></span></a><label for="cafe">현재 카페</label><select id="cafe"><option value="">카페를 선택하세요</option>${cafes.map((c) => `<option value="${escape(c.id)}">${escape(c.name)}</option>`).join("")}</select><p id="role"></p>${me.canCreateCafe ? '<button id="create-cafe" class="secondary">카페 만들기</button>' : ""}<nav><button class="selected" data-view="sales">일별 매출</button><button data-view="purchases">매입</button><button data-view="expenses">비용</button><button data-view="other-incomes">기타 수입</button><button data-view="dashboard">손익 요약</button><button data-view="payroll">급여</button><button data-view="work">직원 · 근무</button><button data-view="inventory">재고</button><button data-view="members">멤버 · 초대</button></nav><div class="aside-bottom"><span>${escape(me.name)}</span><button id="logout" class="secondary">로그아웃</button><a href="/">내 PC 장부</a></div></aside><main><header><div><p class="eyebrow">SHARED WORKSPACE</p><h1 id="title">카페를 선택하세요</h1></div><button id="refresh" class="secondary">새로고침</button></header><p id="status" role="status" aria-live="polite">서버에 저장한 자료를 불러옵니다.</p><section id="content"></section></main></div>`;
  document
    .querySelector("#create-cafe")
    ?.addEventListener("click", async () => {
      if (dirty && !confirm("작성 중인 입력을 버릴까요?")) return;
      const name = prompt("카페 이름을 입력하세요.");
      if (!name) return;
      try {
        await api("/api/v1/cafes", {
          method: "POST",
          data: { name, timezone: "Asia/Seoul" },
          key: crypto.randomUUID(),
        });
        await init();
      } catch (e) {
        status(e.message, true);
      }
    });
  document.querySelector("#cafe").onchange = (e) => {
    if (dirty && !confirm("저장하지 않은 입력을 버리고 카페를 바꿀까요?")) {
      e.target.value = current?.id ?? "";
      return;
    }
    selectCafe(e.target.value);
  };
  document.querySelector("#logout").onclick = async () => {
    if (dirty && !confirm("저장하지 않은 입력을 버리고 로그아웃할까요?"))
      return;
    try {
      await api("/auth/logout", { method: "POST" });
      clear();
      signedOut();
    } catch (e) {
      status(e.message, true);
    }
  };
  document.querySelector("#refresh").onclick = () => refresh();
  document.querySelectorAll("[data-view]").forEach(
    (b) =>
      (b.onclick = () => {
        if (dirty && !confirm("저장하지 않은 입력을 버리고 이동할까요?"))
          return;
        view = b.dataset.view;
        dirty = false;
        editing = null;
        renderView();
      }),
  );
  if (!cafes.length)
    document.querySelector("#content").innerHTML =
      '<div class="empty"><h2>아직 참여한 카페가 없습니다</h2><p>소유자에게 초대 링크를 받아 참여해 주세요.</p></div>';
}
let stockItems = [];
let inventoryRefresh = null;
let view = "sales",
  rows = [],
  cursor = null,
  readGeneration = 0;
async function selectCafe(id) {
  controller?.abort();
  controller = new AbortController();
  generation++;
  current = cafes.find((c) => c.id === id) ?? null;
  dirty = false;
  retry = null;
  editing = null;
  rows = [];
  cursor = null;
  document.querySelector("#cafe").value = id;
  document.querySelector("#title").textContent =
    current?.name ?? "카페를 선택하세요";
  document.querySelector("#role").textContent = current
    ? { owner: "소유자", admin: "관리자", staff: "직원" }[current.role]
    : "";
  await renderView();
}
function salesForm() {
  const moneyInput = (name, label, required = false) =>
    `<label>${label}<input name="${name}" type="number" step="1" ${required ? "required" : ""} placeholder="${required ? "0" : "미입력"}"></label>`;
  return `<section class="card"><div class="section-head"><h2 id="form-title">${labels[view]} 기록</h2><span>금액은 원 단위로 입력합니다</span></div><form id="sale-form"><label>영업일<input name="businessDate" type="date" required></label>${view === "sales" ? moneyInput("card", "카드") + moneyInput("cash", "현금") + moneyInput("transfer", "계좌이체") : `<label>거래처<input name="vendor" maxlength="200"></label><label>항목<input name="item" maxlength="200" required></label>${moneyInput("amount", "금액", true)}`}${view === "purchases" ? '<label>재고 연동<select name="stockItem"><option value="">기존 연동 유지 / 새 거래는 없음</option><option value="none">연동 해제</option></select></label><label>입고 수량<input name="stockDelta" type="number" step="0.01" placeholder="2.5"></label>' : ""}<label class="wide">메모<input name="note" maxlength="2000" placeholder="기록할 내용을 적어주세요"></label><div class="form-actions"><button type="submit">저장</button><button id="cancel-edit" type="button" class="secondary">입력 지우기</button></div></form></section>`;
}
async function renderView() {
  generation++;
  inventoryRefresh = null;
  rows = [];
  cursor = null;
  const el = document.querySelector("#content");
  if (!current) {
    el.replaceChildren();
    return;
  }
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.view === view));
  if (current.role === "staff" && view !== "work") {
    el.innerHTML =
      '<div class="empty"><h2>직원 권한으로 참여 중입니다</h2><p>전체 매출과 멤버 관리는 소유자·관리자에게만 표시됩니다.</p></div>';
    status("카페별 권한이 적용되어 있습니다.");
    return;
  }
  if (["dashboard", "payroll"].includes(view)) {
    const ticket = generation;
    inventoryRefresh = payrollScreen({
      root: el,
      cafe: current,
      api,
      escape,
      status,
      dashboard: view === "dashboard",
      valid: () => ticket === generation,
      dirty: (value) => {
        dirty = value;
      },
      canLeave: () => !dirty || confirm("저장하지 않은 입력을 버릴까요?"),
    });
    return;
  }
  if (view === "work") {
    const ticket = generation;
    inventoryRefresh = workScreen({
      root: el,
      cafe: current,
      staff: current.role === "staff",
      api,
      escape,
      status,
      valid: () => ticket === generation,
      dirty: (value) => {
        dirty = value;
      },
      canLeave: () => !dirty || confirm("저장하지 않은 입력을 버릴까요?"),
    });
    return;
  }
  if (view === "inventory") {
    const ticket = generation;
    inventoryRefresh = inventoryScreen({
      root: el,
      cafe: current.id,
      api,
      escape,
      status,
      valid: () => ticket === generation,
      dirty: (value) => {
        dirty = value;
      },
      canLeave: () => !dirty || confirm("저장하지 않은 입력을 버릴까요?"),
    });
    return;
  }
  if (view === "members") {
    const ticket = generation;
    inventoryRefresh = membersScreen({
      root: el,
      cafe: current,
      me,
      api,
      escape,
      status,
      valid: () => ticket === generation,
      onChange: init,
      dirty: (value) => {
        dirty = value;
      },
    });
    return;
  }
  el.innerHTML =
    salesForm() +
    `<section class="card"><div class="section-head"><h2>${labels[view]} 내역</h2><div class="filters"><label>시작일<input id="from" type="date"></label><label>종료일<input id="to" type="date"></label><button id="filter" class="secondary">조회</button></div></div><div id="records"></div><button id="more" class="secondary" hidden>더 보기</button></section>`;
  const form = document.querySelector("#sale-form");
  if (view === "purchases") {
    const ticket = generation;
    (async () => {
      try {
        stockItems = [];
        let next = null;
        do {
          const r = await api(
            `/api/v1/cafes/${current.id}/inventory/items${next ? "?cursor=" + encodeURIComponent(next) : ""}`,
          );
          if (ticket !== generation) return;
          stockItems.push(...r.data);
          next = r.nextCursor;
        } while (next);
        form.elements.stockItem.insertAdjacentHTML(
          "beforeend",
          stockItems
            .map(
              (item) =>
                `<option value="${item.id}">${escape(item.name)} (${item.quantityHundredths / 100} ${escape(item.unit)})</option>`,
            )
            .join(""),
        );
      } catch (e) {
        if (ticket === generation) status(e.message, true);
      }
    })();
  }
  form.elements.businessDate.value = new Date().toLocaleDateString("sv-SE", {
    timeZone: current.timezone,
  });
  form.oninput = () => {
    dirty = true;
  };
  form.onsubmit = saveSale;
  document.querySelector("#cancel-edit").onclick = () => {
    if (dirty && !confirm("저장하지 않은 입력을 지울까요?")) return;
    dirty = false;
    editing = null;
    retry = null;
    form.reset();
    form.elements.businessDate.value = new Date().toLocaleDateString("sv-SE", {
      timeZone: current.timezone,
    });
    document.querySelector("#form-title").textContent = labels[view] + " 기록";
  };
  document.querySelector("#filter").onclick = () => refresh();
  document.querySelector("#more").onclick = () => refresh(true);
  await refresh();
}
async function refresh(append = false) {
  if (inventoryRefresh) return inventoryRefresh(append);
  if (!current || current.role === "staff") return;
  const ticket = generation,
    readTicket = ++readGeneration,
    cafe = current.id,
    activeView = view;
  const q = new URLSearchParams({ limit: "50" });
  if (labels[view]) {
    for (const key of ["from", "to"]) {
      const value = document.querySelector("#" + key)?.value;
      if (value) q.set(key, value);
    }
  }
  if (append && cursor) q.set("cursor", cursor);
  try {
    const r = await api(`/api/v1/cafes/${cafe}/${activeView}?${q}`, {
      signal: controller?.signal,
    });
    if (
      ticket !== generation ||
      readTicket !== readGeneration ||
      cafe !== current?.id ||
      activeView !== view
    )
      return;
    rows = append ? [...rows, ...r.data] : r.data;
    cursor = r.nextCursor;
    drawRows();
    status(
      dirty
        ? "최신 자료를 불러왔습니다. 작성 중인 입력은 유지됩니다."
        : "서버의 최신 자료입니다.",
    );
  } catch (e) {
    if (e.name !== "AbortError" && ticket === generation) {
      if (e.code === "UNAUTHENTICATED") {
        clear();
        signedOut(e.message);
        return;
      }
      if (["FORBIDDEN", "NOT_FOUND"].includes(e.code)) {
        rows = [];
        document.querySelector("#records")?.replaceChildren();
      }
      status(e.message, true);
    }
  }
}
function drawRows() {
  const el = document.querySelector("#records");
  if (view === "members") {
    el.innerHTML = `<ul class="members">${rows.map((r) => `<li><strong>${escape(r.name)}</strong><span>${escape(r.email)}</span><b>${escape({ owner: "소유자", admin: "관리자", staff: "직원" }[r.role])} · ${r.status === "active" ? "참여 중" : "참여 해제"}</b></li>`).join("")}</ul>`;
    return;
  }
  el.innerHTML = rows.length
    ? `<div class="table-scroll"><table><thead><tr><th>영업일</th>${view === "sales" ? "<th>카드</th><th>현금</th><th>계좌이체</th>" : "<th>거래처</th><th>항목</th><th>금액</th>"}<th>메모</th><th>관리</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${escape(r.businessDate)}</td>${view === "sales" ? `<td>${amount(r.card)}</td><td>${amount(r.cash)}</td><td>${amount(r.transfer)}</td>` : `<td>${escape(r.vendor)}</td><td>${escape(r.item)}</td><td>${amount(r.amount)}</td>`}<td>${escape(r.note)}</td><td><button class="text-button" data-edit="${escape(r.id)}">수정</button><button class="text-button danger" data-delete="${escape(r.id)}">삭제</button></td></tr>`).join("")}</tbody></table></div>`
    : '<p class="empty">이 기간에 등록된 기록이 없습니다.</p>';
  document.querySelector("#more").hidden = !cursor;
  el.querySelectorAll("[data-edit]").forEach(
    (b) =>
      (b.onclick = () => {
        if (dirty && !confirm("작성 중인 입력을 버리고 수정할까요?")) return;
        editing = rows.find((r) => r.id === b.dataset.edit);
        const form = document.querySelector("#sale-form");
        for (const k of entryKeys()) form.elements[k].value = editing[k] ?? "";
        dirty = true;
        retry = null;
        document.querySelector("#form-title").textContent =
          editing.businessDate + " " + labels[view] + " 수정";
        form.elements.businessDate.focus();
      }),
  );
  el.querySelectorAll("[data-delete]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          saving ||
          !confirm("이 기록을 삭제할까요? 기록은 이력에 보존됩니다.")
        )
          return;
        const r = rows.find((r) => r.id === b.dataset.delete),
          ticket = generation;
        b.disabled = true;
        try {
          await api(`/api/v1/cafes/${current.id}/${view}/${r.id}`, {
            method: "DELETE",
            data: { expectedVersion: r.version },
            key: crypto.randomUUID(),
          });
          if (ticket === generation) await refresh();
        } catch (e) {
          if (ticket === generation) status(e.message, true);
        } finally {
          b.disabled = false;
        }
      }),
  );
}
async function saveSale(event) {
  event.preventDefault();
  if (saving) return;
  const form = event.currentTarget,
    cafe = current.id,
    ticket = generation;
  const data = Object.fromEntries(new FormData(form));
  if (view === "purchases") {
    if (data.stockItem === "none") data.stock = null;
    else if (data.stockItem) {
      const item = stockItems.find((r) => r.id === data.stockItem),
        n = Number(data.stockDelta),
        delta = Math.round(n * 100);
      if (!item || !delta || Math.abs(n * 100 - delta) > 1e-7) {
        status(
          "재고 품목과 소수 둘째 자리까지의 입고 수량을 확인해 주세요.",
          true,
        );
        return;
      }
      data.stock = {
        itemId: item.id,
        expectedItemVersion: item.version,
        deltaHundredths: delta,
      };
    }
    delete data.stockItem;
    delete data.stockDelta;
  }
  for (const k of view === "sales" ? ["card", "cash", "transfer"] : ["amount"])
    data[k] = data[k] === "" ? null : Number(data[k]);
  if (editing) data.expectedVersion = editing.version;
  const path = `/api/v1/cafes/${cafe}/${view}${editing ? "/" + editing.id : ""}`,
    method = editing ? "PATCH" : "POST",
    signature = JSON.stringify([path, method, data]);
  if (retry?.signature !== signature)
    retry = { signature, key: crypto.randomUUID() };
  saving = true;
  for (const field of form.elements) field.disabled = true;
  status("저장 중입니다.");
  try {
    await api(path, { method, data, key: retry.key });
    if (ticket !== generation) return;
    dirty = false;
    retry = null;
    editing = null;
    form.reset();
    form.elements.businessDate.value = new Date().toLocaleDateString("sv-SE", {
      timeZone: current.timezone,
    });
    document.querySelector("#form-title").textContent = labels[view] + " 기록";
    if (view === "purchases") await renderView();
    else await refresh();
    status("저장했습니다.");
  } catch (e) {
    if (ticket === generation) status(e.message, true);
  } finally {
    saving = false;
    for (const field of form.elements) field.disabled = false;
  }
}
async function showInvite() {
  try {
    const r = (await api("/api/v1/invitations/" + pendingInvite)).data;
    const el = document.createElement("section");
    el.className = "card";
    el.innerHTML = `<h2>카페 초대</h2><p>${escape(r.cafeName ?? r.email ?? "초대된 카페")} · ${escape(r.role ?? "")}</p><button id="accept-invite">초대 수락</button>`;
    document.querySelector("main").prepend(el);
    el.querySelector("button").onclick = async () => {
      try {
        await api("/api/v1/invitations/" + pendingInvite + "/accept", {
          method: "POST",
          data: {},
          key: crypto.randomUUID(),
        });
        pendingInvite = null;
        history.replaceState(null, "", "/cloud.html");
        await init();
      } catch (e) {
        status(e.message, true);
      }
    };
  } catch (e) {
    status(e.message, true);
  }
}
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
setInterval(() => {
  if (!document.hidden && !saving) refresh();
}, 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !saving) refresh();
});
init();
