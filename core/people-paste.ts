// 작업자 표 붙여넣기 해석(docs/31-people-import.md B): 엑셀 · 구글 시트 · Jira CSV(엑셀로 연 것)에서 복사한 글자.
// 화면 미리보기에서도 쓰므로 다른 모듈을 가져오지 않는다(가벼운 순수 함수).

/** 이름 같음 판정: 앞뒤 · 연속 공백 무시, 대소문자 무시 */
export const nameKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export const PERSON_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type PasteStatus = 'new' | 'exists' | 'fill' | 'dup' | 'bad';
export interface PasteRow {
  /** 붙여넣은 글의 줄 번호(1부터) */
  line: number;
  name: string;
  /** 목록(파트 · 지원 팀)에 맞춘 이름. 목록에 없으면 원래 글자 그대로이고 teamKnown = false */
  team: string | null;
  teamKnown: boolean;
  email: string | null;
  note: string | null;
  /** new = 새로 더함, exists = 이미 있음, fill = 이미 있고 비어 있는 이메일만 채움, dup = 붙여넣은 글 안에서 겹침, bad = 고칠 것 */
  status: PasteStatus;
  problem: string | null;
  /** 이미 있는 사람(exists · fill) */
  personId: string | null;
}
export interface PasteResult { rows: PasteRow[]; header: boolean; columns: { name: number; team: number; email: number; note: number } }

const ALIASES: Record<'name' | 'team' | 'email' | 'note', string[]> = {
  name: ['이름', '성명', '작업자', '담당자', '담당', 'name', 'fullname', 'displayname', 'assignee', '표시이름'],
  team: ['소속팀', '소속', '팀', '부서', '파트', 'team', 'department', 'dept', 'group'],
  email: ['이메일', '메일', '이메일주소', 'email', 'e-mail', 'emailaddress', 'mail'],
  note: ['특이사항', '메모', '비고', 'note', 'notes', 'memo', 'comment'],
};
const headKey = (s: string) => s.trim().toLowerCase().replace(/[\s_()]/g, '');

/** 탭(엑셀 · 시트 복사) 또는 쉼표(CSV)로 나눈다. 큰따옴표로 감싼 칸(줄바꿈 · 구분자 포함)도 읽는다 */
export function splitTable(text: string): string[][] {
  const src = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const firstLine = src.split('\n').find(l => l.trim()) ?? '';
  const sep = firstLine.includes('\t') ? '\t' : firstLine.includes(',') ? ',' : '\t';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

/**
 * 붙여넣은 글 → 미리보기 줄. 첫 줄이 머리글(이름 · 팀 · 이메일 · 메모 등)이면 열을 맞추고, 아니면 이름 · 팀 · 이메일 · 메모 순서.
 * teams: 고를 수 있는 소속팀 이름(파트 + 지원 팀), people: 지금 명단
 */
export function parsePeopleText(text: string, teams: string[], people: { personId: string; name: string; email: string | null }[]): PasteResult {
  const table = splitTable(text);
  const cols = { name: -1, team: -1, email: -1, note: -1 };
  const head = table[0] ?? [];
  head.forEach((h, i) => {
    const k = headKey(h);
    for (const f of ['name', 'team', 'email', 'note'] as const) if (cols[f] < 0 && ALIASES[f].includes(k)) { cols[f] = i; break; }
  });
  const header = cols.name >= 0;
  if (!header) Object.assign(cols, { name: 0, team: 1, email: 2, note: 3 });
  const teamBy = new Map(teams.map(t => [nameKey(t), t]));
  const personBy = new Map(people.map(p => [nameKey(p.name), p]));
  const seen = new Set<string>();
  const at = (r: string[], i: number) => { const v = i >= 0 ? (r[i] ?? '').trim() : ''; return v ? v : null; };
  const rows: PasteRow[] = [];
  table.slice(header ? 1 : 0).forEach((r, i) => {
    const name = at(r, cols.name)?.replace(/\s+/g, ' ') ?? null;
    if (!name) return;
    const teamRaw = at(r, cols.team);
    const known = teamRaw ? teamBy.get(nameKey(teamRaw)) ?? null : null;
    const email = at(r, cols.email);
    const note = at(r, cols.note);
    const key = nameKey(name);
    const person = personBy.get(key) ?? null;
    let status: PasteStatus = person ? (email && !person.email ? 'fill' : 'exists') : 'new';
    let problem: string | null = null;
    if (seen.has(key)) { status = 'dup'; problem = '위 줄과 같은 이름'; }
    else if (name.length > 40) { status = 'bad'; problem = '이름이 40자를 넘습니다'; }
    else if (email && !PERSON_EMAIL.test(email)) { status = person ? 'exists' : 'bad'; problem = '이메일 형식이 아닙니다'; }
    else if (note && note.length > 1000) { status = 'bad'; problem = '특이사항이 1천 자를 넘습니다'; }
    seen.add(key);
    rows.push({ line: i + (header ? 2 : 1), name, team: known ?? teamRaw, teamKnown: !teamRaw || !!known, email, note, status, problem, personId: person?.personId ?? null });
  });
  return { rows, header, columns: cols };
}
