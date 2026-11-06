// 프로젝트·파트·리소스: 새 프로젝트 마법사에서 입력한 것(기본 정보·파트·인원·가동률·리소스·공수)을 만든 뒤에 고친다.
// AI: 리소스 × 파트마다 "기본(AI 없이)"과 "AI 사용 시" 공수, 파트마다 AI 활용 비율 → 공수 = 기본 × (1 − 비율) + AI × 비율
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { rpc } from '../lib/rpc.ts';
import type { SetupView } from '../../../core/plan.ts';
import type { Edit } from '../../../core/edits.ts';
import { afterCommit } from './commit.ts';
import { IconPlus, IconX } from './icons.tsx';

const WEEK = ['월', '화', '수', '목', '금', '토', '일'];
const pctText = (v: number | null) => (v == null ? '' : String(Math.round(v * 1000) / 10));
const numText = (v: number | null) => (v == null ? '' : String(Math.round(v * 100) / 100));

/** 글자 칸: 칸을 벗어나거나 Enter면 반영, Esc면 되돌림, 거절되면 원래 값 */
export function Field(props: { value: string; label: string; disabled?: boolean; class?: string; placeholder?: string; list?: string; numeric?: boolean; onCommit: (text: string) => unknown }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const reset = () => setText(props.value);
  return <input class={props.class ?? 'field'} aria-label={props.label} value={text} disabled={props.disabled} placeholder={props.placeholder} list={props.list}
    inputMode={props.numeric ? 'decimal' : undefined}
    onInput={e => setText((e.target as HTMLInputElement).value)}
    onBlur={() => { if (text.trim() !== props.value.trim()) afterCommit(props.onCommit(text.trim()), reset); }}
    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { reset(); (e.target as HTMLInputElement).blur(); } }} />;
}

