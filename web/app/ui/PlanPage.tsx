// 업데이트 계획: 타임라인 · 파트 부하 지도 · 업데이트 목록 · 만들기 · 상세(고치기)
import { UPDATE_STATUS } from '../lib/terms.ts';
import { Dialog } from './Dialog.tsx';
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { rpc } from '../lib/rpc.ts';
import type { PlanView, PlanRow, UpdateDetail } from '../../../core/plan.ts';
import type { Edit } from '../../../core/edits.ts';
import type { Finding } from '../../../core/pipeline.ts';
import type { PlanMode, UpdateStatus } from '../../../engine/types.ts';
import { fmtDate, fmtShortDate, fmtInt, fmtDays, fmtPct, fmtWorkdays, fmtMonth, localToday } from '../lib/format.ts';
import { VolumeTable } from './VolumeTable.tsx';
import { IconAlert, IconPlus, IconX } from './icons.tsx';
import { useReorder, Grip } from './reorder.tsx';
import { MODE_LABEL, humanKey } from './LaunchPage.tsx';
import { BatchPill, batchWhen, BATCH_STATUS } from './BatchPill.tsx';

// 판정 이름은 한 곳(lib/terms.ts)에서
const STATUS = UPDATE_STATUS;
const LIFE: Record<string, string> = { PLANNED: '계획', IN_PROGRESS: '진행 중', DONE: '완료', CANCELLED: '취소' };

// 날짜 → 타임라인 위치(0~1)
function scaleOf(months: string[]) {
  const start = Date.parse(`${months[0]}-01T00:00:00Z`);
  const [ey, em] = months[months.length - 1].split('-').map(Number);
  const end = Date.UTC(ey, em, 1);
  return (iso: string) => Math.min(1, Math.max(0, (Date.parse(`${iso}T00:00:00Z`) - start) / (end - start)));
}

export function ModeSwitch(props: { value: PlanMode; onChange: (m: PlanMode) => void }) {
  return (
    <div class="segmented wide" role="radiogroup" aria-label="물량 템플릿">
      {(['MIN', 'TARGET', 'STRETCH'] as PlanMode[]).map(m => (
        <button type="button" role="radio" aria-checked={props.value === m} class={props.value === m ? 'on' : ''} onClick={() => props.onChange(m)}>{MODE_LABEL[m]}</button>
      ))}
    </div>
  );
}

