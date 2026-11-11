// 변경 이력: 한 번 수정한 것마다 한 줄, 펼치면 칸별 이전 → 이후, 되돌리기
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { rpc } from '../lib/rpc.ts';
import type { HistoryBatch } from '../../../core/history.ts';
import { IconX } from './icons.tsx';
import { fmtDateTime } from '../lib/format.ts';

const ACTION: Record<string, string> = { UPDATE: '바꿈', INSERT: '더함', DELETE: '지움' };
const show = (v: unknown) => (v === undefined ? '—' : v === null ? '빈칸' : typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v));

export function HistoryPage(props: { version: number; readOnly: boolean; onUndo: (batchId: string, force: boolean) => Promise<{ ok: boolean; needsForce?: boolean }> }) {
  const [data, setData] = useState<{ batches: HistoryBatch[]; total: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; force: boolean } | null>(null);
  useEffect(() => { void rpc.history().then(setData); }, [props.version]);
  if (!data) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  return (
    <div class="page">
      <header class="page-head">
        <div>
          <PageEyebrow page="history" />
          <h1>누가 언제 무엇을 바꿨나</h1>
          <p class="muted" style="margin-top: 6px">한 번 수정한 것마다 한 줄입니다. 되돌리면 이전 값으로 바꾸고, 되돌린 것도 이력에 남습니다.</p>
        </div>
        <span class="small faint">전체 {data.total}개{data.total > data.batches.length ? ` · 최근 ${data.batches.length}개` : ''}</span>
      </header>
      <section class="card">
        <div class="card-body">
          {data.batches.length === 0 && <p class="muted">아직 수정 기록이 없습니다.</p>}
          {data.batches.map(b => (
            <div class={`hist-item${b.undone ? ' undone' : ''}`}>
              <div class="hist-head">
                <button type="button" class="hist-toggle" aria-expanded={open === b.batchId} onClick={() => setOpen(open === b.batchId ? null : b.batchId)}>
                  <span class="num faint small">{b.at ? fmtDateTime(b.at) : ''}</span>
                  <span class="hist-summary">{b.reason && !b.isUndo ? b.reason : b.summary}</span>
                  {b.isUndo && <span class="tag">되돌리기</span>}
                  {b.undone && <span class="tag">되돌림</span>}
                  <span class="small faint">{b.editor} · {b.count}칸</span>
                </button>
                {!props.readOnly && !b.undone && !b.isUndo && (
                  confirm?.id === b.batchId
                    ? <span class="inline">
                      <button type="button" class="btn sm primary" onClick={async () => {
                        const r = await props.onUndo(b.batchId, confirm.force);
                        setConfirm(r.needsForce ? { id: b.batchId, force: true } : null);
                      }}>{confirm.force ? '그래도 되돌리기' : '되돌리기'}</button>
                      <button type="button" class="btn ghost icon-btn" aria-label="그만두기" onClick={() => setConfirm(null)}><IconX /></button>
                    </span>
                    : <button type="button" class="btn sm" onClick={() => setConfirm({ id: b.batchId, force: false })}>되돌리기…</button>
                )}
              </div>
              {open === b.batchId && (
                <div class="table-wrap">
                  <table class="grid hist-table">
                    <thead><tr><th>동작</th><th>대상</th><th>위치</th><th>항목</th><th class="n">이전</th><th class="n">이후</th></tr></thead>
                    <tbody>
                      {b.entries.map(e => (
                        <tr class="row"><td>{ACTION[e.action] ?? e.action}</td><td>{e.target}</td><td class="small">{e.key}</td><td>{e.field ?? '—'}</td>
                          <td class="n num">{show(e.old)}</td><td class="n num">{show(e.next)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
