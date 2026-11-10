// 공정 순서 · 파이프라인(docs/28 · 29): 이름 붙인 파이프라인만. 파트 표는 목록일 뿐, 새 파트는 어느 파이프라인에도 들어가지 않는다.
// 단계 칩은 끌어서 순서를 바꾸고, 단계 사이 겹침률은 눌러서 고친다(비우면 파트 쌍 → 기본). 리소스는 리소스 · 공수 표에서 파이프라인을 고른다.
import { useState } from 'preact/hooks';
import type { SetupView } from '../../../core/plan.ts';
import type { Edit } from '../../../core/edits.ts';
import { Field } from './SetupPage.tsx';
import { useReorder, Grip } from './reorder.tsx';
import { IconPlus, IconX } from './icons.tsx';

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** 단계 사이 겹침률: 적은 값(진하게) 또는 물려받은 값(흐리게). 누르면 고치기 */
function OverlapPill(props: { own: number | null; inherited: number; label: string; disabled: boolean; onCommit: (rate: number | null) => unknown }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState('');
  const shown = props.own ?? props.inherited;
  if (edit && !props.disabled) {
    const commit = () => {
      setEdit(false);
      const t = text.trim().replace('%', '');
      if (t === '') { if (props.own != null) void props.onCommit(null); return; }
      const n = Number(t);
      if (Number.isFinite(n) && n >= 0 && n <= 100 && n / 100 !== props.own) void props.onCommit(n / 100);
    };
    return <input class="field overlap-in" inputMode="decimal" aria-label={props.label} value={text} ref={el => el?.focus()}
      onInput={e => setText((e.target as HTMLInputElement).value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEdit(false); }} />;
  }
  return (
    <button type="button" class={`overlap-pill${props.own == null ? ' inherited' : ''}`} aria-label={`${props.label} ${pct(shown)}`} disabled={props.disabled}
      title={props.own == null ? `겹침률 ${pct(shown)}(물려받은 값). 눌러서 이 단계만 바꿉니다. 앞 공정이 이만큼 끝나면 다음 공정을 시작합니다` : `겹침률 ${pct(shown)}. 비우면 물려받은 값으로 돌아갑니다`}
      onClick={() => { setText(props.own == null ? '' : String(Math.round(props.own * 100))); setEdit(true); }}>
      <span class="overlap-arrow" aria-hidden="true">→</span>{pct(shown)}
    </button>
  );
}

function StepChips(props: { v: SetupView; ids: string[]; own: (partId: string) => number | null; inherited: (from: string, to: string) => number; readOnly: boolean;
  onOrder: (ids: string[]) => unknown; onOverlap: (partId: string, rate: number | null) => unknown; onRemove?: (partId: string) => unknown; dragLabel: string }) {
  const name = new Map(props.v.parts.map(p => [p.partId, p.name]));
  const r = useReorder(props.ids, props.onOrder, { disabled: props.readOnly, axis: 'x', delay: 250 });
  return (
    <div class="step-chips" data-reorder-box="">
      {props.ids.map((id, i) => (
        <>
          {i > 0 && <OverlapPill own={props.own(id)} inherited={props.inherited(props.ids[i - 1], id)} label={`${props.dragLabel}: ${name.get(props.ids[i - 1])} → ${name.get(id)} 겹침률`} disabled={props.readOnly}
            onCommit={rate => props.onOverlap(id, rate)} />}
          <span class={`step-chip ${r.cls(id)}`} {...r.item(id)}>
            {!props.readOnly && <button {...r.handle(id, `${props.dragLabel} ${name.get(id)}`)}><Grip /></button>}
            <span class="step-n">{i + 1}</span>{name.get(id) ?? id}
            {props.onRemove && !props.readOnly && <button type="button" class="step-x" aria-label={`${name.get(id)} 단계 빼기`} onClick={() => void props.onRemove!(id)}><IconX /></button>}
          </span>
        </>
      ))}
    </div>
  );
}

