// 유형 템플릿: 업데이트 유형과 유형별 기본 물량(새 업데이트를 만들 때 복사)
import { useState, useEffect } from 'preact/hooks';
import { afterCommit } from './commit.ts';
import { MODE_LABEL } from '../lib/modes.ts';
import { rpc } from '../lib/rpc.ts';
import type { TypeView } from '../../../core/plan.ts';
import type { Edit } from '../../../core/edits.ts';
import { fmtInt } from '../lib/format.ts';
import { IconPlus, IconX } from './icons.tsx';

function Qty(props: { value: number | null; label: string; disabled: boolean; onCommit: (v: number | null) => unknown }) {
  const [text, setText] = useState(props.value == null ? '' : String(props.value));
  useEffect(() => setText(props.value == null ? '' : String(props.value)), [props.value]);
  const reset = () => setText(props.value == null ? '' : String(props.value));
  const commit = () => {
    const t = text.trim();
    if (t === '') { if (props.value !== null) afterCommit(props.onCommit(null), reset); return; }
    const n = Number(t);
    if (!Number.isInteger(n) || n < 0) { reset(); return; }
    if (n !== props.value) afterCommit(props.onCommit(n), reset);
  };
  return <input class="qty" inputMode="numeric" aria-label={props.label} value={text} placeholder="—" disabled={props.disabled}
    onInput={e => setText((e.target as HTMLInputElement).value)} onBlur={commit}
    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

export function TemplatesPage(props: { version: number; readOnly: boolean; onApply: (e: Edit) => Promise<boolean> }) {
  const [types, setTypes] = useState<TypeView[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  useEffect(() => { void rpc.types().then(setTypes); }, [props.version]);
  if (!types) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  const editable = types.filter(t => !t.isLaunch);
  const cur = editable.find(t => t.typeId === selected) ?? editable[0];
  const apply = (e: Edit) => props.onApply(e);
  const sum = (k: 'min' | 'target' | 'stretch') => cur?.rows.reduce((a, r) => a + (r[k] ?? 0), 0) ?? 0;

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <div class="eyebrow">유형 템플릿</div>
          <h1>업데이트 유형별 기본 물량</h1>
          <p class="muted" style="margin-top: 6px">새 업데이트를 만들 때 이 물량을 복사해요. 템플릿을 고쳐도 이미 만든 업데이트는 바뀌지 않아요.</p>
        </div>
      </header>
      <div class="split">
        <section class="card">
          <div class="card-head"><h2>유형</h2></div>
          <div class="card-body" style="padding-top: 10px">
            <nav class="type-list">
              {editable.map(t => (
                <button type="button" class={`nav-item${cur?.typeId === t.typeId ? ' active' : ''}`} onClick={() => setSelected(t.typeId)}>
                  {t.name}<span class="end faint small">{t.rows.length}종</span>
                </button>
              ))}
            </nav>
            {!props.readOnly && (
              <div class="inline" style="margin-top: 12px">
                <input class="field" style="flex: 1; min-width: 0" placeholder="새 유형 이름" aria-label="새 유형 이름" value={newName} onInput={e => setNewName((e.target as HTMLInputElement).value)} />
                <button type="button" class="btn sm" disabled={!newName.trim()} onClick={async () => {
                  if (await props.onApply({ kind: 'createType', name: newName })) { setNewName(''); }
                }}><IconPlus />더하기</button>
              </div>
            )}
          </div>
        </section>
        {cur ? (
          <section class="card">
            <div class="card-head">
              <input class="title-input" aria-label="유형 이름" value={cur.name} disabled={props.readOnly}
                onChange={e => apply({ kind: 'renameType', typeId: cur.typeId, name: (e.target as HTMLInputElement).value })} />
              <div class="inline">
                <span class="small faint">이 유형의 업데이트 {cur.usedBy}개</span>
                {!props.readOnly && (
                  <button type="button" class="btn sm ghost" disabled={cur.usedBy > 0} title={cur.usedBy > 0 ? '이 유형을 쓰는 업데이트가 있어 지울 수 없어요' : ''}
                    onClick={() => apply({ kind: 'deleteType', typeId: cur.typeId })}>유형 지우기</button>
                )}
              </div>
            </div>
            <div class="card-body" style="padding-top: 8px">
              <div class="table-wrap">
                <table class="grid vol">
                  <colgroup><col /><col class="qty-col" /><col class="qty-col" /><col class="qty-col" /><col class="act-col" /></colgroup>
                  <thead><tr><th>리소스</th><th class="n">{MODE_LABEL.MIN}</th><th class="n">{MODE_LABEL.TARGET}</th><th class="n">{MODE_LABEL.STRETCH}</th><th aria-label="행 작업" /></tr></thead>
                  <tbody>
                    {cur.rows.map(r => (
                      <tr class="row">
                        <td><div class="res-name"><span class="title">{r.name}</span><span class="small faint">{r.groupName}</span></div></td>
                        {(['min_qty', 'target_qty', 'stretch_qty'] as const).map((f, i) => (
                          <td class="n" data-label={[MODE_LABEL.MIN, MODE_LABEL.TARGET, MODE_LABEL.STRETCH][i]}>
                            <Qty value={[r.min, r.target, r.stretch][i]} label={`${r.name} ${[MODE_LABEL.MIN, MODE_LABEL.TARGET, MODE_LABEL.STRETCH][i]}`} disabled={props.readOnly}
                              onCommit={v => apply({ kind: 'template', typeId: cur.typeId, resourceTypeId: r.resourceTypeId, field: f, value: v })} />
                          </td>
                        ))}
                        <td class="n act">{!props.readOnly && (
                          <span class="row-actions"><button type="button" class="btn ghost icon-btn" aria-label={`${r.name} 빼기`}
                            onClick={() => apply({ kind: 'removeTemplateResource', typeId: cur.typeId, resourceTypeId: r.resourceTypeId })}><IconX /></button></span>
                        )}</td>
                      </tr>
                    ))}
                    {cur.rows.length > 0 && (
                      <tr class="total"><td>합계</td><td class="n num">{fmtInt(sum('min'))}</td><td class="n num">{fmtInt(sum('target'))}</td><td class="n num">{fmtInt(sum('stretch'))}</td><td /></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {cur.rows.length === 0 && <p class="muted small" style="padding: 12px 0">아직 물량이 없어요. 리소스를 더해 주세요.</p>}
              {!props.readOnly && cur.addable.length > 0 && (
                <label class="btn sm" style="position: relative; margin-top: 12px">
                  <IconPlus /> 리소스 더하기
                  <select aria-label="템플릿에 더할 리소스" style="position: absolute; inset: 0; opacity: 0; cursor: pointer" value=""
                    onChange={e => { const v = (e.target as HTMLSelectElement).value; if (v) apply({ kind: 'addTemplateResource', typeId: cur.typeId, resourceTypeId: v }); }}>
                    <option value="">리소스 고르기</option>
                    {cur.addable.map(a => <option value={a.resourceTypeId}>{a.groupName} · {a.name}</option>)}
                  </select>
                </label>
              )}
            </div>
          </section>
        ) : <section class="card"><div class="card-body muted">유형을 더해 주세요.</div></section>}
      </div>
    </div>
  );
}
