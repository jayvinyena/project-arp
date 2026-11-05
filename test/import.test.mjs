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
  // 일정 짜는 방식까지: 파트×달 배정 공수, 공정별 시작·완료일
  assert.ok(r.months.length > 0 && r.months.every(m => m.same), JSON.stringify(r.months.filter(m => !m.same).slice(0, 3)));
  assert.ok(r.stages.length > 0 && r.stages.every(g => g.same), JSON.stringify(r.stages.filter(g => !g.same).slice(0, 3)));
});

// ───────── 운영 시트 흉내(tools/gen-operating-sheet.mjs): 실제 규모 · 운영 흔적 ─────────
const { buildOperatingFixture, toExportedXlsx } = await import('../tools/gen-operating-sheet.mjs');

test('사용 여부(ACTIVE): 옛 도구처럼 체크·TRUE·Y·YES·1만 사용, 빈칸·그 밖의 글자는 사용 안 함', async () => {
  const f = legacy();
  const p = f.sheets['01_Part_Master'];
  p[1][3] = 'Y'; p[2][3] = ''; p[3][3] = '사용'; p[4][3] = 'yes';
  const { raw, rows } = await importOf(f.sheets);
  raw.close();
  assert.deepEqual(rows.parts.map(x => [x.part_id, x.active]), [['CONCEPT', 1], ['MODEL', 0], ['ANIM', 0], ['UI', 1]]);
});

test('운영 시트: 엑셀 날짜·보조 시트·보조 칸이 있어도 막힘 없이 계산되고, 옛 도구와 달라지는 이유를 알린다', async () => {
  const sheets = await readXlsx(toExportedXlsx(buildOperatingFixture()));
  const { rows, report } = legacyToRows(sheets, { projectName: '운영' });
  assert.deepEqual(report.horizon, { start: '2026-11', end: '2028-10' });
  assert.equal(report.skipped.length, 0, report.skipped.join(' / '));
  assert.equal(report.ignoredSheets.length, 8);
  assert.equal(rows.updates.length, 14);
  assert.deepEqual(rows.updates.filter(u => u.status === 'DONE' || u.status === 'CANCELLED').map(u => u.update_id).sort(), ['CBT_2026', 'UPD_COLLAB', 'UPD_MINI3']);
  assert.ok(report.adjustments.some(a => a.includes('인력 첫 달(2026-11)보다 먼저') && a.includes('정식 런칭')));
  assert.ok(report.adjustments.some(a => a.includes('출시 완료·취소') && a.includes('CBT 빌드') && a.includes('콜라보')));
  assert.equal(rows.updates.find(u => u.update_id === 'UPD_S4').release_date, '2028-07-31', '빈 출시일 → 목표 월 말일');
  assert.equal(rows.updates.find(u => u.update_id === 'LAUNCH_2027').start_date, '2026-09-01', '엑셀 날짜 → 날짜');
  const raw = new DatabaseSync(':memory:');
  const db = nodeDb(raw);
  writeImported(db, SCHEMA_SQL, rows);
  const session = new ProjectSession(db);
  const p = session.prepare();
  const result = session.calculate().result;
  raw.close();
  assert.equal(p.blocked, false, p.findings.map(x => x.code).join(','));
  assert.equal(result.updates.length, 11);
  assert.ok(result.updates.every(u => u.expectedCompletionDate), '모두 계획 기간 안에 끝난다');
});

