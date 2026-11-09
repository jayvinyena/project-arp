// 팀 제작 리스트 형식 가져오기(docs/20-asset-management.md 19절) · 에셋 세부 분류 · 속성.
// 시트는 가상의 예시다(실제 사내 자료는 넣지 않는다).
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
import { assetsView, assetDetail } from '../core/assets.ts';
import { scanSheetBook, importSheetBook, isArpAssetBook, statusWord, NEW_RESOURCE } from '../core/sheet-import.ts';
import { validate } from '../core/pipeline.ts';
import { readXlsx, readXlsxWithLinks } from '../core/xlsx.ts';
import { writeXlsx } from '../core/xlsx-write.ts';
import { assetBook } from '../core/asset-io.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-sheet-import', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
let copies = 0;
function open(name = 'normal') {
  const path = `${OUT}/${name}-copy${(copies += 1)}.arp`;
  copyFileSync(samples[name], path);
  const db = nodeDb(openProjectFile(path));
  return { db, session: new ProjectSession(db) };
}
let n = 0;
const ctx = () => ({ editor: '검사', batchId: `s${(n += 1)}` });

import { BOOK, LINKS } from '../samples/production-list.mjs';
const bytes = () => writeXlsx(BOOK, { links: LINKS });

test('엑셀 읽기: 칸 하이퍼링크를 함께 읽는다', async () => {
  const { sheets, links } = await readXlsxWithLinks(bytes());
  assert.equal(sheets['캐릭터'][2][4], '문서');
  assert.equal(links['캐릭터']['2,4'], 'https://docs.example.com/spec/wind');
  assert.deepEqual(await readXlsx(bytes()), sheets);
});

test('상태 말 알아보기', () => {
  assert.equal(statusWord('완료'), 'DONE');
  assert.equal(statusWord(' 없음 '), 'OMIT');
  assert.equal(statusWord('작업중'), 'WIP');
  assert.equal(statusWord('컨펌 요청'), 'REVIEW');
  assert.equal(statusWord(true), 'DONE');
  assert.equal(statusWord(false), null);
  assert.equal(statusWord(''), null);
  assert.equal(statusWord('작업 대기중'), 'unknown');
});

test('훑기: 파트 상태가 있는 시트만, (시트 · 분류)와 마일스톤 대응을 미리 골라 둔다', async () => {
  const t = open();
  const sheets = await readXlsx(bytes());
  assert.equal(isArpAssetBook(sheets), false);
  const s = scanSheetBook(t.db, sheets);
  const by = Object.fromEntries(s.sheets.map(x => [x.name, x]));
  assert.equal(by['캐릭터'].included, true);
  assert.equal(by['캐릭터'].rows, 4);
  assert.deepEqual(by['캐릭터'].parts, ['원화', '모델링', '애니메이션', 'FX']);
  assert.deepEqual(by['캐릭터'].attrs, ['속성', '등장 지역']);
  assert.equal(by['코스튬'].included, true, '두 줄 머리글');
  assert.deepEqual(by['코스튬'].parts, ['원화', '모델링', '애니메이션', 'FX']);
  assert.ok(by['코스튬'].columns.includes('원화 담당'), by['코스튬'].columns.join());
  assert.deepEqual(by['코스튬'].attrs, ['데이터 연결']);
  assert.equal(by['요약'].included, false);
  assert.match(by['레벨'].reason, /파트 상태 칸/);
  const keys = Object.fromEntries(s.keys.map(k => [`${k.sheet}|${k.label}`, k]));
  assert.equal(keys['캐릭터|신규 캐릭터'].guess, 'CHAR_NEW');
  assert.equal(keys['캐릭터|신규 캐릭터'].count, 4);
  assert.equal(keys['코스튬|코스튬 · 상의'].guess, 'COSTUME');
  assert.equal(keys['코스튬|신규 · 캐릭터'].guess, 'CHAR_NEW', '대분류 + 분류를 붙인 이름');
  const ms = Object.fromEntries(s.milestones.map(m => [m.value, m.guess]));
  assert.deepEqual(ms, { M1: null, M9: null, '미니 1': 'MINI1', '시즌 1': 'S1' });
  assert.deepEqual(s.unknownWords, [{ word: '작업 대기중', count: 1 }]);
  assert.equal(s.rows, 6);
  // ARP 에셋 양식은 알아본다
  assert.equal(isArpAssetBook(await readXlsx(writeXlsx(assetBook(t.db, 'LAUNCH').sheets))), true);
});

