const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
export function scorecards(root, cards, note = "조회 조건에 맞는 전체 기록 기준") {
  root.innerHTML = `<div class="scorecards">${cards.map(({label, value, unit = "", hint = ""}) => `<div class="scorecard"><span>${escape(label)}</span><strong>${value === null || value === undefined ? "—" : escape(typeof value === "number" ? value.toLocaleString("ko-KR", {maximumFractionDigits: 2}) : value)}<small>${escape(unit)}</small></strong>${hint ? `<p>${escape(hint)}</p>` : ""}</div>`).join("")}</div><p class="scorecard-caption">${escape(note)}</p>`;
}
