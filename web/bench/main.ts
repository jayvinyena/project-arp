// 브라우저 측정: SQLite WebAssembly + 엔진으로 첫 화면·재계산·저장 시간을 잰다.
// 결과는 window.__bench 에 담기고 화면에도 표로 나온다. tools/bench-browser.mjs 가 크롬으로 열어 읽는다.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { ProjectSession } from '../../core/pipeline.ts';
import type { CalculateOutput } from '../../core/pipeline.ts';
import { applyScenarioOp, compareScenarios } from '../../core/scenarios.ts';
import { openFromBytes, exportBytes, wrap } from '../lib/wasm-db.ts';
import type { Sqlite3 } from '../lib/wasm-db.ts';

interface DatasetResult {
  name: string;
  fileKB: number;
  stages: number;
  fetchMs: number;
  openMs: number;
  firstCalc: { validateMs: number; readMs: number; engineMs: number; totalMs: number };
  renderMs: number;
  /** 파일 받기 시작부터 첫 결과가 화면에 나오기까지 */
  openToScreenMs: number;
  /** 페이지를 연 뒤 첫 결과가 화면에 나오기까지 (첫 데이터에만 뜻이 있다) */
  firstScreenMs: number | null;
  recalc: { runs: number; medianMs: number; maxMs: number; medianEngineMs: number };
  saveExportMs: number;
  /** 원본 + 시나리오 3개 비교(중앙값) */
  compare3Ms: number;
}

const DATASETS = ['scale', 'normal', 'scale-stress'];
const RECALC_RUNS = 15;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x: number) => Math.round(x * 10) / 10;
const out = document.getElementById('out')!;

async function main() {
  const t0 = performance.now();
  const sqlite3 = (await sqlite3InitModule()) as unknown as Sqlite3;
  const initMs = performance.now() - t0;
  const results: DatasetResult[] = [];

  for (const name of DATASETS) {
    const tFetch = performance.now();
    const bytes = new Uint8Array(await (await fetch(`../${name}.arp`, { cache: 'no-store' })).arrayBuffer());
    const fetchMs = performance.now() - tFetch;

    const tOpen = performance.now();
    const db = openFromBytes(sqlite3, bytes);
    const openMs = performance.now() - tOpen;
    const sql = wrap(db);
    const session = new ProjectSession(sql);

    const first = session.calculate();
    if (first.blocked || !first.result) throw new Error(`${name}: 계산 불가`);

    // 첫 화면: 업데이트 판정과 파트 부하 요약을 그린다
    const tRender = performance.now();
    renderSummary(name, first.result);
    await new Promise(requestAnimationFrame);
    const renderMs = performance.now() - tRender;
    const screenAt = performance.now();
    const openToScreenMs = screenAt - tFetch;
    const firstScreenMs = results.length === 0 ? screenAt : null;

    // 재계산: 사용자가 값 하나를 바꾸는 경우(첫 파트 첫 달 인원 ±1)를 흉내 낸다
    const part = String(sql.get('SELECT part_id FROM parts WHERE active = 1 ORDER BY sort_order LIMIT 1')!.part_id);
    const month = String(sql.get('SELECT horizon_start_month AS m FROM settings')!.m);
    const totals: number[] = [];
    const engines: number[] = [];
    for (let i = 0; i < RECALC_RUNS; i += 1) {
      const t = performance.now();
      session.edit('UPDATE capacity SET headcount = headcount + ? WHERE part_id = ? AND month = ?', [i % 2 === 0 ? 1 : -1, part, month], ['capacity']);
      const r = session.calculate();
      totals.push(performance.now() - t);
      engines.push(r.timings.engineMs);
    }

    // 시나리오 3개 비교: 파트 인원 + 첫 업데이트 물량 배율
    const firstUpdate = String(sql.get("SELECT update_id FROM updates ORDER BY priority LIMIT 1")!.update_id);
    const ids = [1, 2, 3].map(i => {
      const id = applyScenarioOp(sql, { kind: 'create', name: `안 ${i}` }).createdId!;
      applyScenarioOp(sql, { kind: 'addAction', scenarioId: id, action: { kind: 'headcount', partId: part, fromMonth: month, toMonth: String(sql.get('SELECT horizon_end_month AS m FROM settings')!.m), delta: i } });
      applyScenarioOp(sql, { kind: 'addAction', scenarioId: id, action: { kind: 'volumeScale', updateId: firstUpdate, scale: 1 + i / 10 } });
      return id;
    });
    compareScenarios(sql, session, ids);
    const cmpTimes = [0, 1, 2, 3, 4].map(() => compareScenarios(sql, session, ids).ms);

    const tSave = performance.now();
    const saved = exportBytes(sqlite3, db);
    const saveExportMs = performance.now() - tSave;
    if (saved.byteLength < 1000) throw new Error('저장 바이트가 너무 작음');
    db.close();

    results.push({
      name,
      fileKB: Math.round(bytes.byteLength / 1024),
      stages: first.result.meta.stageCount,
      fetchMs: round(fetchMs),
      openMs: round(openMs),
      firstCalc: {
        validateMs: round(first.timings.validateMs), readMs: round(first.timings.readMs),
        engineMs: round(first.timings.engineMs), totalMs: round(first.timings.totalMs),
      },
      renderMs: round(renderMs),
      openToScreenMs: round(openToScreenMs),
      firstScreenMs: firstScreenMs === null ? null : round(firstScreenMs),
      recalc: { runs: RECALC_RUNS, medianMs: round(median(totals)), maxMs: round(Math.max(...totals)), medianEngineMs: round(median(engines)) },
      saveExportMs: round(saveExportMs),
      compare3Ms: round(median(cmpTimes)),
    });
  }

  const bench = {
    userAgent: navigator.userAgent,
    sqlite: sqlite3.version.libVersion,
    moduleAndWasmInitMs: round(initMs),
    datasets: results,
  };
  (window as unknown as { __bench: unknown }).__bench = bench;
  renderTable(bench.datasets, bench.moduleAndWasmInitMs, bench.sqlite);
}

