import "./dashboard.css";
const number = (n) => Number(n).toLocaleString("ko-KR");
const won = (n) => number(n) + "원";
const day = (date) => Date.parse(date + "T12:00:00Z");

export function flowChart(daily) {
  if (!daily.length)
    return '<div class="chart-empty"><span>아직 흐름을 그릴 기록이 없어요.</span><small>선택한 기간의 매출과 비용을 기록해 주세요.</small></div>';
  let income = 0,
    cost = 0;
  const points = daily.map((r) => ({
    date: r.date,
    income: (income += r.income),
    cost: (cost += r.cost),
  }));
  const lo = Math.min(0, ...points.flatMap((p) => [p.income, p.cost]));
  const hi = Math.max(1, ...points.flatMap((p) => [p.income, p.cost]));
  const x = (i) =>
    66 +
    904 *
      (points.length === 1
        ? 0.5
        : (day(points[i].date) - day(points[0].date)) /
          (day(points.at(-1).date) - day(points[0].date)));
  const y = (v) => 205 - ((v - lo) / (hi - lo)) * 190;
  const line = (k) =>
    points
      .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(p[k]).toFixed(2)}`)
      .join(" ");
  const axisDates =
    points.length === 1
      ? [points[0].date]
      : [0, 1 / 3, 2 / 3, 1].map((t) =>
          new Date(
            day(points[0].date) +
              (day(points.at(-1).date) - day(points[0].date)) * t,
          )
            .toISOString()
            .slice(0, 10),
        );
  const labels = [...new Set(axisDates)].filter(
    (date, i, dates) =>
      i === dates.length - 1 ||
      i === 0 ||
      ((day(date) - day(dates[i - 1])) /
        (day(points.at(-1).date) - day(points[0].date))) *
        904 >=
        65,
  );
  return `<div class="flow-chart"><svg viewBox="0 0 1000 250" role="img" aria-label="기록일 기준 누적 수익 ${won(income)}, 누적 비용 ${won(cost)}"><defs><linearGradient id="cloud-flow-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#13a779" stop-opacity=".25"/><stop offset="100%" stop-color="#13a779" stop-opacity=".015"/></linearGradient></defs>${[
    0, 0.25, 0.5, 0.75, 1,
  ]
    .map((t) => {
      const v = lo + (hi - lo) * t;
      return `<line x1="66" x2="970" y1="${y(v)}" y2="${y(v)}" stroke="#eceef0" stroke-dasharray="3 5"/><text x="52" y="${y(v) + 4}" text-anchor="end" class="chart-text">${Math.abs(v) >= 10000 ? (v / 10000).toFixed(0) + "만" : number(Math.round(v))}</text>`;
    })
    .join(
      "",
    )}<path d="${line("income")} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#cloud-flow-fill)"/><path d="${line("cost")}" fill="none" stroke="#9aa4b2" stroke-width="2" stroke-dasharray="5 5"/><path d="${line("income")}" fill="none" stroke="#15966d" stroke-width="2.5" stroke-linejoin="round"/>${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.income)}" r="${points.length < 20 ? 4 : 2}" fill="#15966d" stroke="white" stroke-width="2"><title>${p.date} · 누적 수익 ${won(p.income)} · 누적 비용 ${won(p.cost)}</title></circle>`).join("")}${labels.map((date) => `<text x="${points.length === 1 ? x(0) : 66 + (904 * (day(date) - day(points[0].date))) / (day(points.at(-1).date) - day(points[0].date))}" y="237" text-anchor="middle" class="chart-text">${date.slice(5).replace("-", ".")}</text>`).join("")}</svg></div><div class="flow-caption"><span>기록일 기준 누적 · ${daily[0].date} — ${daily.at(-1).date}</span><span>미입력일 제외 · 월 기타수당은 월말 반영</span></div>`;
}

