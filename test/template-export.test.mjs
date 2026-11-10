// 편집용 엑셀(지금 프로젝트 → 가져오기 양식) 왕복: 내보내기 → 엑셀 → 다시 가져오기 = 같은 데이터 · 같은 계산
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile, createProjectFile, SCHEMA_SQL } from '../tools/lib/project-db.mjs';
import { buildScaleData } from '../tools/gen-scale.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { planView } from '../core/plan.ts';
import { writeXlsx } from '../core/xlsx-write.ts';
import { readXlsx } from '../core/xlsx.ts';
import { projectTemplateBook } from '../core/template-export.ts';
import { legacyToRows, writeImported } from '../core/import-legacy.ts';
import { readModeNames } from '../core/modes.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-template-export', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
samples.scale = `${OUT}/scale.arp`;
createProjectFile(samples.scale, buildScaleData()).close();
let copies = 0;
function open(path) {
  const copy = `${OUT}/copy${(copies += 1)}.arp`;
  copyFileSync(path, copy);
  const raw = openProjectFile(copy);
  const db = nodeDb(raw);
  return { raw, db, session: new ProjectSession(db) };
}
async function roundTrip(db) {
  const book = projectTemplateBook(db);
  const read = await readXlsx(writeXlsx(book.sheets, { freezeRows: book.freezeRows }));
  const { rows, report } = legacyToRows(read, { projectName: '파일 이름' });
  const raw = new DatabaseSync(':memory:');
  const back = nodeDb(raw);
  writeImported(back, SCHEMA_SQL, rows);
  return { raw, back, report };
}
const TABLES = {
  parts: 'part_id, name, sort_order, active',
  resource_types: 'resource_type_id, name, sort_order, active',
  resource_parts: 'resource_type_id, part_id, rework_rate',
  efforts: 'resource_type_id, part_id, profile_id, days',
  effort_mix: 'part_id, profile_id, round(share, 6) AS share',
  part_overlaps: 'from_part_id, to_part_id, overlap_rate',
  update_types: 'update_type_id, name, is_launch, active',
  type_templates: 'update_type_id, resource_type_id, min_qty, target_qty, stretch_qty',
  updates: 'update_id, name, update_type_id, start_date, freeze_date, release_date, status, note',
  volumes: 'update_id, resource_type_id, min_qty, target_qty, stretch_qty, required, priority, difficulty, round(reuse_rate, 6) AS reuse_rate, outsource_qty, note',
  capacity: 'part_id, month, headcount, round(utilization, 6) AS utilization, productivity, outsource_days, support_days, note',
  holidays: 'date, name, kind',
  progress: 'update_id, resource_type_id, part_id, completed_qty, as_of, spent_days',
  settings: 'horizon_start_month, horizon_end_month, work_weekdays, buffer_rate, default_overlap_rate',
};
const dump = (db, t) => db.all(`SELECT ${TABLES[t]} FROM ${t} ORDER BY 1, 2, 3`);
const completions = (db, mode) => planView(db, new ProjectSession(db), mode).rows.map(r => `${r.updateId}:${r.result?.completion ?? '-'}:${r.result?.status ?? '-'}`);

for (const name of ['normal', 'scale', 'overload']) {
  test(`왕복(${name}): 표마다 같은 값, 세 템플릿 모두 같은 완료 예정`, async () => {
    const { raw, db } = open(samples[name]);
    const { raw: raw2, back } = await roundTrip(db);
    for (const t of Object.keys(TABLES)) assert.deepEqual(dump(back, t), dump(db, t), t);
    // 우선순위는 순서만 같으면 된다(번호는 다시 매김)
    const order = d => d.all("SELECT update_id FROM updates WHERE status IN ('PLANNED','IN_PROGRESS') ORDER BY priority").map(r => r.update_id);
    assert.deepEqual(order(back), order(db));
    for (const m of ['MIN', 'TARGET', 'STRETCH']) assert.deepEqual(completions(back, m), completions(db, m), m);
    raw.close(); raw2.close();
  });
}

test('왕복: 프로젝트 이름 · 템플릿 이름 · 근무 요일 · AI 활용 · 분류 · 런칭 유형 · 최소안 0', async () => {
  const { raw, db, session } = open(samples.normal);
  const ctx = { editor: '검사', batchId: 'b' };
  applyEdit(db, session, { kind: 'modeName', mode: 'MIN', name: '보수안' }, ctx);
  applyEdit(db, session, { kind: 'setting', field: 'work_weekdays', value: '1111110' }, ctx);
  applyEdit(db, session, { kind: 'aiShare', partId: db.get('SELECT part_id FROM parts ORDER BY sort_order').part_id, share: 0.35 }, ctx);
  applyEdit(db, session, { kind: 'addHoliday', date: '2027-07-07', name: '창립기념일', holidayKind: 'COMPANY' }, ctx);
  db.run("UPDATE volumes SET min_qty = 0 WHERE rowid = (SELECT min(rowid) FROM volumes)");
  db.run("UPDATE update_types SET update_type_id = update_type_id, name = '첫 출시' WHERE is_launch = 1");
  const { raw: raw2, back, report } = await roundTrip(db);
  assert.equal(back.get("SELECT value FROM meta WHERE key = 'project_name'").value, db.get("SELECT value FROM meta WHERE key = 'project_name'").value, '파일 이름보다 양식의 프로젝트 이름');
  assert.deepEqual(readModeNames(back), readModeNames(db));
  for (const t of ['settings', 'effort_mix', 'holidays', 'volumes', 'update_types']) assert.deepEqual(dump(back, t), dump(db, t), t);
  assert.ok(!report.adjustments.some(a => /BUSINESS_DAYS|최저가 비었거나/.test(a)), report.adjustments.join(' / '));
  raw.close(); raw2.close();
});

const REAL = fileURLToPath(new URL('../private/ART_RESOURCE_PLANNER.arp', import.meta.url));
test('왕복(실제 운영 파일, 있으면): 같은 완료 예정', { skip: !existsSync(REAL) }, async () => {
  const { raw, db } = open(REAL);
  const { raw: raw2, back } = await roundTrip(db);
  for (const t of ['parts', 'resource_types', 'efforts', 'updates', 'volumes', 'capacity']) assert.deepEqual(dump(back, t), dump(db, t), t);
  for (const m of ['MIN', 'TARGET', 'STRETCH']) assert.deepEqual(completions(back, m), completions(db, m), m);
  raw.close(); raw2.close();
});

test('편집용 엑셀 "안내" 시트에 빠지는 것(파이프라인 · 에셋 · 작업자 · 소식 · 이력)을 적는다(docs/32 2)', () => {
  const { db } = open(samples.normal);
  const guide = projectTemplateBook(db).sheets['안내'].flat().map(c => (c && typeof c === 'object' ? c.v : c)).join('\n');
  for (const w of ['파이프라인', '에셋', '작업자 명단', '소식', '변경 이력']) assert.ok(guide.includes(w), w);
  assert.ok(!guide.includes('순서가 곧 공정 순서'), '파트 순서는 보기 순서(docs/29)');
});