test('대조(운영 시트): 옛 계산 방식 흉내면 출시 완료·취소까지 13개 업데이트·6파트가 옛 엔진과 모두 같다', { skip: !existsSync(LEGACY_ENGINE) && '옛 도구 폴더(../arp)가 없어 건너뜀' }, async () => {
  const { compareLegacy, fixtureFromXlsx } = await import('../tools/compare-legacy.mjs');
  // 구글 시트에서 내려받은 .xlsx를 그대로 넣는 길(엑셀 날짜 → 날짜)로 대조한다
  const r = await compareLegacy(await fixtureFromXlsx(toExportedXlsx(buildOperatingFixture())), { keepLegacyWorkdays: true });
  assert.equal(r.parts.length, 6);
  assert.equal(r.updates.length, 13);
  for (const p of r.parts) {
    assert.ok(Math.abs(p.oldRequired - p.newRequired) < 1e-6, `${p.partId} 필요 공수 ${p.oldRequired} ≠ ${p.newRequired}`);
    assert.ok(Math.abs(p.oldCapacity - p.newCapacity) < 1e-6, `${p.partId} 작업 가능량 ${p.oldCapacity} ≠ ${p.newCapacity}`);
  }
  for (const u of r.updates) assert.equal(u.diffCalendarDays, 0, `${u.updateId} ${u.oldCompletion} → ${u.newCompletion}`);
  // 일정 짜는 방식까지: 파트×달 배정 공수, 공정별 시작·완료일
  assert.ok(r.months.length > 0 && r.months.every(m => m.same), JSON.stringify(r.months.filter(m => !m.same).slice(0, 3)));
  assert.ok(r.stages.length > 0 && r.stages.every(g => g.same), JSON.stringify(r.stages.filter(g => !g.same).slice(0, 3)));
});

test('가져오기: 중복 행·소수 순서·소수 템플릿 수량·달력에 없는 날짜가 있어도 전체가 실패하지 않고 보고한다(전체 점검에서 찾음)', async () => {
  const f = legacy();
  f.sheets['01_Part_Master'].push([...f.sheets['01_Part_Master'][1]]);
  f.sheets['03_Effort_Standard'].push([...f.sheets['03_Effort_Standard'][1]]);
  f.sheets['06_Update_Volume_Template'].push([...f.sheets['06_Update_Volume_Template'][1]]);
  f.sheets['06_Update_Volume_Template'][2][3] = 2.5;
  f.sheets['10_Update_Master'][1][13] = 1.5;
  f.sheets['10_Update_Master'][2][5] = '2027-02-30';
  f.sheets['13_Progress_Actual'].push(['UPD_2027_S1', 'CHAR_COSTUME', 'CONCEPT', 5, 0, 0, '2026-11-20']);
  const { raw, db, report, rows } = await importOf(f.sheets);
  raw.close();
  assert.equal(rows.parts.length, 4);
  assert.ok(report.skipped.some(x => x.includes('파트 CONCEPT')));
  assert.ok(report.skipped.some(x => x.includes('공수 CHAR_COSTUME|CONCEPT')));
  assert.ok(report.skipped.some(x => x.includes('템플릿 SEASON|CHAR_NEW')));
  assert.equal(rows.updates.find(u => u.update_id === 'LAUNCH_BASE').sort_order, 2);
  assert.equal(rows.progress.find(p => p.update_id === 'UPD_2027_S1' && p.resource_type_id === 'CHAR_COSTUME').completed_qty, 5, '같은 실적은 뒤의 값');
});

