// 설정 단계(docs/23-ux-review.md 6.2 · 6.4): 처음 할 일 안내와 처음 화면 고르기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSamples } from '../tools/build-samples.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';
import { nodeDb } from '../tools/lib/pipeline.mjs';
import { setupStatus } from '../core/onboarding.ts';

const OUT = fileURLToPath(new URL('../samples/out/test-onboarding', import.meta.url));
const samples = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
const open = name => { const path = `${OUT}/${name}-copy.arp`; copyFileSync(samples[name], path); return nodeDb(openProjectFile(path)); };

test('예시(normal): 필수 3단계 끝, 작업 진척 기록이 있어 처음 화면은 현황판', () => {
  const db = open('normal');
  assert.deepEqual({ ...setupStatus(db) }, { resources: true, capacity: true, volume: true, assets: false, records: true, firstUpdateId: 'LAUNCH' });
});

test('기록 · 물량 · 인력 · 공수를 지우면 단계가 하나씩 꺼진다', () => {
  const db = open('normal');
  db.run('DELETE FROM progress');
  assert.equal(setupStatus(db).records, false, '기록 없음 → 처음 화면은 런칭 물량 설계');
  db.run('UPDATE volumes SET min_qty = 0, target_qty = 0, stretch_qty = 0');
  assert.equal(setupStatus(db).volume, false);
  db.run('UPDATE capacity SET headcount = 0');
  assert.equal(setupStatus(db).capacity, false);
  db.run("UPDATE efforts SET days = 0 WHERE profile_id = 'BASE'");
  assert.equal(setupStatus(db).resources, false);
});

test('에셋이 있으면 기록이 있는 것으로 본다', () => {
  const db = open('assets');
  db.run('DELETE FROM progress');
  const s = setupStatus(db);
  assert.equal(s.assets, true);
  assert.equal(s.records, true);
});