export function PipelineSection(props: { v: SetupView; readOnly: boolean; apply: (e: Edit) => Promise<boolean> }) {
  const { v, readOnly: ro, apply } = props;
  const [newName, setNewName] = useState('');
  const pair = (from: string, to: string) => v.overlaps.find(o => o.from === from && o.to === to)?.rate ?? null;
  const unpicked = v.resources.filter(r => !r.pipelineId || !v.pipelines.some(p => p.pipelineId === r.pipelineId));
  const loose = v.parts.filter(p => p.active && !v.pipelines.some(pl => pl.steps.some(s => s.partId === p.partId)));
  return (
    <section class="card" aria-label="공정 순서 · 파이프라인">
      <div class="card-head">
        <div><h2>공정 순서 · 파이프라인</h2>
          <p class="small muted" style="margin-top: 2px">리소스는 파이프라인 하나의 단계 순서대로 작업합니다(리소스 · 공수 표의 "파이프라인"). 파트를 더해도 파이프라인은 바뀌지 않습니다. 단계 칩은 끌어서 순서를 바꾸고, 단계 사이 % 는 겹침률(앞 공정이 이만큼 끝나면 다음 공정 시작, 점선은 물려받은 값)입니다.</p></div>
      </div>
      <div class="card-body pipelines">
        {loose.length > 0 && (
          <p class="pipe-note small" role="note">어느 파이프라인에도 없는 파트: <b>{loose.map(p => p.name).join(' · ')}</b>. 이 파트로는 일이 가지 않습니다. 쓰는 파이프라인에 "＋ 단계 더하기"로 넣거나 새 파이프라인을 만드십시오.</p>
        )}
        {unpicked.length > 0 && (
          <p class="pipe-note small" role="note">파이프라인을 고르지 않은 리소스 {unpicked.length}종({unpicked.slice(0, 4).map(r => r.name).join(', ')}{unpicked.length > 4 ? ' 등' : ''})은 파트 표 순서로 계산합니다. 리소스 · 공수 표에서 고르십시오.</p>
        )}
        {v.pipelines.length === 0 && <p class="small faint">파이프라인이 없습니다. 아래에서 만들고 단계를 순서대로 더합니다.</p>}
        {v.pipelines.map(pl => {
          const ids = pl.steps.map(s => s.partId);
          const rest = v.parts.filter(p => p.active && !ids.includes(p.partId));
          return (
            <div class="pipeline-card">
              <div class="pipeline-head">
                <Field class="field pipeline-name" value={pl.name} label={`${pl.name} 파이프라인 이름`} disabled={ro} onCommit={t => apply({ kind: 'renamePipeline', pipelineId: pl.pipelineId, name: t })} />
                <span class="small faint">리소스 {pl.resources}종</span>
                <span style="flex: 1" />
                {!ro && rest.length > 0 && (
                  <select class="field add-step" aria-label={`${pl.name} 단계 더하기`} value="" onChange={e => { const id = (e.target as HTMLSelectElement).value; if (id) void apply({ kind: 'pipelineSteps', pipelineId: pl.pipelineId, partIds: [...ids, id] }); }}>
                    <option value="">＋ 단계 더하기</option>
                    {rest.map(p => <option value={p.partId}>{p.name}</option>)}
                  </select>
                )}
                {!ro && <button type="button" class="btn ghost icon-btn" aria-label={`${pl.name} 파이프라인 지우기`} disabled={pl.resources > 0}
                  title={pl.resources > 0 ? '쓰는 리소스가 있어 지울 수 없습니다' : '지우기'} onClick={() => void apply({ kind: 'deletePipeline', pipelineId: pl.pipelineId })}><IconX /></button>}
              </div>
              {ids.length === 0
                ? <p class="small faint">단계가 없습니다. "＋ 단계 더하기"로 파트를 순서대로 넣습니다.</p>
                : <StepChips v={v} ids={ids} readOnly={ro} dragLabel={pl.name} own={id => pl.steps.find(s => s.partId === id)?.overlap ?? null}
                  inherited={(a, b) => pair(a, b) ?? v.defaultOverlap}
                  onOrder={next => apply({ kind: 'pipelineSteps', pipelineId: pl.pipelineId, partIds: next })}
                  onOverlap={(id, rate) => apply({ kind: 'stepOverlap', pipelineId: pl.pipelineId, partId: id, rate })}
                  onRemove={id => apply({ kind: 'pipelineSteps', pipelineId: pl.pipelineId, partIds: ids.filter(x => x !== id) })} />}
            </div>
          );
        })}
        {!ro && (
          <div class="inline">
            <input class="field" aria-label="새 파이프라인 이름" placeholder="새 파이프라인 이름(예: 배경)" value={newName} onInput={e => setNewName((e.target as HTMLInputElement).value)}
              onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget.nextElementSibling as HTMLButtonElement | null)?.click(); }} />
            <button type="button" class="btn sm" disabled={!newName.trim()} onClick={async () => { if (await apply({ kind: 'createPipeline', name: newName, partIds: [] })) setNewName(''); }}><IconPlus />파이프라인 만들기</button>
            <span class="small faint">만든 뒤 단계를 순서대로 더하고, 리소스 · 공수 표에서 리소스의 파이프라인을 고릅니다.</span>
          </div>
        )}
      </div>
    </section>
  );
}