function planFor(scan, extra = {}) {
  return {
    milestones: { M1: 'LAUNCH', '시즌 1': 'S1', '미니 1': 'MINI1' },
    resources: Object.fromEntries(scan.keys.map(k => [k.key, k.guess ?? ''])),
    words: { '작업 대기중': 'WIP' },
    doneDate: '2026-11-06',
    addVolumes: true,
    ...extra,
  };
}

test('가져오기: 에셋 · 세부 분류 · 리소스명 · Jira · 기획서 링크 · 속성 · 파트 상태 · 물량 더하기, 다시 넣으면 그대로, 한 번에 되돌리기', async () => {
  const t = open();
  const { sheets, links } = await readXlsxWithLinks(bytes(), { fillMerged: true });
  const scan = scanSheetBook(t.db, sheets);
  const c = ctx();
  const r = importSheetBook(t.db, t.session, sheets, links, planFor(scan), c);
  assert.equal(r.created, 5);
  assert.equal(r.volumesAdded, 1, '미니 1에 신규 캐릭터 물량을 더함');
  assert.equal(r.jiraBaseSet, true);
  assert.deepEqual(r.skipped.map(x => [x.sheet, x.row, x.reason]), [['캐릭터', 6, '마일스톤을 고르지 않음']]);

  const v = assetsView(t.db, 'LAUNCH');
  const wind = v.assets.find(a => a.name === '바람 기사');
  assert.equal(wind.code, 'CH_WindKnight');
  assert.equal(wind.category, '신규 캐릭터');
  assert.equal(wind.jiraKey, 'ART-12');
  assert.equal(wind.note, '보스 후보');
  assert.deepEqual(wind.attrs, [{ name: '속성', value: '바람' }, { name: '등장 지역', value: '초원' }]);
  assert.deepEqual(Object.fromEntries(Object.entries(wind.parts).map(([p, s]) => [p, s.status])), { CONCEPT: 'DONE', MODELING: 'DONE', ANIMATION: 'WIP', FX: 'OMIT' });
  assert.equal(wind.parts.CONCEPT.doneAt, '2026-11-06');
  assert.deepEqual(assetDetail(t.db, wind.assetId).links.map(l => [l.title, l.url]), [['기획서', 'https://docs.example.com/spec/wind']]);
  assert.equal(v.jiraBase, 'https://example.atlassian.net/browse/');
  const shirt = v.assets.find(a => a.name === '여름 셔츠');
  assert.equal(shirt.resourceTypeId, 'COSTUME');
  assert.equal(shirt.category, '코스튬 · 상의');
  assert.equal(shirt.stage, 'MODELING');
  assert.equal(shirt.parts.CONCEPT.assignee, '김원화', '파트 담당 칸 → 파트 담당');
  // 모든 에셋이 같은 파이프라인: 코스튬은 FX를 거치지 않지만 시트 값대로 넣는다(계획 공수 밖이라 작업 진척에는 세지 않음)
  assert.deepEqual([shirt.parts.FX.status, shirt.parts.FX.inPlan], ['DONE', false]);
  const mini = assetsView(t.db, 'MINI1').assets.find(a => a.name === '미니 손님');
  assert.equal(mini.parts.FX.status, 'TODO', '빈칸은 기본(거치는 파트 = 대기)');
  assert.deepEqual(shirt.attrs, [{ name: '데이터 연결', value: 'ITEM_001' }]);
  // 작업 진척 자동 집계: 신규 캐릭터 원화 = 손 입력 3 대신 에셋에서 센 2(바람 기사 · 불꽃 마법사), FX = 해당 없음 1
  const prog = Object.fromEntries(t.db.all("SELECT part_id, completed_qty FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = 'CHAR_NEW'").map(x => [x.part_id, x.completed_qty]));
  assert.deepEqual(prog, { CONCEPT: 2, MODELING: 1, FX: 1 });
  // 미니 1: 물량이 없던 신규 캐릭터를 더하고 등록 에셋 수로 맞춤(기본안 1)
  const vol = t.db.get("SELECT min_qty, target_qty, stretch_qty FROM volumes WHERE update_id = 'MINI1' AND resource_type_id = 'CHAR_NEW'");
  assert.deepEqual({ ...vol }, { min_qty: 0, target_qty: 1, stretch_qty: 1 });

  // 다시 넣기: 새로 만들지 않고, 바뀐 것도 없다
  const again = importSheetBook(t.db, t.session, sheets, links, planFor(scan), ctx());
  assert.deepEqual([again.created, again.changed, again.unchanged], [0, 0, 5]);

  // 한 번에 되돌리기
  undoBatch(t.db, t.session, c.batchId, ctx());
  assert.equal(t.db.get("SELECT count(*) AS n FROM assets").n, 0);
  assert.equal(t.db.get("SELECT count(*) AS n FROM asset_attrs").n, 0);
  assert.equal(t.db.get("SELECT count(*) AS n FROM volumes WHERE update_id = 'MINI1' AND resource_type_id = 'CHAR_NEW'").n, 0);
  assert.equal(t.db.get("SELECT completed_qty FROM progress WHERE update_id = 'LAUNCH' AND resource_type_id = 'CHAR_NEW' AND part_id = 'CONCEPT'").completed_qty, 3, '손 입력 진척이 돌아온다');
});

