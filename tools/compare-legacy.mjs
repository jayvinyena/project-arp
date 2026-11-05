// 옛 엔진 ↔ 새 엔진 결과 대조: 같은 옛 시트 데이터를
//   ① 옛 도구 엔진(../arp, Apps Script 코드를 Node 하네스로)으로 계산하고
//   ② 엑셀로 내보냈다가 새 가져오기로 들여와 새 엔진으로 계산해
// 파트별 필요 공수·작작업 가능량과 업데이트별 완료 예정을 나란히 놓는다.
//   node tools/compare-legacy.mjs [구글 시트에서 내려받은 .xlsx · 옛 fixture(.json · .cjs)] [--json]
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { toExportedXlsx } from './gen-operating-sheet.mjs';
import { readXlsx, serialToDate } from '../core/xlsx.ts';
import { legacyToRows, writeImported } from '../core/import-legacy.ts';
import { SCHEMA_SQL } from './lib/project-db.mjs';
import { nodeDb, readProjectData } from './lib/pipeline.mjs';
import { runPlan } from '../engine/index.ts';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LEGACY = `${ROOT}../arp`;
const arg = process.argv.slice(2).find(a => !a.startsWith('--'));

/** 구글 시트에서 내려받은 .xlsx → 옛 하네스가 읽는 모양(날짜 칸의 엑셀 날짜는 'YYYY-MM-DD' 글자 → 하네스가 Date로 바꾼다) */
export async function fixtureFromXlsx(bytes) {
  const sheets = await readXlsx(new Uint8Array(bytes));
  const isDateCol = h => /DATE|YEAR_MONTH|_AT$|^EFFECTIVE_/.test(String(h ?? ''));
  for (const rows of Object.values(sheets)) {
    const head = rows[0] ?? [];
    for (const row of rows.slice(1)) head.forEach((h, i) => { if (isDateCol(h) && typeof row[i] === 'number') row[i] = serialToDate(row[i]); });
  }
  return { name: 'xlsx', sheets };
}

async function loadFixture() {
  if (!arg) return require('../test/fixtures/legacy-sample.cjs')();
  if (arg.endsWith('.json')) return JSON.parse(readFileSync(arg, 'utf8'));
  if (arg.endsWith('.xlsx')) return fixtureFromXlsx(readFileSync(arg));
  return require(arg)();
}

