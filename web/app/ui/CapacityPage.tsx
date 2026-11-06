// 인력: 파트 × 달 인원·가동률·생산성·외주·지원, 기간 채우기, 계획 기간 바꾸기
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { rpc } from '../lib/rpc.ts';
import type { CapacityView, CapacityCell } from '../../../core/plan.ts';
import type { Edit, CapacityField } from '../../../core/edits.ts';
import { afterCommit } from './commit.ts';

const FIELDS: { key: CapacityField; label: string; unit: string; pct?: boolean; help: string }[] = [
  { key: 'headcount', label: '인원', unit: '명', help: '정규 인원. 0.5 = 반달 또는 반일 근무' },
  { key: 'utilization', label: '가동률', unit: '%', pct: true, help: '근무일 중 실제 제작에 쓰는 비율' },
  { key: 'outsource_days', label: '외주', unit: '인·일', help: '그 달 외부에서 받는 작업 가능량' },
  { key: 'support_days', label: '지원', unit: '인·일', help: '다른 조직에서 잠시 받는 작업 가능량' },
  { key: 'productivity', label: '생산성', unit: '배', help: '공수 기준 대비 속도. 신규 인원이면 1보다 작게' },
];

const show = (v: number, pct?: boolean) => (pct ? String(Math.round(v * 1000) / 10) : String(Math.round(v * 100) / 100));

function Cell(props: { value: number; pct?: boolean; label: string; disabled: boolean; onCommit: (v: number) => unknown }) {
  const [text, setText] = useState(show(props.value, props.pct));
  useEffect(() => setText(show(props.value, props.pct)), [props.value, props.pct]);
  const reset = () => setText(show(props.value, props.pct));
  const commit = () => {
    // 보이는 글자를 고치지 않았으면 반영하지 않는다(표시는 반올림이라 0.875가 0.88로 저장되지 않게)
    if (text.trim() === show(props.value, props.pct)) return;
    const n = Number(text.trim());
    if (text.trim() === '' || !Number.isFinite(n)) { reset(); return; }
    const v = props.pct ? n / 100 : n;
    if (Math.abs(v - props.value) > 1e-9) afterCommit(props.onCommit(v), reset);
  };
  return <input class="qty cap-cell" inputMode="decimal" aria-label={props.label} value={text} disabled={props.disabled}
    onInput={e => setText((e.target as HTMLInputElement).value)} onBlur={commit}
    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(show(props.value, props.pct)); (e.target as HTMLInputElement).blur(); } }} />;
}

