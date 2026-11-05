// 열 때 변화 알림: 서버가 없어도 "내가 지난번에 본 뒤" 바뀐 것을 알린다.
// 지난번 본 전망은 각자 브라우저에 두고(파일에는 두지 않음), 다른 사람이 고친 횟수는 파일의 변경 이력에서 센다.
import type { SqlDb } from './db.ts';
import type { ProjectSession } from './pipeline.ts';
import { planView } from './plan.ts';

export interface SeenUpdate { name: string; completion: string | null; status: string }
export interface Seen { at: string; updates: Record<string, SeenUpdate> }

export interface Notice {
  since: string;
  changed: { updateId: string; name: string; before: string | null; after: string | null; beforeStatus: string; afterStatus: string; deltaDays: number | null }[];
  added: string[];
  removed: string[];
  editsByOthers: number;
  editors: string[];
}

/** 지금 전망(목표안): 계산 대상 업데이트의 완료 예정과 판정. 계산이 막혔으면 null(비교하지 않는다) */
export function outlookNow(db: SqlDb, session: ProjectSession): Seen['updates'] | null {
  const v = planView(db, session, 'TARGET');
  if (v.blocked) return null;
  return Object.fromEntries(v.rows.filter(r => r.live && r.result).map(r => [r.updateId, { name: r.name, completion: r.result!.completion, status: r.result!.status }]));
}

const days = (a: string | null, b: string | null) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 86400000) : null);

/** 지난번 본 것과 지금을 비교. 바뀐 것이 없으면 null */
export function noticeSince(db: SqlDb, prev: Seen, now: Seen['updates'], me: string): Notice | null {
  const changed: Notice['changed'] = [];
  for (const [id, n] of Object.entries(now)) {
    const p = prev.updates[id];
    if (!p) continue;
    if (p.completion !== n.completion || p.status !== n.status) {
      changed.push({ updateId: id, name: n.name, before: p.completion, after: n.completion, beforeStatus: p.status, afterStatus: n.status, deltaDays: days(p.completion, n.completion) });
    }
  }
  const added = Object.keys(now).filter(id => !prev.updates[id]).map(id => now[id].name);
  const removed = Object.keys(prev.updates).filter(id => !now[id]).map(id => prev.updates[id].name);
  const others = db.get('SELECT count(DISTINCT batch_id) AS n, group_concat(DISTINCT editor) AS who FROM change_log WHERE at > ? AND editor <> ?', [prev.at, me]);
  const editsByOthers = Number(others?.n ?? 0);
  const editors = others?.who ? String(others.who).split(',') : [];
  if (!changed.length && !added.length && !removed.length && !editsByOthers) return null;
  changed.sort((a, b) => Math.abs(b.deltaDays ?? 999) - Math.abs(a.deltaDays ?? 999));
  return { since: prev.at, changed, added, removed, editsByOthers, editors };
}
