// 작업자 명단(docs/24-people.md): 더하기 · 고치기(이메일 형식) · 참여 끄기 · 지우기 · 되돌리기 · 인력 화면 · 에셋 담당 제안
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { undoBatch, historyView } from '../core/history.ts';
import { capacityView } from '../core/plan.ts';
import { assetsView } from '../core/assets.ts';
import { migrate, LATEST_SCHEMA } from '../core/migrate.ts';
import { teamOptions } from '../core/people.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-people', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
let k = 0;
const open = name => { const path = `${OUT}/${name}-copy${(k += 1)}.arp`; copyFileSync(samples[name], path); const raw = openProjectFile(path); const db = nodeDb(raw); return { raw, db, session: new ProjectSession(db) }; };
let n = 0;
const ctx = () => ({ editor: '검사', batchId: `p${(n += 1)}` });

test('더하기 · 고치기 · 참여 끄기 · 지우기, 이메일 형식 검사, 되돌리기', () => {
  const t = open('normal');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  assert.deepEqual(capacityView(t.db).people, []);
  const id = apply({ kind: 'createPerson', name: '  홍길동 ', team: '원화' }).createdId;
  apply({ kind: 'personField', personId: id, field: 'email', value: 'hong@example.com' });
  apply({ kind: 'personField', personId: id, field: 'note', value: '신규 입사\n2주 적응' });
  assert.throws(() => apply({ kind: 'personField', personId: id, field: 'email', value: 'hong@' }), /이메일 형식/);
  assert.throws(() => apply({ kind: 'personField', personId: id, field: 'name', value: ' ' }), /비울 수 없/);
  assert.throws(() => apply({ kind: 'createPerson', name: '' }), /이름을 입력/);
  assert.equal(apply({ kind: 'personField', personId: id, field: 'email', value: 'hong@example.com' }).changed, false);
  apply({ kind: 'createPerson', name: '김모델', team: '모델링' });
  apply({ kind: 'createPerson', name: '소속 없음' });
  const off = ctx();
  apply({ kind: 'personField', personId: id, field: 'active', value: '0' }, off);
  const v = capacityView(t.db).people;
  assert.deepEqual(v.map(p => [p.name, p.team, p.active]), [['홍길동', '원화', false], ['김모델', '모델링', true], ['소속 없음', null, true]], '파트(공정) 순, 소속팀 없으면 뒤');
  assert.equal(v[0].email, 'hong@example.com');
  assert.equal(v[0].note, '신규 입사\n2주 적응');
  assert.ok(historyView(t.db).batches.some(b => b.summary.includes('작업자')));
  undoBatch(t.db, t.session, off.batchId, ctx());
  assert.equal(capacityView(t.db).people.find(p => p.personId === id).active, true);
  const del = ctx();
  apply({ kind: 'deletePerson', personId: id }, del);
  assert.equal(capacityView(t.db).people.length, 2);
  undoBatch(t.db, t.session, del.batchId, ctx());
  assert.equal(capacityView(t.db).people.find(p => p.personId === id).email, 'hong@example.com', '지운 작업자가 돌아온다');
});

test('에셋 화면 담당 제안: 참여 중인 작업자만', () => {
  const t = open('assets');
  const names = assetsView(t.db, 'LAUNCH').people.map(p => p.name);
  assert.ok(names.includes('김원화') && names.includes('박모델') && !names.includes('최애니'), names.join());
});

test('한 번에 더하기: 이메일 · 특이사항까지, 이메일 형식 검사', () => {
  const t = open('normal');
  const id = applyEdit(t.db, t.session, { kind: 'createPerson', name: '한모델', team: '모델링', email: 'han@example.com', note: '외주\n' }, ctx()).createdId;
  const p = capacityView(t.db).people.find(x => x.personId === id);
  assert.deepEqual([p.team, p.email, p.note], ['모델링', 'han@example.com', '외주']);
  assert.throws(() => applyEdit(t.db, t.session, { kind: 'createPerson', name: '틀림', email: 'nope' }, ctx()), /이메일 형식/);
  assert.equal(capacityView(t.db).people.some(x => x.name === '틀림'), false, '틀리면 만들지 않는다');
});

