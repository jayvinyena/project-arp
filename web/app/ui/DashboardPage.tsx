// 제작 현황판(docs/20-asset-management.md 18절): 업데이트(마일스톤) 하나의 제작 상황을 한 화면에.
// 요약 4칸 · 추이(누적 완료 공수 대 계획선, 완료 예정) · 처리할 것 · 항목 × 파트 진행 · 단계 분포 · 배치.
import { UPDATE_STATUS } from '../lib/terms.ts';
import { BatchPill, batchWhen } from './BatchPill.tsx';
import type { BatchRow } from '../../../core/plan.ts';
import { useState, useEffect, useRef } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { ModeSwitch } from './PlanPage.tsx';
import { rpc } from '../lib/rpc.ts';
import type { DashboardView, DashTodo } from '../../../core/dashboard.ts';
import type { PlanMode, UpdateStatus } from '../../../engine/types.ts';
import { fmtPct, fmtDate, fmtInt, fmtShortDate } from '../lib/format.ts';
import { MODE_LABEL } from '../lib/modes.ts';

type View = DashboardView & { forecast: { completion: string | null; status: string; batches: BatchRow[] } | null };
const VERDICT = UPDATE_STATUS;
// 현황판에서 카드를 열면, 카드를 닫을 때 현황판으로 돌아온다(docs/34 B-02)
const openAsset = (updateId: string, assetId: string) => window.dispatchEvent(new CustomEvent('arp:assets', { detail: { updateId, assetId, back: 'dashboard' } }));
/** 현황판의 칸 · 줄 → 에셋 화면 거르기(docs/34 B-21) */
const openAssets = (detail: { updateId: string; resourceTypeId?: string; partId?: string; who?: string; status?: string }) => window.dispatchEvent(new CustomEvent('arp:assets', { detail }));
const TAB_KEY = 'arp.dash.todoTab';

