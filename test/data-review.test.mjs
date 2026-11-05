// 데이터 정비 도구(tools/data-review.mjs): 운영 시트 → .arp + PM 점검 엑셀
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readXlsx } from '../core/xlsx.ts';
import { buildOperatingFixture, toExportedXlsx } from '../tools/gen-operating-sheet.mjs';
import { openProjectFile } from '../tools/lib/project-db.mjs';

const OUT = fileURLToPath(new URL('../samples/out/test-data-review', import.meta.url));
const TOOL = fileURLToPath(new URL('../tools/data-review.mjs', import.meta.url));

test('데이터 정비: 운영 시트를 .arp로 가져오고, 출시 달까지 인력 기간을 늘리고, PM 점검 엑셀을 만든다', async () => {
  mkdirSync(OUT, { recursive: true });
  const f = buildOperatingFixture();
  // 인력을 2028-05까지만 둔다 → 출시가 더 늦은 업데이트(시즌 4 2028-07, 여름 이벤트 2028-07)까지 늘어야 한다
  f.sheets['12_Capacity_Monthly'] = [f.sheets['12_Capacity_Monthly'][0], ...f.sheets['12_Capacity_Monthly'].slice(1).filter(r => String(r[1]) <= '2028-05-01')];
  // 두 업데이트의 물량을 같게(템플릿 복사 자리표시 값 흉내)
  const vol = f.sheets['11_Update_Volume'];
  const s2 = vol.filter(r => r[1] === 'UPD_S2').map(r => r.slice());
  f.sheets['11_Update_Volume'] = [...vol.filter(r => r[1] !== 'UPD_S3'), ...s2.map(r => { r[0] = `UPD_S3|${r[2]}`; r[1] = 'UPD_S3'; return r; })];
  const input = `${OUT}/운영.xlsx`;
  writeFileSync(input, toExportedXlsx(f));
  const log = execFileSync(process.execPath, [TOOL, input], { encoding: 'utf8' });
  assert.match(log, /인력 기간: 2026-11 ~ 2028-05 → 2028-07/);
  assert.ok(existsSync(`${OUT}/운영.arp`));
  const raw = openProjectFile(`${OUT}/운영.arp`);
  const horizon = raw.prepare('SELECT horizon_end_month AS e FROM settings').get().e;
  const logged = raw.prepare("SELECT count(*) AS n FROM change_log WHERE reason LIKE '데이터 정비%'").get().n;
  raw.close();
  assert.equal(horizon, '2028-07');
  assert.ok(logged > 0, '늘린 기간은 변경 이력에 남아 되돌릴 수 있다');
  const x = await readXlsx(new Uint8Array(readFileSync(`${OUT}/운영 데이터 점검.xlsx`)));
  assert.deepEqual(Object.keys(x), ['요약', '필요 공수 큰 순', '공수 기준', '날짜·기간', '인력', '데이터 점검', '확인 요청']);
  assert.equal(x['요약'][3][1], '됨');
  const top = x['필요 공수 큰 순'].slice(1);
  assert.ok(top.length > 50 && top.every((r, i) => i === 0 || r[6] <= top[i - 1][6]), '필요 공수 큰 순으로');
  assert.ok(x['날짜·기간'].some(r => r[0] === '시즌 4' && String(r[5]).includes('제작 완료 목표일 없음')), '시즌 4: 제작 완료 목표일 없음');
  const ask = x['확인 요청'].map(r => r.join(' '));
  assert.ok(ask.some(t => t.includes('시즌 2') && t.includes('시즌 3') && t.includes('같음')), ask.join('\n'));
  assert.deepEqual(x['확인 요청'].slice(1).map(r => r[0]), [1, 2, 3, 4, 5, 6]);
});
