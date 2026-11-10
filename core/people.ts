// 작업자 명단(docs/24-people.md): 이름 · 소속팀 · 이메일 · 특이사항 · 참여 여부.
// 계산에는 쓰지 않는다(인원은 인력 표의 파트 × 달 숫자). 에셋 담당 칸에서 이름을 고를 때 쓴다. 모든 고치기는 이력에 남고 되돌릴 수 있다.
import type { SqlDb } from './db.ts';
import type { EditContext, EditResult } from './edits.ts';
import { log, nextId, fail } from './edits.ts';
import { nameKey } from './people-paste.ts';

export type PersonField = 'name' | 'team' | 'email' | 'note' | 'active';
export interface NewPerson { name: string; team?: string | null; email?: string | null; note?: string | null }
export type PeopleEdit =
  | { kind: 'createPerson'; name: string; team?: string | null; email?: string | null; note?: string | null }
  /** 여러 명 한 번에(담당에서 찾기 · 붙여넣기, docs/31). 이미 있는 이름은 건너뛴다. newTeams = 먼저 만들 지원 팀, fillEmails = 이미 있는 사람의 빈 이메일 채우기 */
  | { kind: 'createPeople'; people: NewPerson[]; newTeams?: string[]; fillEmails?: { personId: string; email: string }[] }
  /** alsoAssignee: 이름을 바꿀 때 같은 이름의 에셋 담당도 함께(docs/31) */
  | { kind: 'personField'; personId: string; field: PersonField; value: string | null; alsoAssignee?: boolean }
  | { kind: 'deletePerson'; personId: string }
  /** 지원 팀(PM · 기획 등 파트가 아닌 팀). 파트는 기준 정보에서 */
  | { kind: 'createTeam'; name: string }
  | { kind: 'deleteTeam'; teamId: string };
export const PEOPLE_EDIT_KINDS = new Set<string>(['createPerson', 'createPeople', 'personField', 'deletePerson', 'createTeam', 'deleteTeam']);

/** 소속팀으로 고를 수 있는 것: 파트(공정 순) + 지원 팀. used = 그 팀 작업자 수 */
export interface TeamOption { name: string; kind: 'part' | 'support'; teamId: string | null; active: boolean; used: number }
export function teamOptions(db: SqlDb): TeamOption[] {
  const used = new Map(db.all('SELECT team, count(*) AS n FROM people WHERE team IS NOT NULL GROUP BY team').map(r => [String(r.team), Number(r.n)]));
  return [
    ...db.all('SELECT part_id, name, active FROM parts ORDER BY active DESC, sort_order').map(r => ({ name: String(r.name), kind: 'part' as const, teamId: null, active: Number(r.active) === 1, used: used.get(String(r.name)) ?? 0 })),
    ...db.all('SELECT team_id, name FROM teams ORDER BY sort_order, team_id').map(r => ({ name: String(r.name), kind: 'support' as const, teamId: String(r.team_id), active: true, used: used.get(String(r.name)) ?? 0 })),
  ];
}
/** 소속팀 값 검사: 비우거나 목록(파트 · 지원 팀)에 있는 이름만 */
function checkTeam(db: SqlDb, team: string | null): string | null {
  if (!team) return null;
  if (!teamOptions(db).some(t => t.name === team)) fail(`"${team}"은(는) 소속팀 목록에 없습니다. 파트는 기준 정보에서, 그 밖의 팀은 "팀 추가"로 먼저 더하십시오.`);
  return team;
}

/** assigned = 이 이름이 담당으로 적힌 에셋 칸 수(이름 바꾸기 때 함께 바꿀지 묻는다) */
export interface Person { personId: string; name: string; team: string | null; email: string | null; note: string | null; active: boolean; assigned: number }

/** 에셋 담당 이름별 칸 수(이름 같음 판정 키로) */
function assigneeCounts(db: SqlDb): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db.all('SELECT assignee, count(*) AS n FROM asset_parts WHERE assignee IS NOT NULL GROUP BY assignee')) {
    const k = nameKey(String(r.assignee));
    if (k) out.set(k, (out.get(k) ?? 0) + Number(r.n));
  }
  return out;
}