function Timeline(props: { view: PlanView; onOpen: (id: string) => void }) {
  const { months } = props.view.horizon;
  if (!months.length) return null;
  const x = scaleOf(months);
  const live = props.view.rows.filter(r => r.live);
  const today = localToday();
  const showToday = today >= `${months[0]}-01` && today.slice(0, 7) <= months[months.length - 1];
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  return (
    <section class="card">
      <div class="card-head">
        <div><h2>타임라인</h2><p class="small muted" style="margin-top: 2px">막대 = 작업 시작 ~ 완료 예정(색 = 판정 ✓ 목표 안 · ! 빠듯 · ▲ 늦음), 가는 선 = {MODE_LABEL.MIN} ~ {MODE_LABEL.STRETCH} 전망 범위(→ = 계획 기간 밖까지)</p></div>
        <div class="legend">
          <span><i class="lg-freeze" />제작 완료 목표</span><span><i class="lg-release" />출시</span><span><i class="lg-batch" />배치 완료 예정</span><span><i class="lg-today" />오늘</span>
        </div>
      </div>
      <div class="card-body">
        <div class="timeline" style={{ '--cols': months.length } as never}>
          <div class="tl-row tl-head">
            <div class="tl-label" />
            <div class="tl-track">
              {months.map((m, i) => (m.endsWith('-01') || i === 0) && <span class="tl-year" style={{ left: pct(i / months.length) }}>{m.slice(0, 4)}년</span>)}
              {months.map((m, i) => (
                <span class={`tl-month${m.endsWith('-01') || i === 0 ? ' year' : ''}`} style={{ left: pct(i / months.length), width: pct(1 / months.length) }}>{Number(m.slice(5))}월</span>
              ))}
            </div>
          </div>
          {live.map(r => {
            const st = r.result ? STATUS[r.result.status] : null;
            const start = r.startDate ? x(r.startDate) : 0;
            const unfinished = r.result?.status === 'UNFINISHED';
            const end = r.result?.completion ? x(r.result.completion) : unfinished ? 1 : start;
            return (
              <button type="button" class="tl-row tl-item" onClick={() => props.onOpen(r.updateId)} aria-label={`${r.name} 열기`}>
                <div class="tl-label">
                  <span class="tl-name">{r.name}</span>
                  {st && <span class={`v-ic ${st.tone}`} title={st.text} aria-label={st.text}>{st.icon}</span>}
                </div>
                <div class="tl-track">
                  {months.map((_, i) => <span class="tl-grid" style={{ left: pct(i / months.length) }} />)}
                  {showToday && <span class="tl-today" style={{ left: pct(x(today)) }} title="오늘" />}
                  <span class={`tl-bar ${st?.tone ?? ''}${unfinished ? ' open' : ''}`} style={{ left: pct(start), width: pct(Math.max(0.004, end - start)) }} />
                  {r.range && r.range.min && (
                    <span class={`tl-range${r.range.stretch ? '' : ' open'}`} title={r.range.stretch ? undefined : `${MODE_LABEL.STRETCH}은 계획 기간 안에 끝나지 않습니다`} style={{ left: pct(x(r.range.min)), width: pct(Math.max(0, (r.range.stretch ? x(r.range.stretch) : 1) - x(r.range.min))) }} />
                  )}
                  {r.batches.filter(b => b.completion).map(b => (
                    <span class={`tl-batch ${BATCH_STATUS[b.status].tone}`} style={{ left: pct(x(b.completion!)) }} title={`배치 ${b.name} 완료 예정 ${fmtDate(b.completion!)} · ${BATCH_STATUS[b.status].text}`} />
                  ))}
                  {r.freezeDate && <span class="tl-freeze" style={{ left: pct(x(r.freezeDate)) }} title={`제작 완료 목표 ${fmtDate(r.freezeDate)}`} />}
                  {r.releaseDate && <span class="tl-release" style={{ left: pct(x(r.releaseDate)) }} title={`출시 ${fmtDate(r.releaseDate)}`} />}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function LoadMap(props: { view: PlanView }) {
  const { months } = props.view.horizon;
  const [pick, setPick] = useState<{ part: string; month: string } | null>(null);
  if (!props.view.parts.length) return null;
  const picked = pick ? props.view.parts.find(p => p.partId === pick.part)?.months.find(m => m.month === pick.month) : null;
  const pickedName = pick ? props.view.parts.find(p => p.partId === pick.part)?.name : '';
  // 가동 비율(배정 ÷ 작업 가능량)을 한 색의 진하기로. 빨강은 '늦음'에만 쓴다
  const tone = (m: { utilization: number }) => {
    if (m.utilization > 1.005) return 'u5';
    if (m.utilization >= 0.98) return 'u4';
    if (m.utilization >= 0.8) return 'u3';
    if (m.utilization >= 0.5) return 'u2';
    if (m.utilization >= 0.05) return 'u1';
    return 'u0';
  };
  return (
    <section class="card">
      <div class="card-head">
        <div><h2>파트 부하 · {MODE_LABEL[props.view.planMode]}</h2><p class="small muted" style="margin-top: 2px">달마다 작업 가능량을 얼마나 썼는지. 진할수록 꽉 찬 달, 빗금은 가능량보다 많이 배정된 달입니다. 칸을 누르면 아래에 숫자가 표시됩니다.</p></div>
        <div class="legend scale"><span>쉼</span><i class="heat u0" /><i class="heat u1" /><i class="heat u2" /><i class="heat u3" /><i class="heat u4" /><span>꽉 참</span><i class="heat u5" /><span>넘침</span></div>
      </div>
      <div class="card-body">
        <div class="heatmap" style={{ '--cols': months.length } as never}>
          <div class="hm-label" />
          {months.map((m, i) => <span class={`hm-month${m.endsWith('-01') || i === 0 ? ' year' : ''}`}>{(m.endsWith('-01') || i === 0) && <span class="hm-yr">{m.slice(0, 4)}년</span>}{Number(m.slice(5))}월</span>)}
          {props.view.parts.map(p => (
            <>
              <div class="hm-label">{p.name}</div>
              {p.months.map(m => (
                <button type="button" class={`hm-cell ${tone(m)}${pick?.part === p.partId && pick.month === m.month ? ' on' : ''}`} aria-label={`${p.name} ${fmtMonth(m.month)} ${fmtPct(m.utilization)}`}
                  aria-pressed={pick?.part === p.partId && pick.month === m.month} onClick={() => setPick({ part: p.partId, month: m.month })}
                  title={`${p.name} ${fmtMonth(m.month)}: 배정 ${fmtDays(m.assigned)} / 가능 ${fmtDays(m.capacity)}인·일 (${fmtPct(m.utilization)})${m.remaining > 0.05 ? ` · 밀린 일 ${fmtDays(m.remaining)}인·일` : ''}`} />
              ))}
            </>
          ))}
        </div>
        <p class="small hm-readout" aria-live="polite">{picked
          ? <><b>{pickedName} · {fmtMonth(picked.month)}</b> 배정 {fmtDays(picked.assigned)} / 가능 {fmtDays(picked.capacity)}인·일 · <b>{fmtPct(picked.utilization)}</b>{picked.remaining > 0.05 ? ` · 밀린 일 ${fmtDays(picked.remaining)}인·일` : ''}</>
          : <span class="faint">칸을 누르면 그 달의 배정 · 가능량이 여기에 표시됩니다.</span>}</p>
      </div>
    </section>
  );
}

/** 늦은 까닭 한 줄(docs/34 C-03): 가장 늦게 끝나는 곳과 인력을 기다린 날 */
function Reason(props: { reason: { partName: string; resourceName: string; waitWorkdays: number | null } }) {
  const w = props.reason.waitWorkdays;
  return <div class="small faint reason-line" style="margin-top: 4px">까닭: {props.reason.resourceName}의 {props.reason.partName}{w ? `(인력 대기 ${fmtWorkdays(w, false)})` : ''}에서 가장 늦게 끝남</div>;
}

function UpdateList(props: { view: PlanView; onOpen: (id: string) => void; onApply: (e: Edit) => void; readOnly: boolean; onFix?: () => void }) {
  const live = props.view.rows.filter(r => r.live);
  const rest = props.view.rows.filter(r => !r.live);
  // 진행 중 · 예정 업데이트는 손잡이나 줄을 길게 눌러 끌어 우선순위를 바꾼다(docs/27 4.3)
  const ro = useReorder(live.map(r => r.updateId), ids => props.onApply({ kind: 'reorderPriority', updateIds: ids }), { disabled: props.readOnly });
  const row = (r: PlanRow) => {
    const st = r.result ? STATUS[r.result.status] : null;
    const drag = r.live && !props.readOnly;
    return (
      <tr class={`row${r.live ? '' : ' muted-row'}${drag ? ` ${ro.cls(r.updateId)}` : ''}`} {...(drag ? ro.item(r.updateId) : {})}>
        <td class="n">
          {drag ? (
            <span class="prio"><button {...ro.handle(r.updateId, `${r.name} 우선순위`)}><Grip /></button><span class="num">{r.priority}</span></span>
          ) : <span class="faint">{r.live ? r.priority : '—'}</span>}
        </td>
        <td>
          <button type="button" class="link" onClick={() => props.onOpen(r.updateId)}>{r.name}</button>
          <span class="tag" style="margin-left: 6px">{r.typeName}</span>
          {!r.live && <span class="tag" style="margin-left: 4px">{LIFE[r.status]}</span>}
        </td>
        <td class="n num c-start" data-label="시작">{fmtShortDate(r.startDate)}</td>
        <td class="n num c-freeze" data-label="제작 완료 목표">{fmtShortDate(r.freezeDate)}</td>
        <td class="n num c-release" data-label="출시">{fmtShortDate(r.releaseDate)}</td>
        <td class="n num c-qty" data-label={`${MODE_LABEL.TARGET} 물량`}>{fmtInt(r.totals.target)}<span class="faint small"> ({r.resourceCount}종)</span></td>
        <td class="n num c-when" data-label="완료 예정 · 범위">
          {r.result ? (r.result.completion ? fmtShortDate(r.result.completion) : '기간 밖') : '—'}
          {r.range && r.result && <div class="small faint">{r.range.min ? fmtShortDate(r.range.min) : '기간 밖'} ~ {r.range.stretch ? fmtShortDate(r.range.stretch) : '기간 밖'}</div>}
        </td>
        <td class="c-verdict">
          {st && <span class={`pill ${st.tone}`} data-icon={st.icon}>{st.text}{r.result?.lateWorkdays ? ` ${fmtWorkdays(r.result.lateWorkdays)}` : ''}</span>}
          {r.result?.reason && r.result.status !== 'ON_TRACK' && <Reason reason={r.result.reason} />}
          {props.onFix && (r.result?.status === 'LATE' || r.result?.status === 'UNFINISHED' || r.batches.some(b => b.status === 'LATE' || b.status === 'UNFINISHED')) && (
            <button type="button" class="link-btn small fix-link" onClick={props.onFix}>맞추는 방법 보기 →</button>
          )}
        </td>
      </tr>
    );
  };
  // 배치 줄(docs/33): 업데이트 줄 바로 아래, 배치 순서대로. 끌기 대상이 아니다(배치 순서는 에셋 › 배치에서)
  const batchLines = (r: PlanRow) => r.batches.map(b => (
    <tr class="row batch-line">
      <td class="c-empty" />
      <td><span class="batch-line-name"><span class="faint" aria-hidden="true">└</span> 배치 <b>{b.name}</b></span></td>
      <td class="c-empty" /><td class="c-empty" />
      <td class="n num small c-due">{b.dueDate ? <>마감 {fmtShortDate(b.dueDate)}</> : <span class="faint">마감 없음</span>}</td>
      <td class="c-empty" />
      <td class="n num c-when" data-label="완료 예정">{batchWhen(b)}</td>
      <td class="c-verdict"><BatchPill b={b} />{b.reason && b.status !== 'ON_TRACK' && b.status !== 'NO_DUE' && <Reason reason={b.reason} />}</td>
    </tr>
  ));
  return (
    <section class="card">
      <div class="card-head"><div><h2>업데이트</h2><p class="small muted" style="margin-top: 2px">우선순위가 높은 업데이트가 인력을 먼저 사용합니다. 왼쪽 손잡이(⠿)나 줄을 길게 눌러 끌면 순서가 바뀝니다.{live.some(r => r.batches.length) && <> 배치가 있는 업데이트는 그 안에서 <b>배치 순서대로</b> 작업한다고 보고 계산하며, 업데이트 아래 줄에 배치별 완료 예정을 보입니다(배치 순서는 에셋 제작 현황 › 배치에서).</>}</p></div></div>
      <div class="card-body" style="padding-top: 8px">
        <div class="table-wrap">
          <table class="grid list plan-list">
            <thead><tr>
              <th class="n" style="width: 96px">순위</th><th>업데이트</th><th class="n">시작</th><th class="n">제작 완료 목표</th><th class="n">출시</th>
              <th class="n">{MODE_LABEL.TARGET} 물량</th><th class="n">완료 예정 · 범위</th><th>판정 · 근거</th>
            </tr></thead>
            <tbody data-reorder-box="">
              {live.map(r => <>{row(r)}{batchLines(r)}</>)}
              {rest.map(row)}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function CreateUpdate(props: { view: PlanView; onClose: () => void; onCreate: (e: Extract<Edit, { kind: 'createUpdate' }>) => Promise<void> }) {
  const types = props.view.types.filter(t => !t.isLaunch);
  const last = props.view.rows.filter(r => r.live && r.releaseDate).map(r => r.releaseDate!).sort().pop();
  const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const start0 = last ? addDays(last, -60) : `${props.view.horizon.start}-01`;
  const [f, setF] = useState({ name: '', typeId: types[0]?.typeId ?? '', startDate: start0, freezeDate: addDays(start0, 75) as string | null, releaseDate: addDays(start0, 90) as string | null });
  const [error, setError] = useState('');
  const submit = async () => {
    if (!f.name.trim()) { setError('업데이트 이름을 입력하십시오.'); return; }
    if (!f.typeId) { setError('업데이트 유형이 없습니다. 유형 템플릿에서 먼저 만드십시오.'); return; }
    try { await props.onCreate({ kind: 'createUpdate', ...f }); } catch (e) { setError((e as Error).message); }
  };
  const t = types.find(x => x.typeId === f.typeId);
  return (
    <Dialog label="업데이트 만들기" onClose={() => props.onClose()}>
        <div class="dialog-head"><h2>업데이트 만들기</h2><button type="button" class="btn ghost icon-btn" aria-label="닫기" onClick={props.onClose}><IconX /></button></div>
        <div class="form" style="padding: 20px">
          {error && <div class="banner bad"><IconAlert /><div>{error}</div></div>}
          <label class="form-row"><span class="form-label">이름</span><input class="field" data-autofocus aria-label="업데이트 이름" value={f.name} placeholder="예: 시즌 3" onInput={e => setF({ ...f, name: (e.target as HTMLInputElement).value })} /></label>
          <label class="form-row">
            <span class="form-label">유형</span>
            <select class="field" aria-label="업데이트 유형" value={f.typeId} onChange={e => setF({ ...f, typeId: (e.target as HTMLSelectElement).value })}>
              {types.map(x => <option value={x.typeId}>{x.name}</option>)}
            </select>
            <span class="form-help">{t ? `${t.name} 템플릿의 물량 ${t.templateCount}종을 복사합니다. 만든 뒤 수정할 수 있습니다.` : ''}</span>
          </label>
          <div class="dates">
            {([['startDate', '작업 시작'], ['freezeDate', '제작 완료 목표'], ['releaseDate', '출시']] as const).map(([k, label]) => (
              <div class={`date-chip${k === 'freezeDate' ? ' key' : ''}`}>
                <label for={`cu-${k}`}>{label}</label>
                <input id={`cu-${k}`} type="date" value={f[k] ?? ''} onInput={e => setF({ ...f, [k]: (e.target as HTMLInputElement).value || (k === 'startDate' ? f.startDate : null) })} />
              </div>
            ))}
          </div>
        </div>
        <div class="wizard-foot"><button type="button" class="btn ghost" onClick={props.onClose}>그만두기</button><button type="button" class="btn primary" onClick={() => void submit()}>만들기</button></div>
      </Dialog>
  );
}

function UpdateDrawer(props: {
  updateId: string; planMode: PlanMode; version: number; readOnly: boolean; types: PlanView['types']; row: PlanRow | undefined; names: Record<string, string>;
  onClose: () => void; onApply: (e: Edit) => Promise<boolean>; setPlanMode: (m: PlanMode) => void;
}) {
  const [data, setData] = useState<{ detail: UpdateDetail | null; days: { blocked: boolean; byResource: Record<string, number>; total: number } | null; findings: Finding[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { void rpc.detail(props.updateId, props.planMode).then(setData); }, [props.updateId, props.planMode, props.version]);
  const d = data?.detail;
  if (data && !d) return null;
  const apply = (e: Edit) => void props.onApply(e);
  const field = (f: 'name' | 'update_type_id' | 'start_date' | 'freeze_date' | 'release_date' | 'status') => (value: string | null) => apply({ kind: 'updateField', updateId: props.updateId, field: f, value });
  const st = props.row?.result ? STATUS[props.row.result.status] : null;
  const errors = (data?.findings ?? []).filter(f => f.level === 'ERROR');
  return (
    <Dialog label="업데이트 상세" onClose={() => props.onClose()} as="aside" class="drawer card">
        {!d ? <div class="card-body muted">불러오는 중…</div> : (
          <>
            <div class="dialog-head">
              <input class="title-input" aria-label="업데이트 이름" value={d.name} disabled={props.readOnly}
                onChange={e => field('name')((e.target as HTMLInputElement).value)} />
              <button type="button" class="btn ghost icon-btn" aria-label="닫기" onClick={props.onClose}><IconX /></button>
            </div>
            <div class="drawer-body">
              <div class="inline" style="gap: 12px">
                {!d.isLaunch && (
                  <select class="field" aria-label="유형" value={d.typeId} disabled={props.readOnly} onChange={e => field('update_type_id')((e.target as HTMLSelectElement).value)}>
                    {props.types.filter(t => !t.isLaunch).map(t => <option value={t.typeId}>{t.name}</option>)}
                  </select>
                )}
                <select class="field" aria-label="상태" value={d.status} disabled={props.readOnly} onChange={e => field('status')((e.target as HTMLSelectElement).value)}>
                  {Object.entries(LIFE).map(([k, v]) => <option value={k}>{v}</option>)}
                </select>
                {st && <span class={`pill ${st.tone}`} data-icon={st.icon}>{st.text}</span>}
                {props.row?.result?.completion && <span class="muted small">완료 예정 {fmtDate(props.row.result.completion)}{props.row.range ? ` · 범위 ${props.row.range.min ? fmtShortDate(props.row.range.min) : '기간 밖'} ~ ${props.row.range.stretch ? fmtShortDate(props.row.range.stretch) : '기간 밖'}` : ''}</span>}
              </div>
              <p class="small muted" style="margin: 6px 0 0">날짜 · 물량을 고치면 바로 다시 계산합니다.</p>
              {props.row?.result?.reason && props.row.result.status !== 'ON_TRACK' && <Reason reason={props.row.result.reason} />}
              {props.row && props.row.batches.length > 0 && (
                <div class="drawer-batches">
                  <b class="small">배치</b>
                  {props.row.batches.map(b => (
                    <div class="drawer-batch small"><span>{b.name}</span><span class="faint">{b.dueDate ? `마감 ${fmtShortDate(b.dueDate)}` : '마감 없음'}</span><span class="num">{batchWhen(b)}</span><BatchPill b={b} /></div>
                  ))}
                </div>
              )}
              <div class="dates">
                {([['start_date', '작업 시작', d.startDate], ['freeze_date', '제작 완료 목표', d.freezeDate], ['release_date', '출시', d.releaseDate]] as const).map(([k, label, value]) => (
                  <div class={`date-chip${k === 'freeze_date' ? ' key' : ''}`}>
                    <label for={`ud-${k}`}>{label}</label>
                    <input id={`ud-${k}`} type="date" value={value ?? ''} disabled={props.readOnly} onChange={e => field(k)((e.target as HTMLInputElement).value || null)} />
                  </div>
                ))}
              </div>
              {errors.length > 0 && (
                <div class="banner bad"><IconAlert /><div><b>계산할 수 없습니다 · 고칠 곳 {errors.length}개</b>
                  <ul class="small">{errors.slice(0, 4).map(f => <li>{humanKey(f.key, props.names)} — {f.title} ({f.detail})</li>)}</ul></div></div>
              )}
              <VolumeTable
                bare
                updateId={d.updateId}
                rows={d.rows}
                addable={d.addable}
                byResource={data?.days?.byResource ?? {}}
                totalDays={data?.days?.total ?? 0}
                planMode={props.planMode}
                findings={data?.findings ?? []}
                blocked={!!data?.days?.blocked}
                readOnly={props.readOnly}
                onEdit={e => apply({ ...e, updateId: d.updateId } as Edit)}
                onCopy={props.readOnly ? undefined : (from, to) => apply({ kind: 'copyQty', updateId: d.updateId, from, to })}
                onSelectMode={props.setPlanMode}
              />
              {!d.isLaunch && !props.readOnly && (
                <div class="danger-zone">
                  {confirmDelete
                    ? <><span class="small">"{d.name}"과 물량·작업 진척을 지우시겠습니까? 변경 이력에는 남습니다.</span>
                      <button type="button" class="btn sm danger" onClick={async () => { if (await props.onApply({ kind: 'deleteUpdate', updateId: d.updateId })) props.onClose(); }}>지우기</button>
                      <button type="button" class="btn sm ghost" onClick={() => setConfirmDelete(false)}>그만두기</button></>
                    : <button type="button" class="btn sm" onClick={() => setConfirmDelete(true)}>이 업데이트 지우기</button>}
                </div>
              )}
            </div>
          </>
        )}
      </Dialog>
  );
}

/** 제목: 런칭이 있으면 "런칭과 업데이트 N개"(N = 런칭 제외), 업데이트가 없으면 "런칭", 런칭이 없으면 "업데이트 N개" */
export function planTitle(rows: { isLaunch: boolean }[]): string {
  const hasLaunch = rows.some(r => r.isLaunch);
  const n = rows.filter(r => !r.isLaunch).length;
  if (hasLaunch) return n ? `런칭과 업데이트 ${n}개` : '런칭';
  return `업데이트 ${n}개`;
}

export function PlanPage(props: {
  version: number; planMode: PlanMode; setPlanMode: (m: PlanMode) => void; readOnly: boolean;
  names: Record<string, string>; onApply: (e: Edit) => Promise<boolean>;
  /** 늦음 → 마감 맞추기, 계산 막힘 → 데이터 점검 */
  onGo?: (page: 'advisor' | 'check') => void;
}) {
  const [view, setView] = useState<PlanView | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { void rpc.plan(props.planMode).then(setView); }, [props.version, props.planMode]);
  if (!view) return <div class="page"><p class="muted">계산 중…</p></div>;
  const errors = view.findings.filter(f => f.level === 'ERROR');
  const names = { ...props.names, ...Object.fromEntries(view.rows.map(r => [r.updateId, r.name])) };
  const live = view.rows.filter(r => r.live);
  const late = live.filter(r => r.result && (r.result.status === 'LATE' || r.result.status === 'UNFINISHED')).length;
  const tight = live.filter(r => r.result?.status === 'TIGHT').length;
  const batchLate = live.reduce((n, r) => n + r.batches.filter(b => b.status === 'LATE' || b.status === 'UNFINISHED').length, 0);
  return (
    <div class="page">
      <header class="page-head">
        <div>
          <PageEyebrow page="plan" />
          {/* 개수는 런칭을 뺀 업데이트만 센다(런칭 + 시즌 3개 = "런칭과 업데이트 3개") */}
          <h1>{planTitle(live)}</h1>
          <p class="muted" style="margin-top: 6px">모든 업데이트가 같은 인력을 우선순위대로 나눠 사용합니다.{!errors.length && ` 늦음 ${late}개 · 빠듯 ${tight}개${batchLate ? ` · 늦는 배치 ${batchLate}개` : ''}.`}</p>
        </div>
        <div class="inline">
          <ModeSwitch value={props.planMode} onChange={props.setPlanMode} />
          {!props.readOnly && <button type="button" class="btn primary" onClick={() => setCreating(true)}><IconPlus />업데이트 만들기</button>}
        </div>
      </header>
      {errors.length > 0 && (
        <div class="banner bad" role="alert"><IconAlert /><div><b>계산할 수 없습니다 · 고칠 곳 {errors.length}개</b>
          <ul class="small">{errors.slice(0, 6).map(f => <li>{humanKey(f.key, names)} — {f.title} ({f.detail})</li>)}</ul>
          {props.onGo && <button type="button" class="btn sm" style="margin-top: 8px" onClick={() => props.onGo!('check')}>데이터 점검에서 고치기</button>}</div></div>
      )}
      {errors.length > 0
        ? <section class="card blocked-card"><div class="card-body small muted">계산할 수 없어 타임라인과 파트 부하를 비워 두었습니다. 위 고칠 곳을 고치면 다시 그립니다.</div></section>
        : <><Timeline view={view} onOpen={setOpenId} /><LoadMap view={view} /></>}
      <UpdateList view={view} onOpen={setOpenId} onApply={e => void props.onApply(e)} readOnly={props.readOnly} onFix={props.onGo ? () => props.onGo!('advisor') : undefined} />
      {creating && <CreateUpdate view={view} onClose={() => setCreating(false)} onCreate={async e => { if (await props.onApply(e)) setCreating(false); }} />}
      {openId && (
        <UpdateDrawer updateId={openId} planMode={props.planMode} version={props.version} readOnly={props.readOnly} types={view.types}
          row={view.rows.find(r => r.updateId === openId)} names={names} onClose={() => setOpenId(null)} onApply={props.onApply} setPlanMode={props.setPlanMode} />
      )}
    </div>
  );
}
