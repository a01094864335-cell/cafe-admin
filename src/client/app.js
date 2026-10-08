import "./styles.css";
import { seed } from "../shared/seed.js";
import { validate } from "../shared/validate.js";
import {
  sum,
  ds,
  day,
  add,
  weekdays,
  weekday,
  monthDays,
  validDate,
  validMonth,
} from "../shared/calculations/dates.js";
import { createCalculations } from "../shared/calculations/ledger.js";
import { createLocalRepository } from "./data/local-repository.ts";
const pages = [
  ["dashboard", "◫", "대시보드"],
  ["sales", "↗", "일별 매출"],
  ["expenses", "↙", "구매 · 비용"],
  ["payroll", "◷", "근무 · 급여"],
  ["inventory", "▤", "재료 · 재고"],
  ["reports", "▥", "손익 리포트"],
  ["settings", "⚙", "설정 · 백업"],
];
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmt = (v) => Math.round(v).toLocaleString("ko-KR"),
  won = (v) => (v === null || v === undefined ? "—" : fmt(v) + "원");
const uid = () =>
  globalThis.crypto?.randomUUID?.() ||
  "id-" + Date.now() + "-" + Math.random().toString(36).slice(2);
const duration = (h) => {
  const n = Math.round(h * 60);
  return Math.floor(n / 60) + "시간" + (n % 60 ? " " + (n % 60) + "분" : "");
};
const repository = createLocalRepository(() => window.localStorage);
const loaded = repository.load();
let db = loaded.data,
  storageOk = loaded.ok,
  loadWarning = loaded.warning;
const nowLocal = new Date(),
  initialMonth =
    nowLocal.getFullYear() +
    "-" +
    String(nowLocal.getMonth() + 1).padStart(2, "0");
let page = "dashboard",
  month = initialMonth,
  rangeStart = initialMonth + "-01",
  rangeEnd = initialMonth + "-" + monthDays(initialMonth),
  dayPage = 0,
  ledgerTab = "all",
  search = "",
  filter = "전체",
  payTab = "daily",
  salesTab = "daily",
  editing = null,
  toastTimer;
function setTheme(theme, persist = false) {
  document.documentElement.setAttribute("data-theme", theme);
  const dark = theme === "dark",
    button = document.getElementById("themeToggle");
  button.innerHTML =
    (dark
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.5A9 9 0 0 1 8.5 4 9 9 0 1 0 20 15.5Z"/></svg>') +
    "<span>" +
    (dark ? "라이트 모드" : "다크 모드") +
    "</span>";
  button.setAttribute(
    "aria-label",
    dark ? "라이트 모드로 전환" : "다크 모드로 전환",
  );
  button.setAttribute(
    "title",
    dark ? "라이트 모드로 전환" : "다크 모드로 전환",
  );
  if (persist) {
    try {
      repository.saveTheme(theme);
    } catch (e) {
      notify("테마를 적용했지만 저장하지 못했어요.");
    }
  }
}
function initTheme() {
  let theme = "light";
  try {
    theme = repository.loadTheme();
  } catch (e) {}
  setTheme(theme);
}
function notify(s) {
  document.getElementById("toast").textContent = s;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => (document.getElementById("toast").textContent = ""),
    4500,
  );
}
function commit(next) {
  try {
    repository.save(next);
    db = next;
    storageOk = true;
    loadWarning = "";
    return true;
  } catch (e) {
    notify("저장 실패: " + e.message);
    return false;
  }
}
const bounds = (...args) =>
  createCalculations(db, rangeStart, rangeEnd).bounds(...args);
const within = (...args) =>
  createCalculations(db, rangeStart, rangeEnd).within(...args);
const selected = (...args) =>
  createCalculations(db, rangeStart, rangeEnd).selected(...args);
const extraTotal = (...args) =>
  createCalculations(db, rangeStart, rangeEnd).extraTotal(...args);
const hasSale = (...args) =>
  createCalculations(db, rangeStart, rangeEnd).hasSale(...args);
const saleTotal = (...args) =>
  createCalculations(db, rangeStart, rangeEnd).saleTotal(...args);
const minutes = (...args) =>
  createCalculations(db, rangeStart, rangeEnd).minutes(...args);
const shift = (...args) =>
  createCalculations(db, rangeStart, rangeEnd).shift(...args);
const employmentReady = (...args) =>
  createCalculations(db, rangeStart, rangeEnd).employmentReady(...args);
const weeks = (...args) =>
  createCalculations(db, rangeStart, rangeEnd).weeks(...args);
const payrollTotals = (...args) =>
  createCalculations(db, rangeStart, rangeEnd).payrollTotals(...args);
const metrics = (...args) =>
  createCalculations(db, rangeStart, rangeEnd).metrics(...args);
function dayCount() {
  return Math.round((day(rangeEnd) - day(rangeStart)) / 86400000) + 1;
}
function visibleDates() {
  return Array.from(
    { length: Math.min(62, dayCount() - dayPage * 62) },
    (_, i) => add(rangeStart, dayPage * 62 + i),
  );
}
function datePager() {
  return dayCount() > 62
    ? `<div class="table-foot"><span>전체 ${dayCount()}일 · ${dayPage * 62 + 1}–${Math.min(dayCount(), (dayPage + 1) * 62)}일 표시 · 합계는 전체 기간 기준</span><div class="row"><button data-action="date-prev" ${dayPage === 0 ? "disabled" : ""}>이전</button><button data-action="date-next" ${(dayPage + 1) * 62 >= dayCount() ? "disabled" : ""}>다음</button></div></div>`
    : "";
}
function applyRange(start, end) {
  rangeStart = start;
  rangeEnd = end;
  month = start.slice(0, 7);
  dayPage = 0;
  render();
}
function rangeMonths() {
  const list = [];
  for (let m = rangeStart.slice(0, 7); m <= rangeEnd.slice(0, 7);) {
    list.push(m);
    m = add(m + "-" + monthDays(m), 1).slice(0, 7);
  }
  return list;
}
const monthLabel = () => rangeStart + " ~ " + rangeEnd;
function stat(label, n, note, featured = false, unit = "원") {
  return `<div class="stat ${featured ? "featured" : ""}"><div class="stat-label">${label}</div><div class="stat-value">${n === null ? "—" : unit === "시간" ? Number(n.toFixed(2)) : fmt(n)}<small>${n === null ? "" : unit}</small></div><div class="stat-note">${note}</div></div>`;
}
function commonStats() {
  const m = metrics();
  return `<div class="stats">${stat("기록한 매출", m.recorded ? m.revenue : null, m.recorded + "일 입력 · 미입력일 제외")}${stat("구매 · 기타 지출", m.purchases + m.misc, "월별 구매 + 재료 외 지출")}${stat("세전 급여 집계", m.wages, m.pending ? "주휴·설정 미확정 · 입력분만 합산" : "기본급 + 주휴 + 월 기타수당")}${stat("간이 운영 잔액", m.profit, m.pending ? "급여 미확정 · 최종 이익 아님" : "재고 원가·세금 등 미반영", true)}</div>`;
}
function titleHTML(title, sub, buttons = "", period = true) {
  return `<div class="heading"><div><p class="eyebrow">${{ dashboard: "OVERVIEW", sales: "SALES LEDGER", expenses: "PURCHASES & EXPENSES", payroll: "TEAM & PAYROLL", inventory: "INVENTORY", reports: "PERFORMANCE", settings: "WORKSPACE" }[page]}</p><h1>${title}</h1><p class="sub">${sub}</p></div><div class="row">${buttons}</div></div>${period ? `<form id="periodForm" class="range-picker"><label>시작일<input type="date" name="rangeStart" aria-label="조회 시작일" value="${rangeStart}" required min="2020-01-01" max="2099-12-31"></label><span>~</span><label>종료일<input type="date" name="rangeEnd" aria-label="조회 종료일" value="${rangeEnd}" required min="2020-01-01" max="2099-12-31"></label><button class="primary" type="submit">기간 적용</button><button type="button" data-action="this-month">이번 달</button><button type="button" data-action="all-dates">전체 기록</button><small>선택 기간 · 모든 화면에 적용</small><p id="periodError" class="error" role="alert"></p></form>` : ""}`;
}

