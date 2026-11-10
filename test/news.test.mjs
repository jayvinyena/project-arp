// 소식(docs/26-viewer.md 4절): 올리기 · 고치기 · 지우기 · 되돌리기, 자동 요약(지난번 본 뒤 바뀐 것)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { undoBatch } from '../core/history.ts';
import { newsView, newsList } from '../core/news.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-news', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
let k = 0;
const open = name => { const path = `${OUT}/${name}-copy${(k += 1)}.arp`; copyFileSync(samples[name], path); const db = nodeDb(openProjectFile(path)); return { db, session: new ProjectSession(db) }; };
let n = 0;
const ctx = (editor = '검사') => ({ editor, batchId: `n${(n += 1)}` });

test('소식 올리기 · 고치기 · 지우기 · 되돌리기, 제목 필수', () => {
  const t = open('assets');
  const apply = (e, c = ctx()) => applyEdit(t.db, t.session, e, c);
  assert.equal(newsList(t.db).length, 2, '예시 소식 2개');
  assert.throws(() => apply({ kind: 'addNews', title: '  ' }), /제목을 입력/);
  const id = apply({ kind: 'addNews', title: ' 동료쿠키 3종 추가 ', body: '1차 납품에 넣습니다.\n', important: true }, ctx('김피엠')).createdId;
  let first = newsList(t.db)[0];
  assert.deepEqual([first.newsId, first.title, first.body, first.important, first.author], [id, '동료쿠키 3종 추가', '1차 납품에 넣습니다.', true, '김피엠'], '최근 순 · 다듬기 · 쓴 사람');
  apply({ kind: 'newsField', newsId: id, field: 'important', value: '0' });
  assert.equal(newsList(t.db)[0].important, false);
  const del = ctx();
  apply({ kind: 'deleteNews', newsId: id }, del);
  assert.equal(newsList(t.db).length, 2);
  undoBatch(t.db, t.session, del.batchId, ctx());
  first = newsList(t.db)[0];
  assert.equal(first.title, '동료쿠키 3종 추가', '지운 소식이 돌아온다');
});

test('자동 요약: 지난번 본 뒤 변경 · 완료된 에셋 작업 · 새 에셋 · 물량 변경 · 검수 요청 · 완료 예정', () => {
  const t = open('assets');
  const since = new Date(Date.now() - 1000).toISOString();
  applyEdit(t.db, t.session, { kind: 'moveStage', assetIds: ['A00006'], stage: 'MODELING' }, ctx('이원화'));
  applyEdit(t.db, t.session, { kind: 'createAssets', updateId: 'LAUNCH', resourceTypeId: 'CHAR_NEW', names: ['새 쿠키'] }, ctx('이원화'));
  applyEdit(t.db, t.session, { kind: 'volume', updateId: 'LAUNCH', resourceTypeId: 'PROP', field: 'target_qty', value: 61 }, ctx('김피엠'));
  applyEdit(t.db, t.session, { kind: 'addNews', title: '요약에는 소식 자체를 세지 않는다' }, ctx('김피엠'));
  const v = newsView(t.db, t.session, since);
  assert.equal(v.summary.since, since);
  assert.equal(v.summary.edits, 3);
  assert.deepEqual(v.summary.editors.sort(), ['김피엠', '이원화']);
  assert.equal(v.summary.partsDone, 1, '원화 완료');
  assert.equal(v.summary.assetsAdded, 1);
  assert.equal(v.summary.volumeEdits, 1);
  assert.ok(v.summary.review >= 1, '예시에 검수 요청이 있다');
  assert.ok(v.summary.forecasts.some(f => f.name === '런칭' && f.completion));
  // 지난번 본 시각이 없으면 최근 7일
  assert.ok(Date.parse(newsView(t.db, t.session, null).summary.since) < Date.now() - 6 * 86400000);
});
