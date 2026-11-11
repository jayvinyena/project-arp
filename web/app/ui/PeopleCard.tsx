// 작업자 명단(docs/24-people.md): 팀별로 묶어 보기 · 찾기 · 팀 거르기 · 한 번에 더하기 · 참여 스위치.
// 소속팀은 목록(파트 + 지원 팀)에서만 고른다. 지원 팀은 "팀" 단추로 더하고, 파트는 기준 정보에서 더한다.
// 칸은 눌러서 바로 고치고(벗어나면 저장), 모든 고치기는 변경 이력에서 되돌린다.
import { Dialog } from './Dialog.tsx';
import { useState } from 'preact/hooks';
import type { AssigneeCandidate, Person, TeamOption } from '../../../core/people.ts';
import { AssigneeFinder, PeoplePaste } from './PeopleImport.tsx';
import type { Edit } from '../../../core/edits.ts';
import { Field } from './SetupPage.tsx';
import { IconPlus, IconX } from './icons.tsx';

const NO_TEAM = '소속팀 없음';
const OFF = '\u0000off';
/** 팀마다 같은 색(이름 머리글자 동그라미). 6색을 돌려 쓴다 */
const hue = (team: string | null, teams: string[]) => `av-${Math.max(0, teams.indexOf(team ?? NO_TEAM)) % 6}`;

/** 소속팀 고르기: 파트 · 지원 팀 묶음. 목록에 없는 옛 값은 그대로 보여 주고 고치게 한다 */
function TeamSelect(props: { value: string; teams: TeamOption[]; label: string; disabled?: boolean; class?: string; onChange: (v: string) => void }) {
  const parts = props.teams.filter(t => t.kind === 'part');
  const support = props.teams.filter(t => t.kind === 'support');
  const known = props.teams.some(t => t.name === props.value);
  return (
    <select class={props.class ?? 'field'} aria-label={props.label} value={props.value} disabled={props.disabled} onChange={e => props.onChange((e.target as HTMLSelectElement).value)}>
      <option value="">소속팀 없음</option>
      {props.value && !known && <option value={props.value}>{props.value} (목록에 없음)</option>}
      <optgroup label="파트">{parts.map(t => <option value={t.name}>{t.name}{t.active ? '' : ' (사용 안 함)'}</option>)}</optgroup>
      {support.length > 0 && <optgroup label="지원 팀">{support.map(t => <option value={t.name}>{t.name}</option>)}</optgroup>}
    </select>
  );
}

