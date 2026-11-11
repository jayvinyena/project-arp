// 공수 옮기기 · 지우기 창(docs/27 4.1): 기록(작업 진척 · 에셋 상태)이 있는 칸을 비울 때, 칸의 → 단추, 파이프라인을 바꿀 때.
import { Dialog } from './Dialog.tsx';
import { useState } from 'preact/hooks';
import type { SetupView } from '../../../core/plan.ts';
import type { Edit } from '../../../core/edits.ts';
import { IconX } from './icons.tsx';

export interface MoveRequest {
  /** 한 칸 옮기기 · 지우기 */
  kind: 'cell';
  resourceTypeId: string; partId: string;
}
export interface PipelineRequest {
  /** 파이프라인 바꾸기: 새 파이프라인에 없는 파트마다 옮길 곳 · 지우기 */
  kind: 'pipeline';
  resourceTypeId: string; pipelineId: string;
}

const guess = (v: SetupView, from: string, candidates: string[]): string => {
  // 이름이 비슷한 파트 먼저(원화 → 배경 원화), 없으면 첫 후보
  const nm = (id: string) => v.parts.find(p => p.partId === id)?.name ?? id;
  const f = nm(from);
  return candidates.find(c => nm(c).includes(f) || f.includes(nm(c))) ?? candidates[0] ?? '';
};

type Props<R> = { v: SetupView; req: R; apply: (e: Edit) => Promise<boolean>; onClose: () => void };

/** 옮길 곳을 아직 고르지 않음(고르기 전에는 바꾸지 않는다) */
const UNPICKED = '\u0000';

export function MoveDialog(props: Props<MoveRequest | PipelineRequest>) {
  return props.req.kind === 'cell' ? <CellMove {...(props as Props<MoveRequest>)} /> : <PipelineMove {...(props as Props<PipelineRequest>)} />;
}

function CellMove(props: Props<MoveRequest>) {
  const { v, req } = props;
  const r = v.resources.find(x => x.resourceTypeId === req.resourceTypeId)!;
  const name = (id: string) => v.parts.find(p => p.partId === id)?.name ?? id;
  const allowedOf = (pipelineId: string | null) => {
    const pl = pipelineId ? v.pipelines.find(p => p.pipelineId === pipelineId) : null;
    return pl ? pl.steps.map(s => s.partId) : v.parts.filter(p => p.active).map(p => p.partId);
  };
  {
    const e = r.efforts[req.partId];
    const targets = allowedOf(r.pipelineId).filter(p => p !== req.partId);
    const same = v.resources.filter(x => x.groupId === r.groupId && x.efforts[req.partId] && x.resourceTypeId !== r.resourceTypeId);
    const [mode, setMode] = useState<'move' | 'drop'>(targets.length ? 'move' : 'drop');
    const [to, setTo] = useState(guess(v, req.partId, targets.filter(t => !r.efforts[t])) || targets[0] || '');
    const [all, setAll] = useState(false);
    const ids = all ? [r.resourceTypeId, ...same.map(x => x.resourceTypeId)] : [r.resourceTypeId];
    const run = async () => {
      const ok = mode === 'move'
        ? await props.apply({ kind: 'moveResourcePart', resourceTypeIds: ids, fromPartId: req.partId, toPartId: to })
        : await props.apply({ kind: 'dropResourcePart', resourceTypeIds: ids, partId: req.partId });
      if (ok) props.onClose();
    };
    return (
      <Dialog label="공수 옮기기 · 지우기" onClose={() => props.onClose()} class="move-dialog">
          <div class="dialog-head"><div><h2>{r.name} · {name(req.partId)}</h2>
            <p class="small muted" style="margin-top: 2px">공수 {e?.base ?? '—'}{e?.done ? ` · 작업 진척 완료 ${e.done}개` : ''}{e?.assets ? ` · 에셋 상태 ${e.assets}개` : ''}</p></div>
            <button type="button" class="btn ghost icon-btn" aria-label="닫기" onClick={props.onClose}><IconX /></button></div>
          <div class="move-body">
            <label class={`move-opt${mode === 'move' ? ' on' : ''}`}>
              <input type="radio" name="move-mode" checked={mode === 'move'} disabled={!targets.length} onChange={() => setMode('move')} />
              <span><b>다른 파트로 옮기기</b>
                <span class="small muted">공수(기본 · AI) · 재작업률 · 작업 진척 · 에셋 상태를 함께 옮깁니다. 받는 파트에 이미 있는 공수는 그대로 둡니다.</span>
                <select class="field" aria-label="옮길 파트" value={to} disabled={mode !== 'move'} onChange={ev => setTo((ev.target as HTMLSelectElement).value)}>
                  {targets.map(t => <option value={t}>{name(t)}{r.efforts[t] ? ' (이미 거침 · 합침)' : ''}</option>)}
                </select></span>
            </label>
            <label class={`move-opt${mode === 'drop' ? ' on' : ''}`}>
              <input type="radio" name="move-mode" checked={mode === 'drop'} onChange={() => setMode('drop')} />
              <span><b>기록까지 지우기</b><span class="small muted">이 파트를 거치지 않게 하고 공수 · 작업 진척 · 에셋 상태를 지웁니다(변경 이력에서 되돌릴 수 있음).</span></span>
            </label>
            {same.length > 0 && <label class="inline small"><input type="checkbox" checked={all} onChange={ev => setAll((ev.target as HTMLInputElement).checked)} />
              같은 분류({r.groupName || '분류 없음'})에서 {name(req.partId)}을(를) 거치는 리소스 {same.length}종도 함께({same.map(x => x.name).join(', ')})</label>}
          </div>
          <div class="dialog-foot"><button type="button" class="btn sm ghost" onClick={props.onClose}>그만두기</button>
            <button type="button" class={`btn sm ${mode === 'move' ? 'primary' : 'danger'}`} disabled={mode === 'move' && !to} onClick={() => void run()}>{mode === 'move' ? '옮기기' : '기록까지 지우기'}</button></div>
        </Dialog>
    );
  }

}

