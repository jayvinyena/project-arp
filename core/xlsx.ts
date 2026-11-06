// .xlsx 읽기 (라이브러리 없음): ZIP 목차 → 필요한 XML만 풀기(DecompressionStream) → 시트별 2차원 배열.
// 브라우저 Worker와 Node 18+에서 같이 돈다. 서식·수식·병합은 보지 않는다(값만).

export type Cell = string | number | boolean | null;
export type Sheets = Record<string, Cell[][]>;

interface Entry { name: string; method: number; compressedSize: number; offset: number }

function u16(b: Uint8Array, i: number) { return b[i] | (b[i + 1] << 8); }
function u32(b: Uint8Array, i: number) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

function zipEntries(b: Uint8Array): Map<string, Entry> {
  // 끝에서 중앙 목록 끝 표시(0x06054b50)를 찾는다
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65536); i -= 1) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('엑셀 파일(.xlsx)이 아닙니다. 구글 시트에서 "파일 → 다운로드 → Microsoft Excel"로 받으십시오.');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const dec = new TextDecoder();
  const out = new Map<string, Entry>();
  for (let n = 0; n < count; n += 1) {
    if (u32(b, p) !== 0x02014b50) throw new Error('엑셀 파일 목차가 깨졌습니다.');
    const method = u16(b, p + 10);
    const compressedSize = u32(b, p + 20);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const offset = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { name, method, compressedSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(b: Uint8Array, e: Entry): Promise<string> {
  if (u32(b, e.offset) !== 0x04034b50) throw new Error(`엑셀 파일 안의 ${e.name}을 읽지 못했습니다.`);
  const start = e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28);
  const raw = b.subarray(start, start + e.compressedSize);
  const data = e.method === 0 ? raw : e.method === 8 ? await inflateRaw(raw) : null;
  if (!data) throw new Error(`지원하지 않는 압축 방식(${e.method})입니다.`);
  return new TextDecoder().decode(data);
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e]);
}
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? unescapeXml(m[1] ?? m[2]) : null;
}
/** <t> 조각들을 이어 붙인 글자 (서식 조각 <r><t>도 포함, 발음 <rPh>는 뺀다) */
function textOf(xml: string): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of clean.matchAll(/<t\b[^>]*?\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += m[1] ? unescapeXml(m[1]) : '';
  return s;
}
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export async function readXlsx(bytes: Uint8Array): Promise<Sheets> {
  const entries = zipEntries(bytes);
  const get = async (name: string) => { const e = entries.get(name); return e ? readEntry(bytes, e) : null; };
  const workbook = await get('xl/workbook.xml');
  const rels = await get('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new Error('엑셀 통합 문서 정보를 찾지 못했습니다.');
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const t = attr(m[1], 'Target');
    if (id && t) targets.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`);
  }
  const shared: string[] = [];
  const sst = await get('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*?\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(m[1] ? textOf(m[1]) : '');

  const sheets: Sheets = {};
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1], 'name');
    const rid = attr(m[1], 'r:id');
    const path = rid ? targets.get(rid) : null;
    if (!name || !path) continue;
    const xml = await get(path);
    if (!xml) continue;
    const rows: Cell[][] = [];
    for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const ri = Number(attr(r[1], 'r') ?? rows.length + 1) - 1;
      const row: Cell[] = [];
      let auto = 0;
      for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], 'r');
        const ci = ref ? colIndex(ref) : auto;
        auto = ci + 1;
        const t = attr(c[1], 't');
        const inner = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value: Cell = null;
        if (t === 's') value = v == null ? null : shared[Number(v)] ?? null;
        else if (t === 'inlineStr') value = textOf(inner);
        else if (t === 'b') value = v === '1';
        else if (t === 'str' || t === 'e') value = v == null ? null : unescapeXml(v);
        else if (t === 'd') value = v == null ? null : unescapeXml(v).slice(0, 10); // 날짜형 칸(ISO 글자)
        else if (v != null && v !== '') value = Number(v);
        row[ci] = value;
      }
      for (let i = 0; i < row.length; i += 1) if (row[i] === undefined) row[i] = null;
      rows[ri] = row;
    }
    for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
    sheets[name] = rows;
  }
  return sheets;
}

/** 엑셀 날짜 일련번호 → YYYY-MM-DD (1900 날짜 체계) */
export function serialToDate(n: number): string {
  const ms = Math.round((n - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}