function banner() {
  return `${loadWarning ? `<div class="info warning" role="alert">${esc(loadWarning)}</div>` : ""}<details class="source-details"><summary>로컬 저장 안내</summary><div>기록은 이 브라우저에 저장됩니다. 다른 PC로 옮기기 전 설정에서 JSON 백업을 내려받으세요. 자동 동기화는 제공하지 않습니다.</div></details>`;
}
function sourceTag(r) {
  return r.source
    ? `<small class="source-tag" title="${esc(r.source.file + " · " + r.source.sheet + " · " + r.source.row + "행")}">시트 ${esc(r.source.row)}행${r.modified ? " · 수정됨" : ""}</small>`
    : "";
}
function chart() {
  const pay = payrollTotals(),
    events = new Map();
  const put = (date, a, b) => {
    const r = events.get(date) || { a: 0, b: 0 };
    r.a += a || 0;
    r.b += b || 0;
    events.set(date, r);
  };
  selected("sales")
    .filter(hasSale)
    .forEach((r) => put(r.date, saleTotal(r), 0));
  selected("incomes").forEach((r) => put(r.date, r.amount, 0));
  selected("purchases").forEach((r) => put(r.date, 0, r.amount));
  selected("payroll").forEach((r) => put(r.date, 0, shift(r).base));
  pay.weekly
    .filter((r) => r.amount !== null && r.amount !== 0)
    .forEach((r) => put(r.holiday, 0, r.amount));
  Object.entries(db.monthlyExtras).forEach(([m, n]) => {
    const date = m + "-" + monthDays(m);
    if (n !== null && within(date)) put(date, 0, n);
  });
  const dates = [...events.keys()].sort();
  if (!dates.length)
    return '<div class="chart-empty"><span>아직 흐름을 그릴 기록이 없어요.</span><small>선택한 기간의 매출과 비용을 기록해 주세요.</small></div>';
  let a = 0,
    b = 0;
  const points = dates.map((date) => {
    const v = events.get(date);
    a += v.a;
    b += v.b;
    return { date, a, b };
  });
  const lo = Math.min(0, ...points.flatMap((p) => [p.a, p.b])),
    hi = Math.max(1, ...points.flatMap((p) => [p.a, p.b])),
    spread = hi - lo,
    W = 1000,
    H = 250,
    left = 66,
    right = 970,
    top = 15,
    bottom = 205;
  const x = (i) =>
      left +
      (right - left) *
        (points.length === 1
          ? 0.5
          : (day(points[i].date) - day(points[0].date)) /
            (day(points.at(-1).date) - day(points[0].date))),
    y = (v) => bottom - ((v - lo) / spread) * (bottom - top);
  const line = (k) =>
    points
      .map(
        (p, i) => (i ? "L" : "M") + x(i).toFixed(2) + "," + y(p[k]).toFixed(2),
      )
      .join(" ");
  const path = (k) =>
    line(k) + ` L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const labels = new Set([
    0,
    Math.floor((points.length - 1) / 3),
    Math.floor(((points.length - 1) * 2) / 3),
    points.length - 1,
  ]);
  return `<div class="flow-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="기록일 기준 누적 수익 ${won(a)}, 누적 비용 ${won(b)}"><defs><linearGradient id="flowFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#13a779" stop-opacity=".25"/><stop offset="100%" stop-color="#13a779" stop-opacity=".015"/></linearGradient></defs>${[
    0, 0.25, 0.5, 0.75, 1,
  ]
    .map((t) => {
      const v = lo + spread * t;
      return `<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="#eceef0" stroke-dasharray="3 5"/><text x="${left - 14}" y="${y(v) + 4}" text-anchor="end" class="chart-text">${Math.abs(v) >= 10000 ? (v / 10000).toFixed(0) + "만" : fmt(v)}</text>`;
    })
    .join(
      "",
    )}<path d="${path("a")}" fill="url(#flowFill)"/><path d="${line("b")}" fill="none" stroke="#9aa4b2" stroke-width="2" stroke-dasharray="5 5"/><path d="${line("a")}" fill="none" stroke="#15966d" stroke-width="2.5" stroke-linejoin="round"/>${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.a)}" r="${points.length < 20 ? 4 : 2}" fill="#15966d" stroke="white" stroke-width="2"><title>${p.date} · 누적 수익 ${won(p.a)} · 누적 비용 ${won(p.b)}</title></circle>`).join("")}${[...labels].map((i) => `<text x="${x(i)}" y="237" text-anchor="middle" class="chart-text">${points[i].date.slice(5).replace("-", ".")}</text>`).join("")}</svg></div><div class="flow-caption"><span>기록일 기준 누적 · ${dates[0]} — ${dates.at(-1)}</span><span>미입력일 제외 · 월 기타수당은 월말 반영</span></div>`;
}

