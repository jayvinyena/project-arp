// 소식(docs/26-viewer.md 4절): 편집자 소식 + 지난번 본 뒤 자동 요약 + 알리기 문구 복사. 보기 모드의 첫 화면.
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { rpc } from '../lib/rpc.ts';
import type { NewsItem, NewsSummary } from '../../../core/news.ts';
import type { Edit } from '../../../core/edits.ts';
import { fmtDate } from '../lib/format.ts';
import { IconPlus, IconX, IconCopy } from './icons.tsx';

const STATUS: Record<string, string> = { ON_TRACK: '목표 안', TIGHT: '빠듯함', LATE: '늦음', UNFINISHED: '기간 안에 못 끝남', NO_RELEASE_DATE: '출시일 없음' };
const when = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function forecastLines(s: NewsSummary) {
  return s.forecasts.map(f => `· ${f.name}: 완료 예정 ${f.completion ? fmtDate(f.completion) : '—'} (${STATUS[f.status] ?? f.status})`);
}
/** 메신저 · 메일에 붙일 글 */
export function shareText(project: string, n: NewsItem | null, s: NewsSummary): string {
  const head = n ? [`[ARP · ${project}] ${n.important ? '(중요) ' : ''}${n.title}`, ...(n.body ? [n.body] : []), `— ${n.author}, ${when(n.at)}`]
    : [`[ARP · ${project}] 요약 (${when(s.since)} 이후)`, `변경 ${s.edits}건 · 완료된 에셋 작업 ${s.partsDone}건 · 새 에셋 ${s.assetsAdded}개 · 검수 요청 ${s.review} · 수정 ${s.retake}`];
  return [...head, '', '완료 예정(기본안)', ...forecastLines(s), '', 'ARP 보기 모드에서 자세히 확인하십시오.'].join('\n');
}

