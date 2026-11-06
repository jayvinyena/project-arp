// 시뮬레이션: ① 시나리오 고르기 · ② 바꿀 것(넣은 변경 · 결과 미리보기 · 변경 추가 · 복제·지우기·원본에 반영) · ③ 결과 비교 · ④ 업데이트 자세히 보기
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { rpc } from '../lib/rpc.ts';
import type { ScenarioSummary, SimMeta, CompareView, ScenarioAction, ScenarioOp, Sensitivity } from '../../../core/scenarios.ts';
import type { MaxScaleResult, HeadcountResult } from '../../../core/launch.ts';
import type { PlanMode, UpdateStatus } from '../../../engine/types.ts';
import { fmtShortDate, fmtPct, fmtHeads, fmtDate, fmtDays } from '../lib/format.ts';
import { ModeSwitch } from './PlanPage.tsx';
import { MODE_LABEL } from './LaunchPage.tsx';
import { IconPlus, IconX, IconAlert, IconSpark, IconUsers, IconPencil } from './icons.tsx';

const TONE: Record<UpdateStatus, string> = { ON_TRACK: 'ok', TIGHT: 'warn', LATE: 'bad', UNFINISHED: 'bad', NO_RELEASE_DATE: '' };
const STATUS_TEXT: Record<UpdateStatus, string> = { ON_TRACK: '목표 안', TIGHT: '빠듯', LATE: '늦음', UNFINISHED: '못 끝냄', NO_RELEASE_DATE: '출시일 없음' };

type ActionKind = ScenarioAction['kind'];
/** 바꿀 수 있는 것 전부. 무리마다 묶어 한눈에 보이게(목록 상자에 숨기지 않는다) */
const KINDS: Record<ActionKind, { label: string; hint: string }> = {
  headcount: { label: '인원', hint: '파트의 정규 인원을 기간 동안 더하거나 뺍니다.' },
  utilization: { label: '가동률', hint: '기간 동안 파트 인원이 실제 작업에 쓰는 시간 비율을 변경합니다(회의 · 휴가 등을 뺀 몫).' },
  productivity: { label: '생산성', hint: '기간 동안 파트의 작업 속도 배율을 변경합니다(1 = 기준, 1.2 = 20% 빠름).' },
  outsource: { label: '외주', hint: '파트에 달마다 외주 인·일을 추가합니다.' },
  support: { label: '임시 지원', hint: '다른 팀에서 지원받는 인·일을 달마다 추가합니다.' },
  aiShare: { label: 'AI 비율', hint: '파트 작업 중 AI를 사용해 진행하는 몫을 변경합니다. 그 몫은 "AI 사용 시" 공수로 계산합니다.' },
  aiEffort: { label: 'AI 공수 절감', hint: 'AI를 사용할 때 공수가 기본보다 얼마나 줄어드는지 변경합니다. AI 비율이 0%이면 효과가 없습니다.' },
  rework: { label: '재작업률', hint: '파트에서 다시 작업하는 비율을 변경합니다. 공수에 그만큼 더해집니다.' },
  overlap: { label: '겹침률', hint: '앞 공정이 끝나기 전에 다음 공정을 얼마나 일찍 시작할지 변경합니다.' },
  buffer: { label: '여유율', hint: '예상하지 못한 일에 대비해 모든 공수에 더해 두는 몫을 변경합니다(전체 공통).' },
  volumeScale: { label: '물량 배율', hint: '업데이트의 모든 물량을 같은 비율로 늘리거나 줄입니다.' },
  volumeQty: { label: '리소스 수량', hint: '업데이트의 리소스 하나의 수량을 변경합니다.' },
  volumeToMin: { label: '최소 물량으로', hint: '업데이트의 수량을 최소 물량 템플릿 값으로 낮춥니다.' },
  updateDates: { label: '날짜', hint: '업데이트의 시작 · 제작 완료 목표 · 출시일을 변경합니다.' },
  priority: { label: '우선순위', hint: '업데이트가 인력을 쓰는 순서를 변경합니다.' },
  exclude: { label: '빼기', hint: '업데이트를 계산에서 제외합니다.' },
  addUpdate: { label: '가상 업데이트', hint: '유형 템플릿 물량으로 아직 없는 업데이트를 넣어 시험합니다.' },
};
const GROUPS: { name: string; kinds: ActionKind[] }[] = [
  { name: '인력', kinds: ['headcount', 'utilization', 'productivity', 'outsource', 'support'] },
  { name: '효율', kinds: ['aiShare', 'aiEffort', 'rework', 'overlap', 'buffer'] },
  { name: '물량', kinds: ['volumeScale', 'volumeQty', 'volumeToMin'] },
  { name: '일정', kinds: ['updateDates', 'priority', 'exclude', 'addUpdate'] },
];
const pct = (x: number | null | undefined) => (x == null ? '' : String(Math.round(x * 1000) / 10));

