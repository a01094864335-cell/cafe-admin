import { createImportPlan } from "../../shared/import-plan.js";
const names = {
  sales: "매출",
  purchases: "매입",
  expenses: "비용",
  other_incomes: "기타 수입",
  inventory_items: "재고 품목",
  inventory_movements: "재고 이동",
  employees: "직원",
  work_logs: "근무",
  payroll_settings: "급여 설정",
  payroll_rates: "연도별 시급",
  weekly_confirmations: "주휴 확인",
  payroll_extras: "기타 수당",
  sales_reconciliations: "매출 대조",
};
function expectedSummary(data) {
  const values = {
    sales: data.sales,
    purchases: data.purchases.filter((r) => r.group === "월별 구매"),
    expenses: data.purchases.filter((r) => r.group !== "월별 구매"),
    other_incomes: data.incomes,
    inventory_items: data.inventory,
    work_logs: data.payroll,
  };
  return Object.fromEntries(
    Object.entries(values).map(([key, rows]) => [
      key,
      {
        count: rows.length,
        ...(key === "work_logs"
          ? {}
          : {
              total: rows.reduce(
                (s, r) =>
                  s +
                  (key === "sales"
                    ? (r.card ?? 0) + (r.cash ?? 0) + (r.transfer ?? 0)
                    : key === "inventory_items"
                      ? Math.round(r.qty * 100)
                      : r.amount),
                0,
              ),
            }),
      },
    ]),
  );
}
export function transferScreen({
  root,
  cafe,
  api,
  escape,
  status,
  valid,
  dirty,
}) {
  if (cafe.role !== "owner") {
    root.innerHTML =
      '<div class="empty"><h2>소유자만 자료를 이전하고 백업할 수 있습니다.</h2></div>';
    return () => {};
  }
  const base = `/api/v1/cafes/${cafe.id}`,
    keys = new Map();
  let plan = null,
    expected = null,
    importJob = null,
    exportJob = null,
    busy = false,
    preparedFile = null,
    commitAllowed = false;
  root.innerHTML =
    '<section class="card"><h2>기존 장부 가져오기</h2><p>빈 카페에 v2 JSON 장부를 가져옵니다. 최대 20MiB이며, 마지막 확인 전까지 새 자료는 장부에 표시되지 않습니다.</p><label>백업 파일<input id="import-file" type="file" accept=".json,application/json"></label><div id="import-preview"></div><div class="form-actions"><button id="import-start" disabled>검증용 업로드</button><button id="import-commit" hidden>합계 확인 후 적용</button><button id="import-cancel" class="secondary" hidden>진행 중인 가져오기 취소</button></div><p id="import-progress" role="status"></p></section><section class="card"><h2>카페 자료 백업</h2><p>현재 카페의 직원별 장부를 JSON으로 내려받습니다. 백업 중에는 이 카페의 장부 저장이 잠시 제한됩니다. 창을 닫으면 최대 5분 후 제한이 해제됩니다.</p><p>공유 장부 v3 형식이며 기존 PC 장부의 v2 가져오기에는 사용할 수 없습니다. 계정 연결·로그인 정보는 포함하지 않습니다.</p><button id="export-start">JSON 백업 만들기</button><button id="export-cancel" class="secondary" hidden>진행 중인 백업 취소</button><div id="backup-download"></div></section>';
  const el = (id) => root.querySelector("#" + id);
  const report = (message, error = false) => {
    if (valid()) status(message, error);
  };
  const table = (summary) =>
    '<div class="table-scroll"><table><thead><tr><th>자료</th><th>건수</th><th>합계</th></tr></thead><tbody>' +
    Object.entries(summary)
      .map(
        ([key, v]) =>
          `<tr><td>${escape(names[key] ?? key)}</td><td>${escape(v.count)}</td><td>${v.total === undefined ? "—" : escape(Number(key === "inventory_items" ? v.total / 100 : v.total).toLocaleString("ko-KR")) + (key === "inventory_items" ? " (수량 합계)" : "원")}</td></tr>`,
      )
      .join("") +
    "</tbody></table>";
  const mutation = async (path, method = "POST", data = {}) => {
    const identity = method + path + JSON.stringify(data);
    if (!keys.has(identity)) keys.set(identity, crypto.randomUUID());
    const r = await api(path, { method, data, key: keys.get(identity) });
    keys.delete(identity);
    return r.data;
  };
  function buttons() {
    if (!valid()) return;
    el("import-start").disabled = busy || !plan;
    el("import-file").disabled = busy;
    el("import-commit").hidden = importJob?.state !== "ready";
    el("import-commit").disabled = busy || !commitAllowed;
    el("import-cancel").hidden =
      !importJob ||
      !["uploading", "validating", "ready", "failed"].includes(importJob.state);
    el("import-cancel").disabled = busy;
    el("export-start").disabled = busy;
    el("export-cancel").hidden = !exportJob;
    el("export-cancel").disabled = busy;
  }
  async function refresh() {
    if (busy || !valid()) return;
    try {
      const [i, e] = await Promise.all([
        api(base + "/imports"),
        api(base + "/exports"),
      ]);
      if (!valid()) return;
      importJob = i.data[0] ?? null;
      exportJob = e.data[0] ?? null;
      commitAllowed = !plan && importJob?.state === "ready";
      if (importJob) {
        el("import-progress").textContent =
          `진행 중인 작업: ${importJob.receivedChunks.length}/${importJob.expectedChunks} 묶음. 같은 파일을 선택해 이어서 진행하거나 취소할 수 있습니다.`;
        if (importJob.summary)
          el("import-preview").innerHTML = table(importJob.summary);
      }
      buttons();
    } catch (e) {
      report(e.message, true);
    }
  }
  el("import-file").onchange = async (event) => {
    const file = event.target.files?.[0];
    plan = null;
    expected = null;
    commitAllowed = false;
    dirty(!!file);
    buttons();
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024)
        throw Error("백업 파일은 20MiB 이하여야 합니다.");
      const data = JSON.parse(await file.text()),
        next = await createImportPlan(data, file.size);
      if (!valid() || event.target.files?.[0] !== file) return;
      expected = expectedSummary(data);
      if (
        Object.values(expected).some(
          (r) => r.total !== undefined && !Number.isSafeInteger(r.total),
        )
      )
        throw Error("합계가 안전하게 계산할 수 있는 금액 범위를 초과합니다.");
      plan = next;
      el("import-preview").innerHTML =
        `<h3>${escape(file.name)} · 업로드 전 미리보기</h3>` + table(expected);
      report("건수와 합계를 확인한 뒤 검증용 업로드를 눌러 주세요.");
    } catch (e) {
      plan = null;
      report(e.message, true);
    } finally {
      buttons();
    }
  };
  el("import-start").onclick = async () => {
    if (busy || !plan) return;
    busy = true;
    dirty(true);
    buttons();
    try {
      const created = await mutation(base + "/imports", "POST", {
        version: 2,
        manifest: plan.manifest,
      });
      if (!valid()) return;
      importJob = (await api(base + "/imports/" + created.id)).data;
      if (importJob.state === "committed") {
        dirty(false);
        report("이 파일은 이미 적용됐습니다. 중복으로 가져오지 않았습니다.");
        return;
      }
      const path = base + "/imports/" + created.id;
      for (const [i, chunk] of plan.chunks.entries()) {
        if (!valid()) return;
        if (!importJob.receivedChunks.includes(i))
          await mutation(path + "/chunks/" + i, "PUT", chunk);
        if (valid())
          el("import-progress").textContent =
            `자료 검증 중 ${i + 1}/${plan.chunks.length} 묶음`;
      }
      if (!valid()) return;
      await mutation(path + "/validate");
      if (!valid()) return;
      importJob = (await api(path)).data;
      if (!valid()) return;
      const matches = Object.entries(expected).every(([key, row]) =>
        Object.entries(row).every(
          ([field, value]) => importJob.summary[key]?.[field] === value,
        ),
      );
      commitAllowed = matches;
      if (!matches)
        throw Error(
          "원본과 서버의 건수·합계가 다릅니다. 적용하지 말고 작업을 취소해 주세요.",
        );
      el("import-preview").innerHTML =
        "<h3>서버 검증 결과 · 원본과 일치</h3>" + table(importJob.summary);
      el("import-progress").textContent =
        "아직 장부에 적용하지 않았습니다. 아래 합계를 확인하고 적용해 주세요.";
      report("업로드와 합계 검증이 완료됐습니다.");
    } catch (e) {
      report(
        e.message +
          " 같은 파일로 다시 시도하거나 가져오기를 취소할 수 있습니다.",
        true,
      );
    } finally {
      busy = false;
      buttons();
    }
  };
  el("import-commit").onclick = async () => {
    if (
      busy ||
      !commitAllowed ||
      !importJob ||
      !confirm(`${cafe.name}에 검증된 자료를 적용할까요?`)
    )
      return;
    busy = true;
    buttons();
    try {
      await mutation(base + "/imports/" + importJob.id + "/commit");
      if (!valid()) return;
      importJob = null;
      plan = null;
      dirty(false);
      el("import-progress").textContent =
        "적용 완료. 장부 메뉴에서 이전한 자료를 확인할 수 있습니다.";
      report("장부에 적용했습니다.");
    } catch (e) {
      report(e.message, true);
    } finally {
      busy = false;
      buttons();
    }
  };
  el("import-cancel").onclick = async () => {
    if (
      busy ||
      !importJob ||
      !confirm(
        "임시 업로드 자료를 지우고 가져오기를 취소할까요? 현재 장부는 유지됩니다.",
      )
    )
      return;
    busy = true;
    buttons();
    try {
      await mutation(base + "/imports/" + importJob.id + "/cancel");
      if (!valid()) return;
      importJob = null;
      keys.clear();
      dirty(false);
      el("import-progress").textContent = "가져오기를 취소했습니다.";
      report("임시 자료를 정리했습니다.");
    } catch (e) {
      report(e.message, true);
    } finally {
      busy = false;
      buttons();
    }
  };
  el("export-start").onclick = async () => {
    if (busy) return;
    busy = true;
    dirty(true);
    buttons();
    try {
      if (!exportJob) exportJob = await mutation(base + "/exports");
      if (!valid()) return;
      const path = base + "/exports/" + exportJob.id,
        info = (await api(path)).data;
      if (info.state !== "running")
        throw Error("백업 시간이 만료됐습니다. 다시 시작해 주세요.");
      const backup = {
        version: info.version,
        format: info.format,
        exportedAt: info.exportedAt,
        cafe: info.cafe,
        metadata: info.metadata,
        summary: info.summary,
        tables: {},
      };
      let bytes = new TextEncoder().encode(JSON.stringify(backup)).length;
      for (const name of info.tables) {
        if (!valid()) return;
        backup.tables[name] = [];
        let cursor = null;
        do {
          const page = await api(
            path +
              "/pages?table=" +
              name +
              (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
          );
          if (!valid()) return;
          bytes += new TextEncoder().encode(JSON.stringify(page.data)).length;
          if (bytes > 20 * 1024 * 1024)
            throw Error(
              "백업이 20MiB를 초과합니다. 관리자에게 별도 복구 백업을 요청해 주세요.",
            );
          backup.tables[name].push(...page.data);
          cursor = page.nextCursor;
        } while (cursor);
        report(`${names[name] ?? name} 백업 중`);
        await api(path); // Continue the lease only after successful progress.
      }
      const file = new Blob([JSON.stringify(backup)], {
        type: "application/json",
      });
      if (file.size > 20 * 1024 * 1024)
        throw Error("백업이 20MiB를 초과합니다.");
      await mutation(path + "/complete");
      if (!valid()) return;
      exportJob = null;
      dirty(false);
      if (preparedFile) URL.revokeObjectURL(preparedFile);
      preparedFile = URL.createObjectURL(file);
      el("backup-download").innerHTML =
        `<p>백업 준비 완료. 아래 링크를 눌러 파일을 보관하세요.</p><a id="download-backup" class="button">JSON 파일 내려받기</a>`;
      el("download-backup").href = preparedFile;
      el("download-backup").download =
        `cafe-backup-${new Date().toISOString().slice(0, 10)}.json`;
      report(
        "백업을 만들고 저장 제한을 해제했습니다. 파일 다운로드를 완료해 주세요.",
      );
    } catch (e) {
      report(e.message, true);
      if (exportJob) {
        try {
          await mutation(base + "/exports/" + exportJob.id + "/cancel");
          exportJob = null;
        } catch {}
      }
      if (valid()) dirty(false);
    } finally {
      busy = false;
      buttons();
    }
  };
  el("export-cancel").onclick = async () => {
    if (busy || !exportJob) return;
    busy = true;
    buttons();
    try {
      await mutation(base + "/exports/" + exportJob.id + "/cancel");
      exportJob = null;
      report("백업을 취소하고 저장 제한을 해제했습니다.");
    } catch (e) {
      report(e.message, true);
    } finally {
      busy = false;
      buttons();
    }
  };
  refresh();
  return refresh;
}
