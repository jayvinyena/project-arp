// 샘플 프로젝트 파일 만들기: samples/*.mjs → samples/out/*.arp
//   node tools/build-samples.mjs
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProjectFile } from './lib/project-db.mjs';
import { writeFileSync, copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { writeXlsx } from './lib/xlsx-write.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SAMPLES = ['normal', 'overload', 'broken', 'assets'];

/** outDir: 테스트 파일끼리 같은 파일을 동시에 쓰지 않도록 따로 줄 수 있다 */
export async function buildSamples(outDir = `${ROOT}samples/out`) {
  mkdirSync(outDir, { recursive: true });
  const built = [];
  for (const name of SAMPLES) {
    const mod = await import(`../samples/${name}.mjs`);
    const path = `${outDir}/${name}.arp`;
    createProjectFile(path, mod.build()).close();
    built.push({ name, path, expect: mod.expect });
  }
  // 옛 구조(v1) 예시: 구조 전환 시험용. 정상 샘플에서 v2 칸을 빼고 버전을 1로 되돌린다
  const v1 = `${outDir}/normal-v1.arp`;
  copyFileSync(`${outDir}/normal.arp`, v1);
  const old = new DatabaseSync(v1);
  old.exec('DROP TABLE asset_comments; DROP TABLE asset_links; DROP TABLE asset_thumbs; DROP TABLE asset_parts; DROP TABLE assets; DROP TABLE batches; ALTER TABLE progress DROP COLUMN spent_days; ALTER TABLE scenario_changes DROP COLUMN group_no; ALTER TABLE scenario_changes DROP COLUMN label; ALTER TABLE scenarios DROP COLUMN applied_at; PRAGMA user_version = 1;');
  old.close();

  // 옛 도구 시트 예시(.xlsx): 가져오기 화면 시험용
  const legacy = createRequire(import.meta.url)('../test/fixtures/legacy-sample.cjs')();
  writeFileSync(`${outDir}/legacy-sample.xlsx`, writeXlsx(legacy.sheets));
  // 운영 시트 흉내(구글 시트에서 내보낸 모양, 날짜는 엑셀 날짜): 실제 규모 가져오기 시험용
  const { buildOperatingFixture, toExportedXlsx } = await import('./gen-operating-sheet.mjs');
  writeFileSync(`${outDir}/operating-sheet.xlsx`, toExportedXlsx(buildOperatingFixture()));
  return built;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const s of await buildSamples()) console.log(`만듦: ${s.path}`);
}
