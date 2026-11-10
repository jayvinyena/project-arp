// 인력: 파트 × 달 인원·가동률·생산성·외주·지원, 기간 채우기, 계획 기간 바꾸기 / 작업자 탭: 이름 · 소속팀 · 이메일 · 특이사항(docs/24-people.md)
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { rpc } from '../lib/rpc.ts';
import type { CapacityView, CapacityCell } from '../../../core/plan.ts';
import type { Edit, CapacityField } from '../../../core/edits.ts';
import { afterCommit } from './commit.ts';
import { Field } from './SetupPage.tsx';
import { IconPlus, IconX } from './icons.tsx';
import type { Person } from '../../../core/people.ts';

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
  const [tab, setTab] = useState<'capacity' | 'people'>('capacity');
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
          <h1>{tab === 'capacity' ? '파트 × 달 인력' : '작업자'}</h1>
          <p class="muted" style="margin-top: 6px">{tab === 'capacity'
            ? '채용·충원·외주를 달마다 입력합니다. 바꾸면 모든 화면의 계산이 바로 변경됩니다.'
            : '실제 작업자 명단입니다. 계산에는 쓰지 않고(인원은 "파트 × 달 인력" 탭의 숫자), 에셋 담당 칸에서 이름을 고를 때 씁니다.'}</p>
        </div>
        {tab === 'capacity' && <div class="horizon-box">
          <span class="form-label">계획 기간</span>
          <div class="inline">
            <input class="field" type="month" aria-label="계획 시작 달" value={horizon.start} disabled={props.readOnly} onInput={e => setHorizon({ ...horizon, start: (e.target as HTMLInputElement).value })} />
            <span class="faint">~</span>
            <input class="field" type="month" aria-label="계획 끝 달" value={horizon.end} disabled={props.readOnly} onInput={e => setHorizon({ ...horizon, end: (e.target as HTMLInputElement).value })} />
            <button type="button" class="btn sm" disabled={props.readOnly || (horizon.start === view.horizon.start && horizon.end === view.horizon.end)}
              onClick={() => apply({ kind: 'horizon', startMonth: horizon.start, endMonth: horizon.end })}>바꾸기</button>
          </div>
          <span class="form-help">늘린 달의 인력은 바로 앞 달 값을 복사합니다(외주·지원은 0).</span>
        </div>}
      </header>

      <nav class="sub-tabs" role="tablist" aria-label="인력 화면">
        <button type="button" role="tab" aria-selected={tab === 'capacity'} class={tab === 'capacity' ? 'on' : ''} onClick={() => setTab('capacity')}>파트 × 달 인력</button>
        <button type="button" role="tab" aria-selected={tab === 'people'} class={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}>작업자 <span class="tab-n">{view.people.length}</span></button>
      </nav>

      {tab === 'people' && <PeopleCard people={view.people} parts={view.parts.map(p => p.name)} readOnly={props.readOnly} apply={apply} />}

      {tab === 'capacity' && <section class="card">
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
      </section>}
    </div>
  );
}