function costBreakdown() {
  const m = metrics();
  return (
    [
      ["월별 구매", m.purchases],
      ["재료 외 지출", m.misc],
      ["급여 집계", m.wages],
    ]
      .map(
        ([label, n]) =>
          `<div class="cost-row"><span>${label}</span><b>${won(n)}</b><div class="track"><span style="width:${m.cost > 0 ? Math.max(0, Math.min(100, (n / m.cost) * 100)) : 0}%"></span></div></div>`,
      )
      .join("") +
    `<div class="total-line"><span>총 비용${m.pending ? " (미확정)" : ""}</span><b>${won(m.cost)}</b></div>`
  );
}
function dashboard() {
  const m = metrics(),
    p = payrollTotals();
  return (
    titleHTML(
      "가게의 흐름을 한눈에",
      "매일 쌓이는 기록에서, 운영의 다음 한 걸음을 찾으세요.",
      '<button class="primary" data-action="record">기록</button>',
    ) +
    commonStats() +
    `<section class="panel overview-flow"><div class="panel-head"><div><span class="section-kicker">CASH FLOW</span><h2>수익과 비용의 흐름</h2><p class="sub">선택한 기간에 기록된 금액의 누적 흐름입니다.</p></div><div class="flow-totals"><div><span><i class="dot green"></i>수익</span><b>${won(m.income)}</b></div><div><span><i class="dot gray"></i>비용${m.pending ? " · 미확정" : ""}</span><b>${won(m.cost)}</b></div></div></div><div class="panel-body">${chart()}</div></section><div class="insight-row"><div><span class="insight-icon">↗</span><p><b>${m.recorded}일의 매출 기록</b><small>선택 ${dayCount()}일 · 빈 날짜는 미입력</small></p></div><div><span class="insight-icon">◷</span><p><b>${duration(p.hours)} 근무</b><small>${p.pending ? "주휴·급여 확인이 필요해요" : "선택 기간의 실근로 시간"}</small></p><button class="ghost small" data-page="payroll">확인 →</button></div><div><span class="insight-icon">▤</span><p><b>${selected("purchases").length}건의 구매·지출</b><small>재료와 운영에 사용한 기록</small></p><button class="ghost small" data-page="expenses">보기 →</button></div></div><div class="dashboard-bottom"><section class="panel ledger-panel"><div class="panel-head"><div><span class="section-kicker">TRANSACTIONS</span><h2>최근 거래 장부</h2></div><span class="sub">최근 8건</span></div><div class="ledger-tabs">${[
      ["all", "전체"],
      ["sale", "매출"],
      ["purchase", "비용"],
      ["shift", "근무"],
    ]
      .map(
        ([key, label]) =>
          `<button data-action="ledger-tab" data-tab="${key}" class="${ledgerTab === key ? "selected" : ""}" aria-pressed="${ledgerTab === key}">${label}</button>`,
      )
      .join(
        "",
      )}</div>${ledgerTable()}</section><aside class="dashboard-aside"><section class="panel"><div class="panel-head"><div><span class="section-kicker">BREAKDOWN</span><h2>비용 구성</h2></div></div><div class="panel-body">${costBreakdown()}</div></section><section class="review-card"><span class="review-dot"></span><h3>마감 전 확인</h3><p>${p.pending ? "주휴·급여가 아직 확정되지 않았어요." : "월 매출 대조를 확인해 주세요."}<br>운영 잔액은 입력분 기준입니다.</p><button data-page="${p.pending ? "payroll" : "sales"}">${p.pending ? "근무·급여 확인" : "매출 장부 확인"} <span>↗</span></button><button class="ghost small" data-action="compare">${month} 월 매출 대조 →</button></section></aside></div>` +
    banner()
  );
}
function ledgerTable() {
  const rows = [
    ...selected("sales").map((r) => ({
      ...r,
      type: "sale",
      label: "매출",
      info: "일별 매출",
      amount: saleTotal(r),
    })),
    ...selected("purchases").map((r) => ({
      ...r,
      type: "purchase",
      label: "비용",
      info: r.item,
      amount: -r.amount,
    })),
    ...selected("payroll").map((r) => ({
      ...r,
      type: "shift",
      label: "근무",
      info: (r.start || "—") + " – " + (r.end || "—"),
      amount: shift(r).base === null ? null : -shift(r).base,
    })),
  ]
    .filter((r) => ledgerTab === "all" || r.type === ledgerTab)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8);
  return table(
    ["내역", "날짜", "금액", "관리"],
    rows.map(
      (r) =>
        `<tr><td><div class="transaction-cell"><span class="transaction-icon ${r.type}">${r.type === "sale" ? "↗" : r.type === "purchase" ? "↙" : "◷"}</span><div><b>${esc(r.info)}</b><small>${r.label}${r.vendor ? " · " + esc(r.vendor) : ""}${r.type === "shift" ? " · 기본급" : ""}</small></div></div></td><td class="muted">${r.date.slice(5).replace("-", ".")}</td><td class="num ${r.type === "sale" ? "positive" : ""}"><b>${won(r.amount)}</b></td><td><button class="ghost small" data-action="edit" data-type="${r.type}" data-id="${esc(r.id)}">수정</button></td></tr>`,
    ),
    4,
    "<span>선택 기간 내 매출 · 비용 · 근무 기본급</span><span>주휴·기타수당은 급여에서 확인</span>",
  );
}

