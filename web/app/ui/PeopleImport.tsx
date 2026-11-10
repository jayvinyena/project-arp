// 작업자 가져오기(docs/31-people-import.md): 에셋 담당에서 찾기(A) · 표 붙여넣기(B).
// 둘 다 미리보기에서 고른 뒤 한 번에 더한다(이력 한 묶음, 한 번에 되돌림). 붙여넣은 글은 이 파일 안에서만 쓴다.
import { useMemo, useState } from 'preact/hooks';
import type { AssigneeCandidate, Person, TeamOption } from '../../../core/people.ts';
import type { Edit } from '../../../core/edits.ts';
import { parsePeopleText } from '../../../core/people-paste.ts';
import type { PasteRow } from '../../../core/people-paste.ts';
import { IconPlus, IconX } from './icons.tsx';

const NEW_TEAM = '\u0001new';

/** 소속팀 고르기(파트 · 지원 팀). extra = 목록에 없는 팀을 "지원 팀으로 만들기"로 고를 수 있게 */
function TeamPick(props: { value: string; teams: TeamOption[]; label: string; extra?: string | null; onChange: (v: string) => void }) {
  const parts = props.teams.filter(t => t.kind === 'part');
  const support = props.teams.filter(t => t.kind === 'support');
  return (
    <select class="field ghost-field" aria-label={props.label} value={props.value} onChange={e => props.onChange((e.target as HTMLSelectElement).value)}>
      <option value="">소속팀 없음</option>
      {props.extra && <option value={NEW_TEAM}>"{props.extra}" 지원 팀으로 만들기</option>}
      <optgroup label="파트">{parts.map(t => <option value={t.name}>{t.name}</option>)}</optgroup>
      {support.length > 0 && <optgroup label="지원 팀">{support.map(t => <option value={t.name}>{t.name}</option>)}</optgroup>}
    </select>
  );
}