export function PeopleCard(props: { people: Person[]; candidates: AssigneeCandidate[]; teams: TeamOption[]; readOnly: boolean; apply: (e: Edit) => Promise<boolean> }) {
  const { people, readOnly: ro, apply } = props;
  const [panel, setPanel] = useState<'find' | 'paste' | null>(null);
  /** 이름 바꾸기: 그 이름이 에셋 담당에 있으면 함께 바꿀지 묻는다(docs/31) */
  const [rename, setRename] = useState<{ person: Person; to: string } | null>(null);
  const doRename = (also: boolean) => { const r = rename!; setRename(null); void apply({ kind: 'personField', personId: r.person.personId, field: 'name', value: r.to, alsoAssignee: also }); };
  const [q, setQ] = useState('');
  const [team, setTeam] = useState('all');
  const [add, setAdd] = useState({ name: '', team: '', email: '', note: '' });
  const [teamPanel, setTeamPanel] = useState(false);
  const [newTeam, setNewTeam] = useState('');
  const teamOf = (p: Person) => p.team ?? NO_TEAM;
  const teams = [...new Set(people.map(teamOf))];
  const active = people.filter(p => p.active);
  const off = people.length - active.length;
  const query = q.trim().toLowerCase();
  const shown = people.filter(p => (team === 'all' ? true : team === OFF ? !p.active : teamOf(p) === team)
    && (!query || [p.name, p.team, p.email, p.note].some(x => (x ?? '').toLowerCase().includes(query))));
  const groups = teams.map(t => ({ team: t, rows: shown.filter(p => teamOf(p) === t) })).filter(g => g.rows.length);
  const set = (k: keyof typeof add) => (e: Event) => { const v = (e.target as HTMLInputElement).value; setAdd(a => ({ ...a, [k]: v })); };
  const create = async () => {
    if (!add.name.trim()) return;
    if (await apply({ kind: 'createPerson', name: add.name, team: add.team || null, email: add.email || null, note: add.note || null })) setAdd(a => ({ name: '', team: a.team, email: '', note: '' }));
  };
  const enter = (e: KeyboardEvent) => { if (e.key === 'Enter') void create(); };
  const addTeam = async () => {
    const name = newTeam.trim();
    if (!name) return;
    if (await apply({ kind: 'createTeam', name })) { setNewTeam(''); setAdd(a => ({ ...a, team: name })); }
  };
  const support = props.teams.filter(t => t.kind === 'support');
  const chip = (key: string, label: string, n: number) => (
    <button type="button" role="radio" aria-checked={team === key} class={`people-chip${team === key ? ' on' : ''}`} onClick={() => setTeam(key)}>{label}<span class="people-chip-n">{n}</span></button>
  );

  return (
    <section class="card people-card">
      <div class="card-head people-head">
        <div><h2>작업자 명단</h2>
          <p class="small muted" style="margin-top: 2px">참여 중 <b>{active.length}명</b> · 에셋 담당 칸에서 이름을 고를 때 씁니다. 계산하는 인원은 "파트 × 달 인력" 탭의 숫자입니다.</p></div>
        <div class="people-head-tools">
          {!ro && <>
            <button type="button" class={`btn sm${panel === 'find' ? ' on' : ''}`} aria-expanded={panel === 'find'} title="에셋 담당 칸에 적힌 이름 중 명단에 없는 사람을 찾아 더합니다"
              onClick={() => setPanel(p => (p === 'find' ? null : 'find'))}>담당에서 찾기{props.candidates.length > 0 && <span class="people-chip-n">{props.candidates.length}</span>}</button>
            <button type="button" class={`btn sm${panel === 'paste' ? ' on' : ''}`} aria-expanded={panel === 'paste'} title="엑셀 · 구글 시트에서 복사한 표를 붙여넣어 여러 명을 더합니다"
              onClick={() => setPanel(p => (p === 'paste' ? null : 'paste'))}>붙여넣기</button>
          </>}
          <input class="field people-search" type="search" aria-label="작업자 찾기" placeholder="이름 · 팀 · 이메일 · 특이사항 찾기" value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />
        </div>
      </div>
      <div class="card-body" style="padding-top: 4px">
        {people.length > 0 && (
          <div class="people-chips" role="radiogroup" aria-label="팀 거르기">
            {chip('all', '전체', people.length)}
            {teams.map(t => chip(t, t, people.filter(p => teamOf(p) === t).length))}
            {off > 0 && chip(OFF, '빠진 사람', off)}
          </div>
        )}

        {!ro && (
          <div class="people-add" role="group" aria-label="작업자 더하기">
            <input class="field" aria-label="새 작업자 이름" placeholder="이름 *" value={add.name} onInput={set('name')} onKeyDown={enter} />
            <span class="people-team-pick">
              <TeamSelect value={add.team} teams={props.teams} label="새 작업자 소속팀" onChange={v => setAdd(a => ({ ...a, team: v }))} />
              <button type="button" class={`btn sm${teamPanel ? ' on' : ''}`} aria-expanded={teamPanel} title="목록에 없는 팀(PM · 기획 등)을 더합니다" onClick={() => setTeamPanel(x => !x)}><IconPlus />팀</button>
            </span>
            <input class="field" type="email" aria-label="새 작업자 이메일" placeholder="이메일(선택)" value={add.email} onInput={set('email')} onKeyDown={enter} />
            <input class="field" aria-label="새 작업자 특이사항" placeholder="특이사항(선택)" title="예: 12월 휴가 · 신규 입사 · 외주" value={add.note} onInput={set('note')} onKeyDown={enter} />
            <button type="button" class="btn sm primary" disabled={!add.name.trim()} onClick={() => void create()}><IconPlus />작업자 더하기</button>
          </div>
        )}

        {!ro && panel === 'find' && <AssigneeFinder candidates={props.candidates} teams={props.teams} apply={apply} onClose={() => setPanel(null)} />}
        {!ro && panel === 'paste' && <PeoplePaste people={people} teams={props.teams} apply={apply} onClose={() => setPanel(null)} />}

        {!ro && teamPanel && (
          <div class="people-teams" role="group" aria-label="소속팀 관리">
            <div class="people-teams-row">
              <span class="small faint">파트</span>
              {props.teams.filter(t => t.kind === 'part').map(t => <span class="team-tag part">{t.name}</span>)}
              <span class="small faint people-teams-note">파트는 기준 정보 › 프로젝트·파트·리소스에서 더합니다(제작 공정 · 계산에 들어감).</span>
            </div>
            <div class="people-teams-row">
              <span class="small faint">지원 팀</span>
              {support.length === 0 && <span class="small faint">아직 없습니다</span>}
              {support.map(t => (
                <span class="team-tag">{t.name}<span class="team-tag-n">{t.used}</span>
                  <button type="button" class="team-tag-x" aria-label={`${t.name} 팀 지우기`} disabled={t.used > 0}
                    title={t.used > 0 ? `이 팀에 작업자가 ${t.used}명 있어 지울 수 없습니다` : '팀 지우기'} onClick={() => void apply({ kind: 'deleteTeam', teamId: t.teamId! })}><IconX /></button>
                </span>
              ))}
              <input class="field" aria-label="새 지원 팀 이름" placeholder="새 팀 이름(예: PM · 기획)" maxLength={30} value={newTeam}
                onInput={e => setNewTeam((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter') void addTeam(); }} />
              <button type="button" class="btn sm" disabled={!newTeam.trim()} onClick={() => void addTeam()}>팀 더하기</button>
            </div>
          </div>
        )}

        {people.length === 0 ? (
          <div class="people-empty">
            <b>아직 작업자가 없습니다</b>
            <p class="small muted">{ro ? '편집하는 사람이 작업자를 더하면 여기에 보입니다.' : '위 칸에 이름과 소속팀을 넣고 Enter를 누릅니다. 이메일 · 특이사항은 나중에 표에서 넣어도 됩니다.'}</p>
          </div>
        ) : groups.length === 0 ? (
          <div class="people-empty"><p class="small muted">조건에 맞는 작업자가 없습니다.</p>
            <button type="button" class="btn sm ghost" onClick={() => { setQ(''); setTeam('all'); }}>거르기 풀기</button></div>
        ) : (
          <div class="table-wrap ref-wrap">
            <table class="grid edit ref people-table">
              <colgroup><col style="width: 200px" /><col style="width: 156px" /><col style="width: 240px" /><col /><col style="width: 104px" /><col style="width: 44px" /></colgroup>
              <thead><tr><th>이름</th><th>소속팀</th><th>이메일</th><th>특이사항</th><th>참여</th><th aria-label="행 작업" /></tr></thead>
              <tbody>
                {groups.map(g => (
                  <>
                    <tr class="group group-strong"><td colSpan={6}><span class="group-head"><span class={`people-dot ${hue(g.team, teams)}`} /><b>{g.team}</b><span class="group-count">{g.rows.length}</span></span></td></tr>
                    {g.rows.map(p => (
                      <tr class={`row${p.active ? '' : ' off'}`}>
                        <td><span class="people-name"><span class={`people-av ${hue(p.team, teams)}`} aria-hidden="true">{p.name.slice(0, 1)}</span>
                          <Field class="field ghost-field" value={p.name} label={`${p.name} 이름`} disabled={ro}
                            onCommit={t => { if (p.assigned > 0 && t.trim() && t.trim() !== p.name) { setRename({ person: p, to: t.trim() }); return false; } return apply({ kind: 'personField', personId: p.personId, field: 'name', value: t }); }} /></span></td>
                        <td><TeamSelect class="field ghost-field" value={p.team ?? ''} teams={props.teams} label={`${p.name} 소속팀`} disabled={ro} onChange={v => void apply({ kind: 'personField', personId: p.personId, field: 'team', value: v })} /></td>
                        <td><Field class="field ghost-field" value={p.email ?? ''} label={`${p.name} 이메일`} placeholder="name@company.com" disabled={ro} onCommit={t => apply({ kind: 'personField', personId: p.personId, field: 'email', value: t })} /></td>
                        <td><Field class="field ghost-field" value={p.note ?? ''} label={`${p.name} 특이사항`} placeholder="특이사항" disabled={ro} onCommit={t => apply({ kind: 'personField', personId: p.personId, field: 'note', value: t })} /></td>
                        <td>
                          <label class={`switch${p.active ? ' on' : ''}`} title={p.active ? '참여 중: 담당 고르기에 나옵니다' : '빠짐: 담당 고르기에서 빠집니다(기록은 남음)'}>
                            <input type="checkbox" role="switch" aria-label={`${p.name} 참여`} checked={p.active} disabled={ro}
                              onChange={e => void apply({ kind: 'personField', personId: p.personId, field: 'active', value: (e.target as HTMLInputElement).checked ? '1' : '0' })} />
                            <span class="switch-track" aria-hidden="true" /><span class="switch-text">{p.active ? '참여' : '빠짐'}</span>
                          </label>
                        </td>
                        <td class="n">{!ro && <button type="button" class="btn ghost icon-btn people-del" aria-label={`${p.name} 지우기`} title="지우기(변경 이력에서 되돌릴 수 있습니다). 그만둔 사람은 지우지 말고 참여를 끄면 기록이 남습니다" onClick={() => void apply({ kind: 'deletePerson', personId: p.personId })}><IconX /></button>}</td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {rename && (
        <Dialog label="작업자 이름 바꾸기" onClose={() => setRename(null)} class="confirm-dialog">
            <h2 style="font-size: 16px">에셋 담당 이름도 바꿀까요?</h2>
            <p class="small muted" style="margin: 8px 0 14px">"{rename.person.name}"이(가) 에셋 담당 <b>{rename.person.assigned}칸</b>에 적혀 있습니다. 함께 "{rename.to}"(으)로 바꾸면 담당 이름과 명단이 계속 맞습니다. 변경 이력에서 한 번에 되돌릴 수 있습니다.</p>
            <div class="inline" style="justify-content: flex-end">
              <button type="button" class="btn sm ghost" onClick={() => setRename(null)}>그만두기</button>
              <button type="button" class="btn sm" onClick={() => doRename(false)}>명단만 바꾸기</button>
              <button type="button" class="btn sm primary" onClick={() => doRename(true)}>담당도 바꾸기</button>
            </div>
          </Dialog>
      )}
    </section>
  );
}