export async function compareLegacy(fixture, { keepLegacyWorkdays }) {
  if (!existsSync(`${LEGACY}/tests/harness/gas-runtime.js`)) throw new Error(`옛 도구 폴더를 찾지 못했어요: ${LEGACY}`);
  const { createRuntime } = require(`${LEGACY}/tests/harness/gas-runtime.js`);
  const rt = createRuntime(fixture);
  const old = rt.call('arpRunSimulation', { planMode: 'TARGET', scheduler: 'STAGE' });

  // 구글 시트 → 엑셀 내보내기와 같은 모양(날짜 칸은 엑셀 날짜)
  const sheets = await readXlsx(toExportedXlsx(fixture));
  const { rows, report } = legacyToRows(sheets, { fixedHolidays: !keepLegacyWorkdays, keepLegacyWorkdays, legacyCompat: keepLegacyWorkdays });
  const raw = new DatabaseSync(':memory:');
  writeImported(nodeDb(raw), SCHEMA_SQL, rows);
  const neu = runPlan(readProjectData(raw), { planMode: 'TARGET' });
  raw.close();

  // 옛 결과의 작업 가능량은 시트에 적힌 인력 행만 더한 값이다 → 새 쪽도 같은 달만 더해 비교한다
  const capMonths = new Set(fixture.sheets['12_Capacity_Monthly'].slice(1).map(r => String(r[1] ?? '').slice(0, 7)).filter(Boolean));
  const parts = (old.partResults ?? []).map(p => {
    const n = neu.parts.find(x => x.partId === p.partId);
    const explicit = neu.partMonths.filter(m => m.partId === p.partId && capMonths.has(m.month)).reduce((a, m) => a + m.capacityDays, 0);
    return { partId: p.partId, oldRequired: p.requiredDays, newRequired: n?.requiredDays ?? null, oldCapacity: p.capacityDays ?? p.totalCapacityDays ?? null, newCapacity: n ? explicit : null };
  });
  const updates = (old.updateResults ?? []).map(u => {
    const n = neu.updates.find(x => x.updateId === u.updateId);
    const a = u.expectedCompletionDate;
    const b = n?.expectedCompletionDate ?? null;
    const days = a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 86400000) : null;
    return { updateId: u.updateId, oldCompletion: a ?? null, newCompletion: b, diffCalendarDays: days, newStatus: n?.status ?? null };
  });
  return { keepLegacyWorkdays, parts, updates, report };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fixture = await loadFixture();
  const out = [];
  for (const keep of [true, false]) {
    const r = await compareLegacy(fixture, { keepLegacyWorkdays: keep });
    out.push(r);
    if (process.argv.includes('--json')) continue;
    console.log(`\n■ ${keep ? '옛 계산 방식 흉내(대조용: 옛 근무일 수 · 상태 무시 · 인력 없는 달은 마지막 달 되풀이)' : '새 방식(기본: 근무 달력 · 출시 완료·취소 제외 · 인력 있는 달만)'}`);
    if (!keep) for (const a of r.report.adjustments.filter(x => /옛 도구는/.test(x))) console.log(`  · ${a}`);
    console.log('  파트        필요 공수 옛 → 새        작업 가능량 옛 → 새');
    for (const p of r.parts) {
      const f = x => (x == null ? '—' : x.toFixed(1)).padStart(7);
      console.log(`  ${p.partId.padEnd(10)} ${f(p.oldRequired)} → ${f(p.newRequired)}     ${f(p.oldCapacity)} → ${f(p.newCapacity)}`);
    }
    console.log('  업데이트       완료 예정 옛 → 새            차이(일)');
    for (const u of r.updates) console.log(`  ${u.updateId.padEnd(14)} ${u.oldCompletion ?? '—'} → ${u.newCompletion ?? '—'}   ${u.diffCalendarDays == null ? '—' : (u.diffCalendarDays > 0 ? '+' : '') + u.diffCalendarDays}`);
  }
  mkdirSync(`${ROOT}samples/out`, { recursive: true });
  writeFileSync(`${ROOT}samples/out/compare-legacy.json`, JSON.stringify(out, null, 2));
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else console.log('\n원자료: samples/out/compare-legacy.json');

  // --check: 옛 계산 방식 흉내에서 모두 같아야 통과(종료 코드 0), 하나라도 다르면 2
  if (process.argv.includes('--check')) {
    const compat = out[0];
    const bad = [
      ...compat.parts.filter(p => Math.abs((p.oldRequired ?? 0) - (p.newRequired ?? 0)) > 1e-6).map(p => `${p.partId} 필요 공수`),
      ...compat.parts.filter(p => Math.abs((p.oldCapacity ?? 0) - (p.newCapacity ?? 0)) > 1e-6).map(p => `${p.partId} 작업 가능량`),
      ...compat.updates.filter(u => u.diffCalendarDays !== 0).map(u => `${u.updateId} 완료 예정(${u.oldCompletion ?? '—'} → ${u.newCompletion ?? '—'})`),
    ];
    if (bad.length) {
      console.log(`\n[대조 실패] 옛 계산 방식 흉내에서 ${bad.length}곳이 달라요: ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ' …' : ''}`);
      process.exit(2);
    }
    console.log(`\n[대조 통과] 옛 계산 방식 흉내에서 파트 ${compat.parts.length}개 · 업데이트 ${compat.updates.length}개가 옛 엔진과 모두 같아요`);
  }
}
