import { scorecards } from "./scorecards.js";
export function workScreen({
  root,
  cafe,
  staff,
  api,
  escape,
  status,
  valid,
  dirty,
  canLeave,
  onChange = () => {},
}) {
  let employees = [],
    selected = "",
    rows = [],
    cursor = null,
    editing = null,
    retry = null,
    saving = false,
    read = 0,
    registering = false,
    createdEmployee = null;
  const date = () =>
    new Date().toLocaleDateString("sv-SE", { timeZone: cafe.timezone });
  const base = `/api/v1/cafes/${cafe.id}/`,
    resource = staff ? "my/work-logs" : "work-logs";
  root.innerHTML = `${staff ? "" : `<section class="card"><div class="section-head"><h2>직원 관리</h2><button type="button" id="employee-new" class="secondary">신규 직원 추가</button></div><form id="employee-form"><label>이름<input name="name" maxlength="200" required></label><label>연결 계정<select name="linkedUserId"><option value="">계정 없이 관리</option></select></label><label>입사일<input name="hireDate" type="date"></label><label>퇴사일<input name="endDate" type="date"></label><fieldset id="employee-payroll" hidden disabled class="wide"><legend>시급 · 예상 근무 주기</legend><label>시급(원)<input name="hourlyRate" type="number" min="1" step="1" required></label><label>주 약정 근무시간<input name="weeklyHours" type="number" min="0" max="40" step="0.01" required></label><label>근무 주기 시작일<input name="firstWeek" type="date" required></label><label>주휴일<select name="holidayDay" required><option value="">선택하세요</option>${["일", "월", "화", "수", "목", "금", "토"].map(d => `<option>${d}</option>`).join("")}</select></label><label>통상 근로자 주 근무일수<input name="normalDays" type="number" min="0.01" max="7" step="0.01" value="5" required></label><p>시작일부터 매주 반복되는 약정 시간을 설정합니다. 주휴수당은 주별 개근·재직 확인 후 비용에 합산됩니다.</p></fieldset><button id="employee-create" hidden>직원 등록</button><button type="button" id="employee-edit" class="secondary">선택 직원 수정</button></form></section>`}<section class="card"><h2>근무 기록</h2>${staff ? "" : '<label>직원<select id="employee-select"></select></label>'}<form id="work-form"><label>근무일<input name="businessDate" type="date" required></label><label>시작<input name="startTime" type="time"></label><label>종료<input name="endTime" placeholder="18:00 또는 24:00" pattern="([01][0-9]|2[0-3]):[0-5][0-9]|24:00"></label><label>휴게(분)<input name="breakMinutes" type="number" min="0" max="1440" step="1" value="0" required></label><label class="wide">메모<input name="note" maxlength="2000"></label><div class="form-actions"><button>저장</button><button id="work-reset" type="button" class="secondary">입력 지우기</button></div></form></section><section class="card"><h2>근무 내역</h2><div class="filters"><label>시작일<input id="work-from" type="date"></label><label>종료일<input id="work-to" type="date"></label><label>정렬<select id="work-sort"><option value="newest">최근일</option><option value="oldest">최초일</option></select></label><button id="work-filter" class="secondary">조회</button></div><div id="work-scorecards" aria-live="polite"></div><div id="work-records"></div><button id="work-more" hidden class="secondary">더 보기</button></section>`;
  const form = root.querySelector("#work-form"),
    records = root.querySelector("#work-records");
  form.elements.businessDate.value = date();
  form.oninput = () => dirty(true);
  function reset() {
    form.reset();
    form.elements.businessDate.value = date();
    editing = null;
    retry = null;
    dirty(false);
  }
  root.querySelector("#work-reset").onclick = () => {
    if (canLeave()) reset();
  };
  async function all(path) {
    let cursor = null,
      result = [];
    do {
      const r = await api(
        path +
          (path.includes("?") ? "&" : "?") +
          "limit=100" +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      );
      result.push(...r.data);
      cursor = r.nextCursor;
    } while (cursor && valid());
    return result;
  }
  async function write(path, method, data) {
    const signature = JSON.stringify([path, method, data]);
    if (retry?.signature !== signature)
      retry = { signature, key: crypto.randomUUID() };
    return api(path, { method, data, key: retry.key });
  }
  async function loadEmployees() {
    employees = await all(base + "employees");
    if (!valid()) return;
    const select = root.querySelector("#employee-select");
    select.innerHTML =
      '<option value="">직원을 선택하세요</option>' +
      employees
        .map((e) => `<option value="${e.id}">${escape(e.name)}</option>`)
        .join("");
    if (!employees.some((e) => e.id === selected))
      selected = employees[0]?.id ?? "";
    select.value = selected;
    select.onchange = () => {
      if (!canLeave()) {
        select.value = selected;
        return;
      }
      selected = select.value;
      reset();
      fillEmployee();
      refresh();
    };
    if (!registering) fillEmployee();
  }
  function fillEmployee() {
    if (staff) return;
    const ef = root.querySelector("#employee-form"),
      e = employees.find((e) => e.id === selected);
    if (e)
      for (const k of ["name", "linkedUserId", "hireDate", "endDate"])
        ef.elements[k].value = e[k] ?? "";
  }
  async function refresh(append = false) {
    if (saving || !valid() || (!staff && !selected)) return;
    const ticket = ++read,
      q = new URLSearchParams({ limit: "50" });
    q.set("sort", root.querySelector("#work-sort").value);
    if (!staff) q.set("employeeId", selected);
    for (const k of ["from", "to"]) {
      const v = root.querySelector("#work-" + k).value;
      if (v) q.set(k, v);
    }
    if (append && cursor) q.set("cursor", cursor);
    try {
      const r = await api(base + resource + "?" + q);
      if (!valid() || ticket !== read) return;
      rows = append ? [...rows, ...r.data] : r.data;
      cursor = r.nextCursor;
      if (r.summary) scorecards(root.querySelector("#work-scorecards"),[
        {label:"근무 기록",value:r.summary.count,unit:"건"},
        {label:"근무한 날짜",value:r.summary.days,unit:"일"},
        {label:"총 실근로",value:`${Math.floor(r.summary.minutes/60)}시간 ${r.summary.minutes%60}분`},
        {label:"확인 필요",value:r.summary.incomplete,unit:"건",hint:"출퇴근·휴게 미입력 또는 시간 오류"},
      ]);
      draw();
      status("최신 근무 기록입니다.");
    } catch (e) {
      if (valid()) {
        root.querySelector("#work-scorecards")?.replaceChildren();
        if (
          [
            "FORBIDDEN",
            "NOT_FOUND",
            "UNAUTHENTICATED",
            "EMPLOYEE_NOT_LINKED",
          ].includes(e.code)
        )
          { records.replaceChildren(); root.querySelector("#work-scorecards").replaceChildren(); }
        status(e.message, true);
      }
    }
  }
  function draw() {
    records.innerHTML = rows.length
      ? `<div class="table-scroll"><table><thead><tr><th>날짜</th><th>시작</th><th>종료</th><th>휴게</th><th>메모</th><th>관리</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.businessDate}</td><td>${r.startTime || "미입력"}</td><td>${r.endTime || "미입력"}</td><td>${r.breakMinutes}분</td><td>${escape(r.note)}</td><td><button class="text-button" data-edit="${r.id}">수정</button><button class="text-button danger" data-delete="${r.id}">삭제</button></td></tr>`).join("")}</tbody></table></div>`
      : '<p class="empty">등록된 근무가 없습니다.</p>';
    root.querySelector("#work-more").hidden = !cursor;
    records.querySelectorAll("[data-edit]").forEach(
      (b) =>
        (b.onclick = () => {
          if (saving || !canLeave()) return;
          editing = rows.find((r) => r.id === b.dataset.edit);
          for (const k of [
            "businessDate",
            "startTime",
            "endTime",
            "breakMinutes",
            "note",
          ])
            form.elements[k].value = editing[k] ?? "";
          dirty(true);
        }),
    );
    records.querySelectorAll("[data-delete]").forEach(
      (b) =>
        (b.onclick = async () => {
          if (saving || !confirm("이 근무 기록을 삭제할까요?")) return;
          const r = rows.find((r) => r.id === b.dataset.delete);
          saving = true;
          let success = false;
          try {
            await write(base + resource + "/" + r.id, "DELETE", {
              expectedVersion: r.version,
            });
            retry = null;
            success = true;
          } catch (e) {
            if (valid()) status(e.message, true);
          } finally {
            saving = false;
            if (success && valid()) { refresh(); onChange(); }
          }
        }),
    );
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (saving || (!staff && !selected)) return;
    const data = Object.fromEntries(new FormData(form));
    data.breakMinutes = Number(data.breakMinutes);
    if (!staff) data.employeeId = selected;
    if (editing) data.expectedVersion = editing.version;
    saving = true;
    for (const el of form.elements) el.disabled = true;
    let success = false;
    try {
      await write(
        base + resource + (editing ? "/" + editing.id : ""),
        editing ? "PATCH" : "POST",
        data,
      );
      if (valid()) reset();
      success = true;
    } catch (e) {
      if (valid()) status(e.message, true);
    } finally {
      saving = false;
      for (const el of form.elements) el.disabled = false;
      if (success && valid()) { refresh(); onChange(); }
    }
  };
  if (!staff) {
    const ef = root.querySelector("#employee-form");
    for (const field of ef.elements) field.disabled = true;
    ef.oninput = () => dirty(true);
    const payrollFields = root.querySelector("#employee-payroll");
    root.querySelector("#employee-new").onclick = () => {
      if (saving || !canLeave()) return;
      registering = true;
      createdEmployee = null;
      ef.reset();
      ef.elements.hireDate.required = true;
      ef.elements.hireDate.value = date();
      ef.elements.firstWeek.value = date();
      payrollFields.hidden = payrollFields.disabled = false;
      root.querySelector("#employee-create").hidden = false;
      root.querySelector("#employee-edit").hidden = true;
      ef.elements.name.focus();
      dirty(true);
    };
    const saveEmployee = async (update) => {
      if (saving) return;
      if (!ef.reportValidity()) return;
      const values = Object.fromEntries(new FormData(ef));
      const data = Object.fromEntries(["name", "linkedUserId", "hireDate", "endDate"].map(k => [k, values[k]]));
      for (const k of ["linkedUserId", "hireDate", "endDate"]) data[k] ||= null;
      const e = employees.find((e) => e.id === selected);
      if (update && !e) return;
      if (update) data.expectedVersion = e.version;
      saving = true;
      try {
        const r = !update && createdEmployee ? createdEmployee : await write(
          base + "employees" + (update ? "/" + e.id : ""),
          update ? "PATCH" : "POST",
          data,
        );
        selected = r.data.id;
        if (!update) {
          createdEmployee = r;
          await write(base + "employees/" + selected + "/payroll-settings", "PATCH", {
            effectiveFrom: data.hireDate,
            effectiveTo: data.endDate,
            firstWeek: values.firstWeek,
            weeklyHours: Number(values.weeklyHours),
            holidayDay: values.holidayDay,
            normalDays: Number(values.normalDays),
            calculationStart: data.hireDate,
            calculationEnd: data.endDate || `${Number(data.hireDate.slice(0, 4)) + 1}-12-31`,
            rates: { [data.hireDate.slice(0, 4)]: Number(values.hourlyRate) },
          });
          createdEmployee = null;
          registering = false;
          payrollFields.hidden = payrollFields.disabled = true;
          ef.elements.hireDate.required = false;
          root.querySelector("#employee-create").hidden = true;
          root.querySelector("#employee-edit").hidden = false;
        }
        dirty(false);
        retry = null;
        if (valid()) {
          await loadEmployees();
          onChange();
          status("직원 정보를 저장했습니다.");
        }
      } catch (e) {
        if (valid()) status(e.message, true);
      } finally {
        saving = false;
      }
    };
    ef.onsubmit = (e) => {
      e.preventDefault();
      saveEmployee(false);
    };
    root.querySelector("#employee-edit").onclick = () => saveEmployee(true);
    (async () => {
      try {
        const members = await all(base + "members");
        if (!valid()) return;
        ef.elements.linkedUserId.innerHTML =
          '<option value="">계정 없이 관리</option>' +
          members
            .filter((m) => m.status === "active")
            .map(
              (m) =>
                `<option value="${escape(m.userId)}">${escape(m.name)} · ${escape(m.email)}</option>`,
            )
            .join("");
        await loadEmployees();
        for (const field of ef.elements) field.disabled = false;
        payrollFields.disabled = !registering;
        refresh();
      } catch (e) {
        if (valid()) status(e.message, true);
      }
    })();
  } else refresh();
  root.querySelector("#work-sort").onchange = () => refresh();
  root.querySelector("#work-filter").onclick = () => refresh();
  root.querySelector("#work-more").onclick = () => refresh(true);
  return refresh;
}