function Delta(props: { d: number | null }) {
  if (props.d == null || props.d === 0) return props.d === 0 ? <span class="delta zero">±0</span> : null;
  return <span class={`delta ${props.d < 0 ? 'good' : 'bad'}`}>{props.d > 0 ? `+${props.d}` : `−${-props.d}`}일</span>;
}

function StepTitle(props: { n: number; title: string; sub?: string }) {
  return (
    <div class="step-title">
      <span class="step-badge">{props.n}</span>
      <div><h2>{props.title}</h2>{props.sub && <p class="small muted" style="margin-top: 2px">{props.sub}</p>}</div>
    </div>
  );
}

function Compare(props: { view: CompareView | null; scenarios: ScenarioSummary[]; picked: string[]; onToggle: (id: string) => void }) {
  const v = props.view;
  return (
    <section class="card">
      <div class="card-head">
        <StepTitle n={3} title={`결과 비교 · ${MODE_LABEL[v?.planMode ?? 'TARGET']}`} sub="원본과 시나리오의 완료 예정 · 파트 부하율을 나란히 봅니다. 차이는 원본 대비 영업일(− = 당겨짐)입니다." />
        {v && <span class="small faint">계산 {fmtDays(v.ms)}ms</span>}
      </div>
      <div class="card-body" style="padding-top: 4px">
        <div class="compare-pick" role="group" aria-label="비교할 시나리오">
          <span class="small faint">비교할 시나리오(최대 3개)</span>
          {props.scenarios.length === 0 && <span class="small muted">시나리오를 만들면 여기서 고릅니다.</span>}
          {props.scenarios.map(s => (
            <label class={`pick-chip${props.picked.includes(s.scenarioId) ? ' on' : ''}`}>
              <input type="checkbox" aria-label={`${s.name} 비교에 넣기`} checked={props.picked.includes(s.scenarioId)} onChange={() => props.onToggle(s.scenarioId)} />
              {s.name}
            </label>
          ))}
        </div>
        {!v ? <p class="muted small" style="padding: 12px 0">계산 중…</p> : (
          <>
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
          </>
        )}
      </div>
    </section>
  );
}

/** 편집 중인 시나리오의 효과를 바꿀 것 바로 아래에서(비교 표까지 내려가지 않아도) */
function Preview(props: { view: CompareView | null; scenarioId: string }) {
  const v = props.view;
  const i = v ? v.columns.findIndex(c => c.id === props.scenarioId) : -1;
  return (
    <div class="sim-preview" aria-live="polite">
      <span class="small faint">결과 미리보기 · 원본 대비</span>
      {!v || i < 0 ? <span class="small faint">계산 중…</span>
        : v.columns[i].blocked ? <span class="small err-text">계산할 수 없습니다 — 아래 결과 비교에서 이유를 확인하십시오</span>
          : (
            <div class="preview-chips">
              {v.rows.map(r => {
                const c = r.cells[i];
                return (
                  <span class="preview-chip">
                    <b>{r.name}</b>
                    {c.excluded ? <span class="faint">빠짐</span> : <><span class="num">{c.completion ? fmtShortDate(c.completion) : c.status ? '기간 밖' : '—'}</span><Delta d={c.delta} /></>}
                  </span>
                );
              })}
            </div>
          )}
    </div>
  );
}

