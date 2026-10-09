export function payrollScreen({
  root,
  cafe,
  api,
  escape,
  status,
  valid,
  dirty,
  canLeave,
  dashboard = false,
}) {
  const base = `/api/v1/cafes/${cafe.id}/`,
    today = new Date().toLocaleDateString("sv-SE", { timeZone: cafe.timezone });
  let saving = false,
    retry = null,
    selected = "",
    settings = [],
    editing = null;
  const input = (name, label, type = "text", value = "", extra = "") =>
    `<label>${label}<input name="${name}" type="${type}" value="${value}" ${extra}></label>`;
  root.innerHTML = `<section class="card"><h2>${dashboard ? "카페 손익" : "급여 집계"}</h2><div class="filters"><label>시작일<input id="summary-from" type="date" value="${today.slice(0, 7)}-01"></label><label>종료일<input id="summary-to" type="date" value="${today}"></label><button id="summary-refresh" class="secondary">조회</button></div><div id="summary"></div></section>${dashboard ? "" : `<section class="card"><h2>직원별 급여 설정</h2><label>직원<select id="payroll-employee"></select></label><p>급여 기준은 적용 기간별로 관리합니다. 설정이 없거나 확인되지 않은 항목은 미확정으로 표시합니다.</p><div id="settings-list"></div><form id="settings-form">${input("effectiveFrom", "적용 시작일", "date", today, "required")}${input("effectiveTo", "적용 종료일", "date")}${input("firstWeek", "첫 주 시작일", "date")}${input("weeklyHours", "주 약정 시간", "number", "20", 'min="0" step="0.01" required')}<label>주휴일<select name="holidayDay"><option value="">미설정</option>${["일", "월", "화", "수", "목", "금", "토"].map((d) => `<option>${d}</option>`).join("")}</select></label>${input("normalDays", "통상 근로 일수", "number", "5", 'min="0.01" max="7" step="0.01" required')}${input("calculationStart", "계산 시작일", "date", today.slice(0, 4) + "-01-01", "required")}${input("calculationEnd", "계산 종료일", "date", today.slice(0, 4) + "-12-31", "required")}<label class="wide">연도별 시급(원)<textarea name="rates" rows="3" required placeholder='{"2026":10000}'>${escape(JSON.stringify({ [today.slice(0, 4)]: null }))}</textarea></label><div class="form-actions"><button>설정 저장</button><button type="button" id="settings-new" class="secondary">새 기간</button></div></form></section><section class="card"><h2>주별 확인</h2><form id="weekly-form">${input("week", "주 시작일", "date", "", "required")}${input("agreedHours", "약정 시간(빈칸=설정값)", "number", "", 'min="0" step="0.01"')}<label>확인<select name="confirmation">${["미확인", "개근·재직 확인", "결근", "검토필요"].map((v) => `<option>${v}</option>`).join("")}</select></label>${input("note", "메모")}<button type="button" id="weekly-load" class="secondary">불러오기</button><button>확인 저장</button></form></section><section class="card"><h2>월별 기타 수당</h2><form id="extra-form">${input("month", "대상 월", "month", today.slice(0, 7), "required")}${input("amount", "수당(원)", "number", "", 'step="1"')}<button type="button" id="extra-load" class="secondary">불러오기</button><button>수당 저장</button></form></section>`}`;
  let read = 0;
  async function refresh() {
    const ticket = ++read;
    try {
      const from = root.querySelector("#summary-from").value,
        to = root.querySelector("#summary-to").value,
        r = (
          await api(
            base +
              (dashboard ? "dashboard" : "payroll") +
              `?from=${from}&to=${to}`,
          )
        ).data;
      if (!valid() || ticket !== read) return;
      const out = root.querySelector("#summary");
      out.innerHTML = dashboard
        ? `<div class="summary-grid">${Object.entries({
            매출: r.revenue,
            "기타 수입": r.other,
            매입: r.purchases,
            비용: r.expenses,
            인건비: r.wages,
            손익: r.profit,
          })
            .map(
              ([k, v]) =>
                `<div><span>${k}</span><strong>${v.toLocaleString("ko-KR")}원</strong></div>`,
            )
            .join("")}</div>`
        : `<div class="table-scroll"><table><thead><tr><th>직원</th><th>기본급</th><th>주휴</th><th>기타</th><th>합계</th><th>확인</th></tr></thead><tbody>${r.employees.map((e) => `<tr><td>${escape(e.name)}</td>${["base", "holiday", "extra", "total"].map((k) => `<td>${e[k].toLocaleString("ko-KR")}원</td>`).join("")}<td>${e.pending ? "미확정" : "확인됨"} · 안내 ${e.notices}건</td></tr>`).join("")}</tbody></table></div>`;
      out.insertAdjacentHTML(
        "beforeend",
        `<p>${r.pending ? "미확정 급여가 있어 합계 확인이 필요합니다." : "입력된 기준의 집계입니다."}</p>`,
      );
      if (!dashboard)
        for (const e of r.employees)
          out.insertAdjacentHTML(
            "beforeend",
            `<details><summary>${escape(e.name)} 계산 상세</summary><ul>${e.work.map((w) => `<li>${w.businessDate} · ${w.hours ?? "미입력"}시간 · ${w.base ?? "미확정"}원 · ${escape(w.notice)}</li>`).join("")}${e.weekly.map((w) => `<li>${w.date} 주 · ${escape(w.status)} · ${w.amount ?? "미확정"}원</li>`).join("")}</ul></details>`,
          );
      status("선택 기간의 최신 집계입니다.");
    } catch (e) {
      if (valid()) {
        if (["FORBIDDEN", "NOT_FOUND", "UNAUTHENTICATED"].includes(e.code))
          root.querySelector("#summary").replaceChildren();
        status(e.message, true);
      }
    }
  }
  root.querySelector("#summary-refresh").onclick = refresh;
  if (!dashboard) {
    const form = root.querySelector("#settings-form"),
      weekly = root.querySelector("#weekly-form"),
      extra = root.querySelector("#extra-form");
    let weekVersion = null,
      weekIdentity = "",
      extraVersion = null,
      extraIdentity = "";
    let settingsRead = 0;
    const employeePath = () => base + "employees/" + selected + "/";
    async function loadSettings() {
      const ticket = ++settingsRead,
        employee = selected;
      let cursor = null,
        loaded = [];
      do {
        const r = await api(
          base +
            "employees/" +
            employee +
            "/" +
            "payroll-settings" +
            (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        );
        if (!valid() || ticket !== settingsRead || employee !== selected)
          return;
        loaded.push(...r.data);
        cursor = r.nextCursor;
      } while (cursor && valid());
      if (!valid() || ticket !== settingsRead || employee !== selected) return;
      settings = loaded;
      root.querySelector("#settings-list").innerHTML =
        settings
          .map(
            (s) =>
              `<button class="secondary" type="button" data-setting="${s.id}">${s.effectiveFrom} ~ ${s.effectiveTo ?? "계속"}</button>`,
          )
          .join(" ") || "<p>저장된 설정이 없습니다.</p>";
      root.querySelectorAll("[data-setting]").forEach(
        (b) =>
          (b.onclick = () => {
            if (!canLeave()) return;
            editing = settings.find((s) => s.id === b.dataset.setting);
            for (const el of form.elements)
              if (el.name)
                el.value =
                  el.name === "rates"
                    ? JSON.stringify(editing.rates)
                    : (editing[el.name] ?? "");
            dirty(true);
          }),
      );
    }
    async function write(path, method, data) {
      const signature = JSON.stringify([path, method, data]);
      if (retry?.signature !== signature)
        retry = { signature, key: crypto.randomUUID() };
      return api(path, { method, data, key: retry.key });
    }
    async function save(path, data, onDone) {
      if (saving || !selected) return;
      saving = true;
      try {
        await write(
          path,
          path.includes("payroll-settings") ? "PATCH" : "PUT",
          data,
        );
        retry = null;
        dirty(false);
        if (valid()) {
          await onDone();
          await refresh();
        }
      } catch (e) {
        if (valid()) status(e.message, true);
      } finally {
        saving = false;
      }
    }
    for (const f of [form, weekly, extra]) f.oninput = () => dirty(true);
    root.querySelector("#settings-new").onclick = () => {
      if (!canLeave()) return;
      editing = null;
      form.reset();
      dirty(false);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      for (const k of ["weeklyHours", "normalDays"]) data[k] = Number(data[k]);
      for (const k of ["effectiveTo", "firstWeek"]) data[k] ||= null;
      try {
        data.rates = JSON.parse(data.rates);
      } catch {
        status(
          '시급은 연도와 금액으로 입력해 주세요. 예: {"2026":10000}',
          true,
        );
        return;
      }
      if (editing) {
        data.id = editing.id;
        data.expectedVersion = editing.version;
      }
      save(employeePath() + "payroll-settings", data, async () => {
        editing = null;
        form.reset();
        await loadSettings();
      });
    };
    async function loadWeek() {
      const value = weekly.elements.week.value;
      if (!value) return;
      const identity = selected + ":" + value,
        r = (await api(employeePath() + "weekly-confirmations/" + value)).data;
      if (!valid() || identity !== selected + ":" + weekly.elements.week.value)
        return;
      weekIdentity = identity;
      weekVersion = r?.version ?? null;
      weekly.elements.agreedHours.value = r?.agreedHours ?? "";
      weekly.elements.confirmation.value = r?.confirmation ?? "미확인";
      weekly.elements.note.value = r?.note ?? "";
      dirty(false);
    }
    async function loadExtra() {
      const value = extra.elements.month.value;
      if (!value) return;
      const identity = selected + ":" + value,
        r = (await api(employeePath() + "payroll-extras/" + value)).data;
      if (!valid() || identity !== selected + ":" + extra.elements.month.value)
        return;
      extraIdentity = identity;
      extraVersion = r?.version ?? null;
      extra.elements.amount.value = r?.amount ?? "";
      dirty(false);
    }
    root.querySelector("#weekly-load").onclick = () => {
      if (canLeave()) loadWeek().catch((e) => status(e.message, true));
    };
    root.querySelector("#extra-load").onclick = () => {
      if (canLeave()) loadExtra().catch((e) => status(e.message, true));
    };
    weekly.onsubmit = (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(weekly)),
        week = data.week;
      delete data.week;
      data.agreedHours =
        data.agreedHours === "" ? null : Number(data.agreedHours);
      if (weekIdentity === selected + ":" + week && weekVersion)
        data.expectedVersion = weekVersion;
      save(employeePath() + "weekly-confirmations/" + week, data, loadWeek);
    };
    extra.onsubmit = (e) => {
      e.preventDefault();
      const value = extra.elements.month.value,
        data = {
          amount:
            extra.elements.amount.value === ""
              ? null
              : Number(extra.elements.amount.value),
        };
      if (extraIdentity === selected + ":" + value && extraVersion)
        data.expectedVersion = extraVersion;
      save(employeePath() + "payroll-extras/" + value, data, loadExtra);
    };
    (async () => {
      try {
        let cursor = null,
          employees = [];
        do {
          const r = await api(
            base +
              "employees" +
              (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
          );
          employees.push(...r.data);
          cursor = r.nextCursor;
        } while (cursor && valid());
        if (!valid()) return;
        const select = root.querySelector("#payroll-employee");
        select.innerHTML = employees
          .map((e) => `<option value="${e.id}">${escape(e.name)}</option>`)
          .join("");
        selected = employees[0]?.id ?? "";
        select.onchange = () => {
          if (saving || !canLeave()) {
            select.value = selected;
            return;
          }
          selected = select.value;
          settingsRead++;
          settings = [];
          root.querySelector("#settings-list").replaceChildren();
          weekVersion = extraVersion = null;
          weekIdentity = extraIdentity = "";
          retry = null;
          editing = null;
          form.reset();
          weekly.reset();
          extra.reset();
          dirty(false);
          loadSettings().catch((e) => status(e.message, true));
        };
        if (selected) await loadSettings();
      } catch (e) {
        if (valid()) status(e.message, true);
      }
    })();
  }
  refresh();
  return refresh;
}
