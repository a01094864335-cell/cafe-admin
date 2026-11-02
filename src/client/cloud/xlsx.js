// Minimal offline XLSX writer: ZIP (stored entries) and explicit text/numeric cells.
function sheetXML(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c],
    );
}
function sheetColumn(index) {
  let result = "";
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}
function worksheetXML(rows) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultColWidth="20"/><sheetData>' +
    rows
      .map(
        (row, i) =>
          '<row r="' +
          (i + 1) +
          '">' +
          row
            .map((v, j) => {
              const ref = sheetColumn(j) + (i + 1);
              if (v === null || v === undefined) return '<c r="' + ref + '"/>';
              return typeof v === "number" && Number.isFinite(v)
                ? '<c r="' + ref + '"><v>' + v + "</v></c>"
                : '<c r="' +
                    ref +
                    '" t="inlineStr"><is><t xml:space="preserve">' +
                    sheetXML(v) +
                    "</t></is></c>";
            })
            .join("") +
          "</row>",
      )
      .join("") +
    "</sheetData></worksheet>"
  );
}
export function workbookBytes(sheets) {
  const enc = new TextEncoder(),
    files = [],
    central = [],
    chunks = [];
  let offset = 0;
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  files.push([
    "[Content_Types].xml",
    xml +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets
        .map(
          (_, i) =>
            '<Override PartName="/xl/worksheets/sheet' +
            (i + 1) +
            '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
        )
        .join("") +
      "</Types>",
  ]);
  files.push([
    "_rels/.rels",
    xml +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  ]);
  files.push([
    "xl/workbook.xml",
    xml +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets
        .map(
          (s, i) =>
            '<sheet name="' +
            sheetXML(s.name) +
            '" sheetId="' +
            (i + 1) +
            '" r:id="rId' +
            (i + 1) +
            '"/>',
        )
        .join("") +
      "</sheets></workbook>",
  ]);
  files.push([
    "xl/_rels/workbook.xml.rels",
    xml +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets
        .map(
          (_, i) =>
            '<Relationship Id="rId' +
            (i + 1) +
            '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
            (i + 1) +
            '.xml"/>',
        )
        .join("") +
      "</Relationships>",
  ]);
  sheets.forEach((s, i) =>
    files.push([
      "xl/worksheets/sheet" + (i + 1) + ".xml",
      worksheetXML(s.rows),
    ]),
  );
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  const header = (size) => {
    const b = new Uint8Array(size);
    return [b, new DataView(b.buffer)];
  };
  for (const [path, content] of files) {
    const name = enc.encode(path),
      data = enc.encode(content);
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const [local, l] = header(30);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(12, 33, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true);
    chunks.push(local, name, data);
    const [record, c] = header(46);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(14, 33, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(record, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0),
    [end, e] = header(22);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  const result = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const b of [...chunks, ...central, end]) {
    result.set(b, cursor);
    cursor += b.length;
  }
  return result;
}
