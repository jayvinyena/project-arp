// 작업자 명단(docs/24-people.md): 이름 · 소속팀 · 이메일 · 특이사항 · 참여 여부.
// 계산에는 쓰지 않는다(인원은 인력 표의 파트 × 달 숫자). 에셋 담당 칸에서 이름을 고를 때 쓴다. 모든 고치기는 이력에 남고 되돌릴 수 있다.
import type { SqlDb } from './db.ts';
import type { EditContext, EditResult } from './edits.ts';
import { log, nextId, fail } from './edits.ts';

export type PersonField = 'name' | 'team' | 'email' | 'note' | 'active';
export type PeopleEdit =
  | { kind: 'createPerson'; name: string; team?: string | null; email?: string | null; note?: string | null }
  | { kind: 'personField'; personId: string; field: PersonField; value: string | null }
  | { kind: 'deletePerson'; personId: string };
export const PEOPLE_EDIT_KINDS = new Set<string>(['createPerson', 'personField', 'deletePerson']);

export interface Person { personId: string; name: string; team: string | null; email: string | null; note: string | null; active: boolean }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: string | null | undefined) => { const t = (v ?? '').trim(); return t ? t : null; };

/** 소속팀 순: 파트 이름과 같은 팀은 공정 순서(원화 → 모델링 …), 그 밖의 팀은 이름순, 소속팀 없음은 맨 뒤. 팀 안에서는 더한 순 */
export function peopleList(db: SqlDb): Person[] {
  return db.all(`SELECT x.* FROM people x LEFT JOIN parts p ON p.name = x.team
      ORDER BY CASE WHEN x.team IS NULL OR x.team = '' THEN 2 WHEN p.part_id IS NULL THEN 1 ELSE 0 END, p.sort_order, x.team, x.sort_order, x.person_id`).map(r => ({
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
      const row = { person_id: id, name, team: clean(edit.team), email, note, active: 1, sort_order: sortOrder };
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
  }
}
