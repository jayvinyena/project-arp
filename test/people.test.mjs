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

const OUT = fileURLToPath(new URL('../samples/out/test-people', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
let k = 0;
const open = name => { const path = `${OUT}/${name}-copy${(k += 1)}.arp`; copyFileSync(samples[name], path); const db = nodeDb(openProjectFile(path)); return { db, session: new ProjectSession(db) }; };
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
