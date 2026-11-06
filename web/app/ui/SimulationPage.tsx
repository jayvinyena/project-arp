// 시뮬레이션: 시나리오 목록 · 나란히 비교 · 시나리오 고치기(동작) · 민감도·거꾸로 계산 · 원본에 반영
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { rpc } from '../lib/rpc.ts';
import type { ScenarioSummary, SimMeta, CompareView, ScenarioAction, ScenarioOp, Sensitivity } from '../../../core/scenarios.ts';
import type { MaxScaleResult, HeadcountResult } from '../../../core/launch.ts';
import type { PlanMode, UpdateStatus } from '../../../engine/types.ts';
import { fmtShortDate, fmtPct, fmtHeads, fmtDate, fmtDays } from '../lib/format.ts';
import { ModeSwitch } from './PlanPage.tsx';
import { MODE_LABEL } from './LaunchPage.tsx';
import { IconPlus, IconX, IconAlert, IconSpark, IconUsers } from './icons.tsx';

const TONE: Record<UpdateStatus, string> = { ON_TRACK: 'ok', TIGHT: 'warn', LATE: 'bad', UNFINISHED: 'bad', NO_RELEASE_DATE: '' };
const STATUS_TEXT: Record<UpdateStatus, string> = { ON_TRACK: '목표 안', TIGHT: '빠듯', LATE: '늦음', UNFINISHED: '못 끝냄', NO_RELEASE_DATE: '출시일 없음' };

type ActionKind = ScenarioAction['kind'];
const KINDS: { kind: ActionKind; label: string; hint: string }[] = [
  { kind: 'headcount', label: '인원', hint: '파트의 정규 인원을 기간 동안 더하거나 제외합니다' },
  { kind: 'outsource', label: '외주', hint: '파트에 달마다 외주 인·일을 추가합니다' },
  { kind: 'aiShare', label: 'AI 비율', hint: '파트 작업 중 AI 공수로 계산하는 몫을 변경합니다' },
  { kind: 'volumeScale', label: '물량', hint: '업데이트의 모든 물량을 같은 비율로 늘리거나 줄입니다' },
  { kind: 'updateDates', label: '날짜', hint: '업데이트의 시작 · 제작 완료 목표 · 출시일을 변경합니다' },
  { kind: 'priority', label: '우선순위', hint: '업데이트가 인력을 쓰는 순서를 변경합니다' },
  { kind: 'exclude', label: '빼기', hint: '업데이트를 계산에서 제외합니다' },
  { kind: 'addUpdate', label: '가상 업데이트', hint: '유형 템플릿 물량으로 아직 없는 업데이트를 넣어 시험합니다' },
  { kind: 'overlap', label: '겹침률', hint: '앞 공정이 끝나기 전에 다음 공정을 얼마나 일찍 시작할지 변경합니다' },
];

function Delta(props: { d: number | null }) {
  if (props.d == null || props.d === 0) return props.d === 0 ? <span class="delta zero">±0</span> : null;
  return <span class={`delta ${props.d < 0 ? 'good' : 'bad'}`}>{props.d > 0 ? `+${props.d}` : `−${-props.d}`}일</span>;
}

