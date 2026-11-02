import { workScreen } from "./work.js";
import { payrollScreen } from "./payroll.js";

export function teamScreen(options) {
  const { root, staff, dirty } = options;
  root.innerHTML = '<section class="card"><h2>근무 · 급여</h2><p>근무를 기록하고 시급 기준 기본급과 주휴수당을 함께 확인합니다.</p></section><div id="team-work"></div>' +
    (staff ? "" : '<div id="team-payroll"></div>');
  const pending = { work: false, payroll: false };
  const track = (part) => (value) => {
    pending[part] = value;
    dirty(pending.work || pending.payroll);
  };
  let refreshPayroll = () => {};
  const refreshWork = workScreen({
    ...options,
    root: root.querySelector("#team-work"),
    dirty: track("work"),
    onChange: () => { refreshPayroll(); refreshPayroll.reloadEmployees?.(); },
  });
  if (!staff) refreshPayroll = payrollScreen({
    ...options,
    root: root.querySelector("#team-payroll"),
    dirty: track("payroll"),
  });
  return () => Promise.all([refreshWork(), refreshPayroll()]);
}