export function NewsPage(props: { version: number; readOnly: boolean; project: string; seenAt: string | null; onSeen: () => void; onApply: (e: Edit) => Promise<boolean>; onToast: (m: string) => void }) {
  const [data, setData] = useState<{ items: NewsItem[]; summary: NewsSummary } | null>(null);
  const [draft, setDraft] = useState({ title: '', body: '', important: false });
  // 처음 연 순간의 "지난번 본 시각"으로 새 소식을 표시하고, 화면을 연 것으로 본 것 처리
  const [since] = useState(props.seenAt);
  useEffect(() => { void rpc.news(since).then(setData); }, [props.version]);
  // 이 화면에 있는 동안 올라온 소식(내가 올린 것 포함)도 본 것으로
  useEffect(() => { props.onSeen(); }, [props.version]);
  if (!data) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  const s = data.summary;
  const fresh = (n: NewsItem) => !since || n.at > since;
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); props.onToast('알리기 문구를 복사했습니다. 메신저 · 메일에 붙여 넣으십시오.'); }
    catch { props.onToast('복사하지 못했습니다. 브라우저의 클립보드 권한을 확인하십시오.'); }
  };
  const post = async () => {
    if (await props.onApply({ kind: 'addNews', title: draft.title, body: draft.body, important: draft.important })) setDraft({ title: '', body: '', important: false });
  };

  return (
    <div class="page news-page">
      <header class="page-head">
        <div>
          <PageEyebrow page="news" />
          <h1>소식</h1>
          <p class="muted" style="margin-top: 6px">편집하는 사람이 남긴 소식과, 지난번 본 뒤 바뀐 것을 모았습니다. "알리기 문구 복사"로 메신저 · 메일에 바로 붙여 넣습니다.</p>
        </div>
      </header>

      {!props.readOnly && (
        <section class="card">
          <div class="card-head"><div><h2>소식 쓰기</h2><p class="small muted" style="margin-top: 2px">바뀐 계획 · 결정 · 부탁을 짧게 남깁니다. 저장하면 보기 모드로 보는 사람에게 "새 소식"으로 보입니다.</p></div></div>
          <div class="card-body news-form">
            <input class="field" aria-label="소식 제목" placeholder="제목(예: M4 원화 2주 당김)" maxLength={80} value={draft.title} onInput={e => { const t = (e.target as HTMLInputElement).value; setDraft(d => ({ ...d, title: t })); }} />
            <textarea class="field textarea" rows={3} aria-label="소식 내용" placeholder="내용(선택)" value={draft.body} onInput={e => { const t = (e.target as HTMLTextAreaElement).value; setDraft(d => ({ ...d, body: t })); }} />
            <div class="inline">
              <label class="inline small"><input type="checkbox" checked={draft.important} onChange={e => { const c = (e.target as HTMLInputElement).checked; setDraft(d => ({ ...d, important: c })); }} />중요</label>
              <span style="flex: 1" />
              <button type="button" class="btn sm primary" disabled={!draft.title.trim()} onClick={() => void post()}><IconPlus />소식 올리기</button>
            </div>
          </div>
        </section>
      )}

      <section class="card">
        <div class="card-head"><div><h2>소식 <span class="small faint">{data.items.length}개{data.items.some(fresh) ? ` · 새 소식 ${data.items.filter(fresh).length}` : ''}</span></h2></div></div>
        <div class="card-body">
          {data.items.length === 0 && <p class="small faint">아직 소식이 없습니다.{props.readOnly ? '' : ' 위에서 첫 소식을 올립니다.'}</p>}
          <ul class="news-list">
            {data.items.map(n => (
              <li class={`news-item${n.important ? ' important' : ''}${fresh(n) ? ' fresh' : ''}`}>
                <div class="news-item-head">
                  {fresh(n) && <span class="pill accent plain">새 소식</span>}
                  {n.important && <span class="pill bad plain">중요</span>}
                  <b class="news-title">{n.title}</b>
                  <span class="small faint">{n.author} · {when(n.at)}</span>
                  <span style="flex: 1" />
                  <button type="button" class="btn sm ghost" onClick={() => void copy(shareText(props.project, n, s))}><IconCopy />알리기 문구 복사</button>
                  {!props.readOnly && <button type="button" class="btn ghost icon-btn" aria-label={`${n.title} 소식 지우기`} title="지우기(변경 이력에서 되돌릴 수 있습니다)" onClick={() => void props.onApply({ kind: 'deleteNews', newsId: n.newsId })}><IconX /></button>}
                </div>
                {n.body && <p class="news-body">{n.body}</p>}
              </li>
            ))}
          </ul>
        </div>
      </section>
      <section class="card">
        <div class="card-head">
          <div><h2>{since ? '지난번 본 뒤 바뀐 것' : '최근 7일 동안 바뀐 것'}</h2>
            <p class="small muted" style="margin-top: 2px">{when(s.since)} 이후{s.editors.length ? ` · 고친 사람 ${s.editors.join(', ')}` : ''}</p></div>
          <button type="button" class="btn sm" onClick={() => void copy(shareText(props.project, null, s))}><IconCopy />요약 문구 복사</button>
        </div>
        <div class="card-body">
          <div class="news-stats">
            <div><span class="small faint">변경</span><b>{s.edits}<span class="unit">건</span></b></div>
            <div><span class="small faint">완료된 에셋 작업</span><b>{s.partsDone}<span class="unit">건</span></b></div>
            <div><span class="small faint">새 에셋</span><b>{s.assetsAdded}<span class="unit">개</span></b></div>
            <div><span class="small faint">지금 검수 요청 · 수정</span><b>{s.review}<span class="unit"> · {s.retake}</span></b></div>
          </div>
          <h3 class="sub-h" style="margin-top: 14px">완료 예정(기본안)</h3>
          <ul class="news-forecasts">
            {s.forecasts.length === 0 && <li class="small faint">계산할 수 없는 상태입니다(데이터 점검 확인).</li>}
            {s.forecasts.map(f => <li><b>{f.name}</b><span class="num">{f.completion ? fmtDate(f.completion) : '—'}</span><span class={`pill ${f.status === 'LATE' || f.status === 'UNFINISHED' ? 'bad' : f.status === 'TIGHT' ? 'warn' : f.status === 'ON_TRACK' ? 'ok' : ''}`}>{STATUS[f.status] ?? f.status}</span></li>)}
          </ul>
        </div>
      </section>

    </div>
  );
}
