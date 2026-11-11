// 프로젝트·파트·리소스: 새 프로젝트 마법사에서 입력한 것(기본 정보·파트·인원·가동률·리소스·공수)을 만든 뒤에 고친다.
// AI: 리소스 × 파트마다 "기본(AI 없이)"과 "AI 사용 시" 공수, 파트마다 AI 활용 비율 → 공수 = 기본 × (1 − 비율) + AI × 비율
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { PipelineSection } from './PipelineSection.tsx';
import { MoveDialog } from './MoveDialog.tsx';
import type { MoveRequest, PipelineRequest } from './MoveDialog.tsx';
import { useReorder, Grip } from './reorder.tsx';
import type { JSX } from 'preact';
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

/** 파트 표 줄: 손잡이(⠿)나 줄을 길게 눌러 끌어 순서를 바꾼다(docs/27 4.3) */
function PartRows(props: { v: SetupView; ro: boolean; apply: (e: Edit) => Promise<boolean>; children: (p: SetupView['parts'][number]) => JSX.Element }) {
  const ids = props.v.parts.map(p => p.partId);
  const r = useReorder(ids, next => props.apply({ kind: 'reorderParts', partIds: next }), { disabled: props.ro });
  return (
    <tbody data-reorder-box="">
      {props.v.parts.map(p => (
        <tr class={`row${p.active ? '' : ' muted-row'} ${r.cls(p.partId)}`} {...r.item(p.partId)}>
          <td class="c">{!props.ro && <button {...r.handle(p.partId, p.name)}><Grip /></button>}</td>
          {props.children(p)}
        </tr>
      ))}
    </tbody>
  );
}

