// 진행 실적: 업데이트 × 리소스 × 파트 완료 수량, 기준일, 진행률
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { rpc } from '../lib/rpc.ts';
import type { ProgressView, ProgressRow } from '../../../core/plan.ts';
import type { Edit } from '../../../core/edits.ts';
import { fmtInt, fmtPct, fmtDate } from '../lib/format.ts';
import { IconCheck } from './icons.tsx';
import { afterCommit } from './commit.ts';

const today = () => new Date().toISOString().slice(0, 10);

function DoneInput(props: { value: number | null; label: string; flag: string | null; disabled: boolean; onCommit: (v: number | null) => unknown }) {
  const [text, setText] = useState(props.value == null ? '' : String(props.value));
  useEffect(() => setText(props.value == null ? '' : String(props.value)), [props.value]);
  const reset = () => setText(props.value == null ? '' : String(props.value));
  const commit = () => {
    const t = text.trim();
    const n = t === '' ? null : Number(t);
    if (n !== null && (!Number.isInteger(n) || n < 0)) { reset(); return; }
    if ((n || null) !== (props.value || null)) afterCommit(props.onCommit(n), reset);
  };
  return <input class={`qty${props.flag ? ' warn' : ''}`} inputMode="numeric" aria-label={props.label} title={props.flag ?? ''} value={text} placeholder="—" disabled={props.disabled}
    onInput={e => setText((e.target as HTMLInputElement).value)} onBlur={commit}
    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(props.value == null ? '' : String(props.value)); (e.target as HTMLInputElement).blur(); } }} />;
}

