// 크롬 시험 전부: 한 번 빌드하고, 시험 묶음을 여럿 동시에 돌린다(묶음마다 다른 포트·크롬 프로필).
//   node tools/e2e-all.mjs [--no-build] [--jobs 3] [save plan …(묶음 이름만 골라서)]
import { spawn } from 'node:child_process';
import { run, ROOT } from './lib/cdp.mjs';

const SUITES = ['save', 'new', 'plan', 'progress', 'assets', 'sheet', 'dashboard', 'sim', 'import', 'stable', 'ext', 'advisor', 'setup', 'deploy'];
const args = process.argv.slice(2);
const jobsAt = args.indexOf('--jobs');
const jobs = Math.max(1, Number(jobsAt >= 0 ? args[jobsAt + 1] : 0) || 3);
const picked = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--jobs');
const suites = picked.length ? SUITES.filter(s => picked.includes(s)) : SUITES;

const t0 = Date.now();
if (!args.includes('--no-build')) {
  console.log('빌드…');
  await run(process.execPath, ['tools/build-samples.mjs'], { stdio: 'ignore' });
  await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'warn']);
}

function runSuite(name, slot) {
  return new Promise(resolve => {
    const started = Date.now();
    const env = { ...process.env, ARP_E2E_PORT: String(4400 + slot), ARP_CDP_PORT: String(9400 + slot) };
    const p = spawn(process.execPath, [`tools/e2e-${name}.mjs`, '--no-build'], { cwd: ROOT, env });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => {
      const secs = Math.round((Date.now() - started) / 1000);
      const summary = /(\d+)\/(\d+) 통과/.exec(out);
      console.log(`\n── ${name} (${secs}초) ──\n${out.trimEnd()}`);
      resolve({ name, ok: code === 0, secs, passed: summary ? Number(summary[1]) : 0, total: summary ? Number(summary[2]) : 0 });
    });
  });
}

// 빈 자리(slot)가 생길 때마다 다음 묶음을 넣는다
const queue = [...suites];
const results = [];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async (_, slot) => {
  while (queue.length) results.push(await runSuite(queue.shift(), slot));
}));

const order = name => SUITES.indexOf(name);
results.sort((a, b) => order(a.name) - order(b.name));
console.log('\n================ 크롬 시험 요약 ================');
for (const r of results) console.log(`  ${r.ok ? '통과' : '실패'}  ${r.name.padEnd(9)} ${String(r.passed).padStart(3)}/${String(r.total).padEnd(3)} ${r.secs}초`);
const passed = results.reduce((a, r) => a + r.passed, 0);
const total = results.reduce((a, r) => a + r.total, 0);
console.log(`\n${passed}/${total} 통과 · 묶음 ${results.filter(r => r.ok).length}/${results.length} · ${Math.round((Date.now() - t0) / 1000)}초(동시 ${jobs}개)`);
process.exit(results.every(r => r.ok) ? 0 : 1);