export function SetupPage(props: { version: number; readOnly: boolean; onApply: (e: Edit) => Promise<boolean> }) {
  const [v, setV] = useState<SetupView | null>(null);
  const [newPart, setNewPart] = useState('');
  const [newRes, setNewRes] = useState({ group: '', name: '' });
  const [hol, setHol] = useState({ date: '', name: '', kind: 'COMPANY' as 'PUBLIC' | 'COMPANY' });
  useEffect(() => { void rpc.setup().then(setV); }, [props.version]);
  if (!v) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  const ro = props.readOnly;
  const apply = (e: Edit) => props.onApply(e);
  const num = (t: string) => (t === '' ? null : Number(t.replace(/,/g, '')));
  const activeParts = v.parts.filter(p => p.active);
  const groups = v.groups;
  // 리소스를 분류별로 묶는다(분류 없는 것은 맨 끝)
  const byGroup: { groupId: string | null; name: string; rows: SetupView['resources'] }[] = [];
  for (const r of v.resources) {
    const last = byGroup[byGroup.length - 1];
    if (last && last.groupId === r.groupId) last.rows.push(r); else byGroup.push({ groupId: r.groupId, name: r.groupName || '분류 없음', rows: [r] });
  }
  const fillAll = async (partId: string, field: 'headcount' | 'utilization', value: number) =>
    apply({ kind: 'fillCapacity', partId, fromMonth: v.horizon.start, toMonth: v.horizon.end, field, value });

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <PageEyebrow page="setup" />
          <h1>프로젝트 · 파트 · 리소스</h1>
          <p class="muted" style="margin-top: 6px">새 프로젝트를 만들 때 입력한 것을 여기서 수정합니다. 수정하면 바로 다시 계산되고, 변경 이력에서 되돌릴 수 있습니다.</p>
        </div>
      </header>

      <section class="card" aria-label="프로젝트">
        <div class="card-head"><h2>프로젝트</h2></div>
        <div class="card-body setup-project">
          <label class="form-row"><span class="form-label">프로젝트 이름</span>
            <Field value={v.project.name} label="프로젝트 이름" disabled={ro} onCommit={t => apply({ kind: 'projectName', name: t })} /></label>
          <label class="form-row"><span class="form-label">여유율</span>
            <span class="inline"><Field class="field narrow n" numeric value={pctText(v.project.bufferRate)} label="여유율" disabled={ro} onCommit={t => apply({ kind: 'setting', field: 'buffer_rate', value: (num(t) ?? 0) / 100 })} /><span class="faint">%</span></span></label>
          <div class="form-row"><span class="form-label">근무 요일</span>
            <div class="segmented" role="group" aria-label="근무 요일">
              {WEEK.map((d, i) => {
                const on = v.project.workWeekdays[i] === '1';
                return <button type="button" class={on ? 'on' : ''} aria-pressed={on} disabled={ro}
                  onClick={() => apply({ kind: 'setting', field: 'work_weekdays', value: v.project.workWeekdays.split('').map((c, j) => (j === i ? (on ? '0' : '1') : c)).join('') })}>{d}</button>;
              })}
            </div></div>
          <div class="form-row"><span class="form-label">휴일 {v.project.holidays.length}일</span>
            <div class="chips">
              {v.project.holidays.map(h => (
                <span class="tag" title={h.kind === 'COMPANY' ? '회사 휴무일' : '공휴일'}>{h.date} {h.name}
                  {!ro && <button type="button" class="chip-x" aria-label={`${h.name} ${h.date} 빼기`} onClick={() => void apply({ kind: 'removeHoliday', date: h.date })}><IconX /></button>}</span>
              ))}
            </div>
            {!ro && (
              <div class="inline" style="margin-top: 8px">
                <input class="field" type="date" aria-label="휴일 날짜" value={hol.date} onInput={e => setHol({ ...hol, date: (e.target as HTMLInputElement).value })} />
                <input class="field" placeholder="이름 (예: 창립기념일)" aria-label="휴일 이름" value={hol.name} onInput={e => setHol({ ...hol, name: (e.target as HTMLInputElement).value })} />
                <select class="field" aria-label="휴일 종류" value={hol.kind} onChange={e => setHol({ ...hol, kind: (e.target as HTMLSelectElement).value as 'PUBLIC' | 'COMPANY' })}>
                  <option value="COMPANY">회사 휴무일</option><option value="PUBLIC">공휴일</option>
                </select>
                <button type="button" class="btn sm" disabled={!hol.date || !hol.name.trim()}
                  onClick={async () => { if (await apply({ kind: 'addHoliday', date: hol.date, name: hol.name, holidayKind: hol.kind })) setHol({ date: '', name: '', kind: hol.kind }); }}><IconPlus />휴일 더하기</button>
              </div>
            )}
          </div>
        </div>
      </section>

      <section class="card" aria-label="파트">
        <div class="card-head">
          <div><h2>파트</h2><p class="small muted" style="margin-top: 2px">순서 = 공정 순서입니다. 기본 인원·가동률은 계획 기간({v.horizon.start} ~ {v.horizon.end}) 모든 달에 적용됩니다. 달마다 다르게 하려면 "인력"에서 수정합니다.</p></div>
        </div>
        <div class="card-body" style="padding-top: 8px">
          <div class="table-wrap">
            <table class="grid edit setup-parts">
              <colgroup><col style="width: 80px" /><col /><col class="num-col" /><col class="num-col" /><col class="num-col" /><col style="width: 120px" /><col style="width: 64px" /><col style="width: 48px" /></colgroup>
              <thead><tr><th>순서</th><th>이름</th><th class="n">기본 인원 <span class="unit">명</span></th><th class="n">기본 가동률 <span class="unit">%</span></th><th class="n" title="이 파트 작업 중 AI 사용 시 공수로 계산하는 비율">AI 활용 <span class="unit">%</span></th><th class="n">거치는 리소스</th><th class="c">사용</th><th aria-label="행 작업" /></tr></thead>
              <tbody>
                {v.parts.map((p, i) => (
                  <tr class={`row${p.active ? '' : ' muted-row'}`}>
                    <td><span class="prio">
                      <button type="button" class="btn ghost icon-btn" aria-label={`${p.name} 앞으로`} disabled={ro || i === 0} onClick={() => void apply({ kind: 'movePart', partId: p.partId, direction: -1 })}>↑</button>
                      <button type="button" class="btn ghost icon-btn" aria-label={`${p.name} 뒤로`} disabled={ro || i === v.parts.length - 1} onClick={() => void apply({ kind: 'movePart', partId: p.partId, direction: 1 })}>↓</button>
                    </span></td>
                    <td><Field value={p.name} label={`${p.name} 파트 이름`} disabled={ro} onCommit={t => apply({ kind: 'renamePart', partId: p.partId, name: t })} /></td>
                    <td class="n"><Field class="field n num-in" numeric value={numText(p.headcount)} label={`${p.name} 기본 인원`} disabled={ro || !p.active}
                      onCommit={t => (num(t) == null || num(t)! < 0 ? false : fillAll(p.partId, 'headcount', num(t)!))} /></td>
                    <td class="n"><Field class="field n num-in" numeric value={pctText(p.utilization)} label={`${p.name} 기본 가동률`} disabled={ro || !p.active}
                      onCommit={t => (num(t) == null || num(t)! < 0 || num(t)! > 100 ? false : fillAll(p.partId, 'utilization', num(t)! / 100))} /></td>
                    <td class="n"><Field class="field n num-in" numeric value={pctText(p.aiShare)} label={`${p.name} AI 활용 비율`} disabled={ro || !p.active}
                      onCommit={t => apply({ kind: 'aiShare', partId: p.partId, share: (num(t) ?? 0) / 100 })} /></td>
                    <td class="n num faint">{p.usedBy}종</td>
                    <td class="c"><label class="check"><input type="checkbox" aria-label={`${p.name} 사용`} checked={p.active} disabled={ro} onChange={() => void apply({ kind: 'partActive', partId: p.partId, active: !p.active })} /></label></td>
                    <td class="n">{!ro && <button type="button" class="btn ghost icon-btn" aria-label={`${p.name} 파트 지우기`} disabled={p.usedBy > 0 || p.hasProgress}
                      title={p.usedBy > 0 ? `리소스 ${p.usedBy}종이 거칩니다. 공수에서 이 파트를 제외해야 삭제할 수 있습니다` : p.hasProgress ? '작업 진척 기록이 있습니다' : '지우기'}
                      onClick={() => void apply({ kind: 'deletePart', partId: p.partId })}><IconX /></button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!ro && (
            <div class="inline" style="margin-top: 10px">
              <input class="field" placeholder="새 파트 이름 (예: 리깅)" aria-label="새 파트 이름" value={newPart} onInput={e => setNewPart((e.target as HTMLInputElement).value)} />
              <button type="button" class="btn sm" disabled={!newPart.trim()} onClick={async () => { if (await apply({ kind: 'createPart', name: newPart })) setNewPart(''); }}><IconPlus />파트 더하기</button>
              <span class="small faint">새 파트는 맨 뒤 공정, 인원 0명으로 들어갑니다.</span>
            </div>
          )}
        </div>
      </section>

      <section class="card" aria-label="리소스">
        <div class="card-head">
          <div><h2>리소스 · 1개당 공수(인·일)</h2>
            <p class="small muted" style="margin-top: 2px">파트마다 <b>기본</b>(AI 없이)과 <b>AI</b>(AI 사용 시) 공수를 입력합니다. 기본을 비우면 그 파트를 거치지 않고, AI를 비우면 기본과 같은 값으로 간주합니다. 계산 공수 = 기본 × (1 − AI 활용 비율) + AI × 비율.</p></div>
        </div>
        <div class="card-body" style="padding-top: 8px">
          <datalist id="setup-groups">{groups.map(g => <option value={g.name} />)}</datalist>
          <div class="table-wrap">
            <table class="grid edit setup-res">
              <colgroup><col style="width: 200px" />{activeParts.map(() => <><col class="eff-col" /><col class="eff-col" /></>)}<col style="width: 64px" /><col style="width: 150px" /><col style="width: 48px" /></colgroup>
              <thead>
                <tr>
                  <th rowSpan={2}>리소스</th>
                  {activeParts.map(p => <th colSpan={2} class="part-th">{p.name}</th>)}
                  <th rowSpan={2} class="c">사용</th>
                  <th rowSpan={2} title="다른 분류로 옮길 때 변경합니다">분류 이동</th>
                  <th rowSpan={2} aria-label="행 작업" />
                </tr>
                <tr>{activeParts.map(() => <><th class="n sub-th">기본</th><th class="n sub-th ai-th">AI</th></>)}</tr>
              </thead>
              <tbody>
                {byGroup.map(g => (
                  <>
                    <tr class="group group-strong"><td colSpan={activeParts.length * 2 + 4}>
                      <span class="group-head">
                        {g.groupId && !ro
                          ? <Field class="field group-name" value={g.name} label={`분류 ${g.name} 이름`} onCommit={t => apply({ kind: 'renameGroup', groupId: g.groupId!, name: t })} />
                          : <b>{g.name}</b>}
                        <span class="group-count">{g.rows.length}종</span>
                      </span>
                    </td></tr>
                    {g.rows.map(r => (
                      <tr class={`row in-group${r.active ? '' : ' muted-row'}`}>
                        <td><Field value={r.name} label={`${r.name} 리소스 이름`} disabled={ro} onCommit={t => apply({ kind: 'renameResource', resourceTypeId: r.resourceTypeId, name: t })} /></td>
                        {activeParts.map(p => {
                          const e = r.efforts[p.partId];
                          return (
                            <>
                              <td class="n eff-base"><Field class="field n num-in" numeric value={numText(e?.base ?? null)} placeholder="—" label={`${r.name} ${p.name} 기본 공수`} disabled={ro}
                                onCommit={t => apply({ kind: 'effort', resourceTypeId: r.resourceTypeId, partId: p.partId, profileId: 'BASE', days: num(t) })} /></td>
                              <td class="n eff-ai"><Field class="field n num-in ai" numeric value={numText(e?.ai ?? null)} placeholder={e ? '=기본' : ''} label={`${r.name} ${p.name} AI 공수`} disabled={ro || !e}
                                onCommit={t => apply({ kind: 'effort', resourceTypeId: r.resourceTypeId, partId: p.partId, profileId: 'AI', days: num(t) })} /></td>
                            </>
                          );
                        })}
                        <td class="c"><label class="check"><input type="checkbox" aria-label={`${r.name} 사용`} checked={r.active} disabled={ro} onChange={() => void apply({ kind: 'resourceActive', resourceTypeId: r.resourceTypeId, active: !r.active })} /></label></td>
                        <td><Field class="field ghost-field" value={r.groupName} label={`${r.name} 분류`} list="setup-groups" disabled={ro} placeholder="분류 없음" onCommit={t => apply({ kind: 'resourceGroup', resourceTypeId: r.resourceTypeId, groupName: t })} /></td>
                        <td class="n">{!ro && <button type="button" class="btn ghost icon-btn" aria-label={`${r.name} 리소스 지우기`} disabled={r.used}
                          title={r.used ? '물량·유형 템플릿·작업 진척에 사용됩니다. 사용 안 함으로 두거나 그곳에서 먼저 제외하십시오' : '지우기'}
                          onClick={() => void apply({ kind: 'deleteResource', resourceTypeId: r.resourceTypeId })}><IconX /></button>}</td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>
          {!ro && (
            <div class="inline" style="margin-top: 10px">
              <input class="field" list="setup-groups" placeholder="분류 (예: 캐릭터)" aria-label="새 리소스 분류" value={newRes.group} onInput={e => setNewRes({ ...newRes, group: (e.target as HTMLInputElement).value })} />
              <input class="field" placeholder="새 리소스 이름 (예: 탈것)" aria-label="새 리소스 이름" value={newRes.name} onInput={e => setNewRes({ ...newRes, name: (e.target as HTMLInputElement).value })} />
              <button type="button" class="btn sm" disabled={!newRes.name.trim()} onClick={async () => { if (await apply({ kind: 'createResource', name: newRes.name, groupName: newRes.group })) setNewRes({ group: newRes.group, name: '' }); }}><IconPlus />리소스 더하기</button>
              <span class="small faint">더한 뒤 파트별 기본 공수를 넣어야 계산에 들어갑니다.</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