/** 명단에 없는 에셋 담당(docs/31 A): 이름(가장 많이 쓴 표기) · 소속팀 제안(가장 많이 맡은 사용 중 파트) · 맡은 칸 수 · 파트별 수 */
export interface AssigneeCandidate { name: string; team: string | null; assets: number; parts: { name: string; n: number }[] }
export function assigneeCandidates(db: SqlDb): AssigneeCandidate[] {
  const known = new Set(db.all('SELECT name FROM people').map(r => nameKey(String(r.name))));
  const by = new Map<string, { spell: Map<string, number>; parts: Map<string, number>; n: number }>();
  for (const r of db.all(`SELECT ap.assignee, p.name AS part, p.active, count(*) AS n FROM asset_parts ap JOIN parts p ON p.part_id = ap.part_id
      WHERE ap.assignee IS NOT NULL GROUP BY ap.assignee, p.part_id ORDER BY p.sort_order`)) {
    const raw = String(r.assignee).trim().replace(/\s+/g, ' ');
    const k = nameKey(raw);
    if (!k || known.has(k)) continue;
    if (!by.has(k)) by.set(k, { spell: new Map(), parts: new Map(), n: 0 });
    const x = by.get(k)!;
    const n = Number(r.n);
    x.n += n;
    x.spell.set(raw, (x.spell.get(raw) ?? 0) + n);
    if (Number(r.active) === 1) x.parts.set(String(r.part), (x.parts.get(String(r.part)) ?? 0) + n);
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return [...by.values()].map(x => ({
    name: top(x.spell)!, team: top(x.parts), assets: x.n,
    parts: [...x.parts].map(([name, n]) => ({ name, n })),
  })).sort((a, b) => b.assets - a.assets || a.name.localeCompare(b.name, 'ko'));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: string | null | undefined) => { const t = (v ?? '').trim(); return t ? t : null; };

/** 소속팀 순: 파트(공정 순) → 지원 팀(더한 순) → 목록에 없는 값 → 소속팀 없음. 팀 안에서는 더한 순 */
export function peopleList(db: SqlDb): Person[] {
  const counts = assigneeCounts(db);
  return db.all(`SELECT x.* FROM people x LEFT JOIN parts p ON p.name = x.team LEFT JOIN teams t ON t.name = x.team
      ORDER BY CASE WHEN x.team IS NULL OR x.team = '' THEN 3 WHEN p.part_id IS NOT NULL THEN 0 WHEN t.team_id IS NOT NULL THEN 1 ELSE 2 END,
        p.sort_order, t.sort_order, x.team, x.sort_order, x.person_id`).map(r => ({
    personId: String(r.person_id), name: String(r.name), team: (r.team as string) ?? null, email: (r.email as string) ?? null,
    note: (r.note as string) ?? null, active: Number(r.active) === 1, assigned: counts.get(nameKey(String(r.name))) ?? 0,
  }));
}

export function applyPeopleEdit(db: SqlDb, edit: PeopleEdit, ctx: EditContext): EditResult {
  switch (edit.kind) {
    case 'createPerson': {
      const name = clean(edit.name);
      if (!name) fail('이름을 입력하십시오.');
      if (name!.length > 40) fail('이름은 40자 이하입니다.');
      const email = clean(edit.email);
      if (email && !EMAIL.test(email)) fail('이메일 형식이 올바르지 않습니다(예: name@company.com).');
      const note = (edit.note ?? '').replace(/\s+$/, '') || null;
      if (note && note.length > 1000) fail('특이사항은 1천 자 이하입니다.');
      const id = nextId(db, 'people', 'person_id', 'P', 3);
      const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM people')?.s ?? 0) + 1;
      const row = { person_id: id, name, team: checkTeam(db, clean(edit.team)), email, note, active: 1, sort_order: sortOrder };
      db.run('INSERT INTO people (person_id, name, team, email, note, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)', Object.values(row));
      log(db, ctx, 'INSERT', 'people', id, null, undefined, row);
      return { changed: true, createdId: id };
    }
    case 'createPeople': {
      // 지원 팀 먼저(이미 있거나 파트 이름이면 건너뜀), 그다음 사람(이미 있는 이름 · 겹친 이름은 건너뜀), 마지막으로 빈 이메일 채우기
      let teams = 0;
      for (const t of edit.newTeams ?? []) {
        const name = clean(t);
        if (!name || db.get('SELECT 1 AS ok FROM parts WHERE name = ?', [name]) || db.get('SELECT 1 AS ok FROM teams WHERE name = ?', [name])) continue;
        applyPeopleEdit(db, { kind: 'createTeam', name }, ctx);
        teams += 1;
      }
      const known = new Set(db.all('SELECT name FROM people').map(r => nameKey(String(r.name))));
      let added = 0;
      let skipped = 0;
      for (const p of edit.people) {
        const k = nameKey(p.name ?? '');
        if (!k || known.has(k)) { skipped += 1; continue; }
        applyPeopleEdit(db, { kind: 'createPerson', ...p, name: p.name.trim().replace(/\s+/g, ' ') }, ctx);
        known.add(k);
        added += 1;
      }
      let filled = 0;
      for (const f of edit.fillEmails ?? []) {
        const cur = db.get('SELECT email FROM people WHERE person_id = ?', [f.personId]);
        if (!cur || cur.email) continue;
        if (applyPeopleEdit(db, { kind: 'personField', personId: f.personId, field: 'email', value: f.email }, ctx).changed) filled += 1;
      }
      const note = [added ? `${added}명 더함` : '', filled ? `이메일 ${filled}명 채움` : '', teams ? `지원 팀 ${teams}개 만듦` : '', skipped ? `이미 있는 ${skipped}명 건너뜀` : ''].filter(Boolean).join(' · ');
      return { changed: added + filled + teams > 0, ...(note ? { note } : {}) } as EditResult;
    }
    case 'personField': {
      const before = db.get('SELECT * FROM people WHERE person_id = ?', [edit.personId]) ?? fail('없는 작업자입니다.');
      let value: string | number | null;
      if (edit.field === 'active') value = edit.value === '1' || edit.value === 'true' ? 1 : 0;
      else if (edit.field === 'note') value = (edit.value ?? '').replace(/\s+$/, '') || null;
      else value = clean(edit.value);
      if (edit.field === 'team') value = checkTeam(db, value as string | null);
      if (edit.field === 'name' && !value) fail('이름은 비울 수 없습니다.');
      if (edit.field === 'name' && String(value).length > 40) fail('이름은 40자 이하입니다.');
      if (edit.field === 'email' && value && !EMAIL.test(String(value))) fail('이메일 형식이 올바르지 않습니다(예: name@company.com).');
      if (edit.field === 'note' && value && String(value).length > 1000) fail('특이사항은 1천 자 이하입니다.');
      const old = before[edit.field] ?? null;
      if (old === value || (old != null && value != null && String(old) === String(value))) return { changed: false };
      db.run(`UPDATE people SET ${edit.field} = ? WHERE person_id = ?`, [value, edit.personId]);
      log(db, ctx, 'UPDATE', 'people', edit.personId, edit.field, old, value);
      if (edit.field === 'name' && edit.alsoAssignee && old) {
        // 같은 이름(공백 · 대소문자 무시)의 에셋 담당도 새 이름으로 — 같은 이력 묶음이라 한 번에 되돌린다
        const k = nameKey(String(old));
        for (const r of db.all('SELECT asset_id, part_id, assignee FROM asset_parts WHERE assignee IS NOT NULL')) {
          if (nameKey(String(r.assignee)) !== k || r.assignee === value) continue;
          db.run('UPDATE asset_parts SET assignee = ? WHERE asset_id = ? AND part_id = ?', [value, r.asset_id, r.part_id]);
          log(db, ctx, 'UPDATE', 'asset_parts', `${r.asset_id}|${r.part_id}`, 'assignee', r.assignee, value);
        }
      }
      return { changed: true };
    }
    case 'deletePerson': {
      const old = db.get('SELECT * FROM people WHERE person_id = ?', [edit.personId]);
      if (!old) return { changed: false };
      db.run('DELETE FROM people WHERE person_id = ?', [edit.personId]);
      log(db, ctx, 'DELETE', 'people', edit.personId, null, old, undefined);
      return { changed: true };
    }
    case 'createTeam': {
      const name = clean(edit.name);
      if (!name) fail('팀 이름을 입력하십시오.');
      if (name!.length > 30) fail('팀 이름은 30자 이하입니다.');
      if (db.get('SELECT 1 AS ok FROM parts WHERE name = ?', [name])) fail(`"${name}"은(는) 이미 파트입니다. 목록에서 고르십시오.`);
      if (db.get('SELECT 1 AS ok FROM teams WHERE name = ?', [name])) fail('같은 이름의 팀이 있습니다.');
      const id = nextId(db, 'teams', 'team_id', 'T', 2);
      const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM teams')?.s ?? 0) + 1;
      const row = { team_id: id, name, sort_order: sortOrder };
      db.run('INSERT INTO teams (team_id, name, sort_order) VALUES (?, ?, ?)', [id, name, sortOrder]);
      log(db, ctx, 'INSERT', 'teams', id, null, undefined, row);
      return { changed: true, createdId: id };
    }
    case 'deleteTeam': {
      const old = db.get('SELECT * FROM teams WHERE team_id = ?', [edit.teamId]);
      if (!old) return { changed: false };
      const n = Number(db.get('SELECT count(*) AS n FROM people WHERE team = ?', [old.name])?.n ?? 0);
      if (n) fail(`"${old.name}" 팀에 작업자가 ${n}명 있습니다. 먼저 그 사람들의 소속팀을 바꾸십시오.`);
      db.run('DELETE FROM teams WHERE team_id = ?', [edit.teamId]);
      log(db, ctx, 'DELETE', 'teams', edit.teamId, null, old, undefined);
      return { changed: true };
    }
  }
}