function renderSummary(name: string, result: NonNullable<CalculateOutput['result']>) {
  const late = result.updates.filter(u => u.status === 'LATE' || u.status === 'UNFINISHED').length;
  const busiest = [...result.parts].sort((a, b) => b.loadRate - a.loadRate)[0];
  const p = document.createElement('p');
  p.textContent = `${name}: 업데이트 ${result.updates.length}개 중 늦음·못 끝냄 ${late}개 · 가장 바쁜 파트 ${busiest.name} ${Math.round(busiest.loadRate * 100)}%`;
  out.appendChild(p);
}

function renderTable(rows: DatasetResult[], initMs: number, version: string) {
  const table = document.createElement('table');
  table.innerHTML = `
    <caption>SQLite ${version} · 모듈·WASM 준비 ${initMs}ms</caption>
    <tr><th>데이터</th><th>파일</th><th>스테이지</th><th>받기</th><th>열기</th><th>첫 계산</th><th>그리기</th><th>열기→화면</th><th>첫 화면(페이지 연 뒤)</th><th>재계산 중앙값</th><th>재계산 최대</th><th>저장용 내보내기</th><th>시나리오 3개 비교</th></tr>
    ${rows.map(r => `<tr><td>${r.name}</td><td>${r.fileKB}KB</td><td>${r.stages}</td><td>${r.fetchMs}</td><td>${r.openMs}</td><td>${r.firstCalc.totalMs}</td><td>${r.renderMs}</td><td>${r.openToScreenMs}</td><td>${r.firstScreenMs ?? '-'}</td><td>${r.recalc.medianMs}</td><td>${r.recalc.maxMs}</td><td>${r.saveExportMs}</td><td>${r.compare3Ms}</td></tr>`).join('')}`;
  out.appendChild(table);
}

main().catch(error => {
  (window as unknown as { __bench: unknown }).__bench = { error: String(error?.stack ?? error) };
  out.textContent = `오류: ${error}`;
});