function ActionForm(props: { meta: SimMeta; planMode: PlanMode; onAdd: (a: ScenarioAction) => Promise<boolean> }) {
  const { meta } = props;
  const [kind, setKind] = useState<ActionKind>('headcount');
  const live = meta.updates.filter(u => u.live);
  const first = meta.months[0] ?? '';
  const last = meta.months[meta.months.length - 1] ?? '';
  const [f, setF] = useState<Record<string, string>>({});
  const v = (k: string, d = '') => f[k] ?? d;
  const set = (k: string) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  // 파트·업데이트를 바꾸면 그 대상의 지금 값으로 칸을 다시 채운다
  const setKey = (k: 'part' | 'update' | 'res') => (e: Event) => {
    const val = (e.target as HTMLSelectElement).value;
    // 기간·템플릿 선택은 남기고 숫자 칸만 비운다(새 대상의 지금 값이 처음 값이 된다)
    const keep = { part: f.part, update: f.update, from: f.from, to: f.to, qmode: f.qmode, res: k === 'update' ? undefined : f.res };
    setF(Object.fromEntries(Object.entries({ ...keep, [k]: val }).filter(([, x]) => x !== undefined)) as Record<string, string>);
  };
  const part = v('part', meta.parts[0]?.partId ?? '');
  const p = meta.parts.find(x => x.partId === part);
  const upd = v('update', live[0]?.updateId ?? '');
  const u = meta.updates.find(x => x.updateId === upd);
  const vols = meta.volumes.filter(x => x.updateId === upd);
  const res = v('res', vols[0]?.resourceTypeId ?? '');
  const vol = vols.find(x => x.resourceTypeId === res);
  const qMode = v('qmode', props.planMode) as PlanMode;
  const curQty = vol ? (qMode === 'MIN' ? vol.min : qMode === 'STRETCH' ? vol.stretch : vol.target) : null;

  const build = (): ScenarioAction | null => {
    const n = (k: string, d = '') => Number(v(k, d));
    const range = { fromMonth: v('from', first), toMonth: v('to', last) };
    switch (kind) {
      case 'headcount': return { kind, partId: part, ...range, delta: n('delta', '1') };
      case 'utilization': return { kind, partId: part, ...range, rate: n('rate', pct(p?.utilization ?? 0.8)) / 100 };
      case 'productivity': return { kind, partId: part, ...range, factor: n('factor', String(p?.productivity ?? 1)) };
      case 'outsource': return { kind, partId: part, ...range, days: n('days', '20') };
      case 'support': return { kind, partId: part, ...range, days: n('days', '10') };
      case 'aiShare': return { kind, partId: part, share: n('share', pct(p?.aiShare || 0.5)) / 100 };
      case 'aiEffort': return { kind, partId: part, saving: n('saving', pct(p?.aiSaving ?? 0.3)) / 100 };
      case 'rework': return { kind, partId: part, rate: n('rate', pct(p?.rework ?? 0)) / 100 };
      case 'buffer': return { kind, rate: n('rate', pct(meta.buffer)) / 100 };
      case 'volumeScale': return { kind, updateId: upd, scale: n('scale', '80') / 100 };
      case 'volumeQty': return { kind, updateId: upd, resourceTypeId: res, mode: qMode, qty: n('qty', String(curQty ?? 0)) };
      case 'volumeToMin': return { kind, updateId: upd, onlyOptional: v('optional', '') === '1' };
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

  const partSel = <select class="field" aria-label="파트" value={part} onChange={setKey('part')}>{meta.parts.map(x => <option value={x.partId}>{x.name}</option>)}</select>;
  const updSel = <select class="field" aria-label="업데이트" value={upd} onChange={setKey('update')}>{live.map(x => <option value={x.updateId}>{x.name}</option>)}</select>;
  const months = (
    <>
      <input class="field" type="month" aria-label="시작 달" value={v('from', first)} onInput={set('from')} />
      <span class="faint">~</span>
      <input class="field" type="month" aria-label="끝 달" value={v('to', last)} onInput={set('to')} />
    </>
  );
  const num = (k: string, d: string, label: string, unit: string) => (
    <><input class="field narrow n" inputMode="decimal" aria-label={label} value={v(k, d)} onInput={set(k)} /><span class="faint small">{unit}</span></>
  );
  const now = (text: string) => <span class="now-val">지금 {text}</span>;
  const date = (k: string, d: string, label: string) => <input class="field" type="date" aria-label={label} title={label} value={v(k, d)} onInput={set(k)} />;

  return (
    <div class="action-form">
      <div class="action-form-head"><b>변경 추가</b><span class="small faint">바꿀 것을 고르고 값을 입력한 뒤 더합니다</span></div>
      <div class="kind-groups" role="radiogroup" aria-label="바꿀 것">
        {GROUPS.map(g => (
          <div class="kind-group">
            <span class="kind-group-name">{g.name}</span>
            <div class="kind-chips">
              {g.kinds.map(k => (
                <button type="button" role="radio" aria-checked={kind === k} data-kind={k} class={`kind-chip${kind === k ? ' on' : ''}`}
                  onClick={() => { setKind(k); setF(x => ({ part: x.part, update: x.update } as Record<string, string>)); }}>{KINDS[k].label}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p class="kind-hint small"><b>{KINDS[kind].label}</b> · {KINDS[kind].hint}</p>
      <div class="inline action-fields">
        {kind === 'headcount' && <>{partSel}{months}{num('delta', '1', '더할 인원', '명 (빼려면 −)')}</>}
        {kind === 'utilization' && <>{partSel}{months}{num('rate', pct(p?.utilization ?? 0.8), '가동률', '%')}{now(p?.utilization == null ? '—' : `평균 ${pct(p.utilization)}%`)}</>}
        {kind === 'productivity' && <>{partSel}{months}{num('factor', String(p?.productivity ?? 1), '생산성', '배')}{now(p?.productivity == null ? '—' : `평균 ${Math.round(p.productivity * 100) / 100}배`)}</>}
        {kind === 'outsource' && <>{partSel}{months}{num('days', '20', '더할 외주', '인·일/월')}</>}
        {kind === 'support' && <>{partSel}{months}{num('days', '10', '더할 임시 지원', '인·일/월')}</>}
        {kind === 'aiShare' && <>{partSel}{num('share', pct(p?.aiShare || 0.5), 'AI 비율', '%')}{now(`${pct(p?.aiShare ?? 0)}%`)}{!meta.hasAI && <span class="small err-text">"AI 사용 시" 공수 프로필이 없습니다</span>}</>}
        {kind === 'aiEffort' && <>{partSel}{num('saving', pct(p?.aiSaving ?? 0.3), 'AI 공수 절감', '% 줄어듦')}{now(p?.aiSaving == null ? 'AI 공수 없음' : `${pct(p.aiSaving)}% 절감`)}{p && p.aiShare === 0 && <span class="small warn-text">이 파트 AI 비율이 0%라 효과가 없습니다. AI 비율도 함께 더하십시오</span>}</>}
        {kind === 'rework' && <>{partSel}{num('rate', pct(p?.rework ?? 0), '재작업률', '%')}{now(`평균 ${pct(p?.rework ?? 0)}%`)}</>}
        {kind === 'buffer' && <>{num('rate', pct(meta.buffer), '여유율', '%')}{now(`${pct(meta.buffer)}%`)}</>}
        {kind === 'volumeScale' && <>{updSel}{num('scale', '80', '물량 배율', `% (${MODE_LABEL.MIN}·${MODE_LABEL.TARGET}·${MODE_LABEL.STRETCH} 모두)`)}</>}
        {kind === 'volumeQty' && <>
          {updSel}
          <select class="field" aria-label="리소스" value={res} onChange={setKey('res')}>{vols.map(x => <option value={x.resourceTypeId}>{x.name}</option>)}</select>
          <select class="field" aria-label="템플릿" value={qMode} onChange={set('qmode')}>{(['MIN', 'TARGET', 'STRETCH'] as PlanMode[]).map(m => <option value={m}>{MODE_LABEL[m]}</option>)}</select>
          {num('qty', String(curQty ?? 0), '수량', '개')}{now(curQty == null ? '빈칸' : `${curQty}개`)}
        </>}
        {kind === 'volumeToMin' && <>{updSel}
          <label class="inline small" style="gap: 6px"><input type="checkbox" checked={v('optional', '') === '1'} onChange={e => setF({ ...f, optional: (e.target as HTMLInputElement).checked ? '1' : '' })} />선택 리소스만</label>
          <span class="small muted">{MODE_LABEL.TARGET} · {MODE_LABEL.STRETCH} 수량을 {MODE_LABEL.MIN} 수량으로 맞춥니다</span>
        </>}
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
            {meta.parts.slice(0, -1).map((x, i) => <option value={`${x.partId}>${meta.parts[i + 1].partId}`}>{x.name} → {meta.parts[i + 1].name}</option>)}
          </select>
          {num('rate', '30', '겹침률', '% (앞 공정 진행 중 시작)')}
        </>}
        <button type="button" class="btn primary" onClick={async () => { const a = build(); if (a && await props.onAdd(a)) setF(x => ({ part: x.part, update: x.update } as Record<string, string>)); }}><IconPlus />더하기</button>
      </div>
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
  const basis = props.scenario ? `"${props.scenario.name}" 기준` : '원본 기준';
  const status = (which: string) => <span class={`ask-status${busy === which ? ' working' : ''}`} aria-live="polite">{busy === which ? '계산 중…' : ''}</span>;
  return (
    <section class="card">
      <div class="card-head">
        <StepTitle n={4} title="업데이트 자세히 보기" sub={`업데이트 하나를 골라, 파트마다 1명을 더하면 며칠 당겨지는지와 물량 · 인원을 얼마나 바꿔야 하는지 계산합니다(${basis}).`} />
        <select class="field" aria-label="분석할 업데이트" value={upd} onChange={e => setUpd((e.target as HTMLSelectElement).value)}>{live.map(u => <option value={u.updateId}>{u.name}</option>)}</select>
      </div>
      <div class="card-body">
        {error && <div class="banner bad"><IconAlert /><div>{error}</div></div>}
        <h3 class="sub-h">파트별 +1명 효과</h3>
        <div class="sens">
          <div class="small muted" style="margin-bottom: 8px">
            파트마다 <b>{sens?.months ? `${sens.months.from} ~ ${sens.months.to}` : '—'}</b> 동안 1명 더하면 · 지금 완료 예정 {sens?.baseCompletion ? fmtDate(sens.baseCompletion) : '—'}
          </div>
          {(sens?.parts ?? props.meta.parts.map(p => ({ partId: p.partId, name: p.name, deltaWorkdays: null, completion: null }))).map(p => {
            const gain = -(p.deltaWorkdays ?? 0);
            return (
              <div class="sens-row">
                <span class="pp-name">{p.name}</span>
                <span class="bar"><span class={`fill${gain > 0 ? '' : ' other'}`} style={{ width: `${Math.max(0, gain) / maxGain * 100}%` }} /></span>
                <span class="num small">{!sens ? '…' : p.deltaWorkdays == null ? (p.completion ? '—' : '여전히 기간 밖') : p.deltaWorkdays === 0 ? '변화 없음' : `${-p.deltaWorkdays}영업일 당겨짐`}</span>
              </div>
            );
          })}
        </div>
        <h3 class="sub-h" style="margin-top: 18px">거꾸로 계산</h3>
        <div class="grid-2">
          <div class="answer reserve-mini">
            {status('scale')}
            <div class="ask-q"><span class="q">제작 완료 목표까지 물량은 최대?</span><button class="btn sm" disabled={!!busy} onClick={() => void run('scale')}><IconSpark />계산</button></div>
            {scale ? (scale.scale == null ? <span class="small">물량을 줄여도 맞추기 어렵습니다</span>
              : <span><b class="big">{fmtPct(scale.scale)}</b> <span class="small muted">{scale.currentOk ? '까지 늘릴 수 있습니다' : '로 줄이면 맞습니다'}</span></span>)
              : <span class="small faint">계산을 누르면 결과가 여기에 표시됩니다</span>}
          </div>
          <div class="answer reserve-mini">
            {status('heads')}
            <div class="ask-q"><span class="q">이 물량을 지키려면 몇 명 더?</span><button class="btn sm" disabled={!!busy} onClick={() => void run('heads')}><IconUsers />계산</button></div>
            {heads ? (heads.currentOk ? <span class="small">지금 인원으로 충분합니다</span>
              : !heads.feasible ? <span class="small">인원만으로는 어렵습니다</span>
                : <div class="chips">{heads.additions.map(a => <span class="pill accent plain">{names[a.partId] ?? a.partId} +{fmtHeads(a.heads)}</span>)}</div>)
              : <span class="small faint">계산을 누르면 결과가 여기에 표시됩니다</span>}
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
  const addPick = (id: string) => setPicked(p => (p.includes(id) ? p : p.length >= 3 ? [...p.slice(1), id] : [...p, id]));

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
  // 편집 중인 시나리오는 늘 비교에 들어간다(미리보기 · 비교 표가 바로 보이게)
  useEffect(() => { if (selected) addPick(selected); }, [selected]);
  useEffect(() => { if (data) void rpc.compare(picked, props.planMode).then(setCompare); }, [data, picked.join(','), props.planMode]);
  useEffect(() => { setConfirmApply(false); setConfirmDelete(false); }, [selected]);

  if (!data) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  const cur = data.scenarios.find(s => s.scenarioId === selected) ?? null;
  const toggle = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : p.length >= 3 ? [...p.slice(1), id] : [...p, id]));
  const editable = !props.readOnly && !!cur && !cur.appliedAt;

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <PageEyebrow page="simulation" />
          <h1>무엇을 바꾸면 어떻게 될까</h1>
          <p class="muted" style="margin-top: 6px">시나리오는 원본을 변경하지 않습니다. ① 시나리오를 고르고 ② 바꿀 것을 더한 뒤 ③ 결과를 비교하고, 마음에 드는 시나리오만 원본에 반영합니다.</p>
        </div>
        <ModeSwitch value={props.planMode} onChange={props.setPlanMode} />
      </header>
      <section class="card scenario-bar">
        <StepTitle n={1} title="시나리오" sub="원본 위에 바꿀 것을 묶어 둔 안입니다. 하나를 눌러 편집합니다." />
        <div class="scenario-list" role="radiogroup" aria-label="편집할 시나리오">
          {data.scenarios.length === 0 && <p class="small muted">아직 없습니다. 오른쪽에서 이름을 입력하고 만드십시오.</p>}
          {data.scenarios.map(s => (
            <button type="button" role="radio" aria-checked={selected === s.scenarioId} class={`scenario-item scenario-name${selected === s.scenarioId ? ' active' : ''}`} onClick={() => setSelected(s.scenarioId)}>
              <span>{s.name}</span>
              <span class="small faint">변경 {s.actions.length}개{s.appliedAt ? ' · 반영됨' : s.stale ? ' · 원본 바뀜' : ''}</span>
            </button>
          ))}
          {!props.readOnly && (
            <div class="scenario-new">
              <input class="field" placeholder="새 시나리오 이름" aria-label="새 시나리오 이름" value={newName} onInput={e => setNewName((e.target as HTMLInputElement).value)}
                onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget.nextElementSibling as HTMLButtonElement | null)?.click(); }} />
              <button type="button" class="btn sm" disabled={!newName.trim()} onClick={async () => {
                const r = await props.onScenario({ kind: 'create', name: newName });
                if (r.ok && r.createdId) { setNewName(''); setSelected(r.createdId); addPick(r.createdId); }
              }}><IconPlus />만들기</button>
            </div>
          )}
        </div>
      </section>
      <div class="stack">
        {cur && (
          <section class="card">
            <div class="card-head">
              <div class="step-title">
                <span class="step-badge">2</span>
                <div>
                  <h2 class="vol-title">바꿀 것 ·
                    <label class="title-edit" title="눌러서 시나리오 이름을 변경합니다">
                      <input class="field inline-title" aria-label="시나리오 이름" value={cur.name} disabled={props.readOnly || !!cur.appliedAt}
                        onChange={e => void props.onScenario({ kind: 'rename', scenarioId: cur.scenarioId, name: (e.target as HTMLInputElement).value })} />
                      {editable && <IconPencil />}
                    </label>
                  </h2>
                  <p class="small muted" style="margin-top: 2px">이 시나리오에 넣은 변경입니다. 위에서부터 차례로 원본에 얹어 계산합니다.</p>
                </div>
              </div>
              {cur.appliedAt && <span class="pill ok">원본에 반영됨 · {fmtDate(cur.appliedAt.slice(0, 10))}</span>}
              {!cur.appliedAt && cur.stale && <span class="pill warn">만든 뒤 원본이 바뀜</span>}
            </div>
            <div class="card-body sim-edit">
              <div class="action-list chips-list">
                {cur.actions.length === 0 && <p class="small muted">아직 넣은 변경이 없습니다. 아래 "변경 추가"에서 더하십시오.</p>}
                {cur.actions.map(a => (
                  <div class="action-item">
                    <span>{a.label}</span>
                    {editable && <button type="button" class="btn ghost icon-btn" aria-label={`${a.label} 빼기`} onClick={() => void props.onScenario({ kind: 'removeAction', scenarioId: cur.scenarioId, groupNo: a.groupNo })}><IconX /></button>}
                  </div>
                ))}
              </div>
              <Preview view={compare} scenarioId={cur.scenarioId} />
              {editable && <ActionForm meta={data.meta} planMode={props.planMode} onAdd={async a => (await props.onScenario({ kind: 'addAction', scenarioId: cur.scenarioId, action: a })).ok} />}
              {!props.readOnly && (
                <div class="danger-zone">
                  <button type="button" class="btn sm" onClick={async () => { const r = await props.onScenario({ kind: 'create', name: `${cur.name} 복제`, copyFrom: cur.scenarioId }); if (r.createdId) setSelected(r.createdId); }}>복제</button>
                  {confirmDelete
                    ? <><span class="small">"{cur.name}"을 삭제하시겠습니까?</span><button type="button" class="btn sm danger" onClick={() => void props.onScenario({ kind: 'delete', scenarioId: cur.scenarioId })}>지우기</button><button type="button" class="btn sm ghost" onClick={() => setConfirmDelete(false)}>그만두기</button></>
                    : <button type="button" class="btn sm" onClick={() => setConfirmDelete(true)}>지우기</button>}
                  <span style="flex: 1" />
                  {!cur.appliedAt && cur.actions.length > 0 && (confirmApply
                    ? <><span class="small">{cur.stale ? '원본이 바뀐 뒤입니다. 그래도 ' : ''}원본에 반영하시겠습니까? 변경 이력에 남습니다.</span>
                      <button type="button" class="btn sm primary" onClick={async () => { if (await props.onApplyScenario(cur.scenarioId, cur.stale)) setConfirmApply(false); }}>{cur.stale ? '그래도 반영' : '반영'}</button>
                      <button type="button" class="btn sm ghost" onClick={() => setConfirmApply(false)}>그만두기</button></>
                    : <button type="button" class="btn sm primary" onClick={() => setConfirmApply(true)}>원본에 반영</button>)}
                </div>
              )}
            </div>
          </section>
        )}
        <Compare view={compare} scenarios={data.scenarios} picked={picked} onToggle={toggle} />
        <Analysis meta={data.meta} scenario={cur && !cur.appliedAt ? cur : null} planMode={props.planMode} version={props.version} />
      </div>
    </div>
  );
}