export function dashboardScreen({
  root,
  cafe,
  api,
  escape,
  status,
  valid,
  navigate,
  range,
  onRange,
}) {
  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: cafe.timezone,
  });
  const monthEnd = (date) => {
    const [y, m] = date.split("-").map(Number);
    return date.slice(0, 7) + "-" + new Date(Date.UTC(y, m, 0)).getUTCDate();
  };
  let read = 0,
    summary = null,
    tab = "all",
    ledgerSort = "newest";
  root.innerHTML = `<div class="cloud-dashboard"><div class="heading"><div><p class="eyebrow">OVERVIEW</p><h1>가게의 흐름을 한눈에</h1><p class="sub">매일 쌓이는 기록에서, 운영의 다음 한 걸음을 찾으세요.</p></div><button id="dashboard-record">기록</button></div><form id="dashboard-period" class="range-picker"><label>시작일<input id="summary-from" type="date" value="${escape(range?.from ?? today.slice(0, 7) + "-01")}" required></label><span>~</span><label>종료일<input id="summary-to" type="date" value="${escape(range?.to ?? monthEnd(today))}" required></label><button type="submit" class="secondary">기간 적용</button><button type="button" id="dashboard-month" class="ghost">이번 달</button><button type="button" id="dashboard-all" class="ghost">전체 기록</button><small>선택 기간 · 최대 1년</small></form><div id="dashboard-result" aria-live="polite"><div class="chart-empty">공유 장부의 최신 집계를 불러오는 중입니다.</div></div></div>`;
  const choices = [
    ["sales", "일별 매출", "카드 · 현금 · 계좌이체"],
    ["purchases", "매입", "원두 · 식재료 · 상품 구매"],
    ["expenses", "비용", "매장 운영비 · 소모품 · 비품"],
    ["work", "근무 · 급여", "출퇴근 · 휴게 · 시급 · 주휴"],
    ["inventory", "재료 · 재고", "새 재료 · 재고 수량"],
    ["other-incomes", "기타 수입", "매출 외 수입"],
  ];
  root.insertAdjacentHTML("beforeend", `<dialog id="dashboard-record-picker" class="cloud-record-picker" aria-labelledby="cloud-picker-title"><div class="picker-heading"><h2 id="cloud-picker-title">어떤 내용을 기록할까요?</h2><button type="button" class="secondary" id="picker-close" aria-label="창 닫기">✕</button></div><p>등록할 항목을 선택하면 입력 화면이 열립니다.</p><div class="picker-choices">${choices.map(([key, title, hint]) => `<button type="button" class="secondary" data-record="${key}"><b>${title}</b><span>${hint}</span></button>`).join("")}</div><button type="button" class="secondary" id="picker-cancel">닫기</button></dialog>`);
  const picker = root.querySelector("#dashboard-record-picker");
  root.querySelector("#dashboard-record").onclick = () => picker.showModal();
  for (const id of ["picker-close", "picker-cancel"]) root.querySelector("#" + id).onclick = () => picker.close();
  picker.onclick = event => { if (event.target === picker) { const r = picker.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) picker.close(); } };
  picker.querySelectorAll("[data-record]").forEach(button => { button.onclick = () => { picker.close(); navigate(button.dataset.record, { record: true }); }; });
  const el = (id) => root.querySelector("#" + id);
  const bindNavigation = () =>
    root
      .querySelectorAll("[data-open]")
      .forEach((b) => (b.onclick = () => navigate(b.dataset.open)));
  function ledger() {
    const labels = {
      sale: "매출",
      purchase: "매입",
      expense: "비용",
      income: "기타 수입",
      shift: "근무",
    };
    const rows = summary.recent
      .filter(
        (r) =>
          tab === "all" ||
          (tab === "purchase"
            ? ["purchase", "expense"].includes(r.type)
            : r.type === tab),
      )
      
      .slice(0, 8);
    el("dashboard-ledger").innerHTML = rows.length
      ? `<div class="table-scroll"><table><thead><tr><th>거래</th><th>날짜</th><th class="numeric">금액</th><th>관리</th></tr></thead><tbody>${rows.map((r) => `<tr><td><div class="transaction-cell"><span class="transaction-icon ${r.type}" aria-hidden="true">${r.type === "sale" ? "↗" : r.type === "shift" ? "◷" : "↙"}</span><div><b>${escape(r.item)}</b><small>${labels[r.type]}${r.vendor ? " · " + escape(r.vendor) : ""}</small>${r.note ? `<small>${escape(r.note)}</small>` : ""}</div></div></td><td>${escape(r.date)}</td><td class="numeric ${["sale", "income"].includes(r.type) ? "positive" : ""}">${r.amount === null ? "—" : won(["purchase", "expense", "shift"].includes(r.type) ? -r.amount : r.amount)}</td><td><button class="ghost" data-open="${{ sale: "sales", purchase: "purchases", expense: "expenses", income: "other-incomes", shift: "work" }[r.type]}">보기</button></td></tr>`).join("")}</tbody></table></div>`
      : '<div class="empty">선택한 기간에 기록이 없습니다.</div>';
    bindNavigation();
  }
  function render(r) {
    const stat = (label, n, note, featured = false) =>
      `<div class="stat ${featured ? "featured" : ""}"><div class="stat-label">${label}</div><div class="stat-value">${n === null ? "—" : number(n)}${n === null ? "" : "<small>원</small>"}</div><div class="stat-note">${note}</div></div>`;
    const days = Math.round((day(r.to) - day(r.from)) / 86400000) + 1;
    const totalMinutes = Math.round(r.hours * 60),
      hours = Math.floor(totalMinutes / 60),
      minutes = totalMinutes % 60;
    el("dashboard-result").innerHTML =
      `<div class="stats">${stat("기록한 매출", r.recorded ? r.revenue : null, r.recorded + "일 입력 · 미입력일 제외")}${stat("구매 · 기타 지출", r.purchases + r.expenses, "월별 구매 + 재료 외 지출")}${stat("세전 급여 집계", r.wages, r.pending ? "주휴·설정 미확정 · 입력분만 합산" : "기본급 + 주휴 + 월 기타수당")}${stat("간이 운영 잔액", r.profit, r.pending ? "급여 미확정 · 최종 이익 아님" : "재고 원가·세금 등 미반영", true)}</div><section class="panel overview-flow"><div class="panel-head"><div><span class="section-kicker">CASH FLOW</span><h2>수익과 비용의 흐름</h2><p class="sub">선택한 기간에 기록된 금액의 누적 흐름입니다.</p></div><div class="flow-totals"><div><span><i class="dot green"></i>수익</span><b>${won(r.income)}</b></div><div><span><i class="dot gray"></i>비용${r.pending ? " · 미확정" : ""}</span><b>${won(r.cost)}</b></div></div></div><div class="panel-body">${flowChart(r.daily)}</div></section><div class="insight-row"><div><span class="insight-icon" aria-hidden="true">↗</span><p><b>${r.recorded}일의 매출 기록</b><small>선택 ${days}일 · 빈 날짜는 미입력</small></p></div><div><span class="insight-icon" aria-hidden="true">◷</span><p><b>${hours}시간${minutes ? " " + minutes + "분" : ""} 근무</b><small>${r.pending ? "주휴·급여 확인이 필요해요" : "선택 기간의 실근로 시간"}</small></p><button class="ghost" data-open="payroll">확인 →</button></div><div><span class="insight-icon" aria-hidden="true">▤</span><p><b>${r.purchaseCount}건의 구매·지출</b><small>재료와 운영에 사용한 기록</small></p><button class="ghost" data-open="purchases">보기 →</button></div></div><div class="dashboard-bottom"><section class="panel ledger-panel"><div class="panel-head"><div><span class="section-kicker">TRANSACTIONS</span><h2>최근 거래 장부</h2></div><label>정렬<select id="dashboard-sort"><option value="newest">최근일</option><option value="oldest">최초일</option><option value="highest">최고액</option><option value="lowest">최소액</option></select></label><span class="sub">선택 기준 8건</span></div><div class="ledger-tabs">${[
        ["all", "전체"],
        ["sale", "매출"],
        ["purchase", "비용"],
        ["shift", "근무"],
      ]
        .map(
          ([key, label]) =>
            `<button data-tab="${key}" class="${key === tab ? "selected" : ""}" aria-pressed="${key === tab}">${label}</button>`,
        )
        .join(
          "",
        )}</div><div id="dashboard-ledger"></div></section><div class="dashboard-aside"><section class="panel"><div class="panel-head"><div><span class="section-kicker">BREAKDOWN</span><h2>비용 구성</h2></div></div><div class="panel-body">${[
        ["월별 구매", r.purchases],
        ["재료 외 지출", r.expenses],
        ["급여 집계", r.wages],
      ]
        .map(
          ([label, n]) =>
            `<div class="cost-row"><span>${label}</span><b>${won(n)}</b><div class="track"><span style="width:${r.cost > 0 ? Math.max(0, Math.min(100, (n / r.cost) * 100)) : 0}%"></span></div></div>`,
        )
        .join(
          "",
        )}<div class="total-line"><span>총 비용${r.pending ? " (미확정)" : ""}</span><b>${won(r.cost)}</b></div></div></section><section class="review-card"><span class="review-dot"></span><h3>마감 전 확인</h3><p>${r.pending ? "주휴·급여가 아직 확정되지 않았어요." : "선택한 기간의 매출과 비용을 확인해 주세요."}<br>운영 잔액은 입력분 기준입니다.</p><button class="secondary" data-open="${r.pending ? "payroll" : "sales"}">${r.pending ? "근무·급여 확인" : "매출 장부 확인"} ↗</button></section></div></div>`;
    root.querySelectorAll("[data-tab]").forEach(
      (b) =>
        (b.onclick = () => {
          tab = b.dataset.tab;
          root.querySelectorAll("[data-tab]").forEach((button) => {
            button.classList.toggle("selected", button.dataset.tab === tab);
            button.setAttribute(
              "aria-pressed",
              String(button.dataset.tab === tab),
            );
          });
          ledger();
        }),
    );
    ledger();
  }
  async function refresh() {
    const ticket = ++read,
      from = el("summary-from").value,
      to = el("summary-to").value;
    if (!from || !to || from > to || day(to) - day(from) > 366 * 86400000) {
      status(
        "시작일과 종료일을 확인해 주세요. 조회 기간은 최대 1년입니다.",
        true,
      );
      return;
    }
    // Clear old values immediately so a new period never labels stale totals.
    summary = null;
    el("dashboard-result").innerHTML =
      '<div class="chart-empty">공유 장부의 최신 집계를 불러오는 중입니다.</div>';
    try {
      const r = (
        await api(`/api/v1/cafes/${cafe.id}/dashboard?from=${from}&to=${to}&sort=${ledgerSort}`)
      ).data;
      if (!valid() || ticket !== read) return;
      summary = r;
      onRange({ from, to });
      render(r);
      el("dashboard-sort").value = ledgerSort;
      el("dashboard-sort").onchange = event => { ledgerSort = event.target.value; refresh(); };
      status("선택 기간의 최신 집계입니다.");
    } catch (e) {
      if (!valid() || ticket !== read) return;
      el("dashboard-result").innerHTML =
        '<div class="empty">집계를 불러오지 못했습니다. 새로고침을 눌러 다시 시도해 주세요.</div>';
      status(e.message, true);
    }
  }
  el("dashboard-period").onsubmit = (e) => {
    e.preventDefault();
    refresh();
  };
  el("dashboard-month").onclick = () => {
    el("summary-from").value = today.slice(0, 7) + "-01";
    el("summary-to").value = monthEnd(today);
    refresh();
  };
  el("dashboard-all").onclick = () => {
    if (!summary?.bounds.first) {
      status("아직 등록된 기록이 없습니다.");
      return;
    }
    const { first, last } = summary.bounds;
    if (day(last) - day(first) > 366 * 86400000) {
      status(
        "전체 기록이 1년을 초과합니다. 시작일과 종료일로 조회 기간을 선택해 주세요.",
        true,
      );
      return;
    }
    el("summary-from").value = first;
    el("summary-to").value = last;
    refresh();
  };
  bindNavigation();
  refresh();
  return refresh;
}
