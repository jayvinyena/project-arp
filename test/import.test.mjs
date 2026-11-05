// 4.5단계: 엑셀 읽기 · 옛 시트 가져오기 · 옛 엔진과 대조
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { writeXlsx } from '../tools/lib/xlsx-write.mjs';
import { readXlsx, serialToDate } from '../core/xlsx.ts';
import { legacyToRows, writeImported } from '../core/import-legacy.ts';
import { SCHEMA_SQL } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { planView } from '../core/plan.ts';

const require = createRequire(import.meta.url);
const legacy = () => require('./fixtures/legacy-sample.cjs')();

async function importOf(sheets, options) {
  const read = await readXlsx(writeXlsx(sheets));
  const { rows, report } = legacyToRows(read, options);
  const raw = new DatabaseSync(':memory:');
  const db = nodeDb(raw);
  writeImported(db, SCHEMA_SQL, rows);
  return { raw, db, report, rows };
}

test('엑셀 읽기: 저장·압축 두 방식, 공유 문자열·특수 문자·참/거짓·빈칸, 날짜 일련번호', async () => {
  const sheets = { '시트 1': [['가', 'B & <C>', 1.5, true], [null, '', -3, false]], 'S2': [[], ['x']] };
  for (const compress of [false, true]) {
    const r = await readXlsx(writeXlsx(sheets, { compress }));
    assert.deepEqual(r['시트 1'], [['가', 'B & <C>', 1.5, true], [null, null, -3, false]]);
    assert.deepEqual(r.S2[1], ['x']);
  }
  assert.equal(serialToDate(46328), '2026-11-02');
  await assert.rejects(readXlsx(new Uint8Array([1, 2, 3, 4])), /엑셀 파일/);
});

test('가져오기: 옛 샘플 → 오류 없이 계산되고, 보고서에 바꾼 것이 남는다', async () => {
  const { raw, db, report, rows } = await importOf(legacy().sheets, { projectName: '옛 샘플' });
  const v = planView(db, new ProjectSession(db));
  raw.close();
  assert.equal(v.blocked, false, JSON.stringify(v.findings));
  assert.deepEqual(report.horizon, { start: '2026-11', end: '2027-06' });
  assert.equal(report.counts.resource_types, 4);
  assert.equal(report.counts.resource_groups, 3);
  assert.equal(report.counts.capacity, 32);
  assert.deepEqual(report.skipped, []);
  assert.ok(report.ignoredSheets.some(x => x.startsWith('04_Pipeline_Template')));
  assert.ok(report.adjustments.some(x => x.includes('겹침률') && x.includes('20%')));
  // 등급 → 숫자 순위: HIGH(S1 2/25, 런칭 4/29) → MEDIUM(이벤트 1/28, S2 5/27)
  const prio = Object.fromEntries(rows.updates.map(u => [u.update_id, u.priority]));
  assert.deepEqual(prio, { UPD_2027_S1: 1, LAUNCH_BASE: 2, UPD_2027_EV1: 3, UPD_2027_S2: 4 });
  // 이월 1 → 최저·목표·확장에 +1, SHOULD → 선택, 외주 수량 그대로
  const costume = rows.volumes.find(x => x.update_id === 'UPD_2027_S1' && x.resource_type_id === 'CHAR_COSTUME');
  assert.deepEqual([costume.min_qty, costume.target_qty, costume.stretch_qty, costume.required], [5, 7, 9, 1]);
  const prop = rows.volumes.find(x => x.update_id === 'UPD_2027_S1' && x.resource_type_id === 'BG_PROP');
  assert.deepEqual([prop.outsource_qty, prop.required, prop.reuse_rate], [5, 0, 0.2]);
  assert.equal(rows.update_types.find(t => t.update_type_id === 'LAUNCH').is_launch, 1);
  assert.equal(rows.settings[0].buffer_rate, 0.2);
});

test('가져오기: 날짜 일련번호·빈 출시일(목표 월 말일)·모르는 상태·없는 리소스 행', async () => {
  const f = legacy();
  const um = f.sheets['10_Update_Master'];
  um[1][3] = 46328;            // PLAN_START_DATE를 엑셀 날짜로
  um[2][5] = '';               // S1 출시일 비움 → 2027-02 말일
  um[3][8] = 'HOLD';           // 모르는 상태
  f.sheets['11_Update_Volume'].push(['X|NOPE', 'UPD_2027_S1', 'NOPE', 1, 1, 1, '', 0, 0, 0, 0, 0, 1, 'MUST', 'HIGH', '']);
  f.sheets['12_Capacity_Monthly'][1][1] = 46327; // 2026-11-01
  const { raw, rows, report } = await importOf(f.sheets, {});
  raw.close();
  assert.equal(rows.updates.find(u => u.update_id === 'LAUNCH_BASE').start_date, '2026-11-02');
  assert.equal(rows.updates.find(u => u.update_id === 'UPD_2027_S1').release_date, '2027-02-28');
  assert.equal(rows.updates.find(u => u.update_id === 'UPD_2027_EV1').status, 'PLANNED');
  assert.ok(report.adjustments.some(x => x.includes('HOLD')));
  assert.ok(report.skipped.some(x => x.includes('NOPE')));
});

test('가져오기: 옛 도구 시트가 아니면 빠진 시트를 알려 준다', async () => {
  const read = await readXlsx(writeXlsx({ 'Sheet1': [['a', 'b']] }));
  assert.throws(() => legacyToRows(read), /빠졌어요: 01_Part_Master/);
});

const LEGACY_ENGINE = fileURLToPath(new URL('../../arp/tests/harness/gas-runtime.js', import.meta.url));
test('대조: 옛 근무일 수에 맞추면 옛 엔진과 필요 공수·작업 가능량·완료 예정이 모두 같다', { skip: !existsSync(LEGACY_ENGINE) && '옛 도구 폴더(../arp)가 없어 건너뜀' }, async () => {
  const { compareLegacy } = await import('../tools/compare-legacy.mjs');
  const r = await compareLegacy(legacy(), { keepLegacyWorkdays: true });
  for (const p of r.parts) {
    assert.ok(Math.abs(p.oldRequired - p.newRequired) < 1e-6, `${p.partId} 필요 공수 ${p.oldRequired} ≠ ${p.newRequired}`);
    assert.ok(Math.abs(p.oldCapacity - p.newCapacity) < 1e-6, `${p.partId} 작업 가능량 ${p.oldCapacity} ≠ ${p.newCapacity}`);
  }
  for (const u of r.updates) assert.equal(u.diffCalendarDays, 0, `${u.updateId} ${u.oldCompletion} → ${u.newCompletion}`);
});