test('엑셀 읽기: 빈 공유 문자열 <si/> · 빈 조각 <t/> · 날짜형 칸 · 작은따옴표 속성(전체 점검에서 찾음)', async () => {
  const { zipFiles } = await import('../core/xlsx-write.ts');
  const X = '<?xml version="1.0" encoding="UTF-8"?>';
  const NS = 'http://schemas.openxmlformats.org';
  const bytes = zipFiles([
    ['xl/workbook.xml', `${X}<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name='S' sheetId='1' r:id='rId1'/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${X}<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/sharedStrings.xml', `${X}<sst><si/><si><t>둘</t></si><si><r><t/></r><r><t>셋</t></r></si></sst>`],
    ['xl/worksheets/sheet1.xml', `${X}<worksheet><sheetData><row r='1'><c r='A1' t='s'><v>0</v></c><c r='B1' t='s'><v>1</v></c><c r='C1' t='s'><v>2</v></c><c r='D1' t='d'><v>2027-03-15T00:00:00</v></c></row></sheetData></worksheet>`],
  ]);
  const r = await readXlsx(bytes);
  assert.deepEqual(r.S[0], ['', '둘', '셋', '2027-03-15']);
});

test('실제 운영 시트에서 찾은 것: 빈 시작일 · UNCLASSIFIED · 한국어 상태 · AS_OF_DATE·ACTUAL_EFFORT_DAYS · ACTIVE 칸 없는 템플릿 · 0 공수', async () => {
  const f = legacy();
  const um = f.sheets['10_Update_Master'];
  const h = um[0];
  const row = um[4]; // UPD_2027_S2
  row[h.indexOf('PLAN_START_DATE')] = '';
  row[h.indexOf('STATUS')] = '예정';
  um[1][h.indexOf('STATUS')] = '진행 중';
  const vh = f.sheets['11_Update_Volume'][0];
  f.sheets['11_Update_Volume'][1][vh.indexOf('REQUIRED_LEVEL')] = 'UNCLASSIFIED';
  f.sheets['11_Update_Volume'][5][vh.indexOf('REQUIRED_LEVEL')] = 'SHOULD';
  // 실적: 실제 시트처럼 AS_OF_DATE · ACTUAL_EFFORT_DAYS 칸
  f.sheets['13_Progress_Actual'] = [['UPDATE_ID', 'RESOURCE_ID', 'PART_ID', 'COMPLETED_QTY', 'OUTSOURCE_COMPLETED_QTY', 'SPEC_OUT_QTY', 'AS_OF_DATE', 'ACTUAL_EFFORT_DAYS'],
    ['UPD_2027_S1', 'CHAR_COSTUME', 'CONCEPT', 3, 0, 0, '2026-11-03', 7.5]];
  // 템플릿: ACTIVE 칸이 아예 없고 최저가 빔
  f.sheets['06_Update_Volume_Template'] = [['UPDATE_TYPE_ID', 'RESOURCE_ID', 'MIN_QTY', 'TARGET_QTY', 'STRETCH_QTY'], ['SEASON', 'CHAR_NEW', '', 2, 3]];
  // 공수 0 = 그 파트에서는 할 일 없음
  const eh = f.sheets['03_Effort_Standard'][0];
  f.sheets['03_Effort_Standard'][1][eh.indexOf('BASE_DAYS')] = 0;
  const { raw, db, report, rows } = await importOf(f.sheets);
  const session = new ProjectSession(db);
  const p = session.prepare();
  raw.close();
  const s2 = rows.updates.find(u => u.update_id === 'UPD_2027_S2');
  assert.equal(s2.start_date, `${report.horizon.start}-01`);
  assert.ok(report.adjustments.some(a => a.includes('시작일이 빈 업데이트 1개')));
  assert.equal(s2.status, 'PLANNED');
  assert.equal(rows.updates.find(u => u.update_id === 'LAUNCH_BASE').status, 'IN_PROGRESS');
  assert.ok(!report.adjustments.some(a => a.includes('알 수 없는 상태')));
  assert.equal(rows.volumes.find(v => v.update_id === 'LAUNCH_BASE' && v.resource_type_id === 'CHAR_NEW').required, 1, 'UNCLASSIFIED = 필수');
  assert.equal(rows.volumes.find(v => v.update_id === 'UPD_2027_S1' && v.resource_type_id === 'BG_PROP').required, 0, 'SHOULD = 선택');
  assert.deepEqual(rows.progress.map(x => [x.as_of, x.spent_days]), [['2026-11-03', 7.5]]);
  assert.deepEqual(rows.type_templates.map(t => [t.update_type_id, t.resource_type_id, t.min_qty, t.target_qty]), [['SEASON', 'CHAR_NEW', 2, 2]]);
  assert.equal(p.blocked, false, p.findings.filter(x => x.level === 'ERROR').map(x => x.code).join(','));
});
