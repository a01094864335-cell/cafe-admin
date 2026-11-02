import test from "node:test";
import assert from "node:assert/strict";
import { backupSheets, sheetFile } from "../src/client/cloud/sheet-export.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const backup = {
  cafe: { name: "요요 & <카페>" },
  exportedAt: "2026-11-02T00:00:00Z",
  tables: {
    sales: [
      {
        business_date: "2026-10-01",
        card: 0,
        cash: null,
        transfer: -10,
        note: "=SUM(A1:A2)",
      },
      {
        business_date: "2026-10-02",
        card: 100,
        cash: 0,
        transfer: 0,
        deleted_at: "2026-11-01",
      },
    ],
    employees: [{ id: "e", name: "직원", linked_user_id: "private-user" }],
    work_logs: [
      {
        employee_id: "e",
        business_date: "2026-10-01",
        start_time: "09:00",
        end_time: "13:00",
        break_minutes: 0,
        note: "@memo",
      },
    ],
    inventory_items: [
      {
        id: "i",
        name: "우유",
        quantity_hundredths: 125,
        minimum_hundredths: 200,
        cost: null,
        supplier: "가게",
      },
    ],
    inventory_movements: [
      {
        item_id: "i",
        delta_hundredths: -25,
        kind: "adjustment",
        note: "줄\n바꿈\u0001",
      },
    ],
  },
};
test("all business tables, deleted records, units, empty values and employee names", async () => {
  const sheets = backupSheets(backup);
  assert.equal(sheets.length, 14);
  assert.deepEqual(sheets.find((s) => s.name === "매출").rows[1], [
    "2026-10-01",
    0,
    null,
    -10,
    -10,
    "=SUM(A1:A2)",
  ]);
  assert.equal(sheets.find((s) => s.name === "매출").rows.length, 2);
  assert.equal(sheets.find((s) => s.name === "근무").rows[1][0], "직원");
  assert.equal(sheets.find((s) => s.name === "재고 품목").rows[1][1], 1.25);
  assert.equal(sheets.find((s) => s.name === "재고 이동").rows[1][2], -0.25);
  const missing = structuredClone(backup);
  missing.tables.work_logs[0].break_missing = 1;
  missing.tables.payroll_settings = [{id:'s',employee_id:'e',weekly_hours:0,weekly_hours_missing:1}];
  const missingSheets = backupSheets(missing);
  assert.equal(missingSheets.find(s=>s.name==='근무').rows[1][4],null);
  assert.equal(missingSheets.find(s=>s.name==='급여 설정').rows[1][5],null);
  const file = sheetFile(backup),
    dir = await mkdtemp(join(tmpdir(), "cafe-xlsx-"));
  try {
    const path = join(dir, "sheet.xlsx");
    await writeFile(path, new Uint8Array(await file.arrayBuffer()));
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import sys,zipfile,xml.etree.ElementTree as E
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 for p in z.namelist(): E.fromstring(z.read(p))
 assert len(E.fromstring(z.read('xl/workbook.xml')).find('s:sheets',ns))==14
 text=b''.join(z.read(p) for p in z.namelist()).decode()
 assert 'private-user' not in text and 'linked_user_id' not in text
 root=E.fromstring(z.read('xl/worksheets/sheet2.xml'))
 assert not root.findall('.//s:f',ns)
 row=root.find('s:sheetData',ns)[1]
 assert row[1].find('s:v',ns).text=='0'
 assert len(row[2])==0
 assert row[3].find('s:v',ns).text=='-10'
 assert row[5].attrib['t']=='inlineStr'
 assert ''.join(row[5].itertext())=='=SUM(A1:A2)'
 assert '\\x01' not in text
`,
        path,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.ok(
    (await sheetFile({ cafe: { name: "빈 카페" }, tables: {} }).arrayBuffer())
      .byteLength > 0,
  );
});
