// 기준 규모 파일 만들기와 측정: 파트 8 · 리소스 종류 500 · 업데이트 50 · 계획 기간 36개월
//   node tools/gen-scale.mjs            현실적인 부하(파트 부하율 약 0.5–1.2)
//   node tools/gen-scale.mjs --stress   일부러 과한 부하(필요 공수가 작업 가능량의 수십 배): 엔진 최악 조건
// 재는 것: 파일 크기, 전체 표 읽기 시간(앱 첫 화면의 데이터 준비에 해당), 검증 시간
import { statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProjectFile, openProjectFile, validate, monthsBetween, TABLE_ORDER } from './lib/project-db.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// 재현 가능한 의사 난수
let seed = 20261105;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (lo, hi) => Math.floor(lo + rand() * (hi - lo + 1));

export function buildScaleData({ parts = 8, resources = 500, updates = 50, horizon = ['2027-01', '2029-12'], stress = false } = {}) {
  seed = 20261105;
  const months = monthsBetween(...horizon);
  const partIds = Array.from({ length: parts }, (_, i) => `P${i + 1}`);
  const rtIds = Array.from({ length: resources }, (_, i) => `R${String(i + 1).padStart(3, '0')}`);
  const data = {
    meta: [{ key: 'project_name', value: '기준 규모' }, { key: 'data_version', value: '1' }],
    settings: [{ id: 1, horizon_start_month: horizon[0], horizon_end_month: horizon[1], buffer_rate: 0.1 }],
    parts: partIds.map((id, i) => ({ part_id: id, name: `파트 ${i + 1}`, sort_order: i + 1 })),
    resource_groups: Array.from({ length: 20 }, (_, i) => ({ group_id: `G${i + 1}`, name: `분류 ${i + 1}`, sort_order: i + 1 })),
    resource_types: rtIds.map((id, i) => ({ resource_type_id: id, group_id: `G${(i % 20) + 1}`, name: `리소스 ${i + 1}`, sort_order: i + 1 })),
    effort_profiles: [{ profile_id: 'BASE', name: '기본', sort_order: 1 }, { profile_id: 'AI', name: 'AI 사용 시', sort_order: 2 }],
    resource_parts: [], efforts: [],
    update_types: [{ update_type_id: 'LAUNCH', name: '런칭', is_launch: 1, sort_order: 1 }, { update_type_id: 'LIVE', name: '업데이트', sort_order: 2 }],
    updates: [], volumes: [], progress: [], capacity: [],
  };
  for (const rt of rtIds) {
    const first = pick(0, parts - 1);
    const count = pick(1, Math.min(4, parts - first));
    for (let k = 0; k < count; k += 1) {
      const part = partIds[first + k];
      const base = stress ? pick(1, 40) / 2 : pick(1, 10) / 2;
      data.resource_parts.push({ resource_type_id: rt, part_id: part, rework_rate: 0.1 });
      data.efforts.push({ resource_type_id: rt, part_id: part, profile_id: 'BASE', days: base });
      data.efforts.push({ resource_type_id: rt, part_id: part, profile_id: 'AI', days: base * 0.75 });
    }
  }
  for (let u = 0; u < updates; u += 1) {
    const id = `U${String(u + 1).padStart(2, '0')}`;
    const startIndex = Math.min(months.length - 4, Math.floor((u / updates) * (months.length - 4)));
    const start = `${months[startIndex]}-01`;
    const release = `${months[Math.min(months.length - 1, startIndex + 3)]}-28`;
    data.updates.push({ update_id: id, name: `업데이트 ${u + 1}`, update_type_id: u === 0 ? 'LAUNCH' : 'LIVE', start_date: start, release_date: release, priority: u + 1, sort_order: u + 1 });
    // 업데이트마다 리소스 종류의 일부를 쓴다 (현실적: 5–15%, 과부하: 20–60%)
    const share = stress ? pick(20, 60) / 100 : pick(5, 15) / 100;
    for (const rt of rtIds) {
      if (rand() > share) continue;
      const target = stress ? pick(1, 20) : pick(1, 5);
      data.volumes.push({ update_id: id, resource_type_id: rt, min_qty: Math.max(0, target - 2), target_qty: target, stretch_qty: target + 3, priority: pick(1, 5) });
    }
  }
  for (const p of partIds) for (const m of months) data.capacity.push({ part_id: p, month: m, headcount: stress ? pick(3, 12) : pick(8, 20), utilization: 0.8, productivity: 1 });
  return data;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(`${ROOT}samples/out`, { recursive: true });
  const stress = process.argv.includes('--stress');
  const path = `${ROOT}samples/out/${stress ? 'scale-stress' : 'scale'}.arp`;
  let t = performance.now();
  const data = buildScaleData({ stress });
  createProjectFile(path, data).close();
  const buildMs = performance.now() - t;

  t = performance.now();
  const db = openProjectFile(path);
  let rowCount = 0;
  for (const table of TABLE_ORDER) rowCount += db.prepare(`SELECT * FROM ${table}`).all().length;
  const readMs = performance.now() - t;

  t = performance.now();
  const findings = validate(db);
  const validateMs = performance.now() - t;
  db.close();

  const counts = Object.fromEntries(['volumes', 'efforts', 'capacity', 'updates'].map(k => [k, data[k].length]));
  console.log(JSON.stringify({
    file: path,
    sizeKB: Math.round(statSync(path).size / 1024),
    rows: rowCount, ...counts,
    buildMs: Math.round(buildMs), readAllMs: Math.round(readMs), validateMs: Math.round(validateMs),
    findings: findings.length,
  }, null, 2));
}
