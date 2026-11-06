// 최소 .xlsx 쓰기: 시트 = 2차원 배열. 글자는 공유 문자열, 숫자·참/거짓은 그대로.
// 브라우저(내보내기)와 Node(검사·대조)가 같이 쓴다. deflate를 주면 압축(8), 없으면 저장(0) 방식.
export type Cell = string | number | boolean | Date | null | undefined;
/** 꾸민 칸(양식용): req = 필수 머리글, opt = 선택 머리글, note = 회색 설명, title = 큰 제목, sub = 소제목 */
export interface StyledCell { v: string | number; s: 'req' | 'opt' | 'note' | 'title' | 'sub' }
const STYLE_ID: Record<StyledCell['s'], number> = { req: 3, opt: 4, note: 5, title: 6, sub: 7 };
const isStyled = (v: unknown): v is StyledCell => typeof v === 'object' && v !== null && !(v instanceof Date) && 's' in (v as object);
export type DeflateRaw = (data: Uint8Array) => Uint8Array;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

function zip(files: [string, string][], deflate?: DeflateRaw): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = enc.encode(text);
    const body = deflate ? deflate(data) : data;
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, deflate ? 8 : 0, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nameBytes.length, true);
    chunks.push(local, nameBytes, body);
    const cen = new Uint8Array(46);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, deflate ? 8 : 0, true); cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true); cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true);
    central.push(cen, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'http://schemas.openxmlformats.org';

/** sheets: { 시트 이름: [[...], ...] } → .xlsx 바이트. 첫 행은 굵게 고정, 열 너비는 글자 수에 맞춘다 */
export function writeXlsx(sheets: Record<string, (Cell | StyledCell)[][]>, options: { deflate?: DeflateRaw; freezeRows?: Record<string, number> } = {}): Uint8Array {
  const names = Object.keys(sheets);
  const strings: string[] = [];
  const index = new Map<string, number>();
  const si = (s: string) => { if (!index.has(s)) { index.set(s, strings.length); strings.push(s); } return index.get(s)!; };
  const sheetXml = (rows: (Cell | StyledCell)[][], freeze = 1) => {
    const widths: number[] = [];
    rows.forEach(row => row.forEach((cell, c) => {
      const v = isStyled(cell) ? (cell.s === 'title' || cell.s === 'note' ? null : cell.v) : cell;
      const len = v == null ? 0 : [...String(v)].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
      widths[c] = Math.min(60, Math.max(widths[c] ?? 6, len + 2));
    }));
    const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
      const v = isStyled(cell) ? cell.v : cell;
      if (v == null || v === '') return '';
      const ref = `${colName(c)}${r + 1}`;
      const style = isStyled(cell) ? ` s="${STYLE_ID[cell.s]}"` : r === 0 && freeze > 0 ? ' s="1"' : '';
      if (v instanceof Date) {
        // 날짜: 엑셀 일련번호(1899-12-30부터 일 수) + 날짜 서식(구글 시트·엑셀이 내보내는 모양)
        const serial = (Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86400000;
        return Number.isFinite(serial) ? `<c r="${ref}" s="2"><v>${serial}</v></c>` : '';
      }
      if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"${style}><v>${v}</v></c>` : '';
      if (typeof v === 'boolean') return `<c r="${ref}" t="b"${style}><v>${v ? 1 : 0}</v></c>`;
      return `<c r="${ref}" t="s"${style}><v>${si(String(v))}</v></c>`;
    }).join('')}</row>`).join('');
    const pane = rows.length > 1 && freeze > 0 ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '';
    return `${XML}<worksheet xmlns="${NS}/spreadsheetml/2006/main">${pane}${cols}<sheetData>${body}</sheetData></worksheet>`;
  };
  const files: [string, string][] = [
    ['[Content_Types].xml', `${XML}<Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="${NS}/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="${NS}/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId${names.length + 2}" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `${XML}<styleSheet xmlns="${NS}/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Malgun Gothic"/></font><font><b/><sz val="11"/><name val="Malgun Gothic"/></font><font><i/><sz val="10"/><color rgb="FF8A8A93"/><name val="Malgun Gothic"/></font><font><b/><sz val="14"/><name val="Malgun Gothic"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE4E4FA"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1F1F3"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="8"><xf fontId="0"/><xf fontId="1" applyFont="1"/><xf fontId="0" numFmtId="164" applyNumberFormat="1"/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/><xf fontId="1" fillId="3" applyFont="1" applyFill="1"/><xf fontId="2" applyFont="1"><alignment wrapText="1" vertical="top"/></xf><xf fontId="3" applyFont="1"/><xf fontId="1" fillId="3" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`],
    ...names.map((n, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheets[n], options.freezeRows?.[n] ?? 1)]),
  ];
  files.push(['xl/sharedStrings.xml', `${XML}<sst xmlns="${NS}/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`]);
  return zip(files, options.deflate);
}
export { zip as zipFiles };
