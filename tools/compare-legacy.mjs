// 옛 엔진 ↔ 새 엔진 결과 대조: 같은 옛 시트 데이터를
//   ① 옛 도구 엔진(../arp, Apps Script 코드를 Node 하네스로)으로 계산하고
//   ② 엑셀로 내보냈다가 새 가져오기로 들여와 새 엔진으로 계산해
// 파트별 필요 공수·작작업 가능량과 업데이트별 완료 예정을 나란히 놓는다.
//   node tools/compare-legacy.mjs [옛 fixture 경로(.json 또는 .cjs)] [--json]
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { writeXlsx } from './lib/xlsx-write.mjs';
import { readXlsx } from '../core/xlsx.ts';
import { legacyToRows, writeImported } from '../core/import-legacy.ts';
import { SCHEMA_SQL } from './lib/project-db.mjs';
import { nodeDb, readProjectData } from './lib/pipeline.mjs';
import { runPlan } from '../engine/index.ts';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LEGACY = `${ROOT}../arp`;
const arg = process.argv.slice(2).find(a => !a.startsWith('--'));

function loadFixture() {
  if (!arg) return require('../test/fixtures/legacy-sample.cjs')();
  if (arg.endsWith('.json')) return JSON.parse(readFileSync(arg, 'utf8'));
  return require(arg)();
}

export async function compareLegacy(fixture, { keepLegacyWorkdays }) {
  if (!existsSync(`${LEGACY}/tests/harness/gas-runtime.js`)) throw new Error(`옛 도구 폴더를 찾지 못했어요: ${LEGACY}`);
  const { createRuntime } = require(`${LEGACY}/tests/harness/gas-runtime.js`);
  const rt = createRuntime(fixture);
  const old = rt.call('arpRunSimulation', { planMode: 'TARGET', scheduler: 'STAGE' });

  const sheets = await readXlsx(writeXlsx(fixture.sheets));
  const { rows, report } = legacyToRows(sheets, { fixedHolidays: !keepLegacyWorkdays, keepLegacyWorkdays });
  const raw = new DatabaseSync(':memory:');
  writeImported(nodeDb(raw), SCHEMA_SQL, rows);
  const neu = runPlan(readProjectData(raw), { planMode: 'TARGET' });
  raw.close();

  const parts = (old.partResults ?? []).map(p => {
    const n = neu.parts.find(x => x.partId === p.partId);
    return { partId: p.partId, oldRequired: p.requiredDays, newRequired: n?.requiredDays ?? null, oldCapacity: p.capacityDays ?? p.totalCapacityDays ?? null, newCapacity: n?.capacityDays ?? null };
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
  const fixture = loadFixture();
  const out = [];
  for (const keep of [true, false]) {
    const r = await compareLegacy(fixture, { keepLegacyWorkdays: keep });
    out.push(r);
    if (process.argv.includes('--json')) continue;
    console.log(`\n■ ${keep ? '옛 근무일 수에 맞춤(대조용)' : '새 근무 달력(기본: 월–금, 고정 공휴일 제외)'}`);
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
}
