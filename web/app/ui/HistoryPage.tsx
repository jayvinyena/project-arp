// 변경 이력: 날짜별로 나누고, 같은 사람이 잇달아 한 같은 종류의 수정은 한 줄로 묶는다(펼쳐서 하나씩 되돌리기).
// 분류(기준 정보 · 인력 · 물량 · 에셋 …)와 찾기로 거른다. 줄을 펼치면 칸별 이전 → 이후.
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { rpc } from '../lib/rpc.ts';
import type { HistoryBatch, HistoryArea } from '../../../core/history.ts';
import { IconX } from './icons.tsx';
import { localToday } from '../lib/format.ts';

const ACTION: Record<string, string> = { UPDATE: '바꿈', INSERT: '더함', DELETE: '지움' };
const AREA: Record<HistoryArea, string> = {
  setup: '기준 정보', capacity: '인력', plan: '물량 · 계획', progress: '작업 진척', assets: '에셋', scenario: '시나리오', news: '소식', other: '그 밖',
};
const AREA_ORDER: HistoryArea[] = ['setup', 'capacity', 'plan', 'progress', 'assets', 'scenario', 'news', 'other'];
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

/** 기록 시각 → 이 컴퓨터 날짜 · 시각 */
const local = (at: string) => {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return { day: '', time: '' };
  const p = (n: number) => String(n).padStart(2, '0');
  return { day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
};
const dayLabel = (day: string) => {
  const today = localToday();
  const y = new Date(Date.parse(`${today}T00:00:00`) - 86400000);
  const yday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  const d = new Date(`${day}T00:00:00`);
  const base = `${d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}년 `}${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;
  return day === today ? `오늘 · ${base}` : day === yday ? `어제 · ${base}` : base;
};
const who = (e: string) => (e && e !== '이름 없음' ? e : '');
const title = (b: HistoryBatch) => (b.reason && !b.isUndo ? b.reason : b.summary);
/** 되돌리기 줄은 요약 앞에 "되돌림:"을 붙이지 않고 알약으로 구분한다 */

/** 잇달아 한 같은 수정(같은 날 · 사람 · 분류 · 요약, 되돌리기 아님)은 한 묶음 */
interface Run { key: string; items: HistoryBatch[] }
function runsOf(list: HistoryBatch[]): Run[] {
  const out: Run[] = [];
  for (const b of list) {
    const last = out[out.length - 1]?.items[0];
    const same = last && !b.isUndo && !last.isUndo && last.undone === b.undone && local(last.at).day === local(b.at).day && last.editor === b.editor && last.area === b.area && title(last) === title(b);
    if (same) out[out.length - 1].items.push(b);
    else out.push({ key: b.batchId, items: [b] });
  }
  return out;
}

export function HistoryPage(props: { version: number; readOnly: boolean; onUndo: (batchId: string, force: boolean) => Promise<{ ok: boolean; needsForce?: boolean }> }) {
  const [data, setData] = useState<{ batches: HistoryBatch[]; total: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; force: boolean } | null>(null);
  const [area, setArea] = useState<HistoryArea | 'all'>('all');
  const [q, setQ] = useState('');
  // 묶은 줄 모두 되돌리기: 확인 중인 묶음 · 진행 중
  const [runConfirm, setRunConfirm] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const undoRun = async (r: Run) => {
    setRunBusy(true);
    try {
      // 최근 것부터(나중 수정이 앞 수정 위에 있으므로)
      for (const b of r.items.filter(x => !x.undone)) {
        const res = await props.onUndo(b.batchId, false);
        if (!res.ok) { if (res.needsForce) { setOpenRun(r.key); setConfirm({ id: b.batchId, force: true }); } break; }
      }
    } finally { setRunBusy(false); setRunConfirm(null); }
  };
  useEffect(() => { void rpc.history().then(setData); }, [props.version]);
  if (!data) return <div class="page"><p class="muted">불러오는 중…</p></div>;

  const count = (a: HistoryArea) => data.batches.filter(b => b.area === a).length;
  const needle = q.trim().toLowerCase();
  const shown = data.batches.filter(b => (area === 'all' || b.area === area)
    && (!needle || [title(b), b.subject, b.change ?? '', b.editor].some(t => t.toLowerCase().includes(needle))));
  const days: { day: string; runs: Run[] }[] = [];
  for (const r of runsOf(shown)) {
    const d = local(r.items[0].at).day;
    if (days[days.length - 1]?.day !== d) days.push({ day: d, runs: [] });
    days[days.length - 1].runs.push(r);
  }

  const undoBtn = (b: HistoryBatch) => !props.readOnly && !b.undone && !b.isUndo && (
    confirm?.id === b.batchId
      ? <span class="inline hist-undo">
        <button type="button" class="btn sm primary" onClick={async () => {
          const r = await props.onUndo(b.batchId, confirm.force);
          setConfirm(r.needsForce ? { id: b.batchId, force: true } : null);
        }}>{confirm.force ? '그래도 되돌리기' : '되돌리기'}</button>
        <button type="button" class="btn ghost icon-btn" aria-label="그만두기" onClick={() => setConfirm(null)}><IconX /></button>
        {confirm.force && <span class="small warn-text hist-force">이 뒤에 같은 칸을 다시 고친 기록이 있습니다. 되돌리면 그 수정도 사라집니다.</span>}
      </span>
      : <button type="button" class="btn sm hist-undo" onClick={() => setConfirm({ id: b.batchId, force: false })}>되돌리기…</button>
  );
  const entries = (b: HistoryBatch) => open === b.batchId && (
    <div class="table-wrap hist-detail">
      <table class="grid hist-table">
        <thead><tr><th>동작</th><th>대상</th><th>위치</th><th>항목</th><th>이전</th><th>이후</th></tr></thead>
        <tbody>
          {b.entries.map(e => (
            <tr class="row"><td>{ACTION[e.action] ?? e.action}</td><td>{e.targetName}</td><td class="small">{e.where}</td><td>{e.fieldName}</td>
              <td class="hist-val">{e.oldText}</td><td class="hist-val">{e.nextText}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  // 한 줄: 시각 · 분류 · 무엇을 했나 · 대상 · 바뀐 값 · 누가
  const line = (b: HistoryBatch, sub = false) => (
    <div class={`hist-item${b.undone ? ' undone' : ''}${sub ? ' sub' : ''}`}>
      <div class="hist-head">
        <button type="button" class="hist-toggle" aria-expanded={open === b.batchId} title="눌러서 칸별 이전 → 이후 보기" onClick={() => setOpen(open === b.batchId ? null : b.batchId)}>
          <span class="num faint small hist-time">{local(b.at).time}</span>
          {!sub && <span class={`tag hist-area a-${b.area}`}>{AREA[b.area]}</span>}
          <span class="hist-main">
            <span class="hist-summary">{title(b)}</span>
            {b.isUndo && <span class="tag">되돌리기</span>}
            {b.undone && <span class="tag">되돌림</span>}
            <span class="hist-subject small">{b.subject}{b.change ? <span class="faint"> · {b.change}</span> : ''}</span>
          </span>
          <span class="small faint hist-who">{who(b.editor)}{b.count > 1 ? `${who(b.editor) ? ' · ' : ''}${b.count}칸` : ''}</span>
        </button>
        {undoBtn(b)}
      </div>
      {entries(b)}
    </div>
  );

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <PageEyebrow page="history" />
          <h1>누가 언제 무엇을 바꿨나</h1>
          <p class="muted" style="margin-top: 6px">날짜별로, 잇달아 한 같은 수정은 한 줄로 묶어 보입니다. 줄을 누르면 칸별 이전 → 이후, 되돌리면 이전 값으로 바꾸고 되돌린 것도 이력에 남습니다.</p>
        </div>
        <span class="small faint">전체 {data.total}개{data.total > data.batches.length ? ` · 최근 ${data.batches.length}개` : ''}</span>
      </header>
      <section class="card">
        <div class="card-head hist-tools">
          <div class="chip-row" role="group" aria-label="분류">
            <button type="button" class={`chip${area === 'all' ? ' on' : ''}`} aria-pressed={area === 'all'} onClick={() => setArea('all')}>전체 <span class="chip-n">{data.batches.length}</span></button>
            {AREA_ORDER.filter(a => count(a) > 0).map(a => (
              <button type="button" class={`chip${area === a ? ' on' : ''}`} aria-pressed={area === a} onClick={() => setArea(area === a ? 'all' : a)}>{AREA[a]} <span class="chip-n">{count(a)}</span></button>
            ))}
          </div>
          <input class="field hist-search" type="search" aria-label="이력 찾기" placeholder="찾기(이름 · 항목 · 사람)" value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />
        </div>
        <div class="card-body">
          {data.batches.length === 0 && <p class="muted">아직 수정 기록이 없습니다.</p>}
          {data.batches.length > 0 && shown.length === 0 && <p class="muted">맞는 기록이 없습니다.</p>}
          {days.map(d => (
            <div class="hist-day">
              <h3 class="hist-day-h">{dayLabel(d.day)} <span class="small faint">{d.runs.reduce((n, r) => n + r.items.length, 0)}건</span></h3>
              {d.runs.map(r => r.items.length === 1 ? line(r.items[0]) : (
                <div class="hist-run">
                  <div class={`hist-item${r.items.every(b => b.undone) ? ' undone' : ''}`}>
                    <div class="hist-head">
                      <button type="button" class="hist-toggle" aria-expanded={openRun === r.key} onClick={() => setOpenRun(openRun === r.key ? null : r.key)}>
                        <span class="num faint small hist-time">{(() => { const a = local(r.items[r.items.length - 1].at).time; const z = local(r.items[0].at).time; return a === z ? z : `${a}~${z}`; })()}</span>
                        <span class={`tag hist-area a-${r.items[0].area}`}>{AREA[r.items[0].area]}</span>
                        <span class="hist-main">
                          <span class="hist-summary">{title(r.items[0])} <span class="hist-times">× {r.items.length}</span></span>
                          {r.items.every(b => b.undone) && <span class="tag">되돌림</span>}
                          <span class="hist-subject small">{(() => { const s = [...new Set(r.items.map(b => b.subject).filter(Boolean))]; return s.length > 4 ? `${s.slice(0, 4).join(' · ')} 외 ${s.length - 4}` : s.join(' · '); })()}</span>
                        </span>
                        <span class="small faint hist-who">{who(r.items[0].editor)}</span>
                      </button>
                      {!props.readOnly && r.items.some(b => !b.undone) && (runConfirm === r.key
                        ? <span class="inline hist-undo">
                          <button type="button" class="btn sm primary" disabled={runBusy} onClick={() => void undoRun(r)}>{runBusy ? '되돌리는 중…' : `${r.items.filter(b => !b.undone).length}건 모두 되돌리기`}</button>
                          <button type="button" class="btn ghost icon-btn" aria-label="그만두기" disabled={runBusy} onClick={() => setRunConfirm(null)}><IconX /></button>
                        </span>
                        : <button type="button" class="btn sm hist-undo" onClick={() => setRunConfirm(r.key)}>모두 되돌리기…</button>)}
                      <button type="button" class="btn sm ghost hist-run-open" aria-expanded={openRun === r.key} onClick={() => setOpenRun(openRun === r.key ? null : r.key)}>{openRun === r.key ? '접기' : `${r.items.length}건 펼치기`}</button>
                    </div>
                  </div>
                  {openRun === r.key && <div class="hist-run-items">{r.items.map(b => line(b, true))}</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
