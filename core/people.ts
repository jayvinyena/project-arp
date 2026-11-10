// 작업자 명단(docs/24-people.md): 이름 · 소속팀 · 이메일 · 특이사항 · 참여 여부.
// 계산에는 쓰지 않는다(인원은 인력 표의 파트 × 달 숫자). 에셋 담당 칸에서 이름을 고를 때 쓴다. 모든 고치기는 이력에 남고 되돌릴 수 있다.
import type { SqlDb } from './db.ts';
import type { EditContext, EditResult } from './edits.ts';
import { log, nextId, fail } from './edits.ts';

export type PersonField = 'name' | 'team' | 'email' | 'note' | 'active';
export type PeopleEdit =
  | { kind: 'createPerson'; name: string; team?: string | null; email?: string | null; note?: string | null }
  | { kind: 'personField'; personId: string; field: PersonField; value: string | null }
  | { kind: 'deletePerson'; personId: string }
  /** 지원 팀(PM · 기획 등 파트가 아닌 팀). 파트는 기준 정보에서 */
  | { kind: 'createTeam'; name: string }
  | { kind: 'deleteTeam'; teamId: string };
export const PEOPLE_EDIT_KINDS = new Set<string>(['createPerson', 'personField', 'deletePerson', 'createTeam', 'deleteTeam']);

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

export interface Person { personId: string; name: string; team: string | null; email: string | null; note: string | null; active: boolean }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: string | null | undefined) => { const t = (v ?? '').trim(); return t ? t : null; };

/** 소속팀 순: 파트(공정 순) → 지원 팀(더한 순) → 목록에 없는 값 → 소속팀 없음. 팀 안에서는 더한 순 */
export function peopleList(db: SqlDb): Person[] {
  return db.all(`SELECT x.* FROM people x LEFT JOIN parts p ON p.name = x.team LEFT JOIN teams t ON t.name = x.team
      ORDER BY CASE WHEN x.team IS NULL OR x.team = '' THEN 3 WHEN p.part_id IS NOT NULL THEN 0 WHEN t.team_id IS NOT NULL THEN 1 ELSE 2 END,
        p.sort_order, t.sort_order, x.team, x.sort_order, x.person_id`).map(r => ({
    personId: String(r.person_id), name: String(r.name), team: (r.team as string) ?? null, email: (r.email as string) ?? null,
    note: (r.note as string) ?? null, active: Number(r.active) === 1,
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
