// 계획 계산 결과 보기
//   node tools/plan.mjs samples/out/normal.arp [MIN|TARGET|STRETCH] [--scenario SC1] [--json]
import { openProjectFile } from './lib/project-db.mjs';
import { calculate } from './lib/pipeline.mjs';

const args = process.argv.slice(2);
const path = args.find(a => a.endsWith('.arp'));
const planMode = args.find(a => ['MIN', 'TARGET', 'STRETCH'].includes(a)) ?? 'TARGET';
const scenarioId = args.includes('--scenario') ? args[args.indexOf('--scenario') + 1] : undefined;
if (!path) {
  console.error('사용법: node tools/plan.mjs <파일.arp> [MIN|TARGET|STRETCH] [--scenario ID] [--json]');
  process.exit(2);
}

const db = openProjectFile(path);
const out = calculate(db, { planMode, scenarioId });
db.close();

if (args.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.blocked ? 1 : 0);
}

const STATUS = { ON_TRACK: '목표 안', TIGHT: '빠듯', LATE: '늦음', UNFINISHED: '기간 안에 못 끝냄', NO_RELEASE_DATE: '출시일 없음' };
const LEVEL = { OK: '여유', WARN: '주의', OVER: '초과', CRITICAL: '심각' };
const pad = (s, n) => String(s ?? '-').padEnd(n);

console.log(`\n■ ${path}  물량 ${planMode}${scenarioId ? `  시나리오 ${scenarioId}` : ''}`);
if (out.skipped.length) console.log(`  얹지 못한 시나리오 변경 ${out.skipped.length}개: ${out.skipped.map(s => `#${s.seq} ${s.why}`).join(', ')}`);
if (out.blocked) {
  console.log('  계산 불가:');
  for (const f of out.findings.filter(f => f.level === 'ERROR')) console.log(`   ${f.code} ${f.key}: ${f.detail}`);
  process.exit(1);
}
const r = out.result;
console.log(`  계획 기간 ${r.horizon.start} ~ ${r.horizon.end} (영업일 ${r.horizon.workdays}) · 스테이지 ${r.meta.stageCount}`);
console.log('\n  업데이트       출시일       완료 예정     판정');
for (const u of r.updates) {
  const late = u.lateWorkdays ? ` +${u.lateWorkdays}영업일` : '';
  const why = u.reason && u.status !== 'ON_TRACK'
    ? `  ← ${u.reason.partId} ${u.reason.resourceTypeId}${u.reason.waitWorkdays ? ` 인력 대기 ${u.reason.waitWorkdays}영업일` : ''}${u.reason.remainingDays > 0.01 ? ` 남은 일 ${u.reason.remainingDays.toFixed(1)}인·일` : ''}`
    : '';
  console.log(`  ${pad(u.name, 12)} ${pad(u.releaseDate, 12)} ${pad(u.expectedCompletionDate, 12)} ${STATUS[u.status]}${late}${u.critical ? ' (심각)' : ''}${why}`);
}
console.log('\n  파트          필요 공수  작업 가능량  부하율  판정  가장 밀린 달');
for (const p of r.parts) {
  console.log(`  ${pad(p.name, 10)} ${p.requiredDays.toFixed(1).padStart(9)} ${p.capacityDays.toFixed(1).padStart(11)} ${(p.loadRate * 100).toFixed(0).padStart(6)}%  ${pad(LEVEL[p.level], 4)}  ${p.peakMonth ?? '-'}`);
}
const t = out.timings;
console.log(`\n  시간: 검증 ${t.validateMs.toFixed(1)}ms · 읽기 ${t.readMs.toFixed(1)}ms · 엔진 ${t.engineMs.toFixed(1)}ms · 합계 ${t.totalMs.toFixed(1)}ms`);
const warnings = out.findings.filter(f => f.level === 'WARN');
if (warnings.length) console.log(`  주의 ${warnings.length}개: ${[...new Set(warnings.map(f => f.code))].join(', ')}`);