export function SetupPage(props: { version: number; readOnly: boolean; onApply: (e: Edit) => Promise<boolean> }) {
  const [v, setV] = useState<SetupView | null>(null);
  const [newPart, setNewPart] = useState('');
  const [newRes, setNewRes] = useState({ group: '', name: '', pipe: '' });
  const [hol, setHol] = useState({ date: '', name: '', kind: 'COMPANY' as 'PUBLIC' | 'COMPANY' });
  const [moveReq, setMoveReq] = useState<MoveRequest | PipelineRequest | null>(null);
  /** 리소스 지우기: 쓰이는 곳이 있으면 무엇이 함께 지워지는지 보여 주고 고르게 한다 */
  const [delRes, setDelRes] = useState<SetupView['resources'][number] | null>(null);
  useEffect(() => { void rpc.setup().then(setV); }, [props.version]);
  if (!v) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  const ro = props.readOnly;
  const apply = (e: Edit) => props.onApply(e);
  const num = (t: string) => (t === '' ? null : Number(t.replace(/,/g, '')));
  const activeParts = v.parts.filter(p => p.active);
  // 파이프라인 고르기 폭 = 가장 긴 이름이 다 보이게(글자 폭을 재서). 표가 좁아져도 칸이 줄지 않게 고르기에 최소 폭을 준다
  const pipeSelW = pipeWidth(v.pipelines.map(pl => pl.name));
  const pipeColW = pipeSelW + 17;
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
          <label class="form-row"><span class="form-label">Jira 주소</span>
            <Field value={v.project.jiraBase ?? ''} label="Jira 주소" placeholder="https://회사.atlassian.net/browse/" disabled={ro} onCommit={t => apply({ kind: 'jiraBase', url: t })} />
            <span class="form-help">에셋의 Jira 키(ABC-123)를 이 주소 뒤에 붙여 이슈를 엽니다.</span></label>
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
          <div><h2>파트</h2><p class="small muted" style="margin-top: 2px">제작 팀(공정) 목록입니다. 순서는 화면에 보이는 순서이고, 공정 순서는 아래 "공정 순서 · 파이프라인"에서 정합니다. 왼쪽 손잡이(⠿)나 줄을 길게 눌러 끌면 순서가 바뀝니다. 기본 인원·가동률은 계획 기간({v.horizon.start} ~ {v.horizon.end}) 모든 달에 적용됩니다. 달마다 다르게 하려면 "인력"에서 수정합니다.</p></div>
        </div>
        <div class="card-body" style="padding-top: 8px">
          <div class="table-wrap ref-wrap">
            <table class="grid edit ref setup-parts">
              <colgroup><col style="width: 44px" /><col /><col class="num-col" /><col class="num-col" /><col class="num-col" /><col style="width: 200px" /><col style="width: 110px" /><col style="width: 64px" /><col style="width: 48px" /></colgroup>
              <thead><tr><th aria-label="순서" /><th>이름</th><th class="n">기본 인원 <span class="unit">명</span></th><th class="n">기본 가동률 <span class="unit">%</span></th><th class="n" title="이 파트 작업 중 AI 사용 시 공수로 계산하는 비율">AI 활용 <span class="unit">%</span></th><th title="이 파트를 단계로 쓰는 파이프라인">파이프라인</th><th class="n">거치는 리소스</th><th class="c">사용</th><th aria-label="행 작업" /></tr></thead>
              <PartRows v={v} ro={ro} apply={apply}>{p => (
                  <>
                    <td><Field value={p.name} label={`${p.name} 파트 이름`} disabled={ro} onCommit={t => apply({ kind: 'renamePart', partId: p.partId, name: t })} /></td>
                    <td class="n"><Field class="field n num-in" numeric value={numText(p.headcount)} label={`${p.name} 기본 인원`} disabled={ro || !p.active}
                      onCommit={t => (num(t) == null || num(t)! < 0 ? false : fillAll(p.partId, 'headcount', num(t)!))} /></td>
                    <td class="n"><Field class="field n num-in" numeric value={pctText(p.utilization)} label={`${p.name} 기본 가동률`} disabled={ro || !p.active}
                      onCommit={t => (num(t) == null || num(t)! < 0 || num(t)! > 100 ? false : fillAll(p.partId, 'utilization', num(t)! / 100))} /></td>
                    <td class="n"><Field class="field n num-in" numeric value={pctText(p.aiShare)} label={`${p.name} AI 활용 비율`} disabled={ro || !p.active}
                      onCommit={t => apply({ kind: 'aiShare', partId: p.partId, share: (num(t) ?? 0) / 100 })} /></td>
                    <td class="part-pipes">{(() => {
                      const names = v.pipelines.filter(pl => pl.steps.some(st => st.partId === p.partId)).map(pl => pl.name);
                      return names.length ? <span class="small">{names.join(' · ')}</span> : <span class={`small ${p.active ? 'warn-text' : 'faint'}`} title="어느 파이프라인에도 없어 이 파트로 일이 가지 않습니다. 공정 순서 · 파이프라인에서 단계로 더하십시오">파이프라인 없음</span>;
                    })()}</td>
                    <td class="n num faint">{p.usedBy}종</td>
                    <td class="c"><label class="check"><input type="checkbox" aria-label={`${p.name} 사용`} checked={p.active} disabled={ro} onChange={() => void apply({ kind: 'partActive', partId: p.partId, active: !p.active })} /></label></td>
                    <td class="n">{!ro && <button type="button" class="btn ghost icon-btn" aria-label={`${p.name} 파트 지우기`} disabled={p.usedBy > 0 || p.hasProgress}
                      title={p.usedBy > 0 ? `리소스 ${p.usedBy}종이 거칩니다. 공수에서 이 파트를 제외해야 삭제할 수 있습니다` : p.hasProgress ? '작업 진척 기록이 있습니다' : '지우기'}
                      onClick={() => void apply({ kind: 'deletePart', partId: p.partId })}><IconX /></button>}</td>
                  </>
                )}</PartRows>
            </table>
          </div>
          {!ro && (
            <div class="inline" style="margin-top: 10px">
              <input class="field" placeholder="새 파트 이름 (예: 리깅)" aria-label="새 파트 이름" value={newPart} onInput={e => setNewPart((e.target as HTMLInputElement).value)} />
              <button type="button" class="btn sm" disabled={!newPart.trim()} onClick={async () => { if (await apply({ kind: 'createPart', name: newPart })) setNewPart(''); }}><IconPlus />파트 더하기</button>
              <span class="small faint">새 파트는 목록에만 들어갑니다(인원 0명, 어느 파이프라인에도 없음). 파이프라인에 단계로 더하고 인력에서 인원을 넣어야 일이 계산됩니다.</span>
            </div>
          )}
        </div>
      </section>

      <PipelineSection v={v} readOnly={ro} apply={apply} />

      <section class="card" aria-label="리소스">
        <div class="card-head">
          <div><h2>리소스 · 1개당 공수(인·일)</h2>
            <p class="small muted" style="margin-top: 2px">파트마다 <b>기본</b>(AI 없이)과 <b>AI</b>(AI 사용 시) 공수를 입력합니다. 기본을 비우면 그 파트를 거치지 않고, AI를 비우면 기본과 같은 값(흐린 숫자)으로 계산합니다. 작업 기록이 있는 칸을 비우거나 칸의 → 를 누르면 다른 파트로 옮길 수 있습니다. 파이프라인을 고르면 그 단계의 칸만 입력합니다.</p></div>
        </div>
        <div class="card-body" style="padding-top: 8px">
          <datalist id="setup-groups">{groups.map(g => <option value={g.name} />)}</datalist>
          <div class="table-wrap ref-wrap">
            <table class="grid edit ref setup-res">
              <colgroup><col style="width: 200px" /><col style={`width: ${pipeColW}px`} />{activeParts.map(() => <><col class="eff-col" /><col class="eff-col" /></>)}<col style="width: 64px" /><col style="width: 150px" /><col style="width: 48px" /></colgroup>
              <thead>
                <tr>
                  <th rowSpan={2}>리소스</th>
                  <th rowSpan={2} title="이 리소스의 공정 순서. 기준 정보 › 공정 순서 · 파이프라인에서 만듭니다">파이프라인</th>
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
                    <tr class="group group-strong"><td colSpan={activeParts.length * 2 + 5}>
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
                        <td><select class="field ghost-field pipe-select" aria-label={`${r.name} 파이프라인`} title={v.pipelines.find(pl => pl.pipelineId === r.pipelineId)?.name} style={`min-width: ${pipeSelW}px`} value={r.pipelineId ?? ''} disabled={ro}
                          onChange={ev => {
                            const pid = (ev.target as HTMLSelectElement).value || null;
                            const pl = pid ? v.pipelines.find(x => x.pipelineId === pid) : null;
                            const outside = pl ? Object.keys(r.efforts).filter(k => !pl.steps.some(st => st.partId === k)) : [];
                            if (pl && outside.length) { (ev.target as HTMLSelectElement).value = r.pipelineId ?? ''; setMoveReq({ kind: 'pipeline', resourceTypeId: r.resourceTypeId, pipelineId: pl.pipelineId }); }
                            else void apply({ kind: 'resourcePipeline', resourceTypeIds: [r.resourceTypeId], pipelineId: pid });
                          }}>
                          {!v.pipelines.some(pl => pl.pipelineId === r.pipelineId) && <option value="" disabled>고르지 않음</option>}
                          {v.pipelines.map(pl => <option value={pl.pipelineId} disabled={pl.steps.length === 0}>{pl.name}</option>)}
                        </select></td>
                        {activeParts.map(p => {
                          const e = r.efforts[p.partId];
                          const pl = r.pipelineId ? v.pipelines.find(x => x.pipelineId === r.pipelineId) : null;
                          const outside = !!pl && !pl.steps.some(st => st.partId === p.partId);
                          if (outside && !e) {
                            return <><td class="n eff-base eff-off" title={`${pl!.name} 파이프라인의 단계가 아닙니다`}><span aria-label={`${r.name} ${p.name} 파이프라인 밖`}>·</span></td><td class="n eff-ai eff-off" /></>;
                          }
                          const records = !!e && (e.done > 0 || e.assets > 0);
                          return (
                            <>
                              <td class={`n eff-base${outside ? ' eff-warn' : ''}`} title={outside ? '파이프라인 밖 파트에 공수가 있습니다(맨 뒤에 계산). → 로 옮기십시오' : undefined}>
                                <Field class="field n num-in" numeric value={numText(e?.base ?? null)} placeholder="—" label={`${r.name} ${p.name} 기본 공수`} disabled={ro}
                                  onCommit={t => {
                                    // 기록이 있는 칸을 비우면 옮기기 · 지우기 창(바로 거절하지 않는다)
                                    if (num(t) == null && records) { setMoveReq({ kind: 'cell', resourceTypeId: r.resourceTypeId, partId: p.partId }); return false; }
                                    return apply({ kind: 'effort', resourceTypeId: r.resourceTypeId, partId: p.partId, profileId: 'BASE', days: num(t) });
                                  }} />
                                {e && !ro && <button type="button" class="eff-move" aria-label={`${r.name} ${p.name} 다른 파트로 옮기기`} title={`다른 파트로 옮기기${records ? `(작업 진척 ${e.done} · 에셋 ${e.assets} 함께)` : ''}`}
                                  onClick={() => setMoveReq({ kind: 'cell', resourceTypeId: r.resourceTypeId, partId: p.partId })}>→</button>}
                              </td>
                              <td class="n eff-ai"><Field class="field n num-in ai" numeric value={numText(e?.ai ?? null)} placeholder={e ? numText(e.base) : ''} label={`${r.name} ${p.name} AI 공수`} disabled={ro || !e}
                                onCommit={t => apply({ kind: 'effort', resourceTypeId: r.resourceTypeId, partId: p.partId, profileId: 'AI', days: num(t) })} /></td>
                            </>
                          );
                        })}
                        <td class="c"><label class="check"><input type="checkbox" aria-label={`${r.name} 사용`} checked={r.active} disabled={ro} onChange={() => void apply({ kind: 'resourceActive', resourceTypeId: r.resourceTypeId, active: !r.active })} /></label></td>
                        <td><Field class="field ghost-field" value={r.groupName} label={`${r.name} 분류`} list="setup-groups" disabled={ro} placeholder="분류 없음" onCommit={t => apply({ kind: 'resourceGroup', resourceTypeId: r.resourceTypeId, groupName: t })} /></td>
                        <td class="n">{!ro && <button type="button" class="btn ghost icon-btn" aria-label={`${r.name} 리소스 지우기`}
                          title={r.used ? '지우기(물량 · 템플릿 등 함께 지워질 것을 먼저 보여 줍니다)' : '지우기(변경 이력에서 되돌릴 수 있습니다)'}
                          onClick={() => { if (r.used) setDelRes(r); else void apply({ kind: 'deleteResource', resourceTypeId: r.resourceTypeId }); }}><IconX /></button>}</td>
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
              {v.pipelines.length > 0 && (
                <select class="field" aria-label="새 리소스 파이프라인" value={v.pipelines.some(pl => pl.pipelineId === newRes.pipe) ? newRes.pipe : v.pipelines[0].pipelineId} onChange={e => setNewRes({ ...newRes, pipe: (e.target as HTMLSelectElement).value })}>
                  {v.pipelines.map(pl => <option value={pl.pipelineId}>{pl.name} 파이프라인</option>)}
                </select>
              )}
              <button type="button" class="btn sm" disabled={!newRes.name.trim()} onClick={async () => {
                const pipe = v.pipelines.some(pl => pl.pipelineId === newRes.pipe) ? newRes.pipe : v.pipelines[0]?.pipelineId;
                if (await apply({ kind: 'createResource', name: newRes.name, groupName: newRes.group, ...(pipe ? { pipelineId: pipe } : {}) })) setNewRes({ ...newRes, name: '' });
              }}><IconPlus />리소스 더하기</button>
              <span class="small faint">더한 뒤 파트별 기본 공수를 넣어야 계산에 들어갑니다.</span>
            </div>
          )}
        </div>
      </section>
      {delRes && (() => {
        const u = delRes.usage;
        const lines = [
          u.volumes ? `업데이트 ${u.volumes}곳의 물량(기본안 합 ${u.qty}개)` : '',
          u.templates ? `유형 템플릿 ${u.templates}곳` : '',
          u.progress ? `작업 진척 기록(완료 ${u.progress}개)` : '',
          u.assets ? `에셋 ${u.assets}개(파트 상태 · 링크 · 댓글 포함)` : '',
        ].filter(Boolean);
        const records = u.progress > 0 || u.assets > 0;
        return (
          <div class="overlay" onClick={e => { if (e.target === e.currentTarget) setDelRes(null); }}>
            <div class="card dialog confirm-dialog" role="dialog" aria-label="리소스 지우기">
              <h2 style="font-size: 16px">"{delRes.name}" 리소스를 지울까요?</h2>
              <p class="small muted" style="margin: 8px 0 6px">이 리소스를 지우면 다음도 함께 지워집니다.</p>
              <ul class="del-list small">{lines.map(l => <li>{l}</li>)}</ul>
              <p class={`small ${records ? 'warn-text' : 'muted'}`} style="margin: 6px 0 14px">{records ? '작업 기록이 있습니다. 기록을 남기려면 "사용 안 함"으로 두십시오(계산 · 화면에서만 빠짐). ' : ''}변경 이력에서 한 번에 되돌릴 수 있습니다.</p>
              <div class="inline" style="justify-content: flex-end">
                <button type="button" class="btn sm ghost" onClick={() => setDelRes(null)}>그만두기</button>
                {delRes.active && <button type="button" class="btn sm" onClick={() => { const r = delRes; setDelRes(null); void apply({ kind: 'resourceActive', resourceTypeId: r.resourceTypeId, active: false }); }}>사용 안 함으로 두기</button>}
                <button type="button" class="btn sm danger" onClick={() => { const r = delRes; setDelRes(null); void apply({ kind: 'deleteResource', resourceTypeId: r.resourceTypeId, cascade: true }); }}>모두 지우기</button>
              </div>
            </div>
          </div>
        );
      })()}
      {moveReq && <MoveDialog v={v} req={moveReq} apply={apply} onClose={() => setMoveReq(null)} />}
    </div>
  );
}

/** 고르기에 이름이 다 보이는 폭(px): 글자 폭 + 안쪽 여백(10 + 10) · 펼침 화살표(약 20) · 여유. 104~260px */
function pipeWidth(names: string[]): number {
  let w = 0;
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.font = `12.5px ${getComputedStyle(document.body).fontFamily}`;
      for (const n of names) w = Math.max(w, ctx.measureText(n).width);
    }
  } catch { w = Math.max(0, ...names.map(n => n.length * 13)); }
  return Math.min(260, Math.max(104, Math.ceil(w) + 48));
}
