export function inventoryScreen({
  root,
  cafe,
  api,
  escape,
  status,
  valid,
  dirty,
  canLeave,
}) {
  let items = [],
    cursor = null,
    editing = null,
    retry = null,
    saving = false,
    read = 0;
  root.innerHTML = `<section class="card"><h2 id="inventory-title">재고 품목 등록</h2><form id="inventory-form"><label>품목명<input name="name" required maxlength="200"></label><label>단위<input name="unit" required maxlength="40" placeholder="kg, 개, L"></label><label>초기 수량<input name="quantity" type="number" step="0.01" value="0" required></label><label>최소 수량<input name="minimum" type="number" step="0.01" value="0" required></label><label>단가(원)<input name="cost" type="number" step="1"></label><label>공급처<input name="supplier" maxlength="200"></label><div class="form-actions"><button>저장</button><button type="button" id="inventory-reset" class="secondary">입력 지우기</button></div></form></section><section class="card"><h2>재고 현황</h2><p>수량 변경은 이동 이력으로 보존됩니다.</p><div id="inventory-records"></div><button id="inventory-more" class="secondary" hidden>더 보기</button></section>`;
  const form = root.querySelector("form"),
    records = root.querySelector("#inventory-records");
  function reset() {
    editing = null;
    retry = null;
    form.reset();
    form.elements.quantity.disabled = false;
    root.querySelector("#inventory-title").textContent = "재고 품목 등록";
    dirty(false);
  }
  form.oninput = () => dirty(true);
  root.querySelector("#inventory-reset").onclick = () => {
    if (canLeave()) reset();
  };
  async function write(path, method, data) {
    const signature = JSON.stringify([path, method, data]);
    if (retry?.signature !== signature)
      retry = { signature, key: crypto.randomUUID() };
    return api(path, { method, data, key: retry.key });
  }
  async function refresh(append = false) {
    if (saving) return;
    const ticket = ++read;
    try {
      const r = await api(
        `/api/v1/cafes/${cafe}/inventory/items?limit=50${append && cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      if (!valid() || ticket !== read) return;
      items = append ? [...items, ...r.data] : r.data;
      cursor = r.nextCursor;
      draw();
      status("서버의 최신 재고입니다.");
    } catch (e) {
      if (valid()) {
        if (["FORBIDDEN", "NOT_FOUND", "UNAUTHENTICATED"].includes(e.code))
          records.replaceChildren();
        status(e.message, true);
      }
    }
  }
  function draw() {
    records.innerHTML = items.length
      ? `<div class="table-scroll"><table><thead><tr><th>품목</th><th>수량</th><th>최소 수량</th><th>단가</th><th>공급처</th><th>관리</th></tr></thead><tbody>${items.map((r) => `<tr><td>${escape(r.name)}</td><td>${r.quantityHundredths / 100} ${escape(r.unit)}</td><td>${r.minimumHundredths / 100}</td><td>${r.cost === null ? "미입력" : r.cost.toLocaleString("ko-KR")}</td><td>${escape(r.supplier)}</td><td><button class="text-button" data-edit="${r.id}">수정</button><button class="text-button" data-adjust="${r.id}">수량 조정</button><button class="text-button" data-history="${r.id}">이력</button><button class="text-button danger" data-delete="${r.id}">삭제</button></td></tr>`).join("")}</tbody></table></div>`
      : '<p class="empty">등록된 품목이 없습니다.</p>';
    root.querySelector("#inventory-more").hidden = !cursor;
    records.querySelectorAll("[data-edit]").forEach(
      (b) =>
        (b.onclick = () => {
          if (saving || !canLeave()) return;
          editing = items.find((r) => r.id === b.dataset.edit);
          for (const k of ["name", "unit", "cost", "supplier"])
            form.elements[k].value = editing[k] ?? "";
          form.elements.quantity.value = editing.quantityHundredths / 100;
          form.elements.quantity.disabled = true;
          form.elements.minimum.value = editing.minimumHundredths / 100;
          root.querySelector("#inventory-title").textContent = "품목 수정";
          dirty(true);
        }),
    );
    records
      .querySelectorAll("[data-adjust],[data-delete],[data-history]")
      .forEach(
        (b) =>
          (b.onclick = async () => {
            if (saving) return;
            const action = b.dataset.adjust
                ? "adjust"
                : b.dataset.delete
                  ? "delete"
                  : "history",
              item = items.find((r) => r.id === b.dataset[action]);
            let data,
              path,
              method = "POST";
            if (action === "history") {
              try {
                let next = null,
                  lines = [];
                do {
                  const r = await api(
                    `/api/v1/cafes/${cafe}/inventory/movements?itemId=${item.id}${next ? "&cursor=" + encodeURIComponent(next) : ""}`,
                  );
                  lines.push(...r.data);
                  next = r.nextCursor;
                } while (next && valid());
                if (valid())
                  alert(
                    lines
                      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                      .map(
                        (r) =>
                          `${r.createdAt} · ${r.deltaHundredths / 100} ${item.unit} · ${r.kind} ${r.note}`,
                      )
                      .join("\n") || "이력이 없습니다.",
                  );
              } catch (e) {
                if (valid()) status(e.message, true);
              }
              return;
            }
            if (action === "adjust") {
              const raw = prompt(
                "증가/감소 수량을 입력하세요. 예: 2.5 또는 -1",
              );
              if (raw === null) return;
              const amount = Number(raw),
                delta = Math.round(amount * 100);
              if (
                !Number.isFinite(amount) ||
                Math.abs(amount * 100 - delta) > 1e-7 ||
                !delta
              ) {
                status(
                  "0이 아닌 소수 둘째 자리까지의 수량을 입력해 주세요.",
                  true,
                );
                return;
              }
              const note = prompt("조정 사유를 입력하세요.");
              if (note === null) return;
              data = {
                itemId: item.id,
                expectedVersion: item.version,
                deltaHundredths: delta,
                note,
              };
              path = `/api/v1/cafes/${cafe}/inventory/movements`;
            } else {
              if (
                !confirm("이 품목을 삭제할까요? 이전 이동 기록은 보존됩니다.")
              )
                return;
              data = { expectedVersion: item.version };
              path = `/api/v1/cafes/${cafe}/inventory/items/${item.id}`;
              method = "DELETE";
            }
            saving = true;
            try {
              await write(path, method, data);
              retry = null;
              status("저장했습니다.");
            } catch (e) {
              if (valid()) status(e.message, true);
            } finally {
              saving = false;
              if (valid()) await refresh();
            }
          }),
      );
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (saving) return;
    const data = Object.fromEntries(new FormData(form));
    const q = (v) => {
      const n = Number(v),
        r = Math.round(n * 100);
      if (!Number.isSafeInteger(r) || Math.abs(n * 100 - r) > 1e-7)
        throw new Error("수량은 소수 둘째 자리까지 입력해 주세요.");
      return r;
    };
    try {
      data.minimumHundredths = q(data.minimum);
      delete data.minimum;
      if (!editing) data.quantityHundredths = q(data.quantity);
      delete data.quantity;
      data.cost = data.cost === "" ? null : Number(data.cost);
      if (editing) data.expectedVersion = editing.version;
    } catch (e) {
      status(e.message, true);
      return;
    }
    saving = true;
    const wasEditing = !!editing;
    for (const el of form.elements) el.disabled = true;
    try {
      await write(
        `/api/v1/cafes/${cafe}/inventory/items${editing ? "/" + editing.id : ""}`,
        editing ? "PATCH" : "POST",
        data,
      );
      if (valid()) reset();
    } catch (e) {
      if (valid()) status(e.message, true);
    } finally {
      saving = false;
      for (const el of form.elements) el.disabled = false;
      form.elements.quantity.disabled = !!editing && wasEditing;
      if (valid()) await refresh();
    }
  };
  root.querySelector("#inventory-more").onclick = () => refresh(true);
  refresh();
  return refresh;
}