test('가져오기: 물량 더하기를 끄면 물량에 없는 리소스 행은 건너뛴다 · 모르는 상태 말은 기본으로 바꾸지 않는다', async () => {
  const t = open();
  const { sheets, links } = await readXlsxWithLinks(bytes(), { fillMerged: true });
  const scan = scanSheetBook(t.db, sheets);
  const r = importSheetBook(t.db, t.session, sheets, links, planFor(scan, { addVolumes: false, words: {} }), ctx());
  assert.equal(r.created, 4);
  assert.ok(r.skipped.some(x => x.reason === '물량에 없는 리소스'));
  const wind = assetsView(t.db, 'LAUNCH').assets.find(a => a.name === '바람 기사');
  assert.equal(wind.parts.ANIMATION.status, 'TODO');
  assert.throws(() => importSheetBook(t.db, t.session, sheets, links, planFor(scan, { doneDate: '2026-13-01' }), ctx()), /완료일/);
});

test('에셋 속성 · 세부 분류: 고치기 · 지우기 · 에셋을 지웠다 되돌리면 속성도 돌아온다', () => {
  const t = open('assets');
  const id = 'A00001';
  assert.equal(applyEdit(t.db, t.session, { kind: 'assetAttr', assetIds: [id], name: '속성', value: '바람' }, ctx()).changed, true);
  assert.equal(applyEdit(t.db, t.session, { kind: 'assetAttr', assetIds: [id], name: '속성', value: '바람' }, ctx()).changed, false);
  applyEdit(t.db, t.session, { kind: 'assetAttr', assetIds: [id], name: '지역', value: '초원' }, ctx());
  applyEdit(t.db, t.session, { kind: 'assetAttr', assetIds: [id], name: '속성', value: '불' }, ctx());
  applyEdit(t.db, t.session, { kind: 'assetField', assetIds: [id], field: 'category', value: '  보스  ' }, ctx());
  assert.throws(() => applyEdit(t.db, t.session, { kind: 'assetAttr', assetIds: [id], name: 'a|b', value: 'x' }, ctx()), /"\|"/);
  let a = assetsView(t.db, 'LAUNCH').assets.find(x => x.assetId === id);
  assert.deepEqual(a.attrs, [{ name: '속성', value: '불' }, { name: '지역', value: '초원' }]);
  assert.equal(a.category, '보스');
  assert.ok(assetDetail(t.db, id).activity.some(x => x.text === '속성 속성: 바람 → 불'));
  const del = ctx();
  applyEdit(t.db, t.session, { kind: 'deleteAssets', assetIds: [id] }, del);
  assert.equal(t.db.get('SELECT count(*) AS n FROM asset_attrs WHERE asset_id = ?', [id]).n, 0);
  undoBatch(t.db, t.session, del.batchId, ctx());
  a = assetsView(t.db, 'LAUNCH').assets.find(x => x.assetId === id);
  assert.deepEqual(a.attrs.map(x => x.name), ['속성', '지역']);
  applyEdit(t.db, t.session, { kind: 'assetAttr', assetIds: [id], name: '지역', value: '' }, ctx());
  assert.deepEqual(assetsView(t.db, 'LAUNCH').assets.find(x => x.assetId === id).attrs.map(x => x.name), ['속성']);
});

