// 엑셀 가져오기 양식: 양식 파일 → 채워서 가져오기 → 계산. 한글 시트·머리글·설명 줄·값 규칙(%, O/X, 높음/보통/낮음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeXlsx } from '../core/xlsx-write.ts';
import { readXlsx } from '../core/xlsx.ts';
import { templateBook, normalizeSheets, IMPORT_SPEC, specSummary } from '../core/import-spec.ts';
import { legacyToRows, writeImported } from '../core/import-legacy.ts';
import { SCHEMA_SQL } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { planView } from '../core/plan.ts';

const NOW = new Date(Date.UTC(2026, 10, 6));
async function roundTrip(book) {
  return readXlsx(writeXlsx(book.sheets, { freezeRows: book.freezeRows }));
}
function load(rows) {
  const raw = new DatabaseSync(':memory:');
  const db = nodeDb(raw);
  writeImported(db, SCHEMA_SQL, rows);
  return { raw, db };
}

test('빈 양식: 안내 + 규격의 모든 시트, 머리글은 한글(필수는 *), 2행은 ※ 설명 줄', async () => {
  const read = await roundTrip(templateBook({ now: NOW }));
  assert.deepEqual(Object.keys(read), ['안내', ...IMPORT_SPEC.map(s => s.ko)]);
  assert.deepEqual(read['파트'][0], ['파트 ID *', '파트 이름 *', '순서', '사용']);
  assert.ok(String(read['파트'][1][0]).startsWith('※'));
  assert.equal(read['파트'].length, 2, '빈 양식에는 데이터가 없다');
  // 안내 시트에 시트마다 설명이 있다
  const guide = read['안내'].map(r => r.join(' ')).join('\n');
  for (const s of IMPORT_SPEC) assert.ok(guide.includes(s.ko), s.ko);
  // 빈 양식을 그대로 가져오면 이유를 알린다
  assert.throws(() => legacyToRows(read), /인력|달이 없습니다/);
});

test('예시 양식: 그대로 가져오면 오류 없이 계산되고, 런칭·시즌 완료 예정이 나온다', async () => {
  const read = await roundTrip(templateBook({ example: true, now: NOW }));
  const { rows, report } = legacyToRows(read, { projectName: '예시' });
  assert.deepEqual(report.missingSheets, []);
  assert.equal(rows.parts.length, 3);
  assert.equal(rows.resource_groups.length, 3, '분류 칸 → 분류 3개');
  assert.equal(rows.resource_types.find(r => r.resource_type_id === 'ICON').group_id, 'G03');
  assert.equal(rows.settings[0].buffer_rate, 0.1, '여유율 10% → 0.1');
  assert.equal(rows.settings[0].default_overlap_rate, 0.2);
  assert.ok(rows.capacity.every(c => c.utilization === 0.8), '가동률 80% → 0.8');
  assert.equal(rows.volumes.find(v => v.resource_type_id === 'ICON').required, 0, '필수 여부 "선택"');
  assert.equal(rows.volumes.find(v => v.resource_type_id === 'ICON').reuse_rate, 0.2);
  assert.equal(rows.updates.find(u => u.update_id === 'LAUNCH').priority, 1, '우선순위 높음 → 1순위');
  assert.equal(rows.progress.length, 1);
  // 옛 도구 전용 보고 문구는 나오지 않는다
  assert.ok(!report.adjustments.some(a => /BUSINESS_DAYS|HIGH\/MEDIUM\/LOW|SHOULD·COULD/.test(a)), report.adjustments.join(' / '));
  const { raw, db } = load(rows);
  const v = planView(db, new ProjectSession(db), 'TARGET');
  raw.close();
  assert.equal(v.findings.filter(f => f.level === 'ERROR').length, 0, JSON.stringify(v.findings.filter(f => f.level === 'ERROR')));
  assert.ok(v.rows.filter(r => r.live).every(r => r.result?.completion), '런칭 · 시즌 1 완료 예정');
});

test('섞어 쓰기: 한글 시트 이름 + 영문 머리글, 영문 시트 이름 + 한글 머리글, 번호 붙은 시트 이름, 사용 O/X', () => {
  const n = normalizeSheets({
    '01 파트': [['PART_ID', 'PART_NAME', 'ACTIVE'], ['A', '원화', 'TRUE']],
    '02_Resource_Master': [['리소스 ID', '리소스 이름', '사용'], ['※ 설명', null, null], ['R1', '캐릭터', 'X'], ['R2', '배경', 'O']],
  });
  assert.deepEqual(n['01_Part_Master'], [['PART_ID', 'PART_NAME', 'ACTIVE'], ['A', '원화', 'TRUE']]);
  assert.deepEqual(n['02_Resource_Master'], [['RESOURCE_ID', 'RESOURCE_NAME', 'ACTIVE'], ['R1', '캐릭터', 'N'], ['R2', '배경', 'Y']]);
});

test('옛 도구 시트는 값까지 그대로(대조가 같아야 한다) · 화면 요약 표', () => {
  const legacy = { '01_Part_Master': [['PART_ID', 'ACTIVE'], ['A', '사용']], '12_Capacity_Monthly': [['UTILIZATION_RATE'], [80]] };
  assert.deepEqual(normalizeSheets(legacy), legacy);
  const sum = specSummary();
  assert.deepEqual(sum.filter(s => s.required).map(s => s.name), ['파트', '리소스', '공수', '업데이트', '물량', '인력']);
  assert.deepEqual(sum.find(s => s.name === '인력').columns, ['달', '파트 ID', '인원']);
});
