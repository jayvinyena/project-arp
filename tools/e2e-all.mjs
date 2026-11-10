// 크롬 시험 전부: 한 번 빌드하고, 시험 묶음을 여럿 동시에 돌린다(묶음마다 다른 포트·크롬 프로필).
// 시간 초과(응답 없음 · 기다림 시간 초과)로 끝난 묶음은 다 돈 뒤 혼자 한 번 더 돌려, 두 번 다 실패할 때만 실패로 센다(docs/32 4).
// 확인이 틀려서(실패 줄) 끝난 묶음은 다시 돌리지 않는다.
//   node tools/e2e-all.mjs [--no-build] [--jobs 3] [--no-retry] [save plan …(묶음 이름만 골라서)]
import { spawn } from 'node:child_process';
import { run, ROOT } from './lib/cdp.mjs';

const SUITES = ['save', 'new', 'flow', 'people', 'viewer', 'plan', 'progress', 'assets', 'sheet', 'dashboard', 'sim', 'import', 'stable', 'ext', 'advisor', 'setup', 'pipeline', 'deploy'];
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
      // 시간 초과로 멈춤: 실패 줄이 없고, 응답 없음 · 기다림 시간 초과 · 묶음 요약 없이 끝남
      const timedOut = code !== 0 && !/(^|\n)\s*실패\s/.test(out) && (/응답 없음|기다림 시간 초과/.test(out) || !summary);
      resolve({ name, ok: code === 0, secs, passed: summary ? Number(summary[1]) : 0, total: summary ? Number(summary[2]) : 0, timedOut, retried: false });
    });
  });
}

// 빈 자리(slot)가 생길 때마다 다음 묶음을 넣는다
const queue = [...suites];
const results = [];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async (_, slot) => {
  while (queue.length) results.push(await runSuite(queue.shift(), slot));
}));

// 시간 초과 묶음만 혼자(동시 실행 없이) 한 번 더
if (!args.includes('--no-retry')) {
  for (const r of results.filter(x => x.timedOut)) {
    console.log(`\n${r.name}: 시간 초과로 멈춰 혼자 한 번 더 돌립니다`);
    const again = await runSuite(r.name, 0);
    results[results.indexOf(r)] = { ...again, retried: true };
  }
}

const order = name => SUITES.indexOf(name);
results.sort((a, b) => order(a.name) - order(b.name));
console.log('\n================ 크롬 시험 요약 ================');
for (const r of results) console.log(`  ${r.ok ? '통과' : '실패'}  ${r.name.padEnd(9)} ${String(r.passed).padStart(3)}/${String(r.total).padEnd(3)} ${r.secs}초${r.retried ? ' (시간 초과로 다시 돌림)' : ''}`);
const passed = results.reduce((a, r) => a + r.passed, 0);
const total = results.reduce((a, r) => a + r.total, 0);
console.log(`\n${passed}/${total} 통과 · 묶음 ${results.filter(r => r.ok).length}/${results.length} · ${Math.round((Date.now() - t0) / 1000)}초(동시 ${jobs}개)`);
process.exit(results.every(r => r.ok) ? 0 : 1);