test('가져오기: 시트 분류대로 새 리소스 종류 만들기(분류 = 시트 이름, 거치는 파트 = 시트 파트 칸, 공수 0 → E08 주의), 같은 이름은 하나로, 한 번에 되돌리기', async () => {
  const t = open();
  const { sheets, links } = await readXlsxWithLinks(bytes(), { fillMerged: true });
  const scan = scanSheetBook(t.db, sheets);
  const k = Object.fromEntries(scan.keys.map(x => [`${x.sheet}|${x.label}`, x]));
  assert.deepEqual(k['코스튬|코스튬 · 상의'].suggest, { group: '코스튬', name: '코스튬 · 상의' });
  assert.deepEqual(k['코스튬|코스튬 · 상의'].parts, ['CONCEPT', 'MODELING', 'ANIMATION', 'FX']);
  const a = k['코스튬|코스튬 · 상의'].key; const b = k['코스튬|신규 · 캐릭터'].key;
  const plan = planFor(scan, {
    resources: { ...planFor(scan).resources, [a]: NEW_RESOURCE, [b]: NEW_RESOURCE },
    create: { [a]: { group: '마이쿠키 의상', name: '의상 상의' }, [b]: { group: '마이쿠키 의상', name: '의상 상의' } },
  });
  const c = ctx();
  const r = importSheetBook(t.db, t.session, sheets, links, plan, c);
  assert.deepEqual(r.resourcesCreated, ['의상 상의'], '같은 이름은 하나로');
  const rt = t.db.get("SELECT r.resource_type_id AS id, g.name AS g FROM resource_types r JOIN resource_groups g ON g.group_id = r.group_id WHERE r.name = '의상 상의'");
  assert.equal(rt.g, '마이쿠키 의상');
  assert.deepEqual(t.db.all("SELECT part_id, days FROM efforts WHERE resource_type_id = ? AND profile_id = 'BASE' ORDER BY part_id", [rt.id]).map(x => [x.part_id, x.days]),
    [['ANIMATION', 0], ['CONCEPT', 0], ['FX', 0], ['MODELING', 0]]);
  const shirt = t.db.get("SELECT resource_type_id FROM assets WHERE name = '여름 셔츠'");
  assert.equal(shirt.resource_type_id, rt.id);
  const f = validate(t.db).filter(x => x.code === 'E08');
  assert.deepEqual(f.map(x => x.key), [rt.id], '공수 0 → 데이터 점검 주의');
  assert.ok(!validate(t.db).some(x => x.level === 'ERROR'), '계산은 멈추지 않는다');
  // 다시 넣기: 같은 이름이 있으면 새로 만들지 않는다
  const again = importSheetBook(t.db, t.session, sheets, links, plan, ctx());
  assert.deepEqual([again.resourcesCreated.length, again.created], [0, 0]);
  // 되돌리기: 리소스 종류 · 분류도 함께
  undoBatch(t.db, t.session, c.batchId, ctx());
  assert.equal(t.db.get("SELECT count(*) AS n FROM resource_types WHERE name = '의상 상의'").n, 0);
  assert.equal(t.db.get("SELECT count(*) AS n FROM resource_groups WHERE name = '마이쿠키 의상'").n, 0);
  assert.throws(() => importSheetBook(t.db, t.session, sheets, links, planFor(scan, { resources: { [a]: NEW_RESOURCE }, create: { [a]: { group: '', name: ' ' } } }), ctx()), /이름이 비었/);
});