function PipelineMove(props: Props<PipelineRequest>) {
  const { v, req } = props;
  const r = v.resources.find(x => x.resourceTypeId === req.resourceTypeId)!;
  const name = (id: string) => v.parts.find(p => p.partId === id)?.name ?? id;
  const pl = v.pipelines.find(p => p.pipelineId === req.pipelineId)!;
  const steps = pl.steps.map(s => s.partId);
  const outside = Object.keys(r.efforts).filter(p => !steps.includes(p));
  const [moves, setMoves] = useState<Record<string, string>>(() => {
    const free = steps.filter(s => !r.efforts[s]);
    const m: Record<string, string> = {};
    // 옮길 곳을 찾지 못하면 "고르지 않음"(기록 지우기를 기본으로 두지 않는다, docs/34 A-22)
    for (const p of outside) { const g = guess(v, p, free.filter(x => !Object.values(m).includes(x))); m[p] = g || UNPICKED; }
    return m;
  });
  const unpicked = outside.filter(p => moves[p] === UNPICKED);
  const dropping = outside.filter(p => moves[p] === '');
  const lost = dropping.reduce((n, p) => n + (r.efforts[p].done || 0) + (r.efforts[p].assets || 0), 0);
  const run = async () => {
    const ok = await props.apply({ kind: 'resourcePipeline', resourceTypeIds: [r.resourceTypeId], pipelineId: pl.pipelineId,
      moves: outside.map(p => ({ fromPartId: p, toPartId: moves[p] || null })) });
    if (ok) props.onClose();
  };
  return (
    <Dialog label="파이프라인 바꾸기" onClose={() => props.onClose()} class="move-dialog">
        <div class="dialog-head"><div><h2>{r.name} → {pl.name} 파이프라인</h2>
          <p class="small muted" style="margin-top: 2px">새 파이프라인({steps.map(name).join(' → ')})에 없는 파트의 공수 · 작업 진척 · 에셋 상태를 어디로 옮길지 고릅니다.</p></div>
          <button type="button" class="btn ghost icon-btn" aria-label="닫기" onClick={props.onClose}><IconX /></button></div>
        <div class="move-body">
          <table class="grid ref move-table">
            <thead><tr><th>지금 파트</th><th>기록</th><th>옮길 곳</th></tr></thead>
            <tbody>
              {outside.map(p => {
                const e = r.efforts[p];
                return (
                  <tr class="row"><td><b>{name(p)}</b> <span class="small faint">공수 {e.base ?? '—'}</span></td>
                    <td class="small">{e.done || e.assets ? `진척 ${e.done} · 에셋 ${e.assets}` : <span class="faint">없음</span>}</td>
                    <td><select class={`field${moves[p] === UNPICKED ? ' need' : ''}`} aria-label={`${name(p)} 옮길 곳`} value={moves[p]} onChange={ev => setMoves({ ...moves, [p]: (ev.target as HTMLSelectElement).value })}>
                      <option value={UNPICKED} disabled>옮길 곳을 고르십시오</option>
                      {steps.map(s => <option value={s}>{name(s)}{r.efforts[s] ? ' (이미 거침 · 합침)' : ''}</option>)}
                      <option value="">지우기(기록까지)</option>
                    </select></td></tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div class="dialog-foot"><button type="button" class="btn sm ghost" onClick={props.onClose}>그만두기</button>
          {unpicked.length > 0 && <span class="small warn-text" style="margin-right: auto">옮길 곳을 고르지 않은 파트 {unpicked.length}개</span>}
          <button type="button" class={`btn sm ${lost > 0 ? 'danger' : 'primary'}`} disabled={unpicked.length > 0} onClick={() => void run()}>{lost > 0 ? `기록 ${lost}개 지우고 바꾸기` : '파이프라인 바꾸기'}</button></div>
      </Dialog>
  );
}
