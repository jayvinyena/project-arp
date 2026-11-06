// 물량 표: 분류별 묶음, 칸 안에서 바로 고치기(Enter·칸 벗어나면 반영, Esc 되돌리기).
// 물량 템플릿 세 개(최소안·기본안·최대안 등, 이름은 프로젝트마다)를 열로 나란히 보여 주고, 편집 중인 템플릿 열만 강조해 입력한다.
// 다른 열 머리글(또는 값)을 누르면 그 템플릿을 편집한다. 복사 버튼은 방향(A → B)을 그대로 쓴다.
import { useState, useEffect } from 'preact/hooks';
import { Field } from './SetupPage.tsx';
import type { LaunchEdit, LaunchRow } from '../../../core/launch.ts';

export type VolumeEdit = Exclude<LaunchEdit, { kind: 'date' }>;
import type { Finding } from '../../../core/pipeline.ts';
import type { PlanMode } from '../../../engine/types.ts';
import { fmtDays, fmtInt } from '../lib/format.ts';
import { IconPlus, IconX, IconPencil, IconCopy } from './icons.tsx';
import { afterCommit } from './commit.ts';
import { MODE_LABEL } from '../lib/modes.ts';
import { PLAN_MODES, MODE_FIELD } from '../../../core/modes.ts';

type QtyField = 'min_qty' | 'target_qty' | 'stretch_qty' | 'outsource_qty';