function Compare(props: { view: CompareView | null; selectedCount: number }) {
  const v = props.view;
  if (!v) return <section class="card"><div class="card-body muted">계산 중…</div></section>;
  return (
    <section class="card">
      <div class="card-head">
        <div><h2>나란히 비교 · {MODE_LABEL[v.planMode]}</h2>
          <p class="small muted" style="margin-top: 2px">완료 예정과 원본 대비 차이(영업일, − = 당겨짐). 위에서 체크한 시나리오 3개까지 함께 비교합니다.</p></div>
        <span class="small faint">계산 {fmtDays(v.ms)}ms</span>
      </div>
      <div class="card-body" style="padding-top: 8px">
        {v.columns.some(c => c.blocked) && (
          <div class="banner bad" style="margin-bottom: 12px"><IconAlert /><div>{v.columns.filter(c => c.blocked).map(c => <div><b>{c.name}</b>: 계산할 수 없습니다 — {c.errors.slice(0, 2).map(e => `${e.title}(${e.key})`).join(', ')}</div>)}</div></div>
        )}
        <div class="table-wrap">
          <table class="grid compare">
            <thead><tr><th>업데이트</th>{v.columns.map((c, i) => <th class={`n${i === 0 ? ' base-col' : ''}`}>{c.name}</th>)}</tr></thead>
            <tbody>
              {v.rows.map(r => (
                <tr class="row">
                  <td><b>{r.name}</b>{r.virtual && <span class="tag" style="margin-left: 6px">가상</span>}</td>
                  {r.cells.map((c, i) => (
                    <td class={`n${i === 0 ? ' base-col' : ''}`}>
                      {c.excluded ? <span class="faint">빠짐</span>
                        : c.status == null ? <span class="faint">—</span>
                          : (
                            <span class="cmp-cell">
                              <span class={`dot ${TONE[c.status]}`} title={STATUS_TEXT[c.status]} />
                              <span class="num">{c.completion ? fmtShortDate(c.completion) : '기간 밖'}</span>
                              {i > 0 && <Delta d={c.delta} />}
                            </span>
                          )}
                    </td>
                  ))}
                </tr>
              ))}
              <tr class="group"><td colSpan={v.columns.length + 1}>파트 부하율 (계획 기간 전체)</td></tr>
              {v.parts.map(p => (
                <tr class="row">
                  <td>{p.name}</td>
                  {p.loads.map((l, i) => {
                    const base = p.loads[0];
                    const diff = l != null && base != null ? l - base : null;
                    return (
                      <td class={`n num${i === 0 ? ' base-col' : ''}`}>
                        {l == null ? '—' : fmtPct(l)}
                        {i > 0 && diff != null && Math.abs(diff) >= 0.005 && <span class={`delta ${diff < 0 ? 'good' : 'bad'}`}>{diff > 0 ? '+' : '−'}{Math.abs(Math.round(diff * 100))}%p</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {props.selectedCount === 0 && <p class="small muted" style="margin-top: 10px">위에서 시나리오를 체크해 비교에 추가하십시오.</p>}
      </div>
    </section>
  );
}

function ActionForm(props: { meta: SimMeta; onAdd: (a: ScenarioAction) => Promise<boolean> }) {
  const { meta } = props;
  const [kind, setKind] = useState<ActionKind>('headcount');
  const live = meta.updates.filter(u => u.live);
  const first = meta.months[0] ?? '';
  const last = meta.months[meta.months.length - 1] ?? '';
  const [f, setF] = useState<Record<string, string>>({});
  const v = (k: string, d = '') => f[k] ?? d;
  const set = (k: string) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const part = v('part', meta.parts[0]?.partId ?? '');
  const upd = v('update', live[0]?.updateId ?? '');
  const u = meta.updates.find(x => x.updateId === upd);

  const build = (): ScenarioAction | null => {
    const n = (k: string, d = '') => Number(v(k, d));
    switch (kind) {
      case 'headcount': return { kind, partId: part, fromMonth: v('from', first), toMonth: v('to', last), delta: n('delta', '1') };
      case 'outsource': return { kind, partId: part, fromMonth: v('from', first), toMonth: v('to', last), days: n('days', '20') };
      case 'aiShare': return { kind, partId: part, share: n('share', '50') / 100 };
      case 'volumeScale': return { kind, updateId: upd, scale: n('scale', '80') / 100 };
      case 'updateDates': return { kind, updateId: upd, startDate: v('start', u?.startDate ?? '') || u?.startDate || null, freezeDate: v('freeze', u?.freezeDate ?? '') || null, releaseDate: v('release', u?.releaseDate ?? '') || null };
      case 'priority': return { kind, updateId: upd, priority: n('priority', '0') };
      case 'exclude': return { kind, updateId: upd };
      case 'addUpdate': return { kind, name: v('name', '가상 업데이트'), typeId: v('type', meta.types[0]?.typeId ?? ''), startDate: v('start', `${first}-01`), freezeDate: v('freeze', '') || null, releaseDate: v('release', '') || null };
      case 'overlap': {
        const pair = v('pair', '');
        const [from, to] = pair ? pair.split('>') : [undefined, undefined];
        return { kind, rate: n('rate', '30') / 100, fromPartId: from, toPartId: to };
      }
    }
  };

  const partSel = <select class="field" aria-label="파트" value={part} onChange={set('part')}>{meta.parts.map(p => <option value={p.partId}>{p.name}</option>)}</select>;
  const updSel = <select class="field" aria-label="업데이트" value={upd} onChange={set('update')}>{live.map(x => <option value={x.updateId}>{x.name}</option>)}</select>;
  const months = (
    <>
      <input class="field" type="month" aria-label="시작 달" value={v('from', first)} onInput={set('from')} />
      <span class="faint">~</span>
      <input class="field" type="month" aria-label="끝 달" value={v('to', last)} onInput={set('to')} />
    </>
  );
  const num = (k: string, d: string, label: string, unit: string) => (
    <><input class="field narrow n" inputMode="decimal" aria-label={label} value={v(k, d)} onInput={set(k)} /><span class="faint">{unit}</span></>
  );
  const date = (k: string, d: string, label: string) => <input class="field" type="date" aria-label={label} title={label} value={v(k, d)} onInput={set(k)} />;
  const hint = KINDS.find(k => k.kind === kind)?.hint ?? '';

  return (
    <div class="action-form">
      <div class="inline action-fields">
        <label class="kind-pick">
          <span class="small faint">바꿀 것</span>
          <select class="field" aria-label="바꿀 것" value={kind} onChange={e => { setKind((e.target as HTMLSelectElement).value as ActionKind); setF({}); }}>
            {KINDS.map(k => <option value={k.kind}>{k.label}</option>)}
          </select>
        </label>
        {kind === 'headcount' && <>{partSel}{months}{num('delta', '1', '더할 인원', '명 (빼려면 −)')}</>}
        {kind === 'outsource' && <>{partSel}{months}{num('days', '20', '더할 외주', '인·일/월')}</>}
        {kind === 'aiShare' && <>{partSel}{num('share', '50', 'AI 비율', '%')}{!meta.hasAI && <span class="small err-text">"AI 사용 시" 공수 프로필이 없습니다</span>}</>}
        {kind === 'volumeScale' && <>{updSel}{num('scale', '80', '물량 배율', `% (${MODE_LABEL.MIN}·${MODE_LABEL.TARGET}·${MODE_LABEL.STRETCH} 모두)`)}</>}
        {kind === 'updateDates' && <>{updSel}<span class="faint small">시작</span>{date('start', u?.startDate ?? '', '시작')}<span class="faint small">완료 목표</span>{date('freeze', u?.freezeDate ?? '', '제작 완료 목표')}<span class="faint small">출시</span>{date('release', u?.releaseDate ?? '', '출시')}</>}
        {kind === 'priority' && <>{updSel}{num('priority', '0', '우선순위', '(작을수록 먼저, 0 = 맨 앞)')}</>}
        {kind === 'exclude' && <>{updSel}<span class="small muted">이 업데이트를 계산에서 뺍니다</span></>}
        {kind === 'addUpdate' && <>
          <input class="field" aria-label="가상 업데이트 이름" value={v('name', '가상 업데이트')} onInput={set('name')} />
          <select class="field" aria-label="유형" value={v('type', meta.types[0]?.typeId ?? '')} onChange={set('type')}>{meta.types.map(t => <option value={t.typeId}>{t.name}</option>)}</select>
          <span class="faint small">시작</span>{date('start', `${first}-01`, '시작')}<span class="faint small">완료 목표</span>{date('freeze', '', '제작 완료 목표')}<span class="faint small">출시</span>{date('release', '', '출시')}
        </>}
        {kind === 'overlap' && <>
          <select class="field" aria-label="파트 쌍" value={v('pair', '')} onChange={set('pair')}>
            <option value="">모든 파트 쌍</option>
            {meta.parts.slice(0, -1).map((p, i) => <option value={`${p.partId}>${meta.parts[i + 1].partId}`}>{p.name} → {meta.parts[i + 1].name}</option>)}
          </select>
          {num('rate', '30', '겹침률', '% (앞 공정 진행 중 시작)')}
        </>}
        <button type="button" class="btn primary" onClick={async () => { const a = build(); if (a && await props.onAdd(a)) setF({}); }}><IconPlus />더하기</button>
      </div>
      <p class="small faint">{hint}</p>
    </div>
  );
}

function Analysis(props: { meta: SimMeta; scenario: ScenarioSummary | null; planMode: PlanMode; version: number }) {
  const live = props.meta.updates.filter(u => u.live);
  const [upd, setUpd] = useState(live[0]?.updateId ?? '');
  const [sens, setSens] = useState<(Sensitivity & { ms: number }) | null>(null);
  const [scale, setScale] = useState<MaxScaleResult | null>(null);
  const [heads, setHeads] = useState<HeadcountResult | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const sid = props.scenario?.scenarioId ?? null;
  useEffect(() => {
    setScale(null); setHeads(null); setError('');
    if (!upd) return;
    void rpc.sensitivity(sid, upd, props.planMode).then(setSens).catch(e => { setSens(null); setError((e as Error).message); });
  }, [sid, upd, props.planMode, props.version]);
  const names = Object.fromEntries(props.meta.parts.map(p => [p.partId, p.name]));
  const maxGain = Math.max(1, ...(sens?.parts ?? []).map(p => -(p.deltaWorkdays ?? 0)));
  const run = async (what: 'scale' | 'heads') => {
    setBusy(what); setError('');
    try {
      if (what === 'scale') setScale(await rpc.maxScaleOf(sid, upd, props.planMode));
      else setHeads(await rpc.headcountOf(sid, upd, props.planMode));
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  return (
    <section class="card">
      <div class="card-head">
        <div><h2>분석 · {props.scenario ? props.scenario.name : '원본'}</h2><p class="small muted" style="margin-top: 2px">업데이트 하나를 골라 인원 효과와 거꾸로 계산을 확인합니다.</p></div>
        <select class="field" aria-label="분석할 업데이트" value={upd} onChange={e => setUpd((e.target as HTMLSelectElement).value)}>{live.map(u => <option value={u.updateId}>{u.name}</option>)}</select>
      </div>
      <div class="card-body">
        {error && <div class="banner bad"><IconAlert /><div>{error}</div></div>}
        {sens && (
          <div class="sens">
            <div class="small muted" style="margin-bottom: 8px">
              파트마다 <b>{sens.months ? `${sens.months.from} ~ ${sens.months.to}` : '—'}</b> 동안 1명 더하면 · 지금 완료 예정 {sens.baseCompletion ? fmtDate(sens.baseCompletion) : '기간 밖'}
            </div>
            {sens.parts.map(p => {
              const gain = -(p.deltaWorkdays ?? 0);
              return (
                <div class="sens-row">
                  <span class="pp-name">{p.name}</span>
                  <span class="bar"><span class={`fill${gain > 0 ? '' : ' other'}`} style={{ width: `${Math.max(0, gain) / maxGain * 100}%` }} /></span>
                  <span class="num small">{p.deltaWorkdays == null ? (p.completion ? '—' : '여전히 기간 밖') : p.deltaWorkdays === 0 ? '변화 없음' : `${-p.deltaWorkdays}영업일 당겨짐`}</span>
                </div>
              );
            })}
          </div>
        )}
        <div class="grid-2" style="margin-top: 16px">
          <div class="answer">
            <div class="ask-q"><span class="q">제작 완료 목표까지 물량은 최대?</span><button class="btn sm" disabled={!!busy} onClick={() => void run('scale')}><IconSpark />{busy === 'scale' ? '계산 중…' : '계산'}</button></div>
            {scale && (scale.scale == null ? <span class="small">물량을 줄여도 맞추기 어렵습니다</span>
              : <span><b class="big">{fmtPct(scale.scale)}</b> <span class="small muted">{scale.currentOk ? '까지 늘릴 수 있습니다' : '로 줄이면 맞습니다'}</span></span>)}
          </div>
          <div class="answer">
            <div class="ask-q"><span class="q">이 물량을 지키려면 몇 명 더?</span><button class="btn sm" disabled={!!busy} onClick={() => void run('heads')}><IconUsers />{busy === 'heads' ? '계산 중…' : '계산'}</button></div>
            {heads && (heads.currentOk ? <span class="small">지금 인원으로 충분합니다</span>
              : !heads.feasible ? <span class="small">인원만으로는 어렵습니다</span>
                : <div class="chips">{heads.additions.map(a => <span class="pill accent plain">{names[a.partId] ?? a.partId} +{fmtHeads(a.heads)}</span>)}</div>)}
          </div>
        </div>
      </div>
    </section>
  );
}

export function SimulationPage(props: {
  version: number; planMode: PlanMode; setPlanMode: (m: PlanMode) => void; readOnly: boolean;
  onScenario: (op: ScenarioOp) => Promise<{ ok: boolean; createdId?: string }>;
  onApplyScenario: (scenarioId: string, force: boolean) => Promise<boolean>;
  /** 다른 화면에서 만든 시나리오: 고르고 원본과 비교 */
  focus?: string | null;
}) {
  const [data, setData] = useState<{ scenarios: ScenarioSummary[]; meta: SimMeta } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<CompareView | null>(null);
  const [newName, setNewName] = useState('');
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void rpc.scenarios().then(d => {
      setData(d);
      const ids = new Set(d.scenarios.map(s => s.scenarioId));
      if (props.focus && ids.has(props.focus)) {
        setPicked([props.focus]);
        setSelected(props.focus);
        return;
      }
      setPicked(p => {
        const kept = p.filter(id => ids.has(id));
        return kept.length || p.length ? kept : d.scenarios.filter(s => !s.appliedAt).slice(0, 2).map(s => s.scenarioId);
      });
      setSelected(s => (s && ids.has(s) ? s : d.scenarios.find(x => !x.appliedAt)?.scenarioId ?? null));
    });
  }, [props.version, props.focus]);
  useEffect(() => { if (data) void rpc.compare(picked, props.planMode).then(setCompare); }, [data, picked.join(','), props.planMode]);
  useEffect(() => { setConfirmApply(false); setConfirmDelete(false); }, [selected]);

  if (!data) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  const cur = data.scenarios.find(s => s.scenarioId === selected) ?? null;
  const toggle = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : p.length >= 3 ? [...p.slice(1), id] : [...p, id]));

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <PageEyebrow page="simulation" />
          <h1>무엇을 바꾸면 어떻게 될까</h1>
          <p class="muted" style="margin-top: 6px">시나리오는 원본을 변경하지 않습니다. 마음에 드는 시나리오만 원본에 반영합니다.</p>
        </div>
        <ModeSwitch value={props.planMode} onChange={props.setPlanMode} />
      </header>
      <section class="card scenario-bar">
        <div class="scenario-bar-head">
          <h2>시나리오</h2>
          <span class="small faint">체크 = 비교에 넣기({picked.length}/3) · 이름을 누르면 아래에서 수정합니다</span>
        </div>
        <div class="scenario-list">
          {data.scenarios.length === 0 && <p class="small muted">아직 없습니다. 오른쪽에서 이름을 입력하고 만드십시오.</p>}
          {data.scenarios.map(s => (
            <div class={`scenario-item${selected === s.scenarioId ? ' active' : ''}${picked.includes(s.scenarioId) ? ' picked' : ''}`}>
              <input type="checkbox" aria-label={`${s.name} 비교에 넣기`} checked={picked.includes(s.scenarioId)} onChange={() => toggle(s.scenarioId)} />
              <button type="button" class="scenario-name" onClick={() => setSelected(s.scenarioId)}>
                <span>{s.name}</span>
                <span class="small faint">변경 {s.actions.length}개{s.appliedAt ? ' · 반영됨' : s.stale ? ' · 원본 바뀜' : ''}</span>
              </button>
            </div>
          ))}
          {!props.readOnly && (
            <div class="scenario-new">
              <input class="field" placeholder="새 시나리오 이름" aria-label="새 시나리오 이름" value={newName} onInput={e => setNewName((e.target as HTMLInputElement).value)}
                onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget.nextElementSibling as HTMLButtonElement | null)?.click(); }} />
              <button type="button" class="btn sm" disabled={!newName.trim()} onClick={async () => {
                const r = await props.onScenario({ kind: 'create', name: newName });
                if (r.ok && r.createdId) { setNewName(''); setSelected(r.createdId); setPicked(p => (p.length >= 3 ? [...p.slice(1), r.createdId!] : [...p, r.createdId!])); }
              }}><IconPlus />만들기</button>
            </div>
          )}
        </div>
      </section>
        <div class="stack">
          <Compare view={compare} selectedCount={picked.length} />
          {cur && (
            <section class="card">
              <div class="card-head">
                <input class="title-input" aria-label="시나리오 이름" value={cur.name} disabled={props.readOnly || !!cur.appliedAt}
                  onChange={e => void props.onScenario({ kind: 'rename', scenarioId: cur.scenarioId, name: (e.target as HTMLInputElement).value })} />
                {cur.appliedAt && <span class="pill ok">원본에 반영됨 · {fmtDate(cur.appliedAt.slice(0, 10))}</span>}
                {!cur.appliedAt && cur.stale && <span class="pill warn">만든 뒤 원본이 바뀜</span>}
              </div>
              <div class="card-body">
                <div class="action-list chips-list">
                  {cur.actions.length === 0 && <p class="small muted">아래에서 바꿀 것을 추가하십시오. 더할 때마다 비교가 다시 계산됩니다.</p>}
                  {cur.actions.map(a => (
                    <div class="action-item">
                      <span>{a.label}</span>
                      {!props.readOnly && !cur.appliedAt && <button type="button" class="btn ghost icon-btn" aria-label={`${a.label} 빼기`} onClick={() => void props.onScenario({ kind: 'removeAction', scenarioId: cur.scenarioId, groupNo: a.groupNo })}><IconX /></button>}
                    </div>
                  ))}
                </div>
                {!props.readOnly && !cur.appliedAt && <ActionForm meta={data.meta} onAdd={async a => (await props.onScenario({ kind: 'addAction', scenarioId: cur.scenarioId, action: a })).ok} />}
                {!props.readOnly && (
                  <div class="danger-zone">
                    <button type="button" class="btn sm ghost" onClick={async () => { const r = await props.onScenario({ kind: 'create', name: `${cur.name} 복제`, copyFrom: cur.scenarioId }); if (r.createdId) setSelected(r.createdId); }}>복제</button>
                    {confirmDelete
                      ? <><span class="small">"{cur.name}"을 삭제하시겠습니까?</span><button type="button" class="btn sm danger" onClick={() => void props.onScenario({ kind: 'delete', scenarioId: cur.scenarioId })}>지우기</button><button type="button" class="btn sm ghost" onClick={() => setConfirmDelete(false)}>그만두기</button></>
                      : <button type="button" class="btn sm ghost" onClick={() => setConfirmDelete(true)}>지우기</button>}
                    <span style="flex: 1" />
                    {!cur.appliedAt && cur.actions.length > 0 && (confirmApply
                      ? <><span class="small">{cur.stale ? '원본이 바뀐 뒤입니다. 그래도 ' : ''}원본에 반영하시겠습니까? 변경 이력에 남습니다.</span>
                        <button type="button" class="btn sm primary" onClick={async () => { if (await props.onApplyScenario(cur.scenarioId, cur.stale)) setConfirmApply(false); }}>{cur.stale ? '그래도 반영' : '반영'}</button>
                        <button type="button" class="btn sm ghost" onClick={() => setConfirmApply(false)}>그만두기</button></>
                      : <button type="button" class="btn sm" onClick={() => setConfirmApply(true)}>원본에 반영</button>)}
                  </div>
                )}
              </div>
            </section>
          )}
          <Analysis meta={data.meta} scenario={cur && !cur.appliedAt ? cur : null} planMode={props.planMode} version={props.version} />
        </div>
    </div>
  );
}
