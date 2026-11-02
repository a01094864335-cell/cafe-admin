// Explicit business columns keep internal authentication and audit identifiers out.
export function backupSheets(backup) {
  const tables = backup.tables;
  const active = (name) => (tables[name] ?? []).filter((r) => !r.deleted_at);
  const employees = new Map(
    (tables.employees ?? []).map((r) => [r.id, r.name]),
  );
  const inventory = new Map(
    (tables.inventory_items ?? []).map((r) => [r.id, r.name]),
  );
  const settings = new Map(
    (tables.payroll_settings ?? []).map((r) => [r.id, r.employee_id]),
  );
  const employee = (id) => employees.get(id) ?? "직원 정보 없음";
  const sheet = (name, columns, rows) => ({
    name,
    rows: [
      columns.map(([label]) => label),
      ...rows.map((r) =>
        columns.map(([, key]) =>
          typeof key === "function" ? key(r) : (r[key] ?? null),
        ),
      ),
    ],
  });
  const money = [
    ["날짜", "business_date"],
    ["구매처", "vendor"],
    ["내용", "item"],
    ["금액 (원)", "amount"],
    ["메모", "note"],
  ];
  return [
    {
      name: "안내",
      rows: [
        ["항목", "내용"],
        ["매장", backup.cafe.name],
        ["생성 시각", backup.exportedAt],
        ["범위", "현재 카페의 전체 기록 (화면 조회 기간·검색과 무관)"],
        ["삭제 기록", "삭제한 기록은 제외합니다."],
        ["재고 기준", "현재 수량과 별도 이동 이력. 이동 시각은 UTC입니다."],
        ["급여", "근무·설정·확인·수당 원본값이며 확정 급여 계산표가 아닙니다."],
        [
          "복원",
          "열람용 엑셀 파일입니다. 장부 복원에는 JSON 백업을 사용하세요.",
        ],
      ],
    },
    sheet(
      "매출",
      [
        ["날짜", "business_date"],
        ["카드 (원)", "card"],
        ["현금 (원)", "cash"],
        ["계좌이체 (원)", "transfer"],
        [
          "합계 (원)",
          (r) =>
            [r.card, r.cash, r.transfer].every((v) => v == null)
              ? null
              : (r.card ?? 0) + (r.cash ?? 0) + (r.transfer ?? 0),
        ],
        ["메모", "note"],
      ],
      active("sales").sort((a, b) =>
        a.business_date.localeCompare(b.business_date),
      ),
    ),
    ...[
      ["purchases", "매입"],
      ["expenses", "비용"],
      ["other_incomes", "기타 수입"],
    ].map(([key, name]) =>
      sheet(
        name,
        money,
        active(key).sort((a, b) =>
          a.business_date.localeCompare(b.business_date),
        ),
      ),
    ),
    sheet(
      "직원",
      [
        ["직원", "name"],
        ["입사일", "hire_date"],
        ["마지막 재직일", "end_date"],
      ],
      active("employees"),
    ),
    sheet(
      "근무",
      [
        ["직원", (r) => employee(r.employee_id)],
        ["날짜", "business_date"],
        ["출근", "start_time"],
        ["퇴근", "end_time"],
        ["무급휴게 (분)", (r) => (r.break_missing ? null : r.break_minutes)],
        ["메모", "note"],
      ],
      active("work_logs"),
    ),
    sheet(
      "급여 설정",
      [
        ["직원", (r) => employee(r.employee_id)],
        ["적용 시작", "effective_from"],
        ["적용 종료", "effective_to"],
        ["첫 주 시작일", "first_week"],
        [
          "주 약정시간",
          (r) => (r.weekly_hours_missing ? null : r.weekly_hours),
        ],
        ["주휴요일", "holiday_day"],
        ["통상 주 근무일수", "normal_days"],
        ["계산 시작", "calculation_start"],
        ["계산 종료", "calculation_end"],
      ],
      active("payroll_settings"),
    ),
    sheet(
      "연도별 시급",
      [
        ["직원", (r) => employee(settings.get(r.settings_id))],
        [
          "설정 적용 시작",
          (r) =>
            (tables.payroll_settings ?? []).find((s) => s.id === r.settings_id)
              ?.effective_from ?? null,
        ],
        ["연도", "year"],
        ["시급 (원)", "hourly_rate"],
      ],
      active("payroll_rates").filter((r) =>
        active("payroll_settings").some((s) => s.id === r.settings_id),
      ),
    ),
    sheet(
      "주휴 확인",
      [
        ["직원", (r) => employee(r.employee_id)],
        ["주 시작일", "week_start"],
        ["약정시간", "agreed_hours"],
        ["확인", "confirmation"],
        ["메모", "note"],
      ],
      active("weekly_confirmations"),
    ),
    sheet(
      "기타 수당",
      [
        ["직원", (r) => employee(r.employee_id)],
        ["월", "month"],
        ["금액 (원)", "amount"],
      ],
      active("payroll_extras"),
    ),
    sheet(
      "매출 대조",
      [
        ["월", "month"],
        ["대조용 매출 (원)", "reported"],
        ["메모", "note"],
      ],
      active("sales_reconciliations"),
    ),
    sheet(
      "재고 품목",
      [
        ["품목", "name"],
        ["수량", (r) => r.quantity_hundredths / 100],
        ["단위", "unit"],
        ["보충 기준", (r) => r.minimum_hundredths / 100],
        ["단가 (원)", "cost"],
        ["거래처", "supplier"],
      ],
      active("inventory_items"),
    ),
    sheet(
      "재고 이동",
      [
        ["시각 (UTC)", "created_at"],
        ["품목", (r) => inventory.get(r.item_id) ?? "품목 정보 없음"],
        ["이동 수량", (r) => r.delta_hundredths / 100],
        [
          "구분",
          (r) =>
            ({
              opening: "초기 재고",
              purchase: "매입",
              adjustment: "조정",
              reversal: "취소 반영",
            })[r.kind] ?? r.kind,
        ],
        ["메모", "note"],
      ],
      active("inventory_movements"),
    ),
  ];
}
