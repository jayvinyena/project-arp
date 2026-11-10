// 0단계 완료 조건: 구조가 만들어지고, 샘플 3벌이 기대한 검증 결과를 내고, 표 제약이 형식만 막는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile, validate, quickLoad, SCHEMA_SQL, APP_ID, workdaysInMonth } from '../tools/lib/project-db.mjs';
import { RULES } from '../rules/validation-rules.mjs';

const samples = await buildSamples(fileURLToPath(new URL('../samples/out/test-phase0', import.meta.url)));
const codes = (findings, level) => [...new Set(findings.filter(f => f.level === level).map(f => f.code))].sort();

for (const s of samples) {
  test(`샘플 ${s.name}: 기대한 오류·주의 규칙만 나온다`, () => {
    const db = openProjectFile(s.path);
    const findings = validate(db);
    db.close();
    assert.deepEqual(codes(findings, 'ERROR'), [...s.expect.errors].sort());
    assert.deepEqual(codes(findings, 'WARN'), [...s.expect.warnings].sort());
  });
}

test('정상 샘플은 모든 파트 부하율이 1 미만, 과부하 샘플은 1.2를 넘는 파트가 있다', () => {
  const load = name => {
    const db = openProjectFile(samples.find(s => s.name === name).path);
    const r = quickLoad(db);
    db.close();
    return r;
  };
  for (const r of load('normal')) assert.ok(r.loadRate < 1, `${r.name} ${r.loadRate}`);
  assert.ok(load('overload').some(r => r.loadRate > 1.2));
});

test('파일 표시: application_id와 구조 버전', () => {
  const db = new DatabaseSync(samples[0].path);
  assert.equal(db.prepare('PRAGMA application_id').get().application_id, APP_ID);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
  db.close();
});

test('표 제약은 형식만 막는다: 날짜 모양·0/1·없는 참조는 거절, 값 규칙 위반은 저장된다', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec("INSERT INTO update_types (update_type_id, name, sort_order) VALUES ('T', '유형', 1)");
  db.exec("INSERT INTO parts (part_id, name, sort_order) VALUES ('P', '파트', 1)");
  assert.throws(() => db.exec("INSERT INTO updates (update_id, name, update_type_id, release_date, priority, sort_order) VALUES ('U1', 'x', 'T', '2027-02-30', 1, 1)"));
  assert.throws(() => db.exec("INSERT INTO updates (update_id, name, update_type_id, release_date, priority, sort_order) VALUES ('U1', 'x', 'T', '2027/02/01', 1, 1)"));
  assert.throws(() => db.exec("INSERT INTO updates (update_id, name, update_type_id, priority, sort_order) VALUES ('U1', 'x', 'NOPE', 1, 1)"));
  assert.throws(() => db.exec("INSERT INTO parts (part_id, name, sort_order, active) VALUES ('Q', 'x', 2, 2)"));
  assert.throws(() => db.exec("INSERT INTO capacity (part_id, month, headcount, utilization) VALUES ('P', '2027-13', 1, 0.8)"));
  assert.throws(() => db.exec("INSERT INTO capacity (part_id, month, headcount, utilization) VALUES ('P', '2027-01', '세 명', 0.8)"));
  // 값 규칙 위반(가동률 1.5, 최저 > 목표)은 저장되고 검증에서 잡힌다
  db.exec("INSERT INTO capacity (part_id, month, headcount, utilization) VALUES ('P', '2027-01', 1, 1.5)");
  db.exec("INSERT INTO updates (update_id, name, update_type_id, start_date, priority, sort_order) VALUES ('U1', 'x', 'T', '2027-01-04', 1, 1)");
  db.exec("INSERT INTO resource_types (resource_type_id, name, sort_order) VALUES ('R', '리소스', 1)");
  db.exec("INSERT INTO volumes (update_id, resource_type_id, min_qty, target_qty, stretch_qty) VALUES ('U1', 'R', 5, 3, 8)");
  db.close();
});

test('규칙 코드는 겹치지 않고, 모든 규칙에 고치는 방법이 있다', () => {
  const seen = new Set();
  for (const r of RULES) {
    assert.ok(!seen.has(r.code), r.code);
    seen.add(r.code);
    assert.ok(['ERROR', 'WARN'].includes(r.level));
    assert.ok(r.fix && r.title);
  }
});

test('근무일 수: 2027-03 월–금 23일 − 삼일절(월) = 22일', () => {
  assert.equal(workdaysInMonth('2027-03', '1111100', new Set(['2027-03-01'])), 22);
  assert.equal(workdaysInMonth('2027-03', '1111100', new Set()), 23);
  // 주말에 걸친 휴일은 빼지 않는다: 2027-08-15는 일요일
  assert.equal(workdaysInMonth('2027-08', '1111100', new Set(['2027-08-15'])), workdaysInMonth('2027-08', '1111100', new Set()));
});