test('소속팀은 목록(파트 + 지원 팀)에서만: 지원 팀 더하기 · 지우기(쓰는 사람이 있으면 거절) · 목록에 없는 이름 거절', () => {
  const t = open('normal');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  assert.deepEqual(teamOptions(t.db).map(x => `${x.kind}:${x.name}`), ['part:원화', 'part:모델링', 'part:애니메이션', 'part:FX']);
  assert.throws(() => apply({ kind: 'createPerson', name: '김피엠', team: 'PM' }), /소속팀 목록에 없습니다/);
  assert.throws(() => apply({ kind: 'createTeam', name: '원화' }), /이미 파트/);
  const tid = apply({ kind: 'createTeam', name: ' PM ' }).createdId;
  assert.throws(() => apply({ kind: 'createTeam', name: 'PM' }), /같은 이름/);
  const pid = apply({ kind: 'createPerson', name: '김피엠', team: 'PM' }).createdId;
  apply({ kind: 'createPerson', name: '박원화', team: '원화' });
  assert.throws(() => apply({ kind: 'personField', personId: pid, field: 'team', value: '마케팅' }), /목록에 없습니다/);
  assert.deepEqual(teamOptions(t.db).filter(x => x.used).map(x => `${x.name}${x.used}`), ['원화1', 'PM1']);
  assert.throws(() => apply({ kind: 'deleteTeam', teamId: tid }), /작업자가 1명/);
  assert.deepEqual(capacityView(t.db).people.map(p => p.name), ['박원화', '김피엠'], '파트 → 지원 팀 순');
  apply({ kind: 'personField', personId: pid, field: 'team', value: '' });
  apply({ kind: 'deleteTeam', teamId: tid });
  assert.equal(teamOptions(t.db).some(x => x.name === 'PM'), false);
});

test('파트 이름을 바꾸면 소속팀도 따라가고, 파트를 지우면 소속팀 없음 — 되돌리면 함께', () => {
  const t = open('normal');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  const pid = apply({ kind: 'createPerson', name: '박원화', team: '원화' }).createdId;
  const ren = ctx();
  apply({ kind: 'renamePart', partId: 'CONCEPT', name: '컨셉' }, ren);
  assert.equal(capacityView(t.db).people.find(p => p.personId === pid).team, '컨셉');
  undoBatch(t.db, t.session, ren.batchId, ctx());
  assert.equal(capacityView(t.db).people.find(p => p.personId === pid).team, '원화');
  apply({ kind: 'createTeam', name: '기획' });
  assert.throws(() => apply({ kind: 'renamePart', partId: 'CONCEPT', name: '기획' }), /같은 이름의 지원 팀/);
});

test('구조 v9: 지금 적힌 소속팀 중 파트가 아닌 것은 지원 팀으로 옮긴다', () => {
  const t = open('normal');
  t.raw.exec(`INSERT INTO people (person_id, name, team, active, sort_order) VALUES ('P001', '가', '원화', 1, 1), ('P002', '나', 'PM', 1, 2), ('P003', '다', '기획', 1, 3), ('P004', '라', 'PM', 1, 4), ('P005', '마', NULL, 1, 5);
    DROP TABLE teams; DROP TABLE pipeline_steps; DROP TABLE pipelines; ALTER TABLE resource_types DROP COLUMN pipeline_id; PRAGMA user_version = 8;`);
  const r = migrate(t.db);
  assert.deepEqual([r.from, r.to], [8, LATEST_SCHEMA]);
  assert.deepEqual(t.raw.prepare('SELECT team_id, name FROM teams ORDER BY sort_order').all().map(x => `${x.team_id}:${x.name}`), ['T01:PM', 'T02:기획']);
  assert.deepEqual(teamOptions(t.db).map(x => x.name), ['원화', '모델링', '애니메이션', 'FX', 'PM', '기획']);
});