/** A. 명단에 없는 에셋 담당 */
export function AssigneeFinder(props: { candidates: AssigneeCandidate[]; teams: TeamOption[]; apply: (e: Edit) => Promise<boolean>; onClose: () => void }) {
  const [off, setOff] = useState<Set<string>>(new Set());
  const [team, setTeam] = useState<Record<string, string>>({});
  const list = props.candidates;
  const picked = list.filter(c => !off.has(c.name));
  const teamOf = (c: AssigneeCandidate) => team[c.name] ?? c.team ?? '';
  const add = async () => {
    if (!picked.length) return;
    if (await props.apply({ kind: 'createPeople', people: picked.map(c => ({ name: c.name, team: teamOf(c) || null })) })) props.onClose();
  };
  return (
    <div class="people-import" role="group" aria-label="담당에서 찾기">
      <div class="people-import-head">
        <b>에셋 담당에서 찾기</b>
        <span class="small faint">에셋 담당 칸(제작 리스트 가져오기 · 직접 입력)에 적힌 이름 중 명단에 없는 사람입니다. 소속팀은 가장 많이 맡은 파트를 제안합니다.</span>
        <button type="button" class="btn ghost icon-btn" aria-label="담당에서 찾기 닫기" onClick={props.onClose}><IconX /></button>
      </div>
      {list.length === 0 ? <p class="small muted">명단에 없는 담당이 없습니다. 에셋 담당 칸이 모두 명단의 이름입니다.</p> : (
        <>
          <div class="table-wrap ref-wrap">
            <table class="grid ref people-import-table">
              <colgroup><col style="width: 44px" /><col style="width: 200px" /><col style="width: 170px" /><col /></colgroup>
              <thead><tr><th class="c"><input type="checkbox" aria-label="모두 고르기" checked={off.size === 0} onChange={e => setOff((e.target as HTMLInputElement).checked ? new Set() : new Set(list.map(c => c.name)))} /></th><th>이름</th><th>소속팀</th><th>맡은 칸</th></tr></thead>
              <tbody>
                {list.map(c => (
                  <tr class={`row${off.has(c.name) ? ' off' : ''}`}>
                    <td class="c"><input type="checkbox" aria-label={`${c.name} 고르기`} checked={!off.has(c.name)} onChange={() => setOff(s => { const n = new Set(s); if (n.has(c.name)) n.delete(c.name); else n.add(c.name); return n; })} /></td>
                    <td><b>{c.name}</b></td>
                    <td><TeamPick value={teamOf(c)} teams={props.teams} label={`${c.name} 소속팀`} onChange={v => setTeam(t => ({ ...t, [c.name]: v }))} /></td>
                    <td class="small muted">{c.assets}칸{c.parts.length ? ` · ${c.parts.map(p => `${p.name} ${p.n}`).join(', ')}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="dialog-foot">
            <span class="small faint">더한 뒤 이메일 · 특이사항은 표에서 넣습니다. 변경 이력에서 한 번에 되돌릴 수 있습니다.</span>
            <button type="button" class="btn sm primary" disabled={!picked.length} onClick={() => void add()}><IconPlus />선택한 {picked.length}명 더하기</button>
          </div>
        </>
      )}
    </div>
  );
}

const STATUS: Record<PasteRow['status'], { label: string; cls: string }> = {
  new: { label: '새로 더함', cls: 'ok' },
  fill: { label: '있음 · 이메일 채움', cls: 'accent' },
  exists: { label: '이미 있음', cls: '' },
  dup: { label: '겹침', cls: 'warn' },
  bad: { label: '고칠 것', cls: 'bad' },
};

/** B. 표 붙여넣기 */
export function PeoplePaste(props: { people: Person[]; teams: TeamOption[]; apply: (e: Edit) => Promise<boolean>; onClose: () => void }) {
  const [text, setText] = useState('');
  const [off, setOff] = useState<Set<number>>(new Set());
  const [choice, setChoice] = useState<Record<number, string>>({});
  const parsed = useMemo(() => parsePeopleText(text, props.teams.map(t => t.name), props.people), [text, props.teams, props.people]);
  const usable = (r: PasteRow) => r.status === 'new' || r.status === 'fill';
  const teamOf = (r: PasteRow) => choice[r.line] ?? (r.teamKnown ? r.team ?? '' : '');
  const picked = parsed.rows.filter(r => usable(r) && !off.has(r.line));
  const adds = picked.filter(r => r.status === 'new');
  const fills = picked.filter(r => r.status === 'fill');
  const add = async () => {
    const newTeams = [...new Set(adds.filter(r => teamOf(r) === NEW_TEAM).map(r => r.team!))];
    const ok = await props.apply({
      kind: 'createPeople', newTeams,
      people: adds.map(r => ({ name: r.name, team: teamOf(r) === NEW_TEAM ? r.team : teamOf(r) || null, email: r.email, note: r.note })),
      fillEmails: fills.map(r => ({ personId: r.personId!, email: r.email! })),
    });
    if (ok) props.onClose();
  };
  return (
    <div class="people-import" role="group" aria-label="붙여넣기">
      <div class="people-import-head">
        <b>표 붙여넣기</b>
        <span class="small faint">엑셀 · 구글 시트(Jira CSV는 엑셀로 열어서)에서 표를 복사해 붙여넣습니다. 첫 줄이 머리글(이름 · 소속팀 · 이메일 · 특이사항)이면 열을 맞추고, 아니면 이 순서로 읽습니다. 글은 이 파일 안에서만 씁니다.</span>
        <button type="button" class="btn ghost icon-btn" aria-label="붙여넣기 닫기" onClick={props.onClose}><IconX /></button>
      </div>
      <textarea class="field people-paste" aria-label="붙여넣을 표" rows={5} placeholder={'이름\t소속팀\t이메일\t특이사항\n김하나\t원화\thana@example.com\t'} value={text}
        onInput={e => { setText((e.target as HTMLTextAreaElement).value); setOff(new Set()); setChoice({}); }} />
      {parsed.rows.length > 0 && (
        <>
          <p class="small muted" role="status">{parsed.header ? '머리글로 열을 맞췄습니다' : '머리글이 없어 이름 · 소속팀 · 이메일 · 특이사항 순서로 읽었습니다'} · {parsed.rows.length}줄
            (새로 {parsed.rows.filter(r => r.status === 'new').length} · 이메일 채움 {parsed.rows.filter(r => r.status === 'fill').length} · 이미 있음 {parsed.rows.filter(r => r.status === 'exists').length} · 고칠 것 {parsed.rows.filter(r => r.status === 'bad' || r.status === 'dup').length})</p>
          <div class="table-wrap ref-wrap">
            <table class="grid ref people-import-table">
              <colgroup><col style="width: 44px" /><col style="width: 52px" /><col style="width: 160px" /><col style="width: 200px" /><col style="width: 210px" /><col /><col style="width: 130px" /></colgroup>
              <thead><tr><th aria-label="고르기" /><th class="n">줄</th><th>이름</th><th>소속팀</th><th>이메일</th><th>특이사항</th><th>상태</th></tr></thead>
              <tbody>
                {parsed.rows.map(r => (
                  <tr class={`row${usable(r) && !off.has(r.line) ? '' : ' off'}`}>
                    <td class="c">{usable(r) && <input type="checkbox" aria-label={`${r.name} 고르기`} checked={!off.has(r.line)} onChange={() => setOff(s => { const n = new Set(s); if (n.has(r.line)) n.delete(r.line); else n.add(r.line); return n; })} />}</td>
                    <td class="n num faint">{r.line}</td>
                    <td><b>{r.name}</b></td>
                    <td>{r.status === 'new'
                      ? <TeamPick value={teamOf(r)} teams={props.teams} label={`${r.name} 소속팀`} extra={r.teamKnown ? null : r.team} onChange={v => setChoice(c => ({ ...c, [r.line]: v }))} />
                      : <span class="small muted">{r.team ?? ''}</span>}
                      {r.status === 'new' && !r.teamKnown && <span class="small warn-text people-team-miss">목록에 없음: {r.team}</span>}</td>
                    <td class="small">{r.email ?? ''}</td>
                    <td class="small muted">{r.note ?? ''}</td>
                    <td><span class={`pill plain ${STATUS[r.status].cls}`} title={r.problem ?? undefined}>{STATUS[r.status].label}</span>{r.problem && <span class="small faint people-problem">{r.problem}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="dialog-foot">
            <span class="small faint">이미 있는 사람은 바꾸지 않습니다(이메일이 비어 있으면 채우기만). 변경 이력에서 한 번에 되돌릴 수 있습니다.</span>
            <button type="button" class="btn sm primary" disabled={!picked.length} onClick={() => void add()}><IconPlus />{adds.length}명 더하기{fills.length ? ` · 이메일 ${fills.length}명 채우기` : ''}</button>
          </div>
        </>
      )}
    </div>
  );
}