function QtyInput(props: {
  value: number | null; field: QtyField; label: string; invalid?: boolean; disabled?: boolean; nullable: boolean;
  onCommit: (v: number | null) => unknown;
}) {
  const [text, setText] = useState(props.value == null ? '' : String(props.value));
  useEffect(() => { setText(props.value == null ? '' : String(props.value)); }, [props.value]);
  const reset = () => setText(props.value == null ? '' : String(props.value));
  const commit = () => {
    const t = text.trim().replace(/,/g, '');
    if (t === '') {
      if (props.nullable) { if (props.value !== null) afterCommit(props.onCommit(null), reset); } else setText(String(props.value ?? 0));
      return;
    }
    const n = Number(t);
    if (!Number.isInteger(n) || n < 0) { reset(); return; }
    if (n !== props.value) afterCommit(props.onCommit(n), reset);
  };
  return (
    <input
      class={`qty${props.field === 'target_qty' ? ' target' : ''}${props.invalid ? ' invalid' : ''}`}
      inputMode="numeric"
      aria-label={props.label}
      value={text}
      placeholder="—"
      disabled={props.disabled}
      onInput={e => setText((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { setText(props.value == null ? '' : String(props.value)); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

export function VolumeTable(props: {
  updateId: string;
  rows: LaunchRow[];
  addable: { resourceTypeId: string; name: string; groupName: string }[];
  /** 카드 테두리 없이(상세 패널 안) */
  bare?: boolean;
  byResource: Record<string, number>;
  totalDays: number;
  planMode: PlanMode;
  findings: Finding[];
  blocked: boolean;
  readOnly: boolean;
  onEdit: (e: VolumeEdit) => unknown;
  /** 다른 템플릿의 수량을 지금 템플릿으로 가져오기(없으면 버튼을 숨긴다) */
  onCopy?: (from: 'min_qty' | 'target_qty' | 'stretch_qty', to: 'min_qty' | 'target_qty' | 'stretch_qty') => unknown;
  /** 지금 템플릿 이름 바꾸기(있으면 제목에서 바로 고친다) */
  onRename?: (name: string) => unknown;
  /** 다른 템플릿 열을 눌러 편집할 템플릿 바꾸기(없으면 열은 보기만) */
  onSelectMode?: (m: PlanMode) => void;
}) {
  const { byResource, totalDays, readOnly, onEdit } = props;
  const launchId = props.updateId;
  const rowErrors = new Map<string, Finding[]>();
  for (const f of props.findings) {
    if (!f.key.startsWith(`${launchId}|`)) continue;
    const rt = f.key.split('|')[1];
    if (!rowErrors.has(rt)) rowErrors.set(rt, []);
    rowErrors.get(rt)!.push(f);
  }

  const groups: { name: string; rows: LaunchRow[] }[] = [];
  for (const r of props.rows) {
    const last = groups[groups.length - 1];
    if (last && last.name === r.groupName) last.rows.push(r); else groups.push({ name: r.groupName, rows: [r] });
  }
  const modeLabel = MODE_LABEL[props.planMode];
  const field = MODE_FIELD[props.planMode];
  const others = PLAN_MODES.filter(m => m !== props.planMode);
  const qtyOf = (r: LaunchRow, m: typeof props.planMode) => (m === 'MIN' ? r.min : m === 'TARGET' ? r.target : r.stretch);
  const edit = (r: LaunchRow, f: QtyField) => (value: number | null) => onEdit({ kind: 'volume', resourceTypeId: r.resourceTypeId, field: f, value });
  const renamable = !!props.onRename && !readOnly;
  const pick = props.onSelectMode;

  return (
    <section class={props.bare ? 'bare' : 'card'} aria-label="물량">
      <div class="card-head vol-head">
        <div>
          <h2 class="vol-title">
            물량 <span class="vol-editing">편집 중</span>
            {renamable
              ? <label class="title-edit" title="눌러서 템플릿 이름을 변경합니다">
                  <Field class="field inline-title" value={modeLabel} label="템플릿 이름" onCommit={t => props.onRename!(t)} />
                  <IconPencil />
                </label>
              : <span class="vol-mode">{modeLabel}</span>}
          </h2>
          <p class="small muted" style="margin-top: 2px">
            리소스 {props.rows.length}종 · 강조된 {modeLabel} 열에만 입력합니다{pick ? ' · 다른 열 머리글을 누르면 그 템플릿을 편집합니다' : ''}{renamable ? ' · 이름은 제목에서 변경합니다' : ''}
          </p>
        </div>
        <div class="inline">
        {!readOnly && props.onCopy && (
          <span class="copy-group" role="group" aria-label="수량 복사">
            <span class="copy-label"><IconCopy />수량 복사</span>
            <span class="btn-group">
              {others.map(m => (
                <button type="button" class="btn sm" aria-label={`${MODE_LABEL[m]} → ${modeLabel} 복사`} title={`${MODE_LABEL[m]}의 수량을 모두 ${modeLabel}에 덮어씁니다(되돌리기 가능)`}
                  onClick={() => props.onCopy!(MODE_FIELD[m], field)}>{MODE_LABEL[m]}<span class="arrow" aria-hidden="true">→</span>{modeLabel}</button>
              ))}
              <button type="button" class="btn sm" aria-label={`${modeLabel} → ${others.map(m => MODE_LABEL[m]).join('·')} 복사`} title={`${modeLabel}의 수량을 ${others.map(m => MODE_LABEL[m]).join('·')}에 덮어씁니다(되돌리기 가능)`}
                onClick={async () => { for (const m of others) await props.onCopy!(field, MODE_FIELD[m]); }}>{modeLabel}<span class="arrow" aria-hidden="true">→</span>{others.map(m => MODE_LABEL[m]).join('·')}</button>
            </span>
          </span>
        )}
        {!readOnly && props.addable.length > 0 && (
          <label class="btn sm" style="position: relative">
            <IconPlus /> 리소스 더하기
            <select
              aria-label="더할 리소스"
              style="position: absolute; inset: 0; opacity: 0; cursor: pointer"
              value=""
              onChange={e => {
                const v = (e.target as HTMLSelectElement).value;
                if (v) onEdit({ kind: 'addResource', resourceTypeId: v });
              }}
            >
              <option value="">리소스 고르기</option>
              {props.addable.map(a => <option value={a.resourceTypeId}>{a.groupName} · {a.name}</option>)}
            </select>
          </label>
        )}
        </div>
      </div>
      <div class="card-body" style="padding-top: 8px">
        <div class="table-wrap">
          <table class="grid vol">
            <colgroup><col />{PLAN_MODES.map(() => <col class="qty-col" />)}<col class="qty-col" /><col class="days-col" /><col class="act-col" /></colgroup>
            <thead>
              <tr>
                <th>리소스 · 거치는 파트(완료)</th>
                {PLAN_MODES.map(m => (
                  <th class={`n mode-th${m === props.planMode ? ' sel' : ''}`} aria-current={m === props.planMode ? 'true' : undefined}>
                    {m === props.planMode || !pick
                      ? <span class="mode-head">{MODE_LABEL[m]}{m === props.planMode && <span class="edit-tag">편집</span>}</span>
                      : <button type="button" class="mode-head" title={`눌러서 ${MODE_LABEL[m]}을 편집합니다`} onClick={() => pick(m)}>{MODE_LABEL[m]}</button>}
                  </th>
                ))}
                <th class="n">외주</th>
                <th class="n">필요 공수 · {modeLabel}</th>
                <th aria-label="행 작업" />
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <>
                  <tr class="group"><td colSpan={8}>{g.name}</td></tr>
                  {g.rows.map(r => {
                    const errs = rowErrors.get(r.resourceTypeId) ?? [];
                    const blank = errs.some(f => f.code === 'V01');
                    const days = byResource[r.resourceTypeId] ?? 0;
                    return (
                      <tr class={`row${errs.some(f => f.level === 'ERROR') ? ' has-error' : ''}`} key={r.resourceTypeId}>
                        <td>
                          <div class="res-name">
                            <span class="title">{r.name}{!r.required && <span class="tag">선택</span>}</span>
                            <span class="steps">
                              {r.parts.map(p => <span class={`step${p.completed > 0 ? ' done' : ''}`}>{p.name}{p.completed > 0 ? ` ${fmtInt(p.completed)}` : ''}</span>)}
                            </span>
                            {errs.map(f => <span class="err-text">{f.title} — {f.detail}</span>)}
                          </div>
                        </td>
                        {PLAN_MODES.map(m => {
                          const q = qtyOf(r, m);
                          if (m === props.planMode) {
                            return <td class="n mode-cell sel" data-label={`${MODE_LABEL[m]} · 편집`}><QtyInput value={q} field="target_qty" label={`${r.name} ${MODE_LABEL[m]}`} nullable invalid={blank && q == null} disabled={readOnly} onCommit={edit(r, field)} /></td>;
                          }
                          const text = q == null ? '빈칸' : fmtInt(q);
                          return (
                            <td class={`n mode-cell ro${q == null ? ' blank' : ''}`} data-label={MODE_LABEL[m]} data-mode={m}>
                              {pick
                                ? <button type="button" class="ro-val" title={`눌러서 ${MODE_LABEL[m]}을 편집합니다`} onClick={() => pick(m)}>{text}</button>
                                : <span class="ro-val">{text}</span>}
                            </td>
                          );
                        })}
                        <td class="n" data-label="외주"><QtyInput value={r.outsource} field="outsource_qty" label={`${r.name} 외주`} nullable={false} disabled={readOnly} onCommit={edit(r, 'outsource_qty')} /></td>
                        <td class="n days" data-label={`필요 공수 · ${modeLabel}`}>
                          {props.blocked
                            ? <span class="faint" title="계산할 수 없습니다">—</span>
                            : (
                              <span class="share">
                                <span class="num">{fmtDays(days)}<span class="faint small"> 인·일</span></span>
                                <span class="bar"><span class="fill" style={{ width: `${totalDays > 0 ? Math.min(100, (days / totalDays) * 100) : 0}%` }} /></span>
                              </span>
                            )}
                        </td>
                        <td class="n act">
                          {!readOnly && (
                            <span class="row-actions">
                              <button class="btn ghost icon-btn" title={`${r.name} 빼기`} aria-label={`${r.name} 빼기`}
                                onClick={() => onEdit({ kind: 'removeResource', resourceTypeId: r.resourceTypeId })}><IconX /></button>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
