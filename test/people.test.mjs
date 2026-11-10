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


// ───────── 작업자 가져오기(docs/31) ─────────
import { parsePeopleText, splitTable } from '../core/people-paste.ts';
import { assigneeCandidates } from '../core/people.ts';

test('붙여넣기 해석: 머리글로 열 맞추기 · 머리글 없으면 순서대로 · CSV 따옴표 · 상태(새로 · 있음 · 이메일 채움 · 겹침 · 고칠 것)', () => {
  const teams = ['원화', '모델링', 'PM'];
  const people = [{ personId: 'P001', name: '김원화', email: null }, { personId: 'P002', name: '박모델', email: 'park@example.com' }];
  // 엑셀 · 시트 복사(탭), 머리글 순서가 다름 · 영문 머리글
  const a = parsePeopleText('Email\tName\tTeam\tNotes\nhana@example.com\t 김하나 \t원화\t신규\nwon@example.com\t김원화\t원화\t\nx@y\t최틀림\t\t\n\t김하나\t\t\n\t정기획\t기획\t', teams, people);
  assert.equal(a.header, true);
  assert.deepEqual(a.columns, { name: 1, team: 2, email: 0, note: 3 });
  assert.deepEqual(a.rows.map(r => [r.line, r.name, r.status, r.team, r.teamKnown]), [
    [2, '김하나', 'new', '원화', true],
    [3, '김원화', 'fill', '원화', true],
    [4, '최틀림', 'bad', null, true],
    [5, '김하나', 'dup', null, true],
    [6, '정기획', 'new', '기획', false],
  ]);
  assert.equal(a.rows[1].personId, 'P001');
  // 머리글 없음: 이름 · 팀 · 이메일 · 메모, 공백 · 대소문자 무시로 이미 있음
  const b = parsePeopleText('박모델\t모델링\nlee  one\tpm', teams, people);
  assert.equal(b.header, false);
  assert.deepEqual(b.rows.map(r => [r.name, r.status, r.team]), [['박모델', 'exists', '모델링'], ['lee one', 'new', 'PM']]);
  // CSV(Jira 내보내기를 그대로): 쉼표 · 따옴표 안 쉼표 · 줄바꿈
  assert.deepEqual(splitTable('Assignee,Summary\n"Kim, Hana","a\nb"\n'), [['Assignee', 'Summary'], ['Kim, Hana', 'a\nb']]);
  assert.deepEqual(parsePeopleText('Assignee,Summary\n"Kim, Hana",x\n"Kim, Hana",y', teams, people).rows.map(r => [r.name, r.status]), [['Kim, Hana', 'new'], ['Kim, Hana', 'dup']]);
});

test('담당에서 찾기: 명단에 없는 담당 · 가장 많이 맡은 파트를 소속팀으로 제안 · 여러 명 한 번에 더하고 한 번에 되돌림', () => {
  const t = open('assets');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  assert.deepEqual(assigneeCandidates(t.db), [], '예시 파일은 담당이 모두 명단에 있다');
  // 명단에 없는 담당: 정모델(모델링 2 · 원화 1), " 정모델 " 표기도 같은 사람
  const ap = t.db.all("SELECT asset_id, part_id FROM asset_parts ORDER BY asset_id, part_id").map(r => [String(r.asset_id), String(r.part_id)]);
  const assetsOf = part => [...new Set(ap.filter(x => x[1] === part).map(x => x[0]))];
  const mod = assetsOf('MODELING'); const con = assetsOf('CONCEPT');
  apply({ kind: 'assetPart', assetIds: [mod[0]], partId: 'MODELING', assignee: '정모델' });
  apply({ kind: 'assetPart', assetIds: [mod[1]], partId: 'MODELING', assignee: ' 정모델 ' });
  apply({ kind: 'assetPart', assetIds: [con[0]], partId: 'CONCEPT', assignee: '정모델' });
  const c = assigneeCandidates(t.db);
  assert.deepEqual(c.map(x => [x.name, x.team, x.assets]), [['정모델', '모델링', 3]]);
  assert.deepEqual(capacityView(t.db).candidates.length, 1);
  // 여러 명 한 번에: 새 지원 팀 · 이미 있는 이름은 건너뜀 · 빈 이메일 채우기
  const before = capacityView(t.db).people.length;
  const kim = capacityView(t.db).people.find(p => p.name === '김원화');
  const c1 = ctx();
  const r = apply({ kind: 'createPeople', newTeams: ['기획'], people: [{ name: '정모델', team: '모델링' }, { name: '한기획', team: '기획', email: 'han@example.com' }, { name: '김원화' }],
    fillEmails: kim.email ? [] : [{ personId: kim.personId, email: 'kim@example.com' }] }, c1);
  assert.match(r.note, /2명 더함/);
  assert.match(r.note, /이미 있는 1명 건너뜀/);
  const after = capacityView(t.db);
  assert.equal(after.people.length, before + 2);
  assert.equal(after.people.find(p => p.name === '한기획').team, '기획');
  assert.deepEqual(after.candidates, [], '더하면 후보에서 빠진다');
  assert.equal(after.people.find(p => p.name === '정모델').assigned, 3);
  undoBatch(t.db, t.session, c1.batchId, ctx());
  assert.equal(capacityView(t.db).people.length, before);
  assert.ok(!teamOptions(t.db).some(x => x.name === '기획'), '지원 팀도 함께 되돌린다');
});

test('이름 바꾸기: "담당도 바꾸기"면 같은 이름의 에셋 담당도 함께(한 묶음으로 되돌림), 아니면 명단만', () => {
  const t = open('assets');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  const kim = capacityView(t.db).people.find(p => p.name === '김원화');
  assert.equal(kim.assigned, 4);
  const c1 = ctx();
  apply({ kind: 'personField', personId: kim.personId, field: 'name', value: '김원화A', alsoAssignee: true }, c1);
  const n = name => Number(t.db.get('SELECT count(*) AS n FROM asset_parts WHERE assignee = ?', [name]).n);
  assert.deepEqual([n('김원화'), n('김원화A')], [0, 4]);
  assert.equal(capacityView(t.db).people.find(p => p.personId === kim.personId).assigned, 4);
  undoBatch(t.db, t.session, c1.batchId, ctx());
  assert.deepEqual([n('김원화'), n('김원화A')], [4, 0]);
  apply({ kind: 'personField', personId: kim.personId, field: 'name', value: '김원화B' });
  assert.deepEqual([n('김원화'), n('김원화B')], [4, 0], '명단만 바꾸면 담당은 그대로');
  assert.deepEqual(assigneeCandidates(t.db).map(x => x.name), ['김원화'], '그러면 옛 이름이 담당 후보로 보인다');
});