function table(headers, rows, cols, foot = "") {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((x, i) => `<th ${i === headers.length - 1 ? 'class="num"' : ""}>${x}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${cols}" class="empty">입력한 기록이 없습니다.</td></tr>`}</tbody></table></div>${foot ? `<div class="table-foot">${foot}</div>` : ""}`;
}
function actions(type, r) {
  return `<div class="row" style="justify-content:flex-end;gap:4px"><button class="small" data-action="edit" data-type="${type}" data-id="${esc(r.id)}">수정</button><button class="ghost small danger" data-action="delete" data-type="${type}" data-id="${esc(r.id)}">삭제</button></div>`;
}
function tabs(items, current, kind) {
  return `<div class="view-tabs" aria-label="보기 선택">${items.map(([id, label]) => `<button class="${current === id ? "primary" : ""}" data-action="tab" data-kind="${kind}" data-tab="${id}" aria-pressed="${current === id}">${label}</button>`).join("")}</div>`;
}
function sales() {
  const rows = selected("sales"),
    m = metrics();
  return (
    titleHTML(
      "일별 매출",
      "날짜별 카드·현금·계좌이체를 한 번에 기록하세요.",
      '<button data-action="add" data-type="income">기타수익</button><button class="primary" data-action="add" data-type="sale">매출 기록</button>',
    ) +
    `<div class="stats">${stat("내가 기록한 매출", m.recorded ? m.revenue : null, m.recorded + "일 입력")}${stat("카드", sum(rows, "card"), "수수료 차감 전")}${stat("현금", sum(rows, "cash"), "계좌이체 포함분 제외")}${stat("계좌이체", sum(rows, "transfer"), "현금과 중복 기록하지 않기", true)}</div>` +
    tabs(
      [
        ["daily", "일별 기록"],
        ["compare", "월별 대조"],
      ],
      salesTab,
      "sales",
    ) +
    `<div class="info">금액 칸이 모두 비어 있으면 미입력입니다. 휴무·매출 0원인 날은 0을 입력하세요. POS 현금에 포함된 이체는 현금에서 빼고 계좌이체에 한 번만 기록합니다.</div>${
      salesTab === "daily"
        ? `<section class="panel"><div class="toolbar"><h2>${monthLabel()} 일별 기록</h2><button class="small" data-action="csv" data-type="sales">CSV 내보내기</button></div>${salesTable()}${datePager()}</section><section class="panel" style="margin-top:22px"><div class="panel-head"><h2>기타수익</h2><span class="sub">원본 매출과 별도 집계</span></div>${table(
            ["날짜", "내용", "금액", "관리"],
            selected("incomes").map(
              (r) =>
                `<tr><td>${r.date}</td><td>${esc(r.item)}</td><td class="num">${won(r.amount)}</td><td>${actions("income", r)}</td></tr>`,
            ),
            4,
          )}</section>`
        : comparisonTable()
    }`
  );
}
function salesTable() {
  const rows = visibleDates().map((date) => {
    const r = db.sales.find((r) => r.date === date);
    return `<tr class="${r ? "" : "unrecorded"}"><td>${date} <small class="muted">${weekday(date)}</small></td>${["card", "cash", "transfer"].map((k) => `<td class="num">${r && r[k] !== null ? fmt(r[k]) : "—"}</td>`).join("")}<td class="num"><b>${won(saleTotal(r))}</b></td><td class="wrap-cell">${esc(r?.note || "")}${r ? sourceTag(r) : ""}</td><td>${r ? actions("sale", r) : `<button class="small" data-action="date-record" data-type="sale" data-date="${date}">입력</button>`}</td></tr>`;
  });
  return table(
    [
      "날짜 · 요일",
      "카드 (원)",
      "현금 (원)",
      "계좌이체 (원)",
      "일매출 합계",
      "메모",
      "관리",
    ],
    rows,
    7,
    `<span>날짜별 1개 기록 · 원본과 같은 입력 항목</span><b>${won(metrics().revenue)}</b>`,
  );
}
function comparisonTable() {
  const months = rangeMonths();
  return `<section class="panel"><div class="toolbar"><h2>대조용 매출과 대조 · 각 월 전체 기준</h2><button class="primary small" data-action="compare">${month} 대조 입력</button></div>${table(
    [
      "월",
      "기록일수",
      "내가 기록한 매출",
      "대조용 매출",
      "차이",
      "메모",
      "관리",
    ],
    months.map((m) => {
      const a = metrics(m),
        c = db.comparisons[m] || { reported: null, note: "" };
      return `<tr><td>${m}</td><td>${a.recorded}일</td><td class="num">${won(a.recorded ? a.revenue : null)}</td><td class="num">${won(c.reported)}</td><td class="num">${won(a.recorded && c.reported !== null ? a.revenue - c.reported : null)}</td><td class="wrap-cell">${esc(c.note)}</td><td><button class="small" data-action="compare" data-month="${m}">입력</button></td></tr>`;
    }),
    7,
  )}</section>`;
}
function purchaseRows() {
  return selected("purchases")
    .filter(
      (r) =>
        (filter === "전체" || r.group === filter) &&
        [r.vendor, r.item, r.note, r.date].some((x) =>
          x.toLowerCase().includes(search.toLowerCase()),
        ),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
}
function expenses() {
  const m = metrics();
  return (
    titleHTML(
      "구매 · 비용",
      "결제한 날짜 기준으로 한 줄씩, 실제 결제액을 기록하세요.",
      '<button class="primary" data-action="add" data-type="purchase">구매 · 지출 기록</button>',
    ) +
    `<div class="stats">${stat("월별 구매", m.purchases, "월별 구매기록 탭 합계")}${stat("재료 외 지출", m.misc, "재료외 필요 지출 기록 탭")}${stat("총 지출", m.purchases + m.misc, "두 장부를 합산 · 급여 별도", true)}${stat("입력 건수", selected("purchases").length, "동일 내용의 서로 다른 원본 행도 보존", false, "건")}</div><div class="info">환불은 금액에 마이너스(-)를 입력하세요. 원본에 없는 결제 방법이나 비용 분류를 임의로 채우지 않고, 구매처·구매내용·메모를 각각 보존했습니다.</div><section class="panel"><div class="toolbar"><div class="row"><input id="search" type="search" value="${esc(search)}" placeholder="구매처 · 구매내용 검색" aria-label="구매 내역 검색"><select id="filter" aria-label="장부 구분">${["전체", "월별 구매", "재료 외 지출"].map((x) => `<option ${filter === x ? "selected" : ""}>${x}</option>`).join("")}</select></div><button class="small" data-action="csv" data-type="purchases">CSV 내보내기</button></div><div id="tableContent">${purchasesTable()}</div></section>`
  );
}
function purchasesTable() {
  const rows = purchaseRows();
  return table(
    ["날짜", "장부", "구매처", "구매내용", "금액 (원)", "메모", "관리"],
    rows.map(
      (r) =>
        `<tr><td>${r.date}</td><td><span class="pill ${r.group === "재료 외 지출" ? "amber" : ""}">${r.group}</span></td><td class="wrap-cell">${esc(r.vendor)}</td><td class="wrap-cell">${esc(r.item)}${sourceTag(r)}</td><td class="num ${r.amount < 0 ? "negative" : ""}">${won(r.amount)}</td><td class="wrap-cell">${esc(r.note)}</td><td>${actions("purchase", r)}</td></tr>`,
    ),
    7,
    `<span>조회 ${rows.length}건</span><b>합계 ${won(sum(rows, "amount"))}</b>`,
  );
}
function payroll() {
  const p = payrollTotals();
  return (
    titleHTML(
      "근무 · 급여",
      "파트타이머 1명 · 일별 근무, 주휴 확인, 월 기타수당을 구분합니다.",
      '<button data-action="extra">월 기타수당</button><button class="primary" data-action="add" data-type="shift">근무 기록</button>',
    ) +
    `<p class="sub" style="margin-bottom:16px">주휴수당은 주휴일 기준, 월 기타수당은 월 마지막 날 기준으로 선택 기간에 합산합니다.</p><div class="stats">${stat("실근로 합계", p.hours, "출퇴근 − 실제 무급휴게", false, "시간")}${stat("기본급", p.base, "근무일별 원 단위 올림")}${stat("주휴수당", p.pending ? null : p.holiday, p.pending ? "미확정 · 확정 입력분 " + won(p.holiday) : "조회 기간 내 주휴일 기준")}${stat("기간 합계 (세전)", p.total, p.pending ? "입력분 집계 · 최종 확정 전" : "기본급 + 주휴 + 기타수당", true)}</div>` +
    tabs(
      [
        ["daily", "날짜별 근무"],
        ["weekly", "주휴 확인"],
        ["setup", "근무 설정"],
      ],
      payTab,
      "payroll",
    ) +
    (p.pending
      ? '<div class="info warning"><b>급여 미확정</b> · 입사일·약정시간·주휴요일 또는 주별 확인이 필요합니다. 빈 주휴수당을 확정 0원으로 처리하지 않습니다.</div>'
      : "") +
    (payTab === "setup"
      ? employmentPanel()
      : payTab === "weekly"
        ? weeklyPanel()
        : `<div class="info">원본처럼 출근·퇴근·무급휴게(분)·메모만 입력합니다. 쉬지 않았으면 0을 입력하고, 쉬지 않은 시간을 자동 차감하지 않습니다. 월말을 넘는 근무는 자정에서 나눠 입력하세요.</div><section class="panel"><div class="toolbar"><h2>${monthLabel()} 근무 기록</h2><button class="small" data-action="csv" data-type="payroll">CSV 내보내기</button></div>${payrollTable()}${datePager()}</section><div class="info warning" style="margin-top:20px">원본 시트의 계산 규칙을 재현했습니다. 연장·야간·휴일 가산, 세금·보험·퇴직금은 자동 계산하지 않으며, 확인한 수당은 ‘월 기타수당’에 입력합니다.</div>`)
  );
}
function payrollTable() {
  return table(
    [
      "날짜 · 요일",
      "출근",
      "퇴근",
      "무급휴게 (분)",
      "실근로",
      "기본급",
      "메모 · 확인 안내",
      "관리",
    ],
    visibleDates().map((date) => {
      const r = db.payroll.find((r) => r.date === date),
        c = r ? shift(r) : null;
      return `<tr class="${r ? "" : "unrecorded"}"><td>${date} <small class="muted">${weekday(date)}</small></td><td>${r?.start || "—"}</td><td>${r?.end || "—"}</td><td class="num">${r?.breakMinutes ?? "—"}</td><td>${c?.hours !== null && c ? duration(c.hours) : "—"}</td><td class="num">${won(c?.base)}</td><td class="wrap-cell">${esc(r?.note || "")}${c?.notice ? `<span class="pill amber">${esc(c.notice)}</span>` : ""}${r ? sourceTag(r) : ""}</td><td>${r ? actions("shift", r) : `<button class="small" data-action="date-record" data-type="shift" data-date="${date}">입력</button>`}</td></tr>`;
    }),
    8,
    `<span>근무하지 않은 날짜는 빈칸 유지</span><span>원본 설정 시급: 근무일 연도별 적용</span>`,
  );
}
function weeklyPanel() {
  if (!employmentReady())
    return `<section class="panel"><div class="panel-body"><h2>먼저 근무 설정을 입력하세요.</h2><p class="sub" style="margin:12px 0 20px">원본의 입사일·기본 주 약정시간·주휴요일이 비어 있습니다. 날짜를 임의로 지정하지 않았습니다.</p><button class="primary" data-action="tab" data-kind="payroll" data-tab="setup">근무 설정</button></div></section>`;
  const rows = weeks().filter((r) => within(r.holiday));
  return `<div class="info">실근로와 약정시간은 다릅니다. 변경된 주만 약정시간을 수정하고, 한 주가 끝난 뒤 개근·재직 여부를 확인하세요. 4주 평균과 수당은 원본 계산식 기준입니다.</div><section class="panel">${table(
    [
      "주 시작 · 종료",
      "주휴일",
      "실근로 (h)",
      "약정 (h)",
      "4주 평균 (h)",
      "확인",
      "주휴수당",
      "상태 · 메모",
      "관리",
    ],
    rows.map(
      (r) =>
        `<tr><td>${r.date}<div class="sub">~ ${r.end}</div></td><td>${r.holiday}</td><td class="num">${Number(r.actual.toFixed(2))}</td><td class="num">${r.agreed ?? "—"}</td><td class="num">${r.average === null ? "—" : Number(r.average.toFixed(2))}</td><td>${r.confirmation}</td><td class="num">${won(r.amount)}</td><td class="wrap-cell"><span class="pill ${r.amount === null ? "amber" : ""}">${esc(r.status)}</span><div>${esc(r.note)}</div></td><td><button class="small" data-action="week" data-date="${r.date}">확인</button></td></tr>`,
    ),
    9,
  )}</section>`;
}
function employmentPanel() {
  const e = db.employment;
  return `<section class="panel"><form id="employmentForm"><div class="panel-head"><h2>근무 설정</h2><span class="pill">원본 설정 탭</span></div><div class="panel-body"><div class="form-grid">${field("입사일 *", "hireDate", e.hireDate, "date", "required")}${field("기본 주 약정시간 *", "weeklyHours", e.weeklyHours, "number", 'required min="0" max="40" step="0.01"')}${select("주휴요일 *", "holidayDay", e.holidayDay || "", ["", ...weekdays])}${field("첫 주 시작일", "firstWeek", e.firstWeek, "date", "")}${field("마지막 재직일", "endDate", e.endDate, "date", "")}${field("통상근로자 주 근무일수", "normalDays", e.normalDays, "number", 'required min="1" max="7" step="1"')}${field("2026년 시급 (원)", "rate2026", e.rates["2026"] ?? "", "number", 'required min="1" max="10000000" step="1"')}${field("2027년 시급 (원)", "rate2027", e.rates["2027"] ?? "", "number", 'required min="1" max="10000000" step="1"')}</div><p class="form-note">첫 주 시작일을 비워두면 입사일로 설정됩니다. 관리기간: ${e.start} ~ ${e.end}. 시급은 사용자가 확인한 값을 입력하세요. 기본 약정시간·시급 변경은 과거 계산에도 반영되므로 주별 시간 변경은 ‘주휴 확인’에서 입력하세요.</p><p class="error" id="employmentError" role="alert"></p></div><div class="dialog-actions"><button class="primary" type="submit">설정 저장</button></div></form></section>`;
}
function inventory() {
  return (
    titleHTML(
      "재료 · 재고",
      "원본 구매내역과 별도로 실제 재고 수량을 기록하세요.",
      '<button class="primary" data-action="add" data-type="inventory">재료 등록</button>',
      false,
    ) +
    `<div class="info">세 시트에는 재고 수량·단가 자료가 없습니다. 구매내용의 포장 수량을 현재 재고로 추정하지 않았으며, 재고 변경은 비용에 중복 반영되지 않습니다.</div><section class="panel">${table(
      ["재료", "수량", "보충 기준", "단가", "거래처", "상태", "관리"],
      db.inventory.map(
        (r) =>
          `<tr><td>${esc(r.name)}</td><td>${r.qty} ${esc(r.unit)}</td><td>${r.min} ${esc(r.unit)}</td><td>${won(r.cost)}</td><td>${esc(r.supplier)}</td><td><span class="pill ${r.qty <= r.min ? "amber" : ""}">${r.qty <= r.min ? "보충 필요" : "여유"}</span></td><td>${actions("inventory", r)}</td></tr>`,
      ),
      7,
    )}</section>`
  );
}
function reports() {
  const m = metrics(),
    p = payrollTotals();
  return (
    titleHTML(
      "손익 리포트",
      "원본 장부의 입력분을 합산한 운영 검토용 집계입니다.",
      '<button data-action="reportCSV">리포트 CSV</button><button class="primary" data-action="print">인쇄 · PDF</button>',
    ) +
    commonStats() +
    `<div class="report-grid"><section class="panel"><div class="panel-head"><h2>${monthLabel()} 수익 · 비용</h2><span class="pill ${m.pending ? "amber" : ""}">${m.pending ? "급여 미확정" : "입력분 집계"}</span></div><div class="statement">${[
      ["일별 매출", m.revenue, "emphasis"],
      ["기타수익", m.other, ""],
      ["월별 구매", -m.purchases, ""],
      ["재료 외 지출", -m.misc, ""],
      ["기본급", -p.base, ""],
      ["확인된 주휴수당", -p.holiday, ""],
      ["월 기타수당", -p.extra, ""],
      ["간이 운영 잔액", m.profit, "result"],
    ]
      .map(
        ([label, value, cls]) =>
          `<div class="statement-row ${cls}"><span>${label}</span><b>${won(value)}</b></div>`,
      )
      .join(
        "",
      )}</div></section><section class="panel"><div class="panel-head"><h2>집계 기준</h2></div><div class="panel-body"><ul class="help-list"><li>매출 1일은 카드·현금·계좌이체 합계입니다. 대조용 매출은 대조에만 사용합니다.</li><li>조회 기간의 구매 기록과 재료 외 지출을 별도 합산합니다. 합계 행은 다시 적재하지 않습니다.</li><li>기본급은 근무일별 원 단위 올림, 주휴는 주휴일 기준, 월 기타수당은 월 마지막 날 기준으로 조회 기간에 반영합니다.</li><li>${m.pending ? "미확정 주휴수당이 있어 현재 잔액은 잠정치입니다." : "미입력 매출·비용이 있으면 잔액도 달라집니다."}</li><li>재고 사용 원가·감가상각·부가세·보험 등은 이 집계에 포함되지 않습니다.</li></ul></div></section></div>`
  );
}
const checks = [
  ["매출 입력", "카드·현금·계좌이체와 0원·미입력 구분 확인"],
  ["매출 대조", "대조용 월매출을 입력하고 차이 확인"],
  ["구매 기록", "구매처·내용·금액·메모와 환불 입력 확인"],
  ["근무 기록", "시각·무급휴게와 일별 기본급 확인"],
  ["주휴 설정", "입사일·약정·주휴요일 및 주별 확인"],
  ["백업", "JSON 저장·복원 및 원본 적재 합계 확인"],
];
function settings() {
  return (
    titleHTML("설정 · 백업", "매장과 백업을 관리하세요.", "", false) +
    `<div class="setting-grid"><section class="panel"><div class="setting-block"><h2>매장 이름</h2><form id="storeForm" class="row"><input name="store" aria-label="매장 이름" value="${esc(db.store)}" required maxlength="80"><button type="submit" class="primary">저장</button></form></div><div class="setting-block"><h2>시작하기</h2><p>빈 장부로 시작하는 배포용 버전입니다. 기록 버튼에서 매출과 지출을 추가하세요. 급여 계산 전 근무 설정에서 시급·약정시간·입사일을 입력하세요.</p><button data-page="payroll">근무 · 급여 설정</button></div></section><section class="panel"><div class="setting-block"><h2>백업 · 복원</h2><p>JSON 백업으로 다른 PC에 기록을 옮길 수 있습니다. 각 사용자의 기록은 사용하는 브라우저에 따로 저장됩니다.</p><div class="row"><button class="primary" data-action="backup">백업 내려받기</button><button data-action="restore">백업 복원</button></div></div><div class="setting-block"><h2>빈 장부로 초기화</h2><p>현재 자료를 지웁니다. 필요한 기록을 먼저 백업하세요.</p><button class="danger" data-action="reset">장부 초기화</button></div></section></div>`
  );
}
const navIcons = {
  dashboard:
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  sales: '<path d="M4 17 10 11 14 15 21 6M15 6h6v6"/>',
  expenses: '<path d="M4 7 10 13 14 9 21 18M15 18h6v-6"/>',
  payroll: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  inventory:
    '<path d="m3 7 9-4 9 4-9 4-9-4v10l9 4 9-4V7M12 11v10M7.5 5 17 9"/>',
  reports:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 16v-4M12 16V7M17 16v-7"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="2" fill="var(--sidebar)"/><circle cx="16" cy="17" r="2" fill="var(--sidebar)"/>',
};
function render() {
  document.getElementById("nav").innerHTML = pages
    .map(
      ([id, icon, label]) =>
        `${id === "inventory" ? '<div class="nav-group-label">관리 & 분석</div>' : ""}<button data-page="${id}" class="${page === id ? "active" : ""}" ${page === id ? 'aria-current="page"' : ""}><span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true">${navIcons[id]}</svg></span>${label}</button>`,
    )
    .join("");
  document.getElementById("crumb").textContent = pages.find(
    (p) => p[0] === page,
  )[2];
  document.querySelector(".store").innerHTML =
    esc(db.store) + " 운영 장부<small>내 PC · 개인 장부</small>";
  document.getElementById("saveState").textContent = storageOk
    ? "이 브라우저에 저장"
    : "저장 자료 확인 필요";
  document.getElementById("main").innerHTML =
    { dashboard, sales, expenses, payroll, inventory, reports, settings }[
      page
    ]() +
    (page === "dashboard" ? "" : banner()) +
    `<footer class="footer"><span>${esc(db.store)} · 운영 관리</span><span>브라우저 저장 · 자동 동기화 없음</span></footer>`;
}
function field(label, name, value, type = "text", attrs = "", full = false) {
  return `<label class="field ${full ? "full" : ""}">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
}
function select(label, name, value, options) {
  return `<label class="field">${label}<select name="${name}">${options.map((x) => `<option value="${esc(x)}" ${x === value ? "selected" : ""}>${esc(x || "선택하세요")}</option>`).join("")}</select></label>`;
}
const arrayFor = {
  sale: "sales",
  purchase: "purchases",
  shift: "payroll",
  inventory: "inventory",
  income: "incomes",
};
function openForm(type, id, date) {
  let r = id ? db[arrayFor[type]]?.find((r) => r.id === id) : {};
  if (["sale", "shift"].includes(type) && date) {
    r = db[arrayFor[type]].find((r) => r.date === date) || {};
    id = r.id;
  }
  if (!r) return;
  editing = { type, id };
  const now = new Date(),
    today =
      now.getFullYear() +
      "-" +
      String(now.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(now.getDate()).padStart(2, "0");
  const dateValue = r.date || date || (within(today) ? today : rangeStart);
  let f = "",
    note = "";
  const title = {
    sale: "일별 매출",
    purchase: "구매 · 지출",
    shift: "일별 근무",
    inventory: "재료 · 재고",
    income: "기타수익",
    comparison: "월 매출 대조",
    extra: "월 기타수당",
    week: "주휴 확인",
  }[type];
  document.getElementById("modalTitle").textContent =
    title + (id ? " 수정" : " 입력");
  if (arrayFor[type] && type !== "inventory")
    f += field(
      type === "shift" ? "근무일" : "날짜",
      "date",
      dateValue,
      "date",
      'required min="2020-01-01" max="2099-12-31"',
    );
  if (type === "sale") {
    f +=
      field(
        "카드 (원)",
        "card",
        r.card ?? "",
        "number",
        'step="1" min="-1000000000000" max="1000000000000"',
      ) +
      field(
        "현금 (원)",
        "cash",
        r.cash ?? "",
        "number",
        'step="1" min="-1000000000000" max="1000000000000"',
      ) +
      field(
        "계좌이체 (원)",
        "transfer",
        r.transfer ?? "",
        "number",
        'step="1" min="-1000000000000" max="1000000000000"',
      );
    note =
      "카드는 수수료 차감 전 금액. 현금에 포함된 이체는 빼고 한 번만 기록하세요. 빈칸은 미입력, 0은 매출 0원입니다.";
  }
  if (type === "purchase") {
    f +=
      select("장부 구분", "group", r.group || "월별 구매", [
        "월별 구매",
        "재료 외 지출",
      ]) +
      field(
        "구매처",
        "vendor",
        r.vendor || "",
        "text",
        'required maxlength="200"',
      ) +
      field(
        "금액 (원)",
        "amount",
        r.amount ?? "",
        "number",
        'required step="1" min="-1000000000000" max="1000000000000"',
      ) +
      field(
        "구매내용",
        "item",
        r.item || "",
        "text",
        'required maxlength="1000"',
        true,
      );
    note = "원본처럼 실제 결제액을 입력합니다. 환불은 음수(-)로 입력하세요.";
  }
  if (type === "shift") {
    f +=
      field(
        "출근 (24시간제)",
        "start",
        r.start ?? "",
        "text",
        'required inputmode="numeric" placeholder="11:00" pattern="([01][0-9]|2[0-3]):[0-5][0-9]"',
      ) +
      field(
        "퇴근 (24:00 가능)",
        "end",
        r.end ?? "",
        "text",
        'required inputmode="numeric" placeholder="18:00" pattern="(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)"',
      ) +
      field(
        "무급휴게 (분)",
        "breakMinutes",
        r.breakMinutes ?? "",
        "number",
        'required min="0" max="1439" step="1"',
      );
    note =
      "실제 쉰 시간만 분 단위로 입력하세요. 없으면 0. 월말을 넘는 근무는 24:00까지와 다음 날 00:00부터로 나눠 입력합니다.";
  }
  if (type === "inventory") {
    f +=
      field(
        "재료명",
        "name",
        r.name || "",
        "text",
        'required maxlength="100"',
        true,
      ) +
      field(
        "현재 수량",
        "qty",
        r.qty ?? 0,
        "number",
        'required min="0" max="100000000" step="0.01"',
      ) +
      field("단위", "unit", r.unit || "개", "text", 'required maxlength="10"') +
      field(
        "보충 기준",
        "min",
        r.min ?? 0,
        "number",
        'required min="0" max="100000000" step="0.01"',
      ) +
      field(
        "단가 (원)",
        "cost",
        r.cost ?? 0,
        "number",
        'required min="0" max="1000000000" step="1"',
      ) +
      field(
        "거래처",
        "supplier",
        r.supplier || "",
        "text",
        'maxlength="200"',
        true,
      );
    note = "재고 수량은 구매·비용에 중복 반영되지 않습니다.";
  }
  if (type === "income")
    f +=
      field("내용", "item", r.item || "", "text", 'required maxlength="200"') +
      field(
        "금액 (원)",
        "amount",
        r.amount ?? "",
        "number",
        'required step="1" min="-1000000000000" max="1000000000000"',
      );
  if (arrayFor[type] && type !== "inventory")
    f += field("메모", "note", r.note || "", "text", 'maxlength="2000"', true);
  if (type === "comparison") {
    editing.month = date || month;
    const c = db.comparisons[editing.month] || { reported: null, note: "" };
    f +=
      field(
        "조회 월",
        "month",
        editing.month,
        "month",
        'required min="2020-01" max="2099-12"',
      ) +
      field(
        "대조용 매출 (원)",
        "reported",
        c.reported ?? "",
        "number",
        'step="1" min="-1000000000000" max="1000000000000"',
      ) +
      field("메모", "note", c.note, "text", 'maxlength="2000"', true);
    note =
      "전달 매출은 대조에만 쓰이며, 실제 수익으로 중복 합산하지 않습니다. 빈칸은 미대조, 0은 전달 매출 0원입니다.";
  }
  if (type === "extra") {
    editing.month = month;
    f +=
      field(
        "조회 월",
        "month",
        month,
        "month",
        'required min="2020-01" max="2099-12"',
      ) +
      field(
        "월 기타수당 (원)",
        "amount",
        db.monthlyExtras[month] ?? "",
        "number",
        'step="1" min="-1000000000000" max="1000000000000"',
      );
    note =
      "월 마지막 날이 조회 기간에 포함되면 합산합니다. 원본 월별 C5에 해당합니다. 일별 기본급·주휴 외에 별도로 확인한 수당의 월 합계를 입력합니다.";
  }
  if (type === "week") {
    const w = weeks().find((r) => r.date === date);
    if (!w) return;
    editing.week = date;
    const override = db.weeks[date] || {
      agreed: null,
      confirmation: "미확인",
      note: "",
    };
    f +=
      field("주 시작일", "date", date, "date", "readonly") +
      field("주 종료일", "endDate", w.end, "date", "readonly") +
      field(
        "주 약정시간 변경 (선택)",
        "agreed",
        override.agreed ?? "",
        "number",
        'min="0" max="40" step="0.01" placeholder="기본 설정 사용"',
      ) +
      select("개근 · 재직 확인", "confirmation", override.confirmation, [
        "미확인",
        "개근·재직 확인",
        "결근",
        "검토필요",
      ]) +
      field("메모", "note", override.note, "text", 'maxlength="2000"', true);
    note =
      "실근로와 별개로 사전에 약정한 시간입니다. 변경이 없으면 비워두세요. 월을 걸친 주는 주휴일이 속한 월에 한 번 집계합니다.";
  }
  document.getElementById("formBody").innerHTML =
    `<div class="form-grid">${f}</div>${["sale", "shift", "comparison"].includes(type) ? '<div class="amount-preview" style="margin-top:18px" aria-live="polite"><span id="previewLabel"></span><b id="previewValue"></b></div>' : ""}<p class="form-note">${note}</p><p class="error" id="formError" role="alert"></p>`;
  updatePreview();
  document.getElementById("modal").showModal();
}
function updatePreview() {
  if (!editing) return;
  const f = document.getElementById("recordForm"),
    label = document.getElementById("previewLabel"),
    value = document.getElementById("previewValue");
  if (!label) return;
  if (editing.type === "sale") {
    const vals = ["card", "cash", "transfer"].map((k) =>
      f.elements[k].value === "" ? null : Number(f.elements[k].value),
    );
    label.textContent = "일매출 합계";
    value.textContent = vals.every((x) => x === null)
      ? "미입력"
      : won(sum(vals));
  }
  if (editing.type === "shift") {
    const r = {
      date: f.elements.date.value,
      start: f.elements.start.value,
      end: f.elements.end.value,
      breakMinutes:
        f.elements.breakMinutes.value === ""
          ? null
          : Number(f.elements.breakMinutes.value),
    };
    const c = shift(r);
    label.textContent =
      c.hours === null
        ? "입력 내용을 확인하세요"
        : duration(c.hours) + " · 시급 " + won(c.rate);
    value.textContent = won(c.base);
    document.getElementById("formError").textContent = c.notice;
  }
  if (editing.type === "comparison") {
    const m = metrics(f.elements.month.value),
      raw = f.elements.reported.value;
    label.textContent = "내 기록 − 대조용";
    value.textContent =
      raw === "" || !m.recorded ? "미대조" : won(m.revenue - Number(raw));
  }
}
function askConfirm(message) {
  const dialog = document.getElementById("confirmDialog");
  document.getElementById("confirmMessage").textContent = message;
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "accept"),
      { once: true },
    );
    dialog.showModal();
  });
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+@\-\t\r]/.test(s) && typeof v !== "number") s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
function csv(name, rows) {
  download(
    name + ".csv",
    "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"),
    "text/csv;charset=utf-8",
  );
  notify("CSV 다운로드를 요청했어요.");
}
function exportCSV(type) {
  if (type === "sales")
    csv("매출_" + rangeStart + "_" + rangeEnd, [
      ["날짜", "요일", "카드", "현금", "계좌이체", "일매출 합계", "메모"],
      ...selected("sales").map((r) => [
        r.date,
        weekday(r.date),
        r.card,
        r.cash,
        r.transfer,
        saleTotal(r),
        r.note,
      ]),
    ]);
  if (type === "purchases")
    csv("구매_" + rangeStart + "_" + rangeEnd, [
      ["날짜", "장부", "구매처", "구매내용", "금액", "메모"],
      ...purchaseRows().map((r) => [
        r.date,
        r.group,
        r.vendor,
        r.item,
        r.amount,
        r.note,
      ]),
    ]);
  if (type === "payroll")
    csv("근무_" + rangeStart + "_" + rangeEnd, [
      [
        "날짜",
        "요일",
        "출근",
        "퇴근",
        "무급휴게(분)",
        "실근로(시간)",
        "기본급",
        "메모",
        "확인 안내",
      ],
      ...selected("payroll").map((r) => {
        const c = shift(r);
        return [
          r.date,
          weekday(r.date),
          r.start,
          r.end,
          r.breakMinutes,
          c.hours,
          c.base,
          r.note,
          c.notice,
        ];
      }),
    ]);
}
document.addEventListener("click", async (e) => {
  const nav = e.target.closest("[data-page]");
  if (nav) {
    page = nav.dataset.page;
    search = "";
    filter = "전체";
    render();
    window.scrollTo({ top: 0, behavior: "instant" });
    return;
  }
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const a = b.dataset.action,
    type = b.dataset.type,
    id = b.dataset.id;
  if (a === "theme") {
    setTheme(
      document.documentElement.getAttribute("data-theme") === "dark"
        ? "light"
        : "dark",
      true,
    );
  }
  if (a === "ledger-tab") {
    ledgerTab = b.dataset.tab;
    render();
  }
  if (a === "record") document.getElementById("recordPicker").showModal();
  if (a === "close-picker") document.getElementById("recordPicker").close();
  if (a === "choose-record") {
    document.getElementById("recordPicker").close();
    openForm(type);
  }
  if (a === "close") document.getElementById("modal").close();
  if (a === "add" || a === "edit") openForm(type, id);
  if (a === "date-record") openForm(type, null, b.dataset.date);
  if (a === "compare") openForm("comparison", null, b.dataset.month || month);
  if (a === "extra") openForm("extra");
  if (a === "week") openForm("week", null, b.dataset.date);
  if (a === "tab") {
    if (b.dataset.kind === "sales") salesTab = b.dataset.tab;
    else payTab = b.dataset.tab;
    render();
  }
  if (a === "date-prev" || a === "date-next") {
    dayPage += a === "date-prev" ? -1 : 1;
    dayPage = Math.max(0, Math.min(Math.ceil(dayCount() / 62) - 1, dayPage));
    render();
  }
  if (a === "this-month") {
    const d = new Date(),
      m = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    applyRange(m + "-01", m + "-" + monthDays(m));
  }
  if (a === "all-dates") {
    const dates = [...db.sales, ...db.purchases, ...db.payroll, ...db.incomes]
      .map((r) => r.date)
      .concat(
        Object.keys(db.monthlyExtras)
          .filter((m) => db.monthlyExtras[m] !== null)
          .map((m) => m + "-" + monthDays(m)),
      )
      .sort();
    if (dates.length) applyRange(dates[0], dates.at(-1));
    else notify("조회할 기록이 없습니다.");
  }
  if (
    a === "delete" &&
    (await askConfirm(
      "이 기록을 삭제할까요? Google 시트 원본은 변경되지 않습니다.",
    ))
  ) {
    const next = structuredClone(db);
    next[arrayFor[type]] = next[arrayFor[type]].filter((r) => r.id !== id);
    if (commit(next)) {
      render();
      notify("기록을 삭제했어요.");
    }
  }
  if (a === "csv") exportCSV(type);
  if (a === "reportCSV") {
    const m = metrics(),
      p = payrollTotals();
    csv("손익_" + rangeStart + "_" + rangeEnd, [
      ["항목", "금액", "상태"],
      ["매출", m.revenue, m.recorded + "일 입력"],
      ["기타수익", m.other, ""],
      ["월별 구매", m.purchases, ""],
      ["재료 외 지출", m.misc, ""],
      ["기본급", p.base, ""],
      ["확인된 주휴", p.holiday, p.pending ? "미확정" : "입력분 집계"],
      ["월 기타수당", p.extra, ""],
      ["간이 운영 잔액", m.profit, p.pending ? "미확정" : "입력분 집계"],
    ]);
  }
  if (a === "print") window.print();
  if (a === "backup") {
    const next = structuredClone(db);
    next.lastBackup = new Date().toISOString();
    download(
      "Cafe Admin_시트장부_" + next.lastBackup.slice(0, 10) + ".json",
      JSON.stringify(next, null, 2),
      "application/json",
    );
    if (commit(next)) render();
    notify("백업 다운로드를 요청했어요.");
  }
  if (a === "restore") document.getElementById("restoreFile").click();
  if (a === "legacy-backup") {
    try {
      const raw = repository.loadLegacyBackup();
      if (raw) download("Cafe Admin_이전목업_v1.json", raw, "application/json");
    } catch (e) {
      notify("이전 자료를 읽지 못했어요.");
    }
  }
  if (
    a === "reset" &&
    (await askConfirm(
      "현재 수정분을 지우고 빈 장부로 초기화할까요? 필요한 내용은 먼저 백업하세요.",
    ))
  ) {
    if (commit(seed())) {
      month = "2026-10";
      rangeStart = "2026-10-01";
      rangeEnd = "2026-10-31";
      dayPage = 0;
      render();
      notify("빈 장부로 초기화했어요.");
    }
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    search = e.target.value;
    document.getElementById("tableContent").innerHTML = purchasesTable();
  }
  if (e.target.closest("#recordForm")) updatePreview();
});
document.addEventListener("change", (e) => {
  if (e.target.id === "filter") {
    filter = e.target.value;
    document.getElementById("tableContent").innerHTML = purchasesTable();
  }
  if (e.target.closest("#recordForm")) {
    if (e.target.name === "month" && validMonth(e.target.value)) {
      const f = document.getElementById("recordForm"),
        m = e.target.value;
      if (editing.type === "comparison") {
        f.elements.reported.value = db.comparisons[m]?.reported ?? "";
        f.elements.note.value = db.comparisons[m]?.note ?? "";
      }
      if (editing.type === "extra")
        f.elements.amount.value = db.monthlyExtras[m] ?? "";
    }
    updatePreview();
  }
  if (e.target.matches("[data-check]")) {
    const next = structuredClone(db),
      i = +e.target.dataset.check;
    next.checks = e.target.checked
      ? [...new Set([...next.checks, i])]
      : next.checks.filter((x) => x !== i);
    if (commit(next)) render();
    else e.target.checked = !e.target.checked;
  }
});
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (form.id === "periodForm") {
    e.preventDefault();
    const start = form.elements.rangeStart.value,
      end = form.elements.rangeEnd.value;
    if (!validDate(start) || !validDate(end) || start > end) {
      document.getElementById("periodError").textContent =
        "종료일은 시작일과 같거나 이후여야 합니다.";
      return;
    }
    applyRange(start, end);
    return;
  }
  if (!["recordForm", "employmentForm", "storeForm"].includes(form.id)) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(form));
  for (const key in v) v[key] = v[key].trim();
  const next = structuredClone(db);
  if (form.id === "storeForm") {
    next.store = v.store;
    if (commit(next)) {
      render();
      notify("저장했어요.");
    }
    return;
  }
  if (form.id === "employmentForm") {
    next.employment = {
      ...next.employment,
      hireDate: v.hireDate,
      weeklyHours: Number(v.weeklyHours),
      holidayDay: v.holidayDay || null,
      firstWeek: v.firstWeek || v.hireDate,
      endDate: v.endDate || null,
      normalDays: Number(v.normalDays),
      rates: {
        ...next.employment.rates,
        2026: Number(v.rate2026),
        2027: Number(v.rate2027),
      },
    };
    try {
      if (!v.holidayDay) throw Error("주휴요일을 선택하세요.");
      validate(next);
    } catch (err) {
      document.getElementById("employmentError").textContent = err.message;
      return;
    }
    if (commit(next)) {
      render();
      notify("근무 설정과 관련 계산을 반영했어요.");
    }
    return;
  }
  const { type, id } = editing;
  const number = (k) => (v[k] === "" ? null : Number(v[k]));
  let record;
  if (type === "sale") {
    record = {
      date: v.date,
      card: number("card"),
      cash: number("cash"),
      transfer: number("transfer"),
      note: v.note,
    };
  }
  if (type === "purchase")
    record = {
      date: v.date,
      group: v.group,
      vendor: v.vendor,
      item: v.item,
      amount: Number(v.amount),
      note: v.note,
    };
  if (type === "shift") {
    record = {
      date: v.date,
      start: v.start,
      end: v.end,
      breakMinutes: number("breakMinutes"),
      note: v.note,
    };
    const c = shift(record);
    if (c.base === null) {
      document.getElementById("formError").textContent = c.notice;
      return;
    }
  }
  if (type === "income")
    record = {
      date: v.date,
      item: v.item,
      amount: Number(v.amount),
      note: v.note,
    };
  if (type === "inventory") {
    record = {
      name: v.name,
      qty: Number(v.qty),
      unit: v.unit,
      min: Number(v.min),
      cost: Number(v.cost),
      supplier: v.supplier,
    };
  }
  if (type === "comparison")
    next.comparisons[v.month] = { reported: number("reported"), note: v.note };
  if (type === "extra") next.monthlyExtras[v.month] = number("amount");
  if (type === "week")
    next.weeks[editing.week] = {
      agreed: number("agreed"),
      confirmation: v.confirmation,
      note: v.note,
    };
  if (record) {
    const key = arrayFor[type];
    if (
      ["sale", "shift"].includes(type) &&
      next[key].some((r) => r.date === record.date && r.id !== id)
    ) {
      document.getElementById("formError").textContent =
        "이 날짜에 이미 기록이 있습니다. 기존 날짜의 수정 버튼을 사용하세요.";
      return;
    }
    const old = id ? next[key].find((r) => r.id === id) : null;
    record = { ...old, ...record, id: id || uid(), modified: !!old?.source };
    if (id) next[key] = next[key].map((r) => (r.id === id ? record : r));
    else next[key].push(record);
  }
  try {
    validate(next);
  } catch (err) {
    document.getElementById("formError").textContent = err.message;
    return;
  }
  if (commit(next)) {
    if (record?.date && !within(record.date)) {
      rangeStart = record.date;
      rangeEnd = record.date;
      month = record.date.slice(0, 7);
      dayPage = 0;
    }
    document.getElementById("modal").close();
    render();
    notify("저장하고 집계에 반영했어요.");
  }
});
document.getElementById("restoreFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024)
      throw Error("20MB 이하 파일만 지원합니다.");
    const next = validate(JSON.parse(await file.text()));
    if (
      await askConfirm(
        `매출 ${next.sales.length}일 · 구매 ${next.purchases.length}건 · 근무 ${next.payroll.length}일의 백업으로 현재 자료를 교체할까요?`,
      )
    ) {
      if (commit(next)) {
        render();
        notify("복원했어요.");
      }
    }
  } catch (err) {
    notify("복원 실패: " + err.message);
  } finally {
    e.target.value = "";
  }
});
if (storageOk) {
  try {
    repository.save(db);
  } catch (e) {
    storageOk = false;
    loadWarning = "저장소 확인 필요: " + e.message;
  }
}
render();

initTheme();
