'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// rows: array of arrays (first row = header). Returns Buffer of .xlsx
function buildXlsx(rows) {
  const sheetRows = rows.map((row, ri) => {
    const cells = row.map((val, ci) => {
      const ref = colName(ci) + (ri + 1);
      if (typeof val === 'number' && Number.isFinite(val)) {
        return `<c r="${ref}"><v>${val}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(val)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Responses" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-'));
  fs.mkdirSync(path.join(tmp, '_rels'));
  fs.mkdirSync(path.join(tmp, 'xl', '_rels'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'xl', 'worksheets'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '[Content_Types].xml'), contentTypes);
  fs.writeFileSync(path.join(tmp, '_rels', '.rels'), rootRels);
  fs.writeFileSync(path.join(tmp, 'xl', 'workbook.xml'), workbook);
  fs.writeFileSync(path.join(tmp, 'xl', '_rels', 'workbook.xml.rels'), wbRels);
  fs.writeFileSync(path.join(tmp, 'xl', 'worksheets', 'sheet1.xml'), sheetXml);

  const outFile = path.join(tmp, 'out.xlsx');
  // zip: content_types first (stored), then rest
  execFileSync('zip', ['-X', '-q', 'out.xlsx', '[Content_Types].xml'], { cwd: tmp });
  execFileSync('zip', ['-rX', '-q', 'out.xlsx', '_rels', 'xl'], { cwd: tmp });
  const buf = fs.readFileSync(outFile);
  fs.rmSync(tmp, { recursive: true, force: true });
  return buf;
}

function colName(i) {
  let s = '';
  i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

module.exports = { buildXlsx };
