// 소식(docs/26-viewer.md 4절): 편집자가 쓰는 짧은 글 + "지난번 본 뒤" 자동 요약. 보기 모드의 첫 화면.
// 소식은 파일에 남고(모두가 본다), "어디까지 봤나"는 각자 브라우저에 둔다.
import type { SqlDb } from './db.ts';
import type { ProjectSession } from './pipeline.ts';
import type { EditContext, EditResult } from './edits.ts';
import { log, nextId, fail } from './edits.ts';
import { outlookNow } from './notice.ts';

export type NewsEdit =
  | { kind: 'addNews'; title: string; body?: string | null; important?: boolean }
  | { kind: 'newsField'; newsId: string; field: 'title' | 'body' | 'important'; value: string | null }
  | { kind: 'deleteNews'; newsId: string };
export const NEWS_EDIT_KINDS = new Set<string>(['addNews', 'newsField', 'deleteNews']);

export interface NewsItem { newsId: string; at: string; author: string; title: string; body: string | null; important: boolean }
export interface NewsSummary {
  /** 이 시각 뒤에 바뀐 것(없으면 최근 7일) */
  since: string;
  edits: number;
  editors: string[];
  /** 완료로 바뀐 에셋 파트 수 */
  partsDone: number;
  assetsAdded: number;
  volumeEdits: number;
  /** 지금 검수 요청 · 수정 중인 에셋 파트 수 */
  review: number;
  retake: number;
  /** 지금 계산 대상 업데이트의 완료 예정(기본안) */
  forecasts: { updateId: string; name: string; completion: string | null; status: string }[];
}

const clean = (v: string | null | undefined) => { const t = (v ?? '').trim(); return t ? t : null; };

export function applyNewsEdit(db: SqlDb, edit: NewsEdit, ctx: EditContext): EditResult {
  switch (edit.kind) {
    case 'addNews': {
      const title = clean(edit.title);
      if (!title) fail('소식 제목을 입력하십시오.');
      if (title!.length > 80) fail('소식 제목은 80자 이하입니다.');
      const body = (edit.body ?? '').replace(/\s+$/, '') || null;
      if (body && body.length > 2000) fail('소식 내용은 2천 자 이하입니다.');
      const id = nextId(db, 'news', 'news_id', 'N', 4);
      const row = { news_id: id, at: new Date().toISOString(), author: ctx.editor, title, body, important: edit.important ? 1 : 0 };
      db.run('INSERT INTO news (news_id, at, author, title, body, important) VALUES (?, ?, ?, ?, ?, ?)', Object.values(row));
      log(db, ctx, 'INSERT', 'news', id, null, undefined, row);
      return { changed: true, createdId: id };
    }
    case 'newsField': {
      const before = db.get('SELECT * FROM news WHERE news_id = ?', [edit.newsId]) ?? fail('없는 소식입니다.');
      let value: string | number | null;
      if (edit.field === 'important') value = edit.value === '1' || edit.value === 'true' ? 1 : 0;
      else if (edit.field === 'body') value = (edit.value ?? '').replace(/\s+$/, '') || null;
      else { value = clean(edit.value); if (!value) fail('소식 제목은 비울 수 없습니다.'); }
      const old = before[edit.field] ?? null;
      if (String(old) === String(value)) return { changed: false };
      db.run(`UPDATE news SET ${edit.field} = ? WHERE news_id = ?`, [value, edit.newsId]);
      log(db, ctx, 'UPDATE', 'news', edit.newsId, edit.field, old, value);
      return { changed: true };
    }
    case 'deleteNews': {
      const old = db.get('SELECT * FROM news WHERE news_id = ?', [edit.newsId]);
      if (!old) return { changed: false };
      db.run('DELETE FROM news WHERE news_id = ?', [edit.newsId]);
      log(db, ctx, 'DELETE', 'news', edit.newsId, null, old, undefined);
      return { changed: true };
    }
  }
}

export function newsList(db: SqlDb, limit = 100): NewsItem[] {
  return db.all('SELECT * FROM news ORDER BY at DESC, news_id DESC LIMIT ?', [limit]).map(r => ({
    newsId: String(r.news_id), at: String(r.at), author: String(r.author), title: String(r.title), body: (r.body as string) ?? null, important: Number(r.important) === 1,
  }));
}

/** 소식 화면: 소식 목록 + since 뒤 자동 요약(since가 없으면 최근 7일) */
export function newsView(db: SqlDb, session: ProjectSession, since: string | null): { items: NewsItem[]; summary: NewsSummary } {
  const from = since ?? new Date(Date.now() - 7 * 86400000).toISOString();
  const logs = db.all("SELECT * FROM change_log WHERE at > ? AND target <> 'news'", [from]);
  const count = (pred: (r: Record<string, unknown>) => boolean) => logs.filter(pred).length;
  const now = outlookNow(db, session) ?? {};
  return {
    items: newsList(db),
    summary: {
      since: from,
      edits: new Set(logs.map(r => String(r.batch_id))).size,
      editors: [...new Set(logs.map(r => String(r.editor)))],
      partsDone: count(r => r.target === 'asset_parts' && String(r.new_json ?? '').includes('"DONE"')),
      assetsAdded: count(r => r.target === 'assets' && r.action === 'INSERT'),
      volumeEdits: count(r => r.target === 'volumes'),
      review: Number(db.get("SELECT count(*) AS n FROM asset_parts WHERE status = 'REVIEW'")?.n ?? 0),
      retake: Number(db.get("SELECT count(*) AS n FROM asset_parts WHERE status = 'RETAKE'")?.n ?? 0),
      forecasts: Object.entries(now).map(([updateId, u]) => ({ updateId, name: u.name, completion: u.completion, status: u.status })),
    },
  };
}
