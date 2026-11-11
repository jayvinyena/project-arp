// 업데이트 띠(docs/36): 업데이트를 쓰는 화면(현황판 · 에셋 · 작업 진척) 맨 위에 같은 모양.
// 진행 중 · 예정 업데이트를 탭으로(판정 기호와 함께), 완료 · 취소는 따로 고르기, 오른쪽에 고른 업데이트의 출시 · 완료 예정 · 판정.
import { useState, useEffect, useRef } from 'preact/hooks';
import { rpc } from '../lib/rpc.ts';
import type { PlanView } from '../../../core/plan.ts';
import type { PlanMode } from '../../../engine/types.ts';
import { UPDATE_STATUS } from '../lib/terms.ts';
import { fmtShortDate } from '../lib/format.ts';

export interface UpdateOption { updateId: string; name: string; live: boolean }

export function UpdateBar(props: { updates: UpdateOption[]; value: string | null; onChange: (id: string) => void; planMode: PlanMode; version: number }) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { let alive = true; void rpc.plan(props.planMode).then(p => { if (alive) setPlan(p); }).catch(() => {}); return () => { alive = false; }; }, [props.version, props.planMode]);
  // 좁은 화면: 고른 탭을 가운데로
  useEffect(() => {
    const box = tabsRef.current; const el = box?.querySelector<HTMLElement>('.update-tab.on');
    if (!box || !el || box.scrollWidth <= box.clientWidth + 1) return;
    const b = box.getBoundingClientRect(); const r = el.getBoundingClientRect();
    box.scrollLeft += (r.left - b.left) - (b.width - r.width) / 2;
  }, [props.value, plan != null]);
  const row = (id: string | null) => (id ? plan?.rows.find(r => r.updateId === id) ?? null : null);
  const live = props.updates.filter(u => u.live);
  const rest = props.updates.filter(u => !u.live);
  const pickedRest = rest.find(u => u.updateId === props.value);
  const cur = row(props.value);
  const st = cur?.result ? UPDATE_STATUS[cur.result.status] : null;
  const tab = (u: UpdateOption) => {
    const r = row(u.updateId); const s = r?.result ? UPDATE_STATUS[r.result.status] : null;
    const on = u.updateId === props.value;
    return (
      <button type="button" role="tab" aria-selected={on} data-id={u.updateId} class={`update-tab${on ? ' on' : ''}${u.live ? '' : ' done'}`}
        title={s ? `${u.name}: ${s.text}` : u.name} onClick={() => props.onChange(u.updateId)}>
        <span class="update-tab-name">{u.name}</span>
        {s && <span class={`v-ic ${s.tone}`} aria-label={s.text}>{s.icon}</span>}
      </button>
    );
  };
  if (!props.updates.length) return null;
  return (
    <div class="update-bar" role="group" aria-label="지금 업데이트">
      <span class="update-bar-h" title="에셋 · 작업 진척 · 현황판 · 시뮬레이션이 같은 업데이트로 열립니다">업데이트</span>
      <div class="update-tabs" role="tablist" aria-label="업데이트 고르기" ref={tabsRef}>
        {live.map(tab)}
        {pickedRest && tab(pickedRest)}
      </div>
      {rest.length > 0 && (
        <select class="field update-more" aria-label="완료 · 취소된 업데이트" value={pickedRest ? pickedRest.updateId : ''} onChange={e => { const id = (e.target as HTMLSelectElement).value; if (id) props.onChange(id); }}>
          <option value="">완료 · 취소 {rest.length}개</option>
          {rest.map(u => <option value={u.updateId}>{u.name}</option>)}
        </select>
      )}
      <dl class="kv-row update-facts">
        <div><dt>출시</dt><dd>{cur?.releaseDate ? fmtShortDate(cur.releaseDate) : '—'}</dd></div>
        <div><dt>완료 예정</dt><dd>{cur?.result ? (cur.result.completion ? fmtShortDate(cur.result.completion) : '기간 밖') : '—'}</dd></div>
        <div><dt>판정</dt><dd>{st ? <span class={`pill ${st.tone}`} data-icon={st.icon}>{st.text}</span> : <span class="faint">{cur && !cur.live ? '계산 밖' : '—'}</span>}</dd></div>
      </dl>
    </div>
  );
}

/** 제목 뒤 업데이트 이름: "제작 현황판 · 런칭" */
export const updateName = (updates: UpdateOption[], id: string | null) => updates.find(u => u.updateId === id)?.name ?? null;