export function CapacityPage(props: { version: number; readOnly: boolean; onApply: (e: Edit) => Promise<boolean> }) {
  const [view, setView] = useState<CapacityView | null>(null);
  const [field, setField] = useState<CapacityField>('headcount');
  const [horizon, setHorizon] = useState({ start: '', end: '' });
  const [fill, setFill] = useState({ partId: '', from: '', to: '', value: '' });
  useEffect(() => { void rpc.capacity().then(v => { setView(v); setHorizon(v.horizon); setFill(f => ({ ...f, partId: f.partId || v.parts[0]?.partId || '', from: f.from || v.months[0] || '', to: f.to || v.months[v.months.length - 1] || '' })); }); }, [props.version]);
  if (!view) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  const meta = FIELDS.find(f => f.key === field)!;
  const apply = (e: Edit) => props.onApply(e);
  // 해마다 달 묶음(머리글 한 칸이 그 해의 달을 모두 덮는다)
  const years: { year: string; n: number; first: boolean }[] = [];
  for (const m of view.months) {
    const y = m.slice(0, 4);
    const last = years[years.length - 1];
    if (last && last.year === y) last.n += 1; else years.push({ year: y, n: 1, first: years.length === 0 });
  }
  const isYearStart = (i: number) => i > 0 && view.months[i].endsWith('-01');

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <PageEyebrow page="capacity" />
          <h1>파트 × 달 인력</h1>
          <p class="muted" style="margin-top: 6px">채용·충원·외주를 달마다 입력합니다. 바꾸면 모든 화면의 계산이 바로 변경됩니다.</p>
        </div>
        <div class="horizon-box">
          <span class="form-label">계획 기간</span>
          <div class="inline">
            <input class="field" type="month" aria-label="계획 시작 달" value={horizon.start} disabled={props.readOnly} onInput={e => setHorizon({ ...horizon, start: (e.target as HTMLInputElement).value })} />
            <span class="faint">~</span>
            <input class="field" type="month" aria-label="계획 끝 달" value={horizon.end} disabled={props.readOnly} onInput={e => setHorizon({ ...horizon, end: (e.target as HTMLInputElement).value })} />
            <button type="button" class="btn sm" disabled={props.readOnly || (horizon.start === view.horizon.start && horizon.end === view.horizon.end)}
              onClick={() => apply({ kind: 'horizon', startMonth: horizon.start, endMonth: horizon.end })}>바꾸기</button>
          </div>
          <span class="form-help">늘린 달의 인력은 바로 앞 달 값을 복사합니다(외주·지원은 0).</span>
        </div>
      </header>

      <section class="card">
        <div class="card-head">
          <div class="segmented wide" role="radiogroup" aria-label="항목">
            {FIELDS.map(f => <button type="button" role="radio" aria-checked={field === f.key} class={field === f.key ? 'on' : ''} onClick={() => setField(f.key)}>{f.label}</button>)}
          </div>
          <span class="small muted">{meta.help} · 단위 {meta.unit}</span>
        </div>
        <div class="card-body">
          <div class="table-wrap ref-wrap">
            <table class="grid ref cap-grid" style={{ minWidth: `${104 + view.months.length * 54}px` }}>
              <thead>
                {/* 해 머리글은 그 해의 달을 모두 덮고, 해가 바뀌는 달에 세로 구분선 */}
                <tr><th class="sticky-col" />{years.map(y => <th colSpan={y.n} class={`year-th${y.first ? '' : ' year-start'}`}>{y.year}년</th>)}</tr>
                <tr><th class="sticky-col">파트</th>{view.months.map((m, i) => <th class={`n${isYearStart(i) ? ' year-start' : ''}`}>{Number(m.slice(5))}월</th>)}</tr>
              </thead>
              <tbody>
                {view.parts.map(p => (
                  <tr class="row">
                    <td class="sticky-col"><b>{p.name}</b></td>
                    {p.cells.map((c: CapacityCell | null, i) => (
                      <td class={`n${isYearStart(i) ? ' year-start' : ''}`}>{c
                        ? <Cell value={c[field]} pct={meta.pct} label={`${p.name} ${view.months[i]} ${meta.label}`} disabled={props.readOnly}
                          onCommit={v => apply({ kind: 'capacity', partId: p.partId, month: view.months[i], field, value: v })} />
                        : <span class="err-text" title="이 달 인력 행이 없습니다">없음</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!props.readOnly && (
            <div class="fill-bar">
              <span class="form-label">한 번에 채우기</span>
              <select class="field" aria-label="채울 파트" value={fill.partId} onChange={e => setFill({ ...fill, partId: (e.target as HTMLSelectElement).value })}>
                {view.parts.map(p => <option value={p.partId}>{p.name}</option>)}
              </select>
              <input class="field" type="month" aria-label="채우기 시작 달" value={fill.from} onInput={e => setFill({ ...fill, from: (e.target as HTMLInputElement).value })} />
              <span class="faint">~</span>
              <input class="field" type="month" aria-label="채우기 끝 달" value={fill.to} onInput={e => setFill({ ...fill, to: (e.target as HTMLInputElement).value })} />
              <input class="field narrow n" inputMode="decimal" aria-label="채울 값" placeholder="값" value={fill.value} onInput={e => setFill({ ...fill, value: (e.target as HTMLInputElement).value })} />
              <span class="faint">{meta.unit}</span>
              <button type="button" class="btn sm" disabled={!fill.value.trim() || !fill.from || !fill.to} onClick={async () => {
                const n = Number(fill.value);
                if (!Number.isFinite(n)) return;
                if (await props.onApply({ kind: 'fillCapacity', partId: fill.partId, fromMonth: fill.from, toMonth: fill.to, field, value: meta.pct ? n / 100 : n })) setFill({ ...fill, value: '' });
              }}>{meta.label} 채우기</button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