function SpentInput(props: { value: number | null; label: string; disabled: boolean; onCommit: (v: number | null) => unknown }) {
  const show = (v: number | null) => (v == null ? '' : String(Math.round(v * 100) / 100));
  const [text, setText] = useState(show(props.value));
  useEffect(() => setText(show(props.value)), [props.value]);
  const reset = () => setText(show(props.value));
  const commit = () => {
    if (text.trim() === show(props.value)) return; // 고치지 않았으면 반올림한 표시값을 저장하지 않는다
    const t = text.trim().replace(/,/g, '');
    const n = t === '' ? null : Number(t);
    if (n !== null && (!Number.isFinite(n) || n < 0)) { reset(); return; }
    if ((n || null) !== (props.value || null)) afterCommit(props.onCommit(n), reset);
  };
  return <input class="qty spent" inputMode="decimal" aria-label={props.label} value={text} placeholder="—" disabled={props.disabled}
    onInput={e => setText((e.target as HTMLInputElement).value)} onBlur={commit}
    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

export function ProgressPage(props: {
  version: number; readOnly: boolean; onApply: (e: Edit) => Promise<boolean>;
  onTemplate: () => Promise<void>; onImport: () => Promise<void>;
}) {
  const [wanted, setWanted] = useState<string | null>(null);
  const [field, setField] = useState<'done' | 'spent'>('done');
  const [view, setView] = useState<ProgressView | null>(null);
  const [asOf, setAsOf] = useState(today());
  useEffect(() => { void rpc.progress(wanted).then(setView); }, [props.version, wanted]);
  if (!view) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  if (!view.updateId) return <div class="page"><p class="muted">업데이트가 없어요. 업데이트 계획에서 먼저 만들어 주세요.</p></div>;
  const updateId = view.updateId;
  const rate = view.summary.totalDays > 0 ? view.summary.doneDays / view.summary.totalDays : 0;
  const apply = (e: Edit) => props.onApply(e);
  const groups: { name: string; rows: ProgressRow[] }[] = [];
  for (const r of view.rows) {
    const last = groups[groups.length - 1];
    if (last && last.name === r.groupName) last.rows.push(r); else groups.push({ name: r.groupName, rows: [r] });
  }
  const flagged = view.rows.reduce((n, r) => n + r.cells.filter(c => c.flag).length, 0);

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <PageEyebrow page="progress" />
          <h1>파트별 완료 수량</h1>
          <p class="muted" style="margin-top: 6px">끝낸 수량을 넣으면 남은 일만 다시 계산해서 완료 예정이 바로 바뀌어요.</p>
        </div>
        <div class="inline">
          <label class="form-row" style="gap: 4px">
            <span class="small faint">업데이트</span>
            <select class="field" aria-label="진척 업데이트" value={updateId} onChange={e => setWanted((e.target as HTMLSelectElement).value)}>
              {view.updates.map(u => <option value={u.updateId}>{u.name}{u.live ? '' : ' (계산 밖)'}</option>)}
            </select>
          </label>
          <label class="form-row" style="gap: 4px">
            <span class="small faint">기준일 · 새로 넣는 값에 남아요</span>
            <input class="field" type="date" aria-label="진척 기준일" value={asOf} onInput={e => setAsOf((e.target as HTMLInputElement).value || today())} />
          </label>
        </div>
      </header>

      <div class="progress-summary">
        <section class="card progress-total">
          <div class="small faint">전체 진행 · 기본 공수 기준</div>
          <div class="big num">{fmtPct(rate)}</div>
          <div class="bar"><span class="fill" style={{ width: `${Math.min(100, rate * 100)}%` }} /></div>
          <div class="small muted num">{fmtInt(view.summary.doneDays)} / {fmtInt(view.summary.totalDays)} 인·일{view.latestAsOf ? ` · 마지막 기준일 ${fmtDate(view.latestAsOf)}` : ''}</div>
        </section>
        <section class="card progress-parts">
          {view.summary.byPart.filter(p => p.totalDays > 0).map(p => {
            const r = p.doneDays / p.totalDays;
            return (
              <div class="pp-row">
                <span class="pp-name">{p.name}</span>
                <span class="bar"><span class="fill" style={{ width: `${Math.min(100, r * 100)}%` }} /></span>
                <span class="num small">{fmtPct(r)}</span>
              </div>
            );
          })}
        </section>
      </div>

      {flagged > 0 && <div class="banner warn"><IconCheck /><div><b>확인할 칸 {flagged}개</b><p class="small muted">주황 테두리 칸에 올리면 이유가 보여요. 계산은 그대로 해요.</p></div></div>}

      <section class="card">
        <div class="card-head">
          <div><h2>{field === 'done' ? '완료 수량' : '실투입 인·일'}</h2>
            <p class="small muted" style="margin-top: 2px">{field === 'done'
              ? '칸 = 그 파트가 끝낸 리소스 개수. 0이나 빈칸은 아직 없음. 빗금 칸은 거치지 않는 파트예요.'
              : '칸 = 그 완료 수량을 만드는 데 실제로 든 인·일. 공수 보정 제안에 쓰여요.'}</p></div>
          <div class="inline">
            <div class="segmented wide" role="radiogroup" aria-label="입력 항목">
              <button type="button" role="radio" aria-checked={field === 'done'} class={field === 'done' ? 'on' : ''} onClick={() => setField('done')}>완료 수량</button>
              <button type="button" role="radio" aria-checked={field === 'spent'} class={field === 'spent' ? 'on' : ''} onClick={() => setField('spent')}>실투입 인·일</button>
            </div>
            <button type="button" class="btn sm ghost" onClick={() => void props.onTemplate()}>양식 받기</button>
            {!props.readOnly && <button type="button" class="btn sm" onClick={() => void props.onImport()}>엑셀로 넣기</button>}
          </div>
        </div>
        <div class="card-body" style="padding-top: 8px">
          <div class="table-wrap">
            <table class="grid progress-grid">
              <thead><tr>
                <th>리소스</th><th class="n">목표</th>
                {view.parts.map(p => <th class="n">{p.name}</th>)}
                <th class="n" style="width: 150px">마지막 공정 기준</th><th style="width: 80px" />
              </tr></thead>
              <tbody>
                {groups.map(g => (
                  <>
                    <tr class="group"><td colSpan={view.parts.length + 4}>{g.name}</td></tr>
                    {g.rows.map(r => (
                      <tr class="row">
                        <td><span class="title" style="font-weight: 600">{r.name}</span>{r.outsource > 0 && <span class="small faint"> · 외주 {fmtInt(r.outsource)}</span>}</td>
                        <td class="n num">{fmtInt(r.target)}</td>
                        {r.cells.map((c, i) => (
                          <td class="n">
                            {!c.passes ? <span class="off-cell" aria-hidden="true" />
                              : field === 'done'
                                ? <DoneInput value={c.completed} label={`${r.name} ${view.parts[i].name} 완료`} flag={c.flag} disabled={props.readOnly}
                                  onCommit={v => apply({ kind: 'progress', updateId, resourceTypeId: r.resourceTypeId, partId: c.partId, value: v, asOf })} />
                                : <SpentInput value={c.spent} label={`${r.name} ${view.parts[i].name} 실투입`} disabled={props.readOnly}
                                  onCommit={v => apply({ kind: 'progressSpent', updateId, resourceTypeId: r.resourceTypeId, partId: c.partId, value: v, asOf })} />}
                          </td>
                        ))}
                        <td class="n">
                          <span class="share">
                            <span class="num small">{fmtPct(r.doneRate)}</span>
                            <span class="bar"><span class={`fill${r.doneRate >= 1 ? ' done' : ''}`} style={{ width: `${r.doneRate * 100}%` }} /></span>
                          </span>
                        </td>
                        <td class="n">
                          {!props.readOnly && r.doneRate < 1 && (
                            <button type="button" class="btn sm ghost" title="거치는 모든 파트를 목표만큼 완료로" onClick={() => apply({ kind: 'completeRow', updateId, resourceTypeId: r.resourceTypeId, asOf })}>다 끝남</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
