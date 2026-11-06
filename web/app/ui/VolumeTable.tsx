// 물량 표: 분류별 묶음, 칸 안에서 바로 고치기(Enter·칸 벗어나면 반영, Esc 되돌리기).
// 물량 템플릿(최소안·기본안·최대안 등, 이름은 프로젝트마다) 중 고른 하나의 수량만 크게 보고 입력하고, 나머지 둘은 흐리게 함께 보여 준다.
import { useState, useEffect } from 'preact/hooks';
import { Field } from './SetupPage.tsx';
import type { LaunchEdit, LaunchRow } from '../../../core/launch.ts';

export type VolumeEdit = Exclude<LaunchEdit, { kind: 'date' }>;
import type { Finding } from '../../../core/pipeline.ts';
import type { PlanMode } from '../../../engine/types.ts';
import { fmtDays, fmtInt } from '../lib/format.ts';
import { IconPlus, IconX } from './icons.tsx';
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

  return (
    <section class={props.bare ? 'bare' : 'card'} aria-label="물량">
      <div class="card-head">
        <div>
          <h2 class="vol-title">물량 ·{' '}
            {props.onRename && !readOnly
              ? <Field class="field inline-title" value={modeLabel} label="템플릿 이름" onCommit={t => props.onRename!(t)} />
              : modeLabel}
          </h2>
          <p class="small muted" style="margin-top: 2px">리소스 {props.rows.length}종 · 숫자를 고치면 바로 다시 계산해요{props.onRename && !readOnly ? ' · 템플릿 이름은 제목을 눌러 바꿔요(예: 보수안 · 계획안 · 도전안)' : ''}</p>
        </div>
        <div class="inline">
        {!readOnly && props.onCopy && (
          <button type="button" class="btn sm" title={`${modeLabel} 수량을 ${others.map(m => MODE_LABEL[m]).join('·')}에도 그대로 넣어요(되돌리기 가능)`}
            onClick={async () => { for (const m of others) await props.onCopy!(field, MODE_FIELD[m]); }}>다른 템플릿에도 똑같이</button>
        )}
        {!readOnly && props.onCopy && others.map(m => (
          <button type="button" class="btn sm ghost" title={`${MODE_LABEL[m]}의 수량을 모두 ${modeLabel}으로 가져와요(되돌리기 가능)`}
            onClick={() => props.onCopy!(MODE_FIELD[m], field)}>{MODE_LABEL[m]} 수량 가져오기</button>
        ))}
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
            <colgroup><col /><col class="qty-col" /><col class="others-col" /><col class="qty-col" /><col class="days-col" /><col class="act-col" /></colgroup>
            <thead>
              <tr>
                <th>리소스 · 거치는 파트(완료)</th>
                <th class="n">{modeLabel}</th>
                <th class="n others-head">다른 템플릿</th>
                <th class="n">외주</th>
                <th class="n">필요 공수 · {modeLabel}</th>
                <th aria-label="행 작업" />
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <>
                  <tr class="group"><td colSpan={6}>{g.name}</td></tr>
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
                        <td class="n" data-label={modeLabel}><QtyInput value={qtyOf(r, props.planMode)} field="target_qty" label={`${r.name} ${modeLabel}`} nullable invalid={blank && qtyOf(r, props.planMode) == null} disabled={readOnly} onCommit={edit(r, field)} /></td>
                        <td class="n others" data-label="다른 템플릿">
                          {others.map(m => <span class={`other${qtyOf(r, m) == null ? ' blank' : ''}`} title={MODE_LABEL[m]}><span class="faint">{MODE_LABEL[m]}</span> <span class="num">{qtyOf(r, m) == null ? '빈칸' : fmtInt(qtyOf(r, m)!)}</span></span>)}
                        </td>
                        <td class="n" data-label="외주"><QtyInput value={r.outsource} field="outsource_qty" label={`${r.name} 외주`} nullable={false} disabled={readOnly} onCommit={edit(r, 'outsource_qty')} /></td>
                        <td class="n days" data-label={`필요 공수 · ${modeLabel}`}>
                          {props.blocked
                            ? <span class="faint" title="계산할 수 없어요">—</span>
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
