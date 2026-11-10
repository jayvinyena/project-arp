// 작업자 명단(docs/24-people.md): 팀별로 묶어 보기 · 찾기 · 팀 거르기 · 한 번에 더하기 · 참여 스위치.
// 칸은 눌러서 바로 고치고(벗어나면 저장), 모든 고치기는 변경 이력에서 되돌린다.
import { useState } from 'preact/hooks';
import type { Person } from '../../../core/people.ts';
import type { Edit } from '../../../core/edits.ts';
import { Field } from './SetupPage.tsx';
import { IconPlus, IconX } from './icons.tsx';

const NO_TEAM = '소속팀 없음';
const OFF = '\u0000off';
/** 팀마다 같은 색(이름 머리글자 동그라미). 6색을 돌려 쓴다 */
const hue = (team: string | null, teams: string[]) => `av-${Math.max(0, teams.indexOf(team ?? NO_TEAM)) % 6}`;

export function PeopleCard(props: { people: Person[]; parts: string[]; readOnly: boolean; apply: (e: Edit) => Promise<boolean> }) {
  const { people, readOnly: ro, apply } = props;
  const [q, setQ] = useState('');
  const [team, setTeam] = useState('all');
  const [add, setAdd] = useState({ name: '', team: '', email: '', note: '' });
  const teamOf = (p: Person) => p.team ?? NO_TEAM;
  const teams = [...new Set(people.map(teamOf))];
  const suggest = [...new Set([...props.parts, ...people.map(p => p.team).filter(Boolean) as string[]])];
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
  const chip = (key: string, label: string, n: number) => (
    <button type="button" role="radio" aria-checked={team === key} class={`people-chip${team === key ? ' on' : ''}`} onClick={() => setTeam(key)}>{label}<span class="people-chip-n">{n}</span></button>
  );

  return (
    <section class="card people-card">
      <div class="card-head people-head">
        <div><h2>작업자 명단</h2>
          <p class="small muted" style="margin-top: 2px">참여 중 <b>{active.length}명</b> · 에셋 담당 칸에서 이름을 고를 때 씁니다. 계산하는 인원은 "파트 × 달 인력" 탭의 숫자입니다.</p></div>
        <input class="field people-search" type="search" aria-label="작업자 찾기" placeholder="이름 · 팀 · 이메일 · 특이사항 찾기" value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />
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
            <datalist id="people-teams">{suggest.map(t => <option value={t} />)}</datalist>
            <input class="field" aria-label="새 작업자 이름" placeholder="이름 *" value={add.name} onInput={set('name')} onKeyDown={enter} />
            <input class="field" aria-label="새 작업자 소속팀" placeholder="소속팀(예: 원화)" list="people-teams" value={add.team} onInput={set('team')} onKeyDown={enter} />
            <input class="field" type="email" aria-label="새 작업자 이메일" placeholder="이메일(선택)" value={add.email} onInput={set('email')} onKeyDown={enter} />
            <input class="field" aria-label="새 작업자 특이사항" placeholder="특이사항(선택, 예: 12월 휴가)" value={add.note} onInput={set('note')} onKeyDown={enter} />
            <button type="button" class="btn sm primary" disabled={!add.name.trim()} onClick={() => void create()}><IconPlus />작업자 더하기</button>
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
              <colgroup><col style="width: 210px" /><col style="width: 140px" /><col style="width: 250px" /><col /><col style="width: 104px" /><col style="width: 44px" /></colgroup>
              <thead><tr><th>이름</th><th>소속팀</th><th>이메일</th><th>특이사항</th><th>참여</th><th aria-label="행 작업" /></tr></thead>
              <tbody>
                {groups.map(g => (
                  <>
                    <tr class="group group-strong"><td colSpan={6}><span class="group-head"><span class={`people-dot ${hue(g.team, teams)}`} /><b>{g.team}</b><span class="group-count">{g.rows.length}</span></span></td></tr>
                    {g.rows.map(p => (
                      <tr class={`row${p.active ? '' : ' off'}`}>
                        <td><span class="people-name"><span class={`people-av ${hue(p.team, teams)}`} aria-hidden="true">{p.name.slice(0, 1)}</span>
                          <Field class="field ghost-field" value={p.name} label={`${p.name} 이름`} disabled={ro} onCommit={t => apply({ kind: 'personField', personId: p.personId, field: 'name', value: t })} /></span></td>
                        <td><Field class="field ghost-field" value={p.team ?? ''} label={`${p.name} 소속팀`} list="people-teams" placeholder="소속팀" disabled={ro} onCommit={t => apply({ kind: 'personField', personId: p.personId, field: 'team', value: t })} /></td>
                        <td><Field class="field ghost-field" value={p.email ?? ''} label={`${p.name} 이메일`} placeholder="name@company.com" disabled={ro} onCommit={t => apply({ kind: 'personField', personId: p.personId, field: 'email', value: t })} /></td>
                        <td><Field class="field ghost-field" value={p.note ?? ''} label={`${p.name} 특이사항`} placeholder="예: 12월 휴가 · 신규 입사 · 외주" disabled={ro} onCommit={t => apply({ kind: 'personField', personId: p.personId, field: 'note', value: t })} /></td>
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
    </section>
  );
}
