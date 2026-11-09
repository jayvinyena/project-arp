// 에셋 2천 개 + 썸네일 규모에서 파일 크기 · 저장 시간(docs/20-asset-management.md 8절 위험)
//   node tools/bench-assets.mjs [에셋 수=2000] [썸네일 KB=15]
// 저장 = 브라우저와 같은 SQLite WebAssembly로 메모리 DB를 바이트로 내보내기 + 파일 통째로 쓰기.
// 썸네일은 무작위 바이트(압축이 안 되는 WebP와 비슷한 크기)로 채운다.
import { mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { buildSamples } from './build-samples.mjs';
import { openProjectFile } from './lib/project-db.mjs';
import { ROOT } from './lib/cdp.mjs';

const N = Number(process.argv[2] ?? 2000);
const KB = Number(process.argv[3] ?? 15);
const OUT = `${ROOT}samples/out/bench`;
mkdirSync(OUT, { recursive: true });
const built = Object.fromEntries((await buildSamples(OUT)).map(s => [s.name, s.path]));
const path = `${OUT}/assets-${N}.arp`;
copyFileSync(built.normal, path);
const db = openProjectFile(path);
const rts = db.prepare("SELECT resource_type_id FROM volumes WHERE update_id = 'LAUNCH'").all().map(r => r.resource_type_id);
const parts = db.prepare('SELECT part_id FROM parts').all().map(r => r.part_id);
db.exec('BEGIN');
const ins = db.prepare('INSERT INTO assets (asset_id, update_id, batch_id, resource_type_id, name, tier, sort_order, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)');
const st = db.prepare('INSERT INTO asset_parts (asset_id, part_id, status, done_at) VALUES (?, ?, ?, ?)');
const th = db.prepare('INSERT INTO asset_thumbs (asset_id, mime, data, width, height, updated_at) VALUES (?, ?, ?, 256, 256, ?)');
const now = new Date().toISOString();
for (let i = 0; i < N; i += 1) {
  const id = `A${String(i + 1).padStart(5, '0')}`;
  ins.run(id, 'LAUNCH', rts[i % rts.length], `에셋 ${i + 1}`, 'TARGET', i, now);
  if (i % 3 === 0) st.run(id, parts[0], 'DONE', '2026-11-04');
  if (i % 5 === 0) st.run(id, parts[1], 'WIP', null);
  th.run(id, 'image/webp', randomBytes(KB * 1024), now);
}
db.exec('COMMIT');
db.close();
const size = statSync(path).size;

const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
const bytes = new Uint8Array(readFileSync(path));
const mem = new sqlite3.oo1.DB();
const p = sqlite3.wasm.allocFromTypedArray(bytes);
let t = performance.now();
const rc = sqlite3.capi.sqlite3_deserialize(mem.pointer, 'main', p, bytes.byteLength, bytes.byteLength,
  sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
if (rc) throw new Error(`deserialize ${rc}`);
const openMs = performance.now() - t;
// 저장 한 번 = 고치기 한 칸 + 내보내기 + 파일 쓰기
const times = [];
for (let k = 0; k < 5; k += 1) {
  mem.exec(`UPDATE assets SET note = 'x${k}' WHERE asset_id = 'A00001'`);
  t = performance.now();
  const out = sqlite3.capi.sqlite3_js_db_export(mem.pointer);
  const exportMs = performance.now() - t;
  t = performance.now();
  writeFileSync(`${OUT}/save-test.arp`, out);
  times.push({ exportMs, writeMs: performance.now() - t });
}
mem.close();
const avg = f => times.reduce((a, x) => a + x[f], 0) / times.length;
const res = { assets: N, thumbKB: KB, fileMB: +(size / 1024 / 1024).toFixed(1), openMs: +openMs.toFixed(0), exportMs: +avg('exportMs').toFixed(0), writeMs: +avg('writeMs').toFixed(0), saveMs: +(avg('exportMs') + avg('writeMs')).toFixed(0) };
console.log(JSON.stringify(res));