/** 추이: 누적 완료 공수(실제) 대 계획선. 오늘 · 목표일 · 완료 예정 표시, 주마다 가로 위치에 따라 값 보기 */
function BurnUp(props: { v: View }) {
  const { trend, window: win, forecast } = props.v;
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(es => setW(Math.max(280, Math.round(es[0].contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const pts = trend.points;
  if (!pts.length || trend.total <= 0) return <div ref={wrap} class="chart-empty small muted">시작일이 없거나 물량이 없어 추이를 그릴 수 없습니다.</div>;
  const H = 240; const L = 44; const R = 16; const T = 14; const B = 28;
  const t0 = Date.parse(pts[0].date) - 6 * 86400000;
  const fc = forecast?.completion ? Date.parse(forecast.completion) : null;
  const t1 = Math.max(Date.parse(pts.at(-1)!.date), fc ?? 0);
  const x = (d: string | number) => L + ((typeof d === 'string' ? Date.parse(d) : d) - t0) / (t1 - t0) * (w - L - R);
  const y = (val: number) => T + (1 - val / trend.total) * (H - T - B);
  const path = (key: 'actual' | 'ideal') => pts.filter(p => p[key] != null).map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p[key]!).toFixed(1)}`).join(' ');
  const months: { t: number; label: string }[] = [];
  for (const p of pts) {
    const d = new Date(Date.parse(p.date) - 6 * 86400000);
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (d.getUTCDate() > 1 ? 1 : 0), 1));
    const label = first.getUTCMonth() === 0 ? `${String(first.getUTCFullYear()).slice(2)}년 1월` : `${first.getUTCMonth() + 1}월`;
    if (first.getTime() <= t1 && !months.some(m => m.t === first.getTime())) months.push({ t: first.getTime(), label });
  }
  const step = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor((w - L - R) / 56))));
  const hp = hover == null ? null : pts[hover];
  const onMove = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const mx = e.clientX - r.left;
    let best = 0; let bd = Infinity;
    pts.forEach((p, i) => { const dd = Math.abs(x(p.date) - mx); if (dd < bd) { bd = dd; best = i; } });
    setHover(best);
  };
  const lastActual = [...pts].reverse().find(p => p.actual != null);
  return (
    <div ref={wrap} class="burnup">
      <svg width={w} height={H} role="img" aria-label={`누적 완료 공수 추이: 지금 ${fmtPct(props.v.summary.rate)}`} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} style="touch-action: pan-y">
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <g>
            <line x1={L} x2={w - R} y1={y(trend.total * f)} y2={y(trend.total * f)} class="grid-line" />
            <text x={L - 6} y={y(trend.total * f) + 4} class="axis-text" text-anchor="end">{Math.round(f * 100)}%</text>
          </g>
        ))}
        {months.filter((_, i) => i % step === 0).map(m => <text x={x(m.t)} y={H - 8} class="axis-text" text-anchor="middle">{m.label}</text>)}
        {win.target && <g><line x1={x(win.target)} x2={x(win.target)} y1={T} y2={H - B} class="mark-line target" /><text x={x(win.target) - 4} y={H - B - 6} class="axis-text" text-anchor="end">{win.targetLabel} {win.target.slice(5).replace('-', '/')}</text></g>}
        <line x1={x(trend.today)} x2={x(trend.today)} y1={T} y2={H - B} class="mark-line today" />
        <text x={x(trend.today) + 4} y={T + 10} class="axis-text">오늘</text>
        <path d={path('ideal')} class="line-ideal" />
        <path d={path('actual')} class="line-actual" />
        {lastActual && <circle cx={x(lastActual.date)} cy={y(lastActual.actual!)} r={4.5} class="dot-actual" />}
        {fc && <g><circle cx={x(fc)} cy={y(trend.total)} r={5} class="dot-forecast" /><text x={x(fc) - 8} y={y(trend.total) + 4} class="axis-text" text-anchor="end">완료 예정 {forecast!.completion!.slice(5).replace('-', '/')}</text></g>}
        {hp && (
          <g pointer-events="none">
            <line x1={x(hp.date)} x2={x(hp.date)} y1={T} y2={H - B} class="crosshair" />
            {hp.actual != null && <circle cx={x(hp.date)} cy={y(hp.actual)} r={4} class="dot-actual" />}
            {hp.ideal != null && <circle cx={x(hp.date)} cy={y(hp.ideal)} r={3.5} class="dot-ideal" />}
          </g>
        )}
      </svg>
      {hp && (
        <div class="chart-tip" style={{ left: `${Math.min(w - 170, Math.max(0, x(hp.date) + 10))}px` }}>
          <b>{fmtShortDate(hp.date)} 주</b>
          <span><i class="key-actual" />실제 {hp.actual == null ? '—' : fmtPct(hp.actual / trend.total)}</span>
          <span><i class="key-ideal" />계획선 {hp.ideal == null ? '—' : fmtPct(hp.ideal / trend.total)}</span>
        </div>
      )}
      {/* 그래프를 글로도(docs/34 B-22): 마우스 · 터치 없이 읽게 */}
      <p class="small muted chart-sum">{lastActual ? <>지금까지 실제 <b>{fmtPct(lastActual.actual! / trend.total)}</b>{lastActual.ideal != null ? <> · 같은 때 계획선 {fmtPct(lastActual.ideal / trend.total)}</> : ''}</> : '아직 완료 기록이 없습니다'}{forecast?.completion ? <> · 완료 예정 {fmtShortDate(forecast.completion)}</> : ''}{win.target ? <> · {win.targetLabel} {fmtShortDate(win.target)}</> : ''}</p>
    </div>
  );
}

function TodoList(props: { updateId: string; items: DashTodo[]; empty: string; sinceLabel: string }) {
  const [more, setMore] = useState(false);
  const list = more ? props.items : props.items.slice(0, 7);
  if (!props.items.length) return <p class="small faint todo-empty">{props.empty}</p>;
  return (
    <ul class="todo-list">
      {list.map(t => (
        <li><button type="button" class="todo-item" onClick={() => openAsset(props.updateId, t.assetId)}>
          <span class="todo-name">{t.name}</span>
          <span class="small faint">{t.resource}{t.part ? ` · ${t.part}` : ''}{t.who ? ` · ${t.who}` : ''}</span>
          {t.since && <span class="small todo-since">{props.sinceLabel} {fmtShortDate(t.since)}</span>}
        </button></li>
      ))}
      {props.items.length > 7 && !more && <li><button type="button" class="btn sm ghost" onClick={() => setMore(true)}>{props.items.length - 7}개 더 보기</button></li>}
    </ul>
  );
}

export function DashboardPage(props: {
  version: number; planMode: PlanMode; setPlanMode: (m: PlanMode) => void; onGo: (page: 'assets' | 'progress' | 'capacity') => void;
  /** 보기 모드: 인력 화면(작업자 명단)으로 가는 단추를 감춘다 */
  viewer?: boolean;
  /** 지금 업데이트(모든 화면이 함께 쓴다) */
  updateId: string | null; onUpdate: (id: string) => void;
}) {
  const [updateId, setUpdateId] = useState<string | null>(props.updateId);
  const [v, setV] = useState<View | null>(null);
  // 처리할 것 탭: 고른 탭은 이 탭(브라우저)에 기억, 처음엔 가장 급한 비어 있지 않은 탭(docs/34 B-20)
  const [tab, setTabRaw] = useState<keyof DashboardView['todo'] | null>(() => { try { return (sessionStorage.getItem(TAB_KEY) as keyof DashboardView['todo'] | null); } catch { return null; } });
  const setTab = (k: keyof DashboardView['todo']) => { setTabRaw(k); try { sessionStorage.setItem(TAB_KEY, k); } catch { /* 저장소 없음 */ } };
  // 단계 분포 묶음: 항목별 · 파이프라인별(docs/32 8). 고른 것은 이 브라우저에 남긴다
  const [stageBy, setStageBy] = useState<'group' | 'pipeline'>(() => { try { return localStorage.getItem('arp.dash.stageBy') === 'pipeline' ? 'pipeline' : 'group'; } catch { return 'group'; } });
  const pickStageBy = (x: 'group' | 'pipeline') => { setStageBy(x); try { localStorage.setItem('arp.dash.stageBy', x); } catch { /* 저장소 없음 */ } };
  useEffect(() => { void rpc.dashboard(updateId, props.planMode).then(x => { setV(x); if (!updateId) setUpdateId(x.updateId); if (x.updateId && x.updateId !== props.updateId) props.onUpdate(x.updateId); }); }, [props.version, updateId, props.planMode]);
  if (!v) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  const s = v.summary;
  const verdict = v.forecast ? VERDICT[v.forecast.status as UpdateStatus] : null;
  const next = v.batches.filter(b => b.due && b.done < b.count).sort((a, b) => (a.due! < b.due! ? -1 : 1))[0] ?? null;
  const TABS: { k: keyof DashboardView['todo']; label: string; empty: string; since: string }[] = [
    { k: 'review', label: '검수 요청', empty: '검수를 기다리는 작업이 없습니다.', since: '시작' },
    { k: 'retake', label: '수정', empty: '수정 중인 작업이 없습니다.', since: '시작' },
    { k: 'overdue', label: '마감 지남', empty: '마감이 지난 에셋이 없습니다.', since: '마감' },
    { k: 'stale', label: '오래 머문 진행', empty: '2주 넘게 진행 중인 작업이 없습니다.', since: '시작' },
    { k: 'hold', label: '보류', empty: '보류된 작업이 없습니다.', since: '' },
  ];
  const urgent = (['overdue', 'retake', 'review', 'stale', 'hold'] as const).find(k => v.todo[k].length) ?? 'review';
  const cur = TABS.find(x => x.k === (tab ?? urgent))!;
  const heat = (r: number) => `color-mix(in srgb, var(--accent) ${Math.round(8 + r * 52)}%, var(--surface))`;
  const ahead = s.aheadWorkdays;

  return (
    <div class="page dashboard">
      <header class="page-head">
        <div>
          <PageEyebrow page="dashboard" />
          <h1>제작 현황판</h1>
          <p class="muted" style="margin-top: 6px">업데이트(마일스톤) 하나의 제작 상황입니다. 진행은 작업 진척의 완료 수량을 기본 공수로 바꿔 계산합니다({MODE_LABEL[props.planMode]} 물량 기준).</p>
        </div>
        <div class="inline">
          <select class="field" aria-label="업데이트(마일스톤)" title="업데이트(마일스톤) — 에셋 · 작업 진척 · 시뮬레이션도 같은 업데이트로 열립니다" value={v.updateId ?? ''} onChange={e => { const id = (e.target as HTMLSelectElement).value; setUpdateId(id); props.onUpdate(id); }}>
            {v.updates.map(u => <option value={u.updateId}>{u.name}{u.live ? '' : ' (완료 · 취소)'}</option>)}
          </select>
          <ModeSwitch value={props.planMode} onChange={props.setPlanMode} />
        </div>
      </header>

      <div class="stat-row dash-tiles">
        <div class="stat">
          <span class="stat-label">진행률</span>
          <b class="stat-num">{fmtPct(s.rate)}</b>
          <span class="dash-bar"><span style={{ width: `${Math.min(100, s.rate * 100)}%` }} />{s.idealRate != null && <i style={{ left: `${s.idealRate * 100}%` }} title={`오늘 계획선 ${fmtPct(s.idealRate)}`} />}</span>
          <span class="small faint">{fmtInt(s.doneDays)} / {fmtInt(s.totalDays)} 인·일{s.idealRate != null ? ` · 계획선 ${fmtPct(s.idealRate)}` : ''}</span>
        </div>
        <div class="stat">
          <span class="stat-label">계획선 대비</span>
          <b class={`stat-num${ahead == null ? '' : ahead < 0 ? ' bad-num' : ' ok-num'}`}>{ahead == null ? '—' : ahead === 0 ? '계획선과 같음' : `${Math.abs(ahead)}영업일 ${ahead > 0 ? '앞섬' : '늦음'}`}</b>
          <span class="small faint">{v.forecast?.completion ? <>완료 예정 {fmtDate(v.forecast.completion)} {verdict && <span class={`pill ${verdict.tone} plain`} data-icon={verdict.icon}>{verdict.text}</span>}</> : '완료 예정을 계산할 수 없습니다'}</span>
        </div>
        <div class="stat">
          <span class="stat-label">이번 주 완료</span>
          <b class="stat-num">{s.weekDone}<span class="stat-unit">건</span></b>
          <span class="small faint">{s.assets ? `지난주 ${s.lastWeekDone}건 · 파트 작업(에셋) 기준` : '에셋을 등록하면 주간 완료를 셉니다'}</span>
        </div>
        <div class="stat">
          <span class="stat-label">다음 배치 마감</span>
          {next ? <>
            <b class={`stat-num${next.daysLeft! < 0 ? ' bad-num' : next.daysLeft! <= 14 ? ' warn-num' : ''}`}>{next.daysLeft! < 0 ? `${-next.daysLeft!}일 지남` : `D-${next.daysLeft}`}</b>
            <span class="small faint">{next.name} · {fmtShortDate(next.due)} · 진행 {fmtPct(next.progress)}</span>
            {(() => { const f = v.forecast?.batches.find(x => x.batchId === next.batchId); return f ? <span class="batch-when small">완료 예정 {batchWhen(f)} <BatchPill b={f} /></span> : null; })()}
          </> : <><b class="stat-num">—</b><span class="small faint">마감일이 있는 배치가 없습니다</span></>}
        </div>
      </div>

      <div class="dash-row">
        <section class="card dash-trend">
          <div class="card-head"><div><h2>추이</h2><p class="small muted" style="margin-top: 2px">누적 완료 공수(실제)와 계획선(시작 0% → {v.window.targetLabel || '목표일'} 100%)을 비교합니다. 선 위에 올리면 주마다 값이 표시됩니다.</p></div>
            <div class="chart-legend small"><span><i class="key-actual" />실제 완료</span><span><i class="key-ideal" />계획선</span><span><i class="key-forecast" />완료 예정</span></div></div>
          <div class="card-body" style="padding-top: 0"><BurnUp v={v} /></div>
        </section>
        <section class="card dash-todo">
          <div class="card-head"><div><h2>처리할 것</h2><p class="small muted" style="margin-top: 2px">누르면 그 에셋의 카드가 열립니다.</p></div></div>
          <div class="card-body" style="padding-top: 0">
            <nav class="todo-tabs" role="tablist" aria-label="처리할 것">
              {TABS.map(x => (
                <button type="button" role="tab" aria-selected={cur.k === x.k} class={cur.k === x.k ? 'on' : ''} onClick={() => setTab(x.k)}>
                  {x.label}<span class={`todo-n${v.todo[x.k].length ? (x.k === 'retake' || x.k === 'overdue' ? ' bad' : ' warn') : ''}`}>{v.todo[x.k].length}</span>
                </button>
              ))}
            </nav>
            {s.assets === 0
              ? <p class="small faint todo-empty">에셋을 등록하면 검수 요청 · 수정 · 마감 지남 같은 처리할 것을 모아 보여 줍니다.</p>
              : <TodoList updateId={v.updateId!} items={v.todo[cur.k]} empty={cur.empty} sinceLabel={cur.since} />}
          </div>
        </section>
      </div>

      <section class="card">
        <div class="card-head"><div><h2>항목 × 파트 진행</h2><p class="small muted" style="margin-top: 2px">칸 = 그 파트가 끝낸 수 / 만들 수(물량 − 외주). 진할수록 많이 끝났습니다. 빗금은 거치지 않는 파트입니다.</p></div>
          {!props.viewer && <button type="button" class="btn sm" onClick={() => props.onGo('progress')}>작업 진척에서 보기</button>}</div>
        <div class="card-body" style="padding-top: 4px">
          <div class="table-wrap ref-wrap">
            <table class="grid ref dash-matrix">
              <colgroup><col />{v.parts.map(() => <col class="heat-col" />)}<col style="width: 170px" /></colgroup>
              <thead><tr><th>리소스</th>{v.parts.map(p => <th class="c">{p.name}</th>)}<th title="끝낸 파트 작업의 기본 공수 ÷ 전체 공수(작업 진척의 끝까지 완료와 다릅니다)">진행(공수)</th></tr></thead>
              <tbody>
                {v.matrix.map(g => (
                  <>
                    <tr class="group group-strong"><td colSpan={v.parts.length + 2}><span class="group-head"><b>{g.groupName}</b><span class="group-count">{g.rows.length}종</span></span></td></tr>
                    {g.rows.map(r => (
                      <tr class="row in-group">
                        <td><b>{r.name}</b><span class="small faint"> · {r.need}개</span></td>
                        {r.cells.map((c, i) => c == null
                          ? <td class="heat off" aria-label={`${r.name} ${v.parts[i].name}: 거치지 않음`} />
                          : <td class="heat" style={{ background: heat(c.rate) }}>
                              <button type="button" class="heat-btn" title={`${r.name} · ${v.parts[i].name}: ${c.done} / ${c.need} (${fmtPct(c.rate)}) — 누르면 에셋에서 봅니다`} aria-label={`${r.name} ${v.parts[i].name} ${c.done} / ${c.need} 에셋에서 보기`}
                                onClick={() => openAssets({ updateId: v.updateId!, resourceTypeId: r.resourceTypeId, partId: v.parts[i].partId })}><span class={c.rate >= 0.6 ? 'heat-text strong' : 'heat-text'}>{c.done} / {c.need}</span></button>
                            </td>)}
                        <td><span class="share"><span class="num small">{fmtPct(r.rate)}</span><span class="bar"><span class={`fill${r.rate >= 1 ? ' done' : ''}`} style={{ width: `${Math.min(100, r.rate * 100)}%` }} /></span></span></td>
                      </tr>
                    ))}
                  </>
                ))}
                <tr class="total"><td>파트 합계(공수 기준)</td>{v.partTotals.map(t => <td class="c num">{t.totalDays > 0 ? fmtPct(t.rate) : '—'}</td>)}<td class="num">{fmtPct(s.rate)}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <div class="dash-row">
        <section class="card dash-stages">
          <div class="card-head"><div><h2>제작 단계 분포</h2><p class="small muted" style="margin-top: 2px">{stageBy === 'pipeline' ? '파이프라인마다 그 단계 순서로 에셋이 어느 단계에 있는지입니다(∥ 는 병렬 단계를 한 칸으로).' : '항목마다 에셋이 어느 단계에 있는지입니다(앞에서부터 아직 끝나지 않은 첫 파트).'}</p></div>
            <div class="inline" style="gap: 6px">
              {v.stages && (
                <div class="segmented wide" role="radiogroup" aria-label="단계 분포 묶음">
                  <button type="button" role="radio" aria-checked={stageBy === 'group'} class={stageBy === 'group' ? 'on' : ''} onClick={() => pickStageBy('group')}>항목별</button>
                  <button type="button" role="radio" aria-checked={stageBy === 'pipeline'} class={stageBy === 'pipeline' ? 'on' : ''} onClick={() => pickStageBy('pipeline')}>파이프라인별</button>
                </div>
              )}
              <button type="button" class="btn sm" onClick={() => props.onGo('assets')}>보드에서 보기</button>
            </div></div>
          <div class="card-body" style="padding-top: 4px">
            {!v.stages ? <p class="small faint">에셋을 등록하면 단계 분포를 보여 줍니다.</p> : stageBy === 'pipeline' ? (
              <div class="stage-bars pipe-stages">
                {v.pipelineStages.map(ps => (
                  <div class="pipe-stage">
                    <div class="stage-legend small"><b class="pipe-stage-name">{ps.name}<span class="faint"> {ps.total}</span></b>
                      {ps.list.map((st, i) => <span><i class={`stg stg-${i === 0 ? 'todo' : i === ps.list.length - 1 ? 'done' : `p${Math.min(4, i)}`}`} />{st.name} {ps.counts[i]}</span>)}</div>
                    <span class="stage-bar" aria-label={`${ps.name} 단계 분포`}>
                      {ps.counts.map((c, i) => c > 0 && (
                        <span class={`stg stg-${i === 0 ? 'todo' : i === ps.counts.length - 1 ? 'done' : `p${Math.min(4, i)}`}`} style={{ flexGrow: c }} title={`${ps.list[i].name} ${c}개`}>{c / ps.total >= 0.08 ? c : ''}</span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div class="stage-legend small">{v.stages.list.map((st, i) => <span><i class={`stg stg-${i === 0 ? 'todo' : i === v.stages!.list.length - 1 ? 'done' : `p${Math.min(4, i)}`}`} />{st.name} <b class="num">{v.stages!.groups.reduce((a, g) => a + (g.counts[i] ?? 0), 0)}</b></span>)}</div>
                <div class="stage-bars">
                  {v.stages.groups.map(g => (
                    <div class="stage-row">
                      <span class="stage-name">{g.name}<span class="small faint"> {g.total}</span></span>
                      <span class="stage-bar">
                        {g.counts.map((c, i) => c > 0 && (
                          <span class={`stg stg-${i === 0 ? 'todo' : i === g.counts.length - 1 ? 'done' : `p${Math.min(4, i)}`}`} style={{ flexGrow: c }} title={`${v.stages!.list[i].name} ${c}개`}>{c / g.total >= 0.08 ? c : ''}</span>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
        <section class="card dash-batches">
          <div class="card-head"><div><h2>배치</h2><p class="small muted" style="margin-top: 2px">마감까지 남은 날, 진행(끝난 파트 작업 비율), 지금 인력으로 계산한 완료 예정입니다. 업데이트 안에서는 배치 순서대로 작업한다고 보고 계산합니다.</p></div></div>
          <div class="card-body" style="padding-top: 4px">
            {!v.batches.length ? <p class="small faint">배치가 없습니다. 에셋 제작 현황의 "배치" 탭에서 더합니다.</p> : (
              <div class="table-wrap ref-wrap">
                <table class="grid ref dash-batch-table">
                  <colgroup><col /><col style="width: 92px" /><col style="width: 58px" /><col style="width: 52px" /></colgroup>
                  <thead><tr><th>배치</th><th>마감</th><th class="n">완료</th><th>진행</th></tr></thead>
                  <tbody>
                    {v.batches.map(b => (
                      <tr class="row">
                        <td><b>{b.name}</b>{(() => { const f = v.forecast?.batches.find(x => x.batchId === b.batchId); return <div class="batch-when small">{f ? <><span class="num">{batchWhen(f)}</span><BatchPill b={f} /></> : <span class="faint">{b.done >= b.count ? '모두 완료' : '완료 예정 없음'}</span>}</div>; })()}</td>
                        <td class="small due-cell">{b.due ? <>{fmtShortDate(b.due)} <span class={`pill plain ${b.daysLeft! < 0 && b.done < b.count ? 'bad' : b.daysLeft! <= 14 ? 'warn' : ''}`}>{b.daysLeft! < 0 ? `${-b.daysLeft!}일 지남` : `D-${b.daysLeft}`}</span></> : '—'}</td>
                        <td class="n num">{b.done} / {b.count}</td>
                        <td><span class="share"><span class="num small">{fmtPct(b.progress)}</span><span class="bar"><span class={`fill${b.progress >= 1 ? ' done' : ''}`} style={{ width: `${b.progress * 100}%` }} /></span></span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>

      <section class="card dash-people">
        <div class="card-head"><div><h2>담당별</h2><p class="small muted" style="margin-top: 2px">에셋 파트 작업을 담당(에셋 담당 칸) 이름마다 상태별로 센 것입니다. 마감 지남 = 마감이 지났는데 끝나지 않은 에셋에서 지금 단계를 맡은 수.</p></div>
          {!props.viewer && <button type="button" class="btn sm" onClick={() => props.onGo('capacity')}>작업자 명단</button>}</div>
        <div class="card-body" style="padding-top: 4px">
          {!v.people.rows.some(r => r.name) ? <p class="small faint">에셋 담당 칸에 이름을 넣으면 담당별로 보여 줍니다.</p> : (
            <div class="table-wrap ref-wrap">
              <table class="grid ref dash-people-table">
                <colgroup><col style="width: 220px" /><col style="width: 130px" /><col style="width: 80px" /><col style="width: 80px" /><col style="width: 88px" /><col style="width: 80px" /><col style="width: 80px" /><col style="width: 88px" /><col style="width: 80px" /></colgroup>
                <thead><tr><th>담당</th><th>소속팀</th><th class="n">대기</th><th class="n">진행</th><th class="n">검수 요청</th><th class="n">수정</th><th class="n">보류</th><th class="n">마감 지남</th><th class="n">완료</th></tr></thead>
                <tbody>
                  {v.people.rows.map(r => (
                    <tr class={`row${r.name ? '' : ' muted-row'}`}>
                      <td>{r.name ? <button type="button" class="link-btn" title="이 담당의 에셋만 보기" onClick={() => openAssets({ updateId: v.updateId!, who: r.name! })}><b>{r.name}</b></button> : <span class="faint">담당 없음</span>}{r.name && !r.inRoster && <span class="pill plain warn people-miss" title="작업자 명단에 없는 이름입니다. 인력 › 작업자 › 담당에서 찾기로 더할 수 있습니다">명단에 없음</span>}</td>
                      <td class="small">{r.team ?? <span class="faint">—</span>}</td>
                      {([r.todo, r.wip, r.review, r.retake, r.hold] as number[]).map((n, i) => <td class={`n num${n === 0 ? ' faint' : i === 3 && n ? ' bad-text' : i === 2 && n ? ' warn-text' : ''}`}>{n}</td>)}
                      <td class={`n num${r.overdue ? ' bad-text' : ' faint'}`}>{r.overdue}</td>
                      <td class={`n num${r.done ? '' : ' faint'}`}>{r.done}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {v.people.headcount.month && (
            <div class="headcount small" role="group" aria-label="파트 인원 비교">
              <span class="faint">파트 인원({v.people.headcount.month.replace('-', '년 ')}월) 명단 · 인력 표</span>
              {v.people.headcount.parts.map(p => {
                const off = p.capacity != null && p.roster !== Math.round(p.capacity);
                return <span class={`headcount-chip${off ? ' off' : ''}`} title={off ? `작업자 명단(참여 중, 소속팀 ${p.name}) ${p.roster}명과 인력 표 인원 ${p.capacity}명이 다릅니다. 계산은 인력 표 숫자를 씁니다` : undefined}>{p.name} <b>{p.roster}</b> · {p.capacity ?? '—'}</span>;
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
