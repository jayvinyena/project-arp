// 프로젝트 파일 점검: 검증 규칙 + (오류가 없으면) 간이 부하
//   node tools/validate.mjs samples/out/normal.arp [MIN|TARGET|STRETCH]
import { openProjectFile, validate, quickLoad } from './lib/project-db.mjs';

const [path, planMode = 'TARGET'] = process.argv.slice(2);
if (!path) {
  console.error('사용법: node tools/validate.mjs <파일.arp> [MIN|TARGET|STRETCH]');
  process.exit(2);
}

const db = openProjectFile(path);
const name = db.prepare("SELECT value FROM meta WHERE key = 'project_name'").get()?.value ?? path;
const findings = validate(db);
const errors = findings.filter(f => f.level === 'ERROR');
const warnings = findings.filter(f => f.level === 'WARN');

console.log(`\n■ ${name}`);
console.log(`  오류 ${errors.length} · 주의 ${warnings.length}`);
for (const f of [...errors, ...warnings]) {
  console.log(`  ${f.level === 'ERROR' ? '오류' : '주의'} ${f.code} ${f.title}\n       ${f.key}: ${f.detail}`);
}

if (errors.length) {
  console.log('\n  계산 불가: 위 오류를 먼저 고쳐야 합니다.');
} else {
  console.log(`\n  간이 부하 (${planMode}, 계획 기간 전체 합계 · 일정 배치 전)`);
  console.log('  파트          필요 공수   작업 가능량   부하율');
  for (const r of quickLoad(db, planMode)) {
    console.log(`  ${r.name.padEnd(10)} ${r.demandDays.toFixed(1).padStart(10)} ${r.capacityDays.toFixed(1).padStart(12)} ${(r.loadRate * 100).toFixed(0).padStart(7)}%`);
  }
}
db.close();
process.exit(errors.length ? 1 : 0);
