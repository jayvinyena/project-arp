// 팀 제작 리스트 가져오기 창(docs/20-asset-management.md 19절).
// 엑셀 넣기에 ARP 에셋 양식이 아닌 파일을 넣으면 열린다: ① 읽은 시트 ② 마일스톤 → 업데이트 ③ 분류 → 리소스 종류 ④ 모르는 상태 말 ⑤ 넣는 방법.
import { useState, useMemo } from 'preact/hooks';
import type { SheetScan, SheetPlan } from '../../../core/sheet-import.ts';
import type { AssetStatus } from '../../../core/assets.ts';
import { fmtInt } from '../lib/format.ts';
import { IconX, IconFolder } from './icons.tsx';

const WORD_TO: { s: AssetStatus | ''; label: string }[] = [
  { s: '', label: '바꾸지 않음' }, { s: 'TODO', label: '대기' }, { s: 'WIP', label: '진행' }, { s: 'REVIEW', label: '검수 요청' },
  { s: 'RETAKE', label: '수정' }, { s: 'DONE', label: '완료' }, { s: 'HOLD', label: '보류' }, { s: 'OMIT', label: '해당 없음' },
];
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function SheetImportDialog(props: { fileName: string; scan: SheetScan; busy: boolean; onImport: (plan: SheetPlan) => void; onClose: () => void }) {
  const s = props.scan;
  const [ms, setMs] = useState<Record<string, string>>(() => Object.fromEntries(s.milestones.map(m => [m.value, m.guess ?? ''])));
  const [rt, setRt] = useState<Record<string, string>>(() => Object.fromEntries(s.keys.map(k => [k.key, k.guess ?? ''])));
  const [words, setWords] = useState<Record<string, AssetStatus | ''>>(() => Object.fromEntries(s.unknownWords.map(w => [w.word, ''])));
  const [doneDate, setDoneDate] = useState(today());
  const [addVolumes, setAddVolumes] = useState(true);
  const groups = useMemo(() => [...new Set(s.resources.map(r => r.group))], [s]);
  const sheetsIn = s.sheets.filter(x => x.included);
  const sheetsOut = s.sheets.filter(x => !x.included);
  const keySheets = [...new Set(s.keys.map(k => k.sheet))];

  // 고른 대응으로 들어갈 행 · 새로 물량에 더할 리소스
  const vols = new Set(s.volumes);
  let rows = 0;
  const newVol = new Set<string>();
  for (const p of s.pairs) {
    const u = ms[p.ms]; const r = rt[p.key];
    if (!u || !r) continue;
    if (!vols.has(`${u}|${r}`)) { if (!addVolumes) continue; newVol.add(`${u}|${r}`); }
    rows += p.count;
  }
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(doneDate);
  const resourceSelect = (key: string, label: string) => (
    <select class={`field${rt[key] ? '' : ' unset'}`} aria-label={`${label} 리소스 종류`} value={rt[key]} onChange={e => setRt({ ...rt, [key]: (e.target as HTMLSelectElement).value })}>
      <option value="">건너뛰기</option>
      {groups.map(g => <optgroup label={g || '분류 없음'}>{s.resources.filter(r => r.group === g).map(r => <option value={r.resourceTypeId}>{r.name}</option>)}</optgroup>)}
    </select>
  );

  return (
    <div class="overlay">
      <div class="card dialog import-guide sheet-import" role="dialog" aria-label="제작 리스트 가져오기">
        <div class="dialog-head">
          <div><h2>제작 리스트 가져오기</h2>
            <p class="small muted" style="margin-top: 2px">{props.fileName} · 시트 {sheetsIn.length}개에서 에셋 {fmtInt(s.rows)}행을 읽었습니다. 무엇을 어디에 넣을지 고릅니다.</p></div>
          <button type="button" class="btn ghost icon-btn" aria-label="닫기" onClick={props.onClose}><IconX /></button>
        </div>
        <div class="drawer-body">
          <section class="import-step">
            <span class="step-badge">1</span>
            <div>
              <h3>읽은 시트</h3>
              <p class="small muted">파트 상태 칸(원화 · 모델링 · 애니 · FX)이 있는 시트만 가져옵니다. 그 밖의 칸은 에셋 속성으로 넣습니다.</p>
              <div class="table-wrap ref-wrap" style="margin-top: 8px">
                <table class="grid ref si-sheets">
                  <colgroup><col style="width: 190px" /><col style="width: 64px" /><col style="width: 200px" /><col /></colgroup>
                  <thead><tr><th>시트</th><th class="n">행</th><th>파트 상태 칸</th><th>속성으로 넣을 칸</th></tr></thead>
                  <tbody>
                    {sheetsIn.map(x => (
                      <tr class="row"><td><b>{x.name}</b></td><td class="n num">{fmtInt(x.rows)}</td><td class="small">{x.parts.join(' · ')}</td>
                        <td class="small">{x.attrs.length ? x.attrs.join(' · ') : <span class="faint">없음</span>}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {sheetsOut.length > 0 && <p class="small faint" style="margin-top: 6px">건너뛰는 시트 {sheetsOut.length}개: {sheetsOut.map(x => `${x.name}(${x.reason})`).join(', ')}</p>}
            </div>
          </section>

          <section class="import-step">
            <span class="step-badge">2</span>
            <div>
              <h3>마일스톤 → 업데이트</h3>
              <p class="small muted">시트의 마일스톤 값을 어느 업데이트에 넣을지 고릅니다. "건너뛰기"인 마일스톤의 행은 넣지 않습니다.</p>
              <div class="si-map">
                {s.milestones.map(m => (
                  <label class="si-map-row"><span><b>{m.value}</b> <span class="faint small">{fmtInt(m.count)}행</span></span>
                    <select class={`field${ms[m.value] ? '' : ' unset'}`} aria-label={`${m.value} 업데이트`} value={ms[m.value]} onChange={e => setMs({ ...ms, [m.value]: (e.target as HTMLSelectElement).value })}>
                      <option value="">건너뛰기</option>
                      {s.updates.map(u => <option value={u.updateId}>{u.name}</option>)}
                    </select></label>
                ))}
              </div>
            </div>
          </section>

          <section class="import-step">
            <span class="step-badge">3</span>
            <div>
              <h3>분류 → 리소스 종류</h3>
              <p class="small muted">시트 · 대분류 · 분류마다 공수 · 물량을 셀 리소스 종류를 고릅니다. 대분류 · 분류 값은 에셋의 세부 분류로 들어갑니다. 이름이 비슷한 종류는 미리 골라 두었습니다.</p>
              {keySheets.map(sh => (
                <div class="si-group">
                  <div class="si-group-h">{sh}</div>
                  <div class="si-map">
                    {s.keys.filter(k => k.sheet === sh).map(k => (
                      <label class="si-map-row"><span><b>{k.label}</b> <span class="faint small">{fmtInt(k.count)}행</span></span>{resourceSelect(k.key, `${sh} ${k.label}`)}</label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {s.unknownWords.length > 0 && (
            <section class="import-step">
              <span class="step-badge">4</span>
              <div>
                <h3>알아보지 못한 상태 말</h3>
                <p class="small muted">"완료 · 없음 · 진행 · 검수 · 수정 · 보류"가 아닌 말입니다. 어떤 상태로 넣을지 고릅니다.</p>
                <div class="si-map">
                  {s.unknownWords.map(w => (
                    <label class="si-map-row"><span><b>"{w.word}"</b> <span class="faint small">{fmtInt(w.count)}칸</span></span>
                      <select class="field" aria-label={`${w.word} 상태`} value={words[w.word]} onChange={e => setWords({ ...words, [w.word]: (e.target as HTMLSelectElement).value as AssetStatus | '' })}>
                        {WORD_TO.map(o => <option value={o.s}>{o.label}</option>)}
                      </select></label>
                  ))}
                </div>
              </div>
            </section>
          )}

          <section class="import-step">
            <span class="step-badge">{s.unknownWords.length > 0 ? 5 : 4}</span>
            <div>
              <h3>넣는 방법</h3>
              <div class="si-opts">
                <label class="si-map-row"><span>"완료" 파트의 완료일 <span class="faint small">시트에 날짜가 없어 이 날로 넣습니다</span></span>
                  <input class="field" type="date" aria-label="완료일" value={doneDate} onInput={e => setDoneDate((e.target as HTMLInputElement).value)} /></label>
                <label class="inline small"><input type="checkbox" checked={addVolumes} onChange={e => setAddVolumes((e.target as HTMLInputElement).checked)} />
                  물량에 없는 리소스는 그 업데이트 물량에 더하고 등록 에셋 수로 맞춥니다</label>
              </div>
              <ul class="small muted si-notes">
                <li>같은 업데이트 · 리소스 종류에서 리소스명(없으면 이름)이 같은 에셋은 새로 만들지 않고 고칩니다. 다시 넣어도 두 번 생기지 않습니다.</li>
                <li>빈 상태 칸은 바꾸지 않습니다. 에픽 칸의 ABC-123은 에셋 Jira 키, 기획서 칸의 링크는 "기획서" 링크가 됩니다.</li>
                <li>한 번에 넣으며, 변경 이력에서 한 번에 되돌릴 수 있습니다.</li>
              </ul>
            </div>
          </section>
        </div>
        <div class="import-foot">
          <p class="small" style="flex: 1" aria-live="polite"><b>{fmtInt(rows)}행</b>을 넣습니다{rows < s.rows ? ` · ${fmtInt(s.rows - rows)}행 건너뜀` : ''}{newVol.size ? ` · 물량에 새로 더할 리소스 ${newVol.size}곳` : ''}</p>
          <button type="button" class="btn sm ghost" onClick={props.onClose}>그만두기</button>
          <button type="button" class="btn primary" disabled={props.busy || rows === 0 || !dateOk}
            onClick={() => props.onImport({ milestones: ms, resources: rt, words, doneDate, addVolumes })}><IconFolder />{props.busy ? '넣는 중…' : '가져오기'}</button>
        </div>
      </div>
    </div>
  );
}