/** 작업자 명단: 이름 · 소속팀 · 이메일 · 특이사항 · 참여. 칸을 벗어나면 저장, 변경 이력에서 되돌린다 */
function PeopleCard(props: { people: Person[]; parts: string[]; readOnly: boolean; apply: (e: Edit) => Promise<boolean> }) {
  const { people, readOnly: ro, apply } = props;
  const [add, setAdd] = useState({ name: '', team: '' });
  const teams = [...new Set([...props.parts, ...people.map(p => p.team).filter(Boolean) as string[]])];
  const count = new Map<string, number>();
  for (const p of people) if (p.active) count.set(p.team ?? '소속팀 없음', (count.get(p.team ?? '소속팀 없음') ?? 0) + 1);
  const create = async () => { if (await apply({ kind: 'createPerson', name: add.name, team: add.team || null })) setAdd(a => ({ name: '', team: a.team })); };
  return (
    <section class="card">
      <div class="card-head">
        <div><h2>작업자 명단</h2>
          <p class="small muted" style="margin-top: 2px">참여 중 {people.filter(p => p.active).length}명{count.size ? ` · ${[...count.entries()].map(([t, n]) => `${t} ${n}`).join(' · ')}` : ''}. 참여를 끄면 담당 고르기에서 빠지고 기록은 남습니다.</p></div>
      </div>
      <div class="card-body" style="padding-top: 4px">
        <datalist id="people-teams">{teams.map(t => <option value={t} />)}</datalist>
        <div class="table-wrap ref-wrap">
          <table class="grid edit ref people-table">
            <colgroup><col style="width: 150px" /><col style="width: 140px" /><col style="width: 230px" /><col /><col style="width: 64px" /><col style="width: 48px" /></colgroup>
            <thead><tr><th>이름</th><th>소속팀</th><th>이메일</th><th>특이사항</th><th class="c">참여</th><th aria-label="행 작업" /></tr></thead>
            <tbody>
              {people.length === 0 && <tr><td colSpan={6} class="muted small">아직 작업자가 없습니다. 아래에서 이름과 소속팀을 넣어 더합니다.</td></tr>}
              {people.map(p => (
                <tr class={`row${p.active ? '' : ' off'}`}>
                  <td><Field class="field ghost-field" value={p.name} label={`${p.name} 이름`} disabled={ro} onCommit={t => apply({ kind: 'personField', personId: p.personId, field: 'name', value: t })} /></td>
                  <td><Field class="field ghost-field" value={p.team ?? ''} label={`${p.name} 소속팀`} list="people-teams" placeholder="소속팀" disabled={ro} onCommit={t => apply({ kind: 'personField', personId: p.personId, field: 'team', value: t })} /></td>
                  <td><Field class="field ghost-field" value={p.email ?? ''} label={`${p.name} 이메일`} placeholder="name@company.com" disabled={ro} onCommit={t => apply({ kind: 'personField', personId: p.personId, field: 'email', value: t })} /></td>
                  <td><Field class="field ghost-field" value={p.note ?? ''} label={`${p.name} 특이사항`} placeholder="예: 12월 휴가 · 신규 입사 · 외주" disabled={ro} onCommit={t => apply({ kind: 'personField', personId: p.personId, field: 'note', value: t })} /></td>
                  <td class="c"><input type="checkbox" aria-label={`${p.name} 참여`} checked={p.active} disabled={ro} onChange={e => void apply({ kind: 'personField', personId: p.personId, field: 'active', value: (e.target as HTMLInputElement).checked ? '1' : '0' })} /></td>
                  <td class="n">{!ro && <button type="button" class="btn ghost icon-btn" aria-label={`${p.name} 지우기`} title="지우기(변경 이력에서 되돌릴 수 있습니다)" onClick={() => void apply({ kind: 'deletePerson', personId: p.personId })}><IconX /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!ro && (
          <div class="inline" style="margin-top: 10px">
            <input class="field" aria-label="새 작업자 이름" placeholder="이름" value={add.name} onInput={e => { const t = (e.target as HTMLInputElement).value; setAdd(a => ({ ...a, name: t })); }}
              onKeyDown={e => { if (e.key === 'Enter' && add.name.trim()) void create(); }} />
            <input class="field" aria-label="새 작업자 소속팀" placeholder="소속팀(예: 원화)" list="people-teams" value={add.team} onInput={e => { const t = (e.target as HTMLInputElement).value; setAdd(a => ({ ...a, team: t })); }} />
            <button type="button" class="btn sm" disabled={!add.name.trim()} onClick={() => void create()}><IconPlus />작업자 더하기</button>
            <span class="small faint">이메일 · 특이사항은 더한 뒤 표에서 입력합니다.</span>
          </div>
        )}
      </div>
    </section>
  );
}
