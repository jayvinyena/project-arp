// 에셋 제작 현황(docs/20-asset-management.md 16절): 에셋 리스트 + 트렐로식 보드(칸반) + 에셋 카드 창.
// 보드 열 = 제작 단계(대기 · 원화 · 모델링 · … · 완료) 또는 파트별 상태. 카드를 끌면 파트 상태가 바뀌고 작업 진척에 자동 집계된다.
// 보조 탭: 배치 · 물량 대조.
import { useState, useEffect, useRef } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { Field } from './SetupPage.tsx';
import { rpc } from '../lib/rpc.ts';
import type { AssetsView, AssetItem, AssetStatus, Tier, Stage, AssetDetail } from '../../../core/assets.ts';
import type { Edit } from '../../../core/edits.ts';
import { fmtPct, fmtDate } from '../lib/format.ts';
import { MODE_LABEL } from '../lib/modes.ts';
import { IconPlus, IconX, IconDownload, IconFolder, IconImage, IconGrid, IconList } from './icons.tsx';
import { useReorder, Grip } from './reorder.tsx';
import type { JSX } from 'preact';

const STATUS: { s: AssetStatus; label: string }[] = [
  { s: 'TODO', label: '대기' }, { s: 'WIP', label: '진행' }, { s: 'REVIEW', label: '검수 요청' }, { s: 'RETAKE', label: '수정' },
  { s: 'DONE', label: '완료' }, { s: 'HOLD', label: '보류' }, { s: 'OMIT', label: '해당 없음' },
];
const LABEL = Object.fromEntries(STATUS.map(x => [x.s, x.label])) as Record<AssetStatus, string>;
/** 같은 단계 안에서 고르는 세부 상태 */
const SUBS: AssetStatus[] = ['WIP', 'REVIEW', 'RETAKE', 'HOLD'];
const TIERS: Tier[] = ['MIN', 'TARGET', 'STRETCH'];
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ───────── 썸네일: 화면에 보이는 카드만, 모아서 한 번에 요청 · 주소 캐시 ─────────
const thumbCache = new Map<string, string>();
const waiting = new Map<string, ((url: string | null) => void)[]>();
let flushTimer = 0;
function requestThumb(assetId: string, at: string, done: (url: string | null) => void) {
  const key = `${assetId}@${at}`;
  if (thumbCache.has(key)) { done(thumbCache.get(key)!); return; }
  waiting.set(key, [...(waiting.get(key) ?? []), done]);
  if (flushTimer) return;
  flushTimer = window.setTimeout(async () => {
    flushTimer = 0;
    const keys = [...waiting.keys()];
    const cbs = new Map(waiting);
    waiting.clear();
    try {
      const { items } = await rpc.thumbs([...new Set(keys.map(k => k.split('@')[0]))]);
      const got = new Map(items.map(i => [i.assetId, i]));
      for (const k of keys) {
        const [id] = k.split('@');
        const it = got.get(id);
        const url = it ? URL.createObjectURL(new Blob([it.data as BlobPart], { type: it.mime })) : null;
        if (url) thumbCache.set(k, url);
        for (const cb of cbs.get(k) ?? []) cb(url);
      }
    } catch { for (const k of keys) for (const cb of cbs.get(k) ?? []) cb(null); }
  }, 30);
}

function Thumb(props: { asset: AssetItem; size?: 'sm' | 'cover' | 'big' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const at = props.asset.thumbAt;
  useEffect(() => {
    setUrl(at ? thumbCache.get(`${props.asset.assetId}@${at}`) ?? null : null);
    if (!at || !ref.current) return;
    let alive = true;
    const io = new IntersectionObserver(es => {
      if (!es.some(e => e.isIntersecting)) return;
      io.disconnect();
      requestThumb(props.asset.assetId, at, u => { if (alive) setUrl(u); });
    }, { rootMargin: '300px' });
    io.observe(ref.current);
    return () => { alive = false; io.disconnect(); };
  }, [props.asset.assetId, at]);
  return (
    <div ref={ref} class={`thumb${props.size ? ` ${props.size}` : ''}${url ? ' has' : ''}`}>
      {url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <span class="thumb-empty" aria-hidden="true">{props.asset.name.slice(0, 2)}</span>}
    </div>
  );
}

/** 이미지 파일 → 긴 변 256px WebP(지원하지 않으면 PNG) */
async function makeThumb(file: Blob): Promise<{ data: Uint8Array; mime: string; width: number; height: number }> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('이미지를 줄이지 못했습니다'))), 'image/webp', 0.8));
  return { data: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || 'image/webp', width: w, height: h };
}

function StatusSelect(props: { value: AssetStatus; label: string; disabled: boolean; options?: AssetStatus[]; onChange: (s: AssetStatus) => void }) {
  const opts = props.options ?? STATUS.map(x => x.s);
  return (
    <select class={`st-select st-${props.value}`} aria-label={props.label} value={props.value} disabled={props.disabled}
      onClick={e => e.stopPropagation()} onChange={e => props.onChange((e.target as HTMLSelectElement).value as AssetStatus)}>
      {(opts.includes(props.value) ? opts : [props.value, ...opts]).map(s => <option value={s}>{LABEL[s]}</option>)}
    </select>
  );
}

/** 이 에셋이 거치는 파트를 그 리소스 파이프라인 순서로. 파이프라인 밖 파트는 "해당 없음"이면 감추고, 기록이 있으면 맨 뒤에 */
const partsInOrder = (a: AssetItem, parts: AssetsView['parts'], pipelines: AssetsView['pipelines']) => {
  const steps = a.pipelineId ? pipelines.find(x => x.pipelineId === a.pipelineId)?.steps ?? null : null;
  const at = (id: string) => { const i = a.order.indexOf(id); return i < 0 ? 1e6 + parts.findIndex(p => p.partId === id) : i; };
  return parts.filter(p => a.parts[p.partId] && !(steps && !steps.includes(p.partId) && a.parts[p.partId].status === 'OMIT')).sort((x, y) => at(x.partId) - at(y.partId));
};

/** 이 에셋의 공정 묶음 번호(같은 묶음 = 병렬, docs/30): 파이프라인 묶음, 그 밖 파트는 뒤에 하나씩 */
const groupRank = (a: AssetItem, partId: string, pipelines: AssetsView['pipelines']): number => {
  const pl = a.pipelineId ? pipelines.find(x => x.pipelineId === a.pipelineId) : null;
  const g = pl ? pl.groups.findIndex(x => x.includes(partId)) : -1;
  if (g >= 0) return g;
  const i = a.order.indexOf(partId);
  return 1e3 + (i < 0 ? 1e3 : i);
};

/** 단계 고르기 칸: 대기 · 이 에셋 파이프라인 순서의 파트 · 완료 */
const stagesOf = (a: AssetItem, parts: AssetsView['parts'], pipelines: AssetsView['pipelines']): { id: Stage; name: string }[] =>
  [{ id: 'TODO', name: '대기' }, ...partsInOrder(a, parts, pipelines).map(p => ({ id: p.partId, name: p.name })), { id: 'DONE', name: '완료' }];

function PartDots(props: { asset: AssetItem; parts: AssetsView['parts']; pipelines: AssetsView['pipelines'] }) {
  return (
    <span class="part-dots">
      {partsInOrder(props.asset, props.parts, props.pipelines).map(p => {
        const s = props.asset.parts[p.partId];
        return <span class={`pdot st-${s.status}`} title={`${p.name}: ${LABEL[s.status]}${s.doneAt ? ` · ${s.doneAt}` : ''}`}><span class="pdot-name">{p.name.slice(0, 2)}</span></span>;
      })}
    </span>
  );
}

const jiraHref = (base: string | null, key: string | null) => (base && key ? `${base}${encodeURIComponent(key)}` : null);

/** 마감 칸: 평소엔 날짜 글자(에셋 마감, 없으면 "배치 날짜"), 누르면 날짜 고르기 */
function DueCell(props: { own: string | null; batchDue: string | null; done: boolean; label: string; disabled: boolean; onCommit: (d: string | null) => unknown }) {
  const [edit, setEdit] = useState(false);
  const due = props.own ?? props.batchDue;
  const late = !!due && due < today() && !props.done;
  if (edit && !props.disabled) {
    return <input class="field" type="date" aria-label={props.label} value={props.own ?? ''} ref={el => el?.focus()}
      onChange={e => { void props.onCommit((e.target as HTMLInputElement).value || null); setEdit(false); }} onBlur={() => setEdit(false)} />;
  }
  return (
    <button type="button" class={`due-btn${late ? ' overdue' : ''}${props.own ? '' : ' inherited'}`} aria-label={props.label} disabled={props.disabled}
      title={props.own ? '에셋 마감일(눌러서 변경)' : due ? '배치 마감일을 따릅니다(눌러서 에셋 마감일 지정)' : '눌러서 마감일 지정'} onClick={() => setEdit(true)}>
      {due ? (props.own ? due : `배치 ${due.slice(5).replace('-', '/')}`) : '—'}
    </button>
  );
}

/** 여러 줄 입력: 칸을 벗어나면 저장 */
function TextArea(props: { value: string; label: string; placeholder?: string; disabled: boolean; rows?: number; onCommit: (t: string) => unknown }) {
  const [t, setT] = useState(props.value);
  useEffect(() => setT(props.value), [props.value]);
  return <textarea class="field textarea" aria-label={props.label} rows={props.rows ?? 4} placeholder={props.placeholder} value={t} disabled={props.disabled}
    onInput={e => setT((e.target as HTMLTextAreaElement).value)} onBlur={() => { if (t !== props.value) void props.onCommit(t); }} />;
}

// ───────── 에셋 카드 창(트렐로 카드 참고) ─────────
function CardWindow(props: { view: AssetsView; asset: AssetItem; stages: { id: Stage; name: string }[]; readOnly: boolean; version: number;
  apply: (e: Edit) => Promise<boolean>; move: (ids: string[], stage: Stage) => void; onClose: () => void }) {
  const { view, asset: a, readOnly: ro, apply } = props;
  const [d, setD] = useState<AssetDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [link, setLink] = useState({ title: '', url: '' });
  const [comment, setComment] = useState('');
  const [attr, setAttr] = useState({ name: '', value: '' });
  const [showActivity, setShowActivity] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { void rpc.assetDetail(a.assetId).then(setD); }, [a.assetId, props.version]);
  const putThumb = async (file: Blob) => {
    if (ro) return;
    setBusy(true);
    try { const t = await makeThumb(file); await apply({ kind: 'assetThumb', assetId: a.assetId, data: t.data, mime: t.mime, width: t.width, height: t.height }); } finally { setBusy(false); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest?.('input, textarea, select')) props.onClose(); };
    const onPaste = (e: ClipboardEvent) => { const f = [...(e.clipboardData?.files ?? [])].find(x => x.type.startsWith('image/')); if (f) { e.preventDefault(); void putThumb(f); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('paste', onPaste); };
  }, [a.assetId]);
  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => { const f = input.files?.[0]; if (f) void putThumb(f); };
    input.click();
  };
  const group = view.groups.find(g => g.resources.some(r => r.resourceTypeId === a.resourceTypeId));
  const rt = group?.resources.find(r => r.resourceTypeId === a.resourceTypeId);
  const batch = view.batches.find(b => b.batchId === a.batchId);
  const due = a.dueDate ?? batch?.dueDate ?? null;
  const overdue = !!due && due < today() && a.stage !== 'DONE';
  const href = jiraHref(view.jiraBase, a.jiraKey);
  const stageName = props.stages.find(s => s.id === a.stage)?.name ?? '';
  const feed = [
    ...(d?.comments ?? []).map(c => ({ kind: 'c' as const, at: c.at, who: c.author, text: c.body, id: c.commentId })),
    ...(showActivity ? (d?.activity ?? []).map(x => ({ kind: 'a' as const, at: x.at, who: x.editor, text: x.text, id: '' })) : []),
  ].sort((x, y) => (x.at < y.at ? 1 : -1));
  return (
    <div class="overlay" onClick={e => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="card dialog asset-card-window" role="dialog" aria-label="에셋 카드">
        <div class={`cw-cover${drag ? ' drag' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); const f = [...(e.dataTransfer?.files ?? [])].find(x => x.type.startsWith('image/')); if (f) void putThumb(f); }}>
          <Thumb asset={a} size="big" />
          <button type="button" class="btn ghost icon-btn cw-close" aria-label="닫기" onClick={props.onClose}><IconX /></button>
          {!ro && <span class="cw-cover-actions">
            <button type="button" class="btn sm" disabled={busy} onClick={pick}><IconImage />{busy ? '줄이는 중…' : a.thumbAt ? '썸네일 바꾸기' : '썸네일 넣기'}</button>
            {a.thumbAt && <button type="button" class="btn sm" onClick={() => void apply({ kind: 'assetThumb', assetId: a.assetId, data: null })}>지우기</button>}
          </span>}
        </div>
        <div class="cw-body">
          <div class="cw-main">
            <Field class="title-input" value={a.name} label="에셋 이름" disabled={ro} onCommit={t => apply({ kind: 'assetField', assetIds: [a.assetId], field: 'name', value: t })} />
            <p class="small muted cw-sub">{group?.name} · {rt?.name}{a.category && a.category !== rt?.name ? ` · ${a.category}` : ''}{a.code ? ` · ${a.code}` : ''} · 단계 <b>{stageName}</b> · 진행 {fmtPct(a.progress)}{a.retakes ? ` · 리테이크 ${a.retakes}회` : ''}</p>
            <div class="cw-labels">
              <span class={`label-chip st-${a.sub}`}>{LABEL[a.sub]}</span>
              <span class="label-chip">{batch ? batch.name : '미배정'}</span>
              <span class="label-chip">{MODE_LABEL[a.tier]}</span>
              {due && <span class={`label-chip${overdue ? ' overdue' : ''}`}>마감 {due}{a.dueDate ? '' : '(배치)'}</span>}
              {a.jiraKey && (href ? <a class="label-chip link" href={href} target="_blank" rel="noreferrer">{a.jiraKey} ↗</a> : <span class="label-chip">{a.jiraKey}</span>)}
            </div>

            <section class="cw-section">
              <h3 class="sub-h">설명</h3>
              <TextArea value={a.note ?? ''} label="설명" placeholder="요청 사항 · 참고 · 특이 사항을 적습니다" disabled={ro} onCommit={t => apply({ kind: 'assetField', assetIds: [a.assetId], field: 'note', value: t })} />
            </section>

            <section class="cw-section">
              <h3 class="sub-h">속성 <span class="small faint">제작 리스트의 추가 칸(속성 · 지역 · 무기 …)</span></h3>
              <div class="cw-attrs">
                {a.attrs.length === 0 && <p class="small faint">아직 속성이 없습니다.</p>}
                {a.attrs.map(x => (
                  <div class="cw-attr">
                    <span class="cw-attr-name">{x.name}</span>
                    <Field value={x.value} label={`속성 ${x.name}`} disabled={ro} onCommit={t => apply({ kind: 'assetAttr', assetIds: [a.assetId], name: x.name, value: t })} />
                    {!ro && <button type="button" class="btn ghost icon-btn" aria-label={`속성 ${x.name} 지우기`} onClick={() => void apply({ kind: 'assetAttr', assetIds: [a.assetId], name: x.name, value: null })}><IconX /></button>}
                  </div>
                ))}
              </div>
              {!ro && (
                <div class="inline cw-link-add">
                  <input class="field" aria-label="속성 이름" placeholder="이름(예: 속성)" value={attr.name} onInput={e => { const t = (e.target as HTMLInputElement).value; setAttr(x => ({ ...x, name: t })); }} />
                  <input class="field" aria-label="속성 값" placeholder="값(예: 바람)" value={attr.value} onInput={e => { const t = (e.target as HTMLInputElement).value; setAttr(x => ({ ...x, value: t })); }} />
                  <button type="button" class="btn sm" disabled={!attr.name.trim() || !attr.value.trim()} onClick={async () => { if (await apply({ kind: 'assetAttr', assetIds: [a.assetId], name: attr.name, value: attr.value })) setAttr({ name: '', value: '' }); }}><IconPlus />속성 더하기</button>
                </div>
              )}
            </section>

            <section class="cw-section">
              <h3 class="sub-h">파트 체크리스트 <span class="small faint">완료 {view.parts.filter(p => a.parts[p.partId]?.status === 'DONE').length} / {view.parts.filter(p => a.parts[p.partId] && a.parts[p.partId].status !== 'OMIT').length}</span></h3>
              <p class="small faint cw-hint">{(() => { const pl = a.pipelineId ? view.pipelines.find(x => x.pipelineId === a.pipelineId) : null; const nm = new Map(view.parts.map(p => [p.partId, p.name])); return pl ? `${pl.name} 파이프라인(${pl.groups.map(g => g.map(x => nm.get(x) ?? x).join(' ∥ ')).join(' → ')})` : '파이프라인을 고르지 않은 리소스라 파트 표'; })()} 순서입니다(∥ 는 병렬). 하지 않는 파트는 "해당 없음", 나중에 하게 되면 "대기"로 바꿉니다.</p>
              <div class="cw-progress"><span style={{ width: `${Math.round(a.progress * 100)}%` }} /></div>
              <div class="table-wrap ref-wrap">
                <table class="grid edit ref asset-parts-table">
                  <colgroup><col style="width: 96px" /><col style="width: 130px" /><col style="width: 150px" /><col /><col style="width: 150px" /><col style="width: 64px" /></colgroup>
                  <thead><tr><th>파트</th><th>상태</th><th>완료일</th><th>담당</th><th>Jira</th><th class="n">리테이크</th></tr></thead>
                  <tbody>
                    {partsInOrder(a, view.parts, view.pipelines).map(p => {
                      const s = a.parts[p.partId];
                      const jh = jiraHref(view.jiraBase, s.jiraKey);
                      return (
                        <tr class={`row${a.stage === p.partId ? ' current' : ''}${s.status === 'OMIT' ? ' omit' : ''}`}>
                          <td><b>{p.name}</b>{!s.inPlan && s.status !== 'OMIT' && <span class="tag plan-out" title="이 리소스 종류의 계획 공수에 없는 파트입니다. 기준 정보에서 거치는 파트로 더하면 계획과 작업 진척에 들어갑니다.">계획 밖</span>}</td>
                          <td><StatusSelect value={s.status} label={`${p.name} 상태`} disabled={ro} onChange={st => void apply({ kind: 'assetPart', assetIds: [a.assetId], partId: p.partId, status: st })} /></td>
                          <td>{s.status === 'DONE'
                            ? <input class="field" type="date" aria-label={`${p.name} 완료일`} value={s.doneAt ?? ''} disabled={ro} onChange={e => void apply({ kind: 'assetPart', assetIds: [a.assetId], partId: p.partId, doneAt: (e.target as HTMLInputElement).value || null })} />
                            : <span class="faint small">{s.startedAt ? `시작 ${s.startedAt}` : '—'}</span>}</td>
                          <td><Field value={s.assignee ?? ''} label={`${p.name} 담당`} placeholder="이름" list="asset-people" disabled={ro} onCommit={t => apply({ kind: 'assetPart', assetIds: [a.assetId], partId: p.partId, assignee: t })} /></td>
                          <td><span class="inline nowrap"><Field value={s.jiraKey ?? ''} label={`${p.name} Jira 키`} placeholder="ABC-123" disabled={ro} onCommit={t => apply({ kind: 'assetPart', assetIds: [a.assetId], partId: p.partId, jiraKey: t })} />
                            {jh && <a class="jira-link" href={jh} target="_blank" rel="noreferrer" aria-label={`${s.jiraKey} 열기`}>↗</a>}</span></td>
                          <td class="n num">{s.retakes || <span class="faint">0</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section class="cw-section">
              <h3 class="sub-h">링크</h3>
              <ul class="cw-links">
                {a.jiraKey && <li><span class="link-kind">Jira</span>{href ? <a href={href} target="_blank" rel="noreferrer">{a.jiraKey}</a> : <span>{a.jiraKey} <span class="small faint">(Jira 주소는 프로젝트 · 파트 · 리소스 화면에서 입력)</span></span>}</li>}
                {(d?.links ?? []).map(l => (
                  <li><span class="link-kind">링크</span><a href={l.url} target="_blank" rel="noreferrer">{l.title}</a>
                    {!ro && <button type="button" class="btn ghost icon-btn" aria-label={`${l.title} 링크 지우기`} onClick={() => void apply({ kind: 'removeLink', linkId: l.linkId })}><IconX /></button>}</li>
                ))}
                {!a.jiraKey && !(d?.links.length) && <li class="small faint">아직 링크가 없습니다.</li>}
              </ul>
              {!ro && (
                <div class="inline cw-link-add">
                  <input class="field" aria-label="링크 제목" placeholder="제목(예: 컨셉 문서)" value={link.title} onInput={e => { const t = (e.target as HTMLInputElement).value; setLink(x => ({ ...x, title: t })); }} />
                  <input class="field" aria-label="링크 주소" placeholder="https://" value={link.url} onInput={e => { const t = (e.target as HTMLInputElement).value; setLink(x => ({ ...x, url: t })); }} />
                  <button type="button" class="btn sm" disabled={!link.url.trim()} onClick={async () => { if (await apply({ kind: 'addLink', assetId: a.assetId, title: link.title, url: link.url })) setLink({ title: '', url: '' }); }}><IconPlus />링크 더하기</button>
                </div>
              )}
            </section>

            <section class="cw-section">
              <div class="cw-feed-head"><h3 class="sub-h">댓글 · 활동</h3>
                <label class="inline small"><input type="checkbox" checked={showActivity} onChange={e => setShowActivity((e.target as HTMLInputElement).checked)} />활동 기록 함께 보기</label></div>
              {!ro && (
                <div class="cw-comment-box">
                  <textarea class="field textarea" rows={2} aria-label="댓글" placeholder="댓글을 입력합니다" value={comment} onInput={e => setComment((e.target as HTMLTextAreaElement).value)} />
                  <button type="button" class="btn sm primary" disabled={!comment.trim()} onClick={async () => { if (await apply({ kind: 'addComment', assetId: a.assetId, body: comment })) setComment(''); }}>남기기</button>
                </div>
              )}
              <ul class="cw-feed">
                {feed.length === 0 && <li class="small faint">아직 댓글이 없습니다.</li>}
                {feed.map(f => (
                  <li class={f.kind === 'a' ? 'act' : 'cmt'}>
                    <span class="feed-who">{f.who}</span><span class="small faint">{f.at.slice(0, 16).replace('T', ' ')}</span>
                    {f.kind === 'c' && !ro && <button type="button" class="btn ghost icon-btn feed-x" aria-label="댓글 지우기" onClick={() => void apply({ kind: 'removeComment', commentId: f.id })}><IconX /></button>}
                    <p class={f.kind === 'a' ? 'small muted' : ''}>{f.text}</p>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <aside class="cw-side">
            <span class="cw-side-h">단계</span>
            <select class="field" aria-label="단계 옮기기" value={a.stage} disabled={ro} onChange={e => props.move([a.assetId], (e.target as HTMLSelectElement).value)}>
              {stagesOf(a, view.parts, view.pipelines).map(s => <option value={s.id}>{s.name}</option>)}
            </select>
            {a.stage !== 'TODO' && a.stage !== 'DONE' && <>
              <span class="cw-side-h">세부 상태</span>
              <StatusSelect value={a.sub} label="세부 상태" disabled={ro} options={SUBS} onChange={st => void apply({ kind: 'assetPart', assetIds: [a.assetId], partId: a.stage, status: st })} />
            </>}
            <span class="cw-side-h">배치</span>
            <select class="field" aria-label="배치" value={a.batchId ?? ''} disabled={ro} onChange={e => void apply({ kind: 'assetField', assetIds: [a.assetId], field: 'batch_id', value: (e.target as HTMLSelectElement).value || null })}>
              <option value="">미배정</option>
              {view.batches.map(b => <option value={b.batchId}>{b.name}{b.dueDate ? ` · ${b.dueDate}` : ''}</option>)}
            </select>
            <span class="cw-side-h">마감일</span>
            <input class="field" type="date" aria-label="에셋 마감일" value={a.dueDate ?? ''} disabled={ro} onChange={e => void apply({ kind: 'assetField', assetIds: [a.assetId], field: 'due_date', value: (e.target as HTMLInputElement).value || null })} />
            {!a.dueDate && batch?.dueDate && <span class="small faint">비우면 배치 마감일({batch.dueDate})</span>}
            <span class="cw-side-h">포함 템플릿</span>
            <select class="field" aria-label="포함 템플릿" value={a.tier} disabled={ro} onChange={e => void apply({ kind: 'assetField', assetIds: [a.assetId], field: 'tier', value: (e.target as HTMLSelectElement).value })}>
              {TIERS.map(t => <option value={t}>{MODE_LABEL[t]}</option>)}
            </select>
            <span class="cw-side-h">Jira 키</span>
            <Field value={a.jiraKey ?? ''} label="에셋 Jira 키" placeholder="ABC-123" disabled={ro} onCommit={t => apply({ kind: 'assetField', assetIds: [a.assetId], field: 'jira_key', value: t })} />
            <span class="cw-side-h">세부 분류</span>
            <Field value={a.category ?? ''} label="세부 분류" placeholder="예: 코스튬 · 상의" disabled={ro} onCommit={t => apply({ kind: 'assetField', assetIds: [a.assetId], field: 'category', value: t })} />
            <span class="cw-side-h">리소스명</span>
            <Field value={a.code ?? ''} label="리소스명" placeholder="예: CH_0123" disabled={ro} onCommit={t => apply({ kind: 'assetField', assetIds: [a.assetId], field: 'code', value: t })} />
            <div class="viewer-slot small faint">에셋 뷰어(큰 이미지 · 3D)는 다음 단계에서 이 자리에</div>
            {!ro && (confirmDelete
              ? <div class="cw-danger"><span class="small">삭제하시겠습니까? 썸네일은 돌아오지 않습니다.</span>
                <button type="button" class="btn sm danger" onClick={async () => { if (await apply({ kind: 'deleteAssets', assetIds: [a.assetId] })) props.onClose(); }}>지우기</button>
                <button type="button" class="btn sm ghost" onClick={() => setConfirmDelete(false)}>그만두기</button></div>
              : <button type="button" class="btn sm" onClick={() => setConfirmDelete(true)}>이 에셋 지우기</button>)}
          </aside>
        </div>
      </div>
    </div>
  );
}

// ───────── 화면 ─────────
type Tab = 'assets' | 'batches' | 'volumes';
type View = 'list' | 'board';

/** 배치 표 줄: 손잡이나 줄을 길게 눌러 끌어 순서를 바꾼다 */
function BatchRows(props: { batches: AssetsView['batches']; ro: boolean; apply: (e: Edit) => Promise<boolean>; children: (b: AssetsView['batches'][number]) => JSX.Element }) {
  const r = useReorder(props.batches.map(b => b.batchId), ids => props.apply({ kind: 'reorderBatches', batchIds: ids }), { disabled: props.ro });
  return (
    <tbody data-reorder-box="">
      {props.batches.length === 0 && <tr><td colSpan={7} class="muted small">배치가 없습니다. 아래에서 더합니다.</td></tr>}
      {props.batches.map(b => (
        <tr class={`row ${r.cls(b.batchId)}`} {...r.item(b.batchId)}>
          <td class="c">{!props.ro && <button {...r.handle(b.batchId, b.name)}><Grip /></button>}</td>
          {props.children(b)}
        </tr>
      ))}
    </tbody>
  );
}
type GroupBy = 'none' | 'group' | 'category' | 'batch' | 'stage';

export function AssetsPage(props: {
  version: number; readOnly: boolean;
  onApply: (e: Edit) => Promise<boolean>;
  onExport: (updateId: string | null) => Promise<void>;
  onImport: () => Promise<void>;
  /** 다른 화면에서 넘어올 때: 업데이트 · 리소스 종류 · 바로 열 에셋 */
  focus?: { updateId: string; resourceTypeId?: string; assetId?: string } | null;
  /** 지금 업데이트(모든 화면이 함께 쓴다) */
  updateId: string | null; onUpdate: (id: string) => void;
}) {
  const ro = props.readOnly;
  const pref = <T,>(k: string, d: T): T => { try { return (localStorage.getItem(`arp.assets.${k}`) as T | null) ?? d; } catch { return d; } };
  const [updateId, setUpdateId] = useState<string | null>(props.focus?.updateId ?? props.updateId);
  const [v, setV] = useState<AssetsView | null>(null);
  const [tab, setTab] = useState<Tab>('assets');
  const [view, setView] = useState<View>(() => pref('view', 'list'));
  const [boardBy, setBoardBy] = useState<string>(() => pref('boardBy', 'stage')); // 'stage' 또는 파트 ID
  const [pipe, setPipe] = useState<string>(() => pref('pipe', 'all')); // 보드 파이프라인: all · base(기본 순서) · 파이프라인 ID
  const [groupBy, setGroupBy] = useState<GroupBy>(() => pref('groupBy', 'group'));
  const [group, setGroup] = useState('all');
  const [batch, setBatch] = useState('all');
  const [who, setWho] = useState('all');
  const [team, setTeam] = useState<string>(() => pref('team', 'all')); // 팀 = 파트
  const [cat, setCat] = useState('all');
  const [status, setStatus] = useState('all');
  const [attrF, setAttrF] = useState('all'); // JSON [이름, 값]
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [add, setAdd] = useState({ rt: '', names: '' });
  const [newBatch, setNewBatch] = useState({ name: '', due: '' });
  const [bulk, setBulk] = useState({ stage: '', batch: '', part: '', partStatus: 'OMIT' as AssetStatus });
  const [limit, setLimit] = useState(300);
  const [dragIds, setDragIds] = useState<string[]>([]);
  const [over, setOver] = useState<{ col: string; index: number } | null>(null);
  const [confirm, setConfirm] = useState<{ ids: string[]; stage: Stage; text: string } | null>(null);
  const [focusRt, setFocusRt] = useState<string | null>(props.focus?.resourceTypeId ?? null);

  useEffect(() => {
    if (!props.focus) return;
    setUpdateId(props.focus.updateId); setFocusRt(props.focus.resourceTypeId ?? null); setTab('assets');
    if (props.focus.assetId) { clearFilters(); setOpenId(props.focus.assetId); }
  }, [props.focus]);
  useEffect(() => { void rpc.assets(updateId).then(x => { setV(x); if (!updateId) setUpdateId(x.updateId); if (x.updateId && x.updateId !== props.updateId) props.onUpdate(x.updateId); }); }, [props.version, updateId]);
  useEffect(() => { try { localStorage.setItem('arp.assets.view', view); localStorage.setItem('arp.assets.boardBy', boardBy); localStorage.setItem('arp.assets.groupBy', groupBy); localStorage.setItem('arp.assets.team', team); localStorage.setItem('arp.assets.pipe', pipe); } catch { /* 없어도 된다 */ } }, [view, boardBy, groupBy, team, pipe]);
  useEffect(() => {
    if (!v || !focusRt) return;
    const g = v.groups.find(x => x.resources.some(r => r.resourceTypeId === focusRt));
    if (g) setGroup(g.groupId ?? '_');
    setFocusRt(null);
  }, [v, focusRt]);
  useEffect(() => { setSel(new Set()); setLimit(300); }, [updateId, group, batch, who, q, team, cat, status, attrF]);

  function clearFilters() { setGroup('all'); setBatch('all'); setWho('all'); setTeam('all'); setCat('all'); setStatus('all'); setAttrF('all'); setQ(''); }
  if (!v) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  const apply = props.onApply;
  const groupKey = (g: AssetsView['groups'][number]) => g.groupId ?? '_';
  const curGroups = group === 'all' ? v.groups : v.groups.filter(g => groupKey(g) === group);
  const rts = curGroups.flatMap(g => g.resources);
  const rtIds = new Set(rts.map(r => r.resourceTypeId));
  const rtName = new Map(v.groups.flatMap(g => g.resources.map(r => [r.resourceTypeId, r.name] as const)));
  const groupName = new Map(v.groups.flatMap(g => g.resources.map(r => [r.resourceTypeId, g.name] as const)));
  const batchById = new Map(v.batches.map(b => [b.batchId, b]));
  const stages: { id: Stage; name: string }[] = [{ id: 'TODO', name: '대기' }, ...v.parts.map(p => ({ id: p.partId, name: p.name })), { id: 'DONE', name: '완료' }];
  const stageName = new Map(stages.map(s => [s.id, s.name]));
  // 담당: 파트 담당(팀을 고르면 그 파트 담당만) + 속성 "담당 · 담당자" 값
  const WHO_ATTR = /^담당(자)?$/;
  const attrWho = (a: AssetItem) => a.attrs.filter(x => WHO_ATTR.test(x.name.replace(/\s+/g, ''))).map(x => x.value);
  const whoOf = (a: AssetItem) => team !== 'all' ? [a.parts[team]?.assignee ?? null, ...attrWho(a)] : [...Object.values(a.parts).map(p => p.assignee), ...attrWho(a)];
  const people = [...new Set(v.assets.flatMap(a => whoOf(a).filter(Boolean) as string[]))].sort((x, y) => x.localeCompare(y, 'ko'));
  const categories = [...new Set(v.assets.filter(a => rtIds.has(a.resourceTypeId)).map(a => a.category).filter(Boolean) as string[])].sort((x, y) => x.localeCompare(y, 'ko'));
  const attrOptions = new Map<string, Set<string>>();
  for (const a of v.assets) for (const x of a.attrs) { if (!attrOptions.has(x.name)) attrOptions.set(x.name, new Set()); attrOptions.get(x.name)!.add(x.value); }
  const [attrName, attrValue] = attrF === 'all' ? ['', ''] : JSON.parse(attrF) as [string, string];
  const filtered = [group, cat, batch, team, who, status, attrF].filter(x => x !== 'all').length + (q.trim() ? 1 : 0);
  const query = q.trim().toLowerCase();
  const shown = v.assets.filter(a => rtIds.has(a.resourceTypeId)
    && (batch === 'all' || (batch === 'none' ? !a.batchId : a.batchId === batch))
    && (cat === 'all' || (cat === 'none' ? !a.category : a.category === cat))
    && (team === 'all' || (a.parts[team] && a.parts[team].status !== 'OMIT'))
    && (who === 'all' || whoOf(a).includes(who))
    && (status === 'all' || (team !== 'all' ? a.parts[team]?.status === status : Object.values(a.parts).some(p => p.status === status)))
    && (attrF === 'all' || a.attrs.some(x => x.name === attrName && x.value === attrValue))
    && (!query || [a.name, a.code, a.category, a.jiraKey, ...a.attrs.map(x => x.value)].some(x => (x ?? '').toLowerCase().includes(query))));
  const count = (pred: (a: AssetItem) => boolean) => shown.filter(pred).length;
  const toggle = (id: string) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selIds = [...sel].filter(id => shown.some(a => a.assetId === id));
  const open = openId ? v.assets.find(a => a.assetId === openId) ?? null : null;
  const dueOf = (a: AssetItem) => a.dueDate ?? (a.batchId ? batchById.get(a.batchId)?.dueDate ?? null : null);
  const t0 = today();

  /** 단계 옮기기: 뒤로 옮기면(되돌림) 먼저 묻는다. 앞 · 뒤는 그 에셋 파이프라인 묶음 순서로(같은 묶음 = 병렬이라 앞 · 뒤가 아님) */
  const move = (ids: string[], stage: Stage) => {
    const rank = (s: Stage, a: AssetItem) => (s === 'TODO' ? -1 : s === 'DONE' ? 1e9 : groupRank(a, s, v.pipelines));
    const back = ids.map(id => v.assets.find(a => a.assetId === id)!).filter(a => a && rank(stage, a) < rank(a.stage, a));
    if (back.length) {
      setConfirm({ ids, stage, text: stage === 'TODO'
        ? `${back.length}개를 "대기"로 되돌리면 모든 파트 상태가 대기가 됩니다.`
        : `${back.length}개를 "${stageName.get(stage)}"로 되돌리면 ${stageName.get(stage)}는 "수정"(리테이크 1회)이 되고 그 뒤 단계 파트는 대기로 돌아갑니다.` });
      return;
    }
    void apply({ kind: 'moveStage', assetIds: ids, stage });
  };

  // ───── 보드 ─────
  // 파이프라인을 고르면 그 파이프라인 에셋만, 열 = 그 단계(docs/28). "모두"면 전체 파트 순서
  const pipeSel = pipe === 'all' ? null : pipe === 'base' ? { pipelineId: null as string | null, steps: v.parts.map(p => p.partId), groups: v.parts.map(p => [p.partId]) } : v.pipelines.find(p => p.pipelineId === pipe) ?? null;
  const boardShown = pipeSel ? shown.filter(a => a.pipelineId === pipeSel.pipelineId) : shown;
  // 파이프라인을 고르면 열 = 묶음(병렬 단계는 한 열, 열 id = 묶음 첫 파트)
  const colOf = (stage: Stage): string => (pipeSel ? pipeSel.groups.find(g => g.includes(stage))?.[0] ?? stage : stage);
  const boardStages = pipeSel
    ? [stages[0], ...pipeSel.groups.map(g => ({ id: g[0] as Stage, name: g.map(id => stageName.get(id) ?? id).join(' ∥ ') })), stages[stages.length - 1]]
    : stages;
  const boardParts = pipeSel ? v.parts.filter(p => pipeSel.steps.includes(p.partId)) : v.parts;
  const partBoard = boardBy !== 'stage' ? boardParts.find(p => p.partId === boardBy) ?? null : null;
  const boardCols: { id: string; name: string; items: AssetItem[] }[] = partBoard
    ? (['TODO', 'WIP', 'REVIEW', 'RETAKE', 'DONE', 'HOLD'] as AssetStatus[]).map(s => ({ id: s, name: LABEL[s], items: boardShown.filter(a => a.parts[partBoard.partId]?.status === s) }))
    : boardStages.map(s => ({ id: s.id, name: s.name, items: boardShown.filter(a => colOf(a.stage) === s.id) }));
  // 모든 에셋이 같은 파이프라인이라 어느 열에나 놓을 수 있다(해당 없음인 파트 열에 놓으면 그 파트가 켜진다)
  const canDrop = (col: string) => !!col;
  const onDrop = (col: string, index: number) => {
    const ids = dragIds;
    setDragIds([]); setOver(null);
    if (!ids.length || ro) return;
    const items = boardCols.find(c => c.id === col)!.items;
    const same = ids.every(id => items.some(a => a.assetId === id));
    if (same) {
      // 같은 열 안: 순서만 바꾼다
      const rest = items.filter(a => !ids.includes(a.assetId)).map(a => a.assetId);
      const at = Math.min(index, rest.length);
      const next = [...rest.slice(0, at), ...ids, ...rest.slice(at)];
      if (next.join() !== items.map(a => a.assetId).join()) void apply({ kind: 'reorderAssets', assetIds: next });
      return;
    }
    if (!canDrop(col)) return;
    if (partBoard) void apply({ kind: 'assetPart', assetIds: ids, partId: partBoard.partId, status: col as AssetStatus });
    else move(ids, col);
  };
  const dropIndex = (e: DragEvent, colEl: HTMLElement) => {
    const cards = [...colEl.querySelectorAll<HTMLElement>('.kb-card')];
    const y = e.clientY;
    const i = cards.findIndex(c => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    return i < 0 ? cards.length : i;
  };

  // ───── 리스트 묶기 ─────
  const groupsOfList: { key: string; name: string; items: AssetItem[] }[] = (() => {
    const list = shown.slice(0, limit);
    if (groupBy === 'none') return [{ key: 'all', name: '', items: list }];
    const keyOf = (a: AssetItem) => groupBy === 'group' ? `${groupName.get(a.resourceTypeId)} · ${rtName.get(a.resourceTypeId)}`
      : groupBy === 'category' ? `${rtName.get(a.resourceTypeId)} › ${a.category ?? '세부 분류 없음'}`
      : groupBy === 'batch' ? (a.batchId ? batchById.get(a.batchId)?.name ?? '' : '미배정') : stageName.get(a.stage) ?? '';
    const order = groupBy === 'stage' ? stages.map(s => s.name) : groupBy === 'batch' ? [...v.batches.map(b => b.name), '미배정'] : [...new Set(list.map(keyOf))];
    const m = new Map<string, AssetItem[]>();
    for (const a of list) { const k = keyOf(a); if (!m.has(k)) m.set(k, []); m.get(k)!.push(a); }
    return order.filter(k => m.has(k)).map(k => ({ key: k, name: k, items: m.get(k)! }));
  })();

  const Summary = () => (
    <div class="asset-summary small" aria-live="polite">
      <b>{shown.length}개</b>
      {stages.map(s => <span class="sum-item"><span class={`sum-dot${s.id === 'DONE' ? ' st-DONE' : s.id === 'TODO' ? ' st-TODO' : ' st-WIP'}`} />{s.name} {count(a => a.stage === s.id)}</span>)}
      <span class="sum-sep" />
      <span class="sum-item warn-num">검수 요청 {count(a => Object.values(a.parts).some(p => p.status === 'REVIEW'))}</span>
      <span class="sum-item bad-num">수정 {count(a => Object.values(a.parts).some(p => p.status === 'RETAKE'))}</span>
      <span class="sum-item">마감 지남 {count(a => !!dueOf(a) && dueOf(a)! < t0 && a.stage !== 'DONE')}</span>
    </div>
  );

  return (
    <div class="page assets-page">
      {/* 담당 칸 제안: 인력 화면의 작업자 명단(참여 중) */}
      <datalist id="asset-people">{v.people.map(p => <option value={p.name}>{p.team ?? ''}</option>)}</datalist>
      <header class="page-head">
        <div>
          <PageEyebrow page="assets" />
          <h1>에셋 제작 현황</h1>
          <p class="muted" style="margin-top: 6px">지금 만들고 있는 에셋의 단계와 상태를 리스트 · 보드에서 보고 바로 고칩니다. 완료는 작업 진척에 자동 집계됩니다.</p>
        </div>
        <label class="inline"><span class="small faint">업데이트(마일스톤)</span>
          <select class="field" aria-label="업데이트(마일스톤)" value={v.updateId ?? ''} onChange={e => { const id = (e.target as HTMLSelectElement).value; setUpdateId(id); props.onUpdate(id); setGroup('all'); setBatch('all'); }}>
            {v.updates.map(u => <option value={u.updateId}>{u.name}{u.live ? '' : ' (완료 · 취소)'}</option>)}
          </select></label>
      </header>

      <nav class="sub-tabs" role="tablist" aria-label="에셋 화면">
        <button type="button" role="tab" aria-selected={tab === 'assets'} class={tab === 'assets' ? 'on' : ''} onClick={() => setTab('assets')}>에셋 <span class="tab-n">{v.totals.assets}</span></button>
        <button type="button" role="tab" aria-selected={tab === 'batches'} class={tab === 'batches' ? 'on' : ''} onClick={() => setTab('batches')}>배치 <span class="tab-n">{v.batches.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === 'volumes'} class={tab === 'volumes' ? 'on' : ''} onClick={() => setTab('volumes')}>물량 대조</button>
      </nav>

      {tab === 'assets' && (
        <section class="card asset-board-card">
          <div class="asset-bar">
            <input class="field" type="search" aria-label="에셋 찾기" placeholder="이름 · 리소스명 · 분류 · 속성 · Jira" value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />
            <span style="flex: 1" />
            <div class="segmented wide" role="radiogroup" aria-label="보기">
              <button type="button" role="radio" aria-checked={view === 'list'} class={view === 'list' ? 'on' : ''} onClick={() => setView('list')}><IconList />리스트</button>
              <button type="button" role="radio" aria-checked={view === 'board'} class={view === 'board' ? 'on' : ''} onClick={() => setView('board')}><IconGrid />보드</button>
            </div>
            {!ro && <button type="button" class={`btn sm${adding ? ' on' : ''}`} aria-expanded={adding} onClick={() => setAdding(x => !x)}><IconPlus />에셋 더하기</button>}
            <button type="button" class="btn sm" onClick={() => void props.onExport(v.updateId)}><IconDownload />엑셀 받기</button>
            {!ro && <button type="button" class="btn sm" onClick={() => void props.onImport()}><IconFolder />엑셀 넣기</button>}
          </div>
          {/* 거르기 줄: 늘 같은 자리(고르기 전후로 화면이 움직이지 않게) */}
          <div class="filter-bar" role="group" aria-label="거르기">
            <span class="filter-label small">거르기</span>
            <select class={`field${group !== 'all' ? ' on' : ''}`} aria-label="항목" value={group} onChange={e => setGroup((e.target as HTMLSelectElement).value)}>
              <option value="all">모든 항목</option>
              {v.groups.map(g => <option value={groupKey(g)}>{g.name} ({g.total})</option>)}
            </select>
            <select class={`field${cat !== 'all' ? ' on' : ''}`} aria-label="세부 분류 거르기" value={cat} onChange={e => setCat((e.target as HTMLSelectElement).value)}>
              <option value="all">모든 세부 분류</option><option value="none">세부 분류 없음</option>
              {categories.map(c => <option value={c}>{c}</option>)}
            </select>
            <select class={`field${batch !== 'all' ? ' on' : ''}`} aria-label="배치 거르기" value={batch} onChange={e => setBatch((e.target as HTMLSelectElement).value)}>
              <option value="all">모든 배치</option><option value="none">미배정</option>
              {v.batches.map(b => <option value={b.batchId}>{b.name}</option>)}
            </select>
            <select class={`field${team !== 'all' ? ' on' : ''}`} aria-label="팀 거르기" title="그 파트 일이 있는(해당 없음이 아닌) 에셋만. 담당 · 상태도 그 파트 기준으로 거릅니다" value={team} onChange={e => { setTeam((e.target as HTMLSelectElement).value); setWho('all'); }}>
              <option value="all">모든 팀</option>
              {v.parts.map(p => <option value={p.partId}>{p.name}팀</option>)}
            </select>
            <select class={`field${who !== 'all' ? ' on' : ''}`} aria-label="담당 거르기" value={who} onChange={e => setWho((e.target as HTMLSelectElement).value)}>
              <option value="all">{team !== 'all' ? `모든 ${v.parts.find(p => p.partId === team)?.name ?? ''} 담당` : '모든 담당'}</option>
              {people.map(p => <option value={p}>{p}</option>)}
            </select>
            <select class={`field${status !== 'all' ? ' on' : ''}`} aria-label="상태 거르기" value={status} onChange={e => setStatus((e.target as HTMLSelectElement).value)}>
              <option value="all">{team !== 'all' ? `모든 ${v.parts.find(p => p.partId === team)?.name ?? ''} 상태` : '모든 상태'}</option>
              {STATUS.map(x => <option value={x.s}>{x.label}</option>)}
            </select>
            <select class={`field${attrF !== 'all' ? ' on' : ''}`} aria-label="속성 거르기" value={attrF} onChange={e => setAttrF((e.target as HTMLSelectElement).value)} disabled={attrOptions.size === 0}>
              <option value="all">{attrOptions.size ? '모든 속성' : '속성 없음'}</option>
              {[...attrOptions.entries()].map(([n, vals]) => <optgroup label={n}>{[...vals].sort((x, y) => x.localeCompare(y, 'ko')).map(x => <option value={JSON.stringify([n, x])}>{n}: {x}</option>)}</optgroup>)}
            </select>
            <button type="button" class="btn sm ghost" disabled={filtered === 0} onClick={clearFilters}>거르기 풀기{filtered ? ` (${filtered})` : ''}</button>
          </div>
          {adding && !ro && (
            <div class="asset-add">
              <select class="field" aria-label="더할 리소스 종류" value={add.rt || rts[0]?.resourceTypeId || ''} onChange={e => setAdd({ ...add, rt: (e.target as HTMLSelectElement).value })}>
                {curGroups.map(g => <optgroup label={g.name}>{g.resources.map(r => <option value={r.resourceTypeId}>{r.name}</option>)}</optgroup>)}
              </select>
              <input class="field" aria-label="새 에셋 이름" placeholder="새 에셋 이름(쉼표로 여러 개)" value={add.names} onInput={e => setAdd({ ...add, names: (e.target as HTMLInputElement).value })}
                onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget.nextElementSibling as HTMLButtonElement | null)?.click(); }} />
              <button type="button" class="btn sm primary" disabled={!add.names.trim()} onClick={async () => {
                const names = add.names.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
                if (await apply({ kind: 'createAssets', updateId: v.updateId!, resourceTypeId: add.rt || rts[0]?.resourceTypeId || '', names, batchId: batch !== 'all' && batch !== 'none' ? batch : null })) setAdd({ ...add, names: '' });
              }}>더하기</button>
              <span class="small faint">물량만큼 한 번에 만들려면 "물량 대조" 탭의 "빈 에셋 만들기"를 씁니다.</span>
            </div>
          )}
          <Summary />

          {/* 고른 에셋 한 번에 고치기: 자리를 늘 확보(고르기 전후로 화면이 움직이지 않게) */}
          <div class={`bulk-bar${selIds.length ? ' on' : ''}`} aria-live="polite">
            {selIds.length === 0
              ? <span class="small faint">{view === 'board' ? '카드를 끌어 단계를 바꿉니다. 체크한 카드는 함께 옮겨집니다.' : '체크로 여러 에셋을 고르면 단계 · 배치 · 파트 상태(해당 없음 ↔ 대기 등)를 한 번에 바꿉니다.'}</span>
              : <>
                <b class="small">{selIds.length}개 선택</b>
                {!ro && <>
                  <select class="field" aria-label="일괄 단계" value={bulk.stage || 'DONE'} onChange={e => setBulk({ ...bulk, stage: (e.target as HTMLSelectElement).value })}>{stages.map(s => <option value={s.id}>{s.name}</option>)}</select>
                  <button type="button" class="btn sm" onClick={() => move(selIds, bulk.stage || 'DONE')}>단계 옮기기</button>
                  <span class="bulk-sep" />
                  <select class="field" aria-label="옮길 배치" value={bulk.batch} onChange={e => setBulk({ ...bulk, batch: (e.target as HTMLSelectElement).value })}>
                    <option value="">미배정</option>{v.batches.map(b => <option value={b.batchId}>{b.name}</option>)}
                  </select>
                  <button type="button" class="btn sm" onClick={() => void apply({ kind: 'assetField', assetIds: selIds, field: 'batch_id', value: bulk.batch || null })}>배치 옮기기</button>
                  <span class="bulk-sep" />
                  <select class="field" aria-label="일괄 파트" value={bulk.part || v.parts[0]?.partId} onChange={e => setBulk({ ...bulk, part: (e.target as HTMLSelectElement).value })}>{v.parts.map(p => <option value={p.partId}>{p.name}</option>)}</select>
                  <select class="field" aria-label="일괄 파트 상태" value={bulk.partStatus} onChange={e => setBulk({ ...bulk, partStatus: (e.target as HTMLSelectElement).value as AssetStatus })}>{STATUS.map(x => <option value={x.s}>{x.label}</option>)}</select>
                  <button type="button" class="btn sm" title="고른 에셋의 그 파트 상태를 바꿉니다. 하지 않는 파트는 해당 없음, 나중에 하게 되면 대기로" onClick={() => void apply({ kind: 'assetPart', assetIds: selIds, partId: bulk.part || v.parts[0]?.partId, status: bulk.partStatus })}>파트 상태 바꾸기</button>
                </>}
                <span style="flex: 1" />
                <button type="button" class="btn sm ghost" onClick={() => setSel(new Set())}>선택 풀기</button>
              </>}
          </div>

          {shown.length === 0 && (
            <div class="empty-assets">
              <p class="muted">{v.assets.length ? '조건에 맞는 에셋이 없습니다.' : '아직 등록된 에셋이 없습니다.'}</p>
              <p class="small faint">"에셋 더하기"나 "엑셀 넣기"로 등록하거나, "물량 대조" 탭의 "빈 에셋 만들기"로 물량만큼 한 번에 만듭니다.</p>
            </div>
          )}

          {view === 'list' && shown.length > 0 && (
            <>
              <div class="list-opts small">
                <span class="faint">묶기</span>
                <div class="segmented wide" role="radiogroup" aria-label="리스트 묶기">
                  {([['group', '항목'], ['category', '세부 분류'], ['batch', '배치'], ['stage', '단계'], ['none', '없음']] as [GroupBy, string][]).map(([k, l]) => <button type="button" role="radio" aria-checked={groupBy === k} class={groupBy === k ? 'on' : ''} onClick={() => setGroupBy(k)}>{l}</button>)}
                </div>
              </div>
              <div class="table-wrap ref-wrap">
                <table class="grid edit ref asset-list">
                  <colgroup><col style="width: 40px" /><col style="width: 56px" /><col style="width: 210px" />{groupBy !== 'group' && <col style="width: 150px" />}<col style="width: 112px" /><col style="width: 112px" /><col style="width: 104px" /><col style="width: 112px" /><col style="width: 104px" /><col style="width: 96px" /><col style="width: 92px" /></colgroup>
                  <thead><tr>
                    <th class="c"><input type="checkbox" aria-label="보이는 에셋 모두 고르기" checked={selIds.length > 0 && selIds.length === shown.length} onChange={e => setSel((e.target as HTMLInputElement).checked ? new Set(shown.map(a => a.assetId)) : new Set())} /></th>
                    <th aria-label="썸네일" /><th>에셋</th>{groupBy !== 'group' && <th>항목 · 종류</th>}<th>단계</th><th>세부 상태</th><th>담당</th><th>배치</th><th>마감</th><th>Jira</th><th>파트</th>
                  </tr></thead>
                  <tbody>
                    {groupsOfList.map(g => (
                      <>
                        {groupBy !== 'none' && <tr class="group group-strong"><td colSpan={groupBy === 'group' ? 10 : 11}><span class="group-head"><b>{g.name}</b><span class="group-count">{g.items.length}</span></span></td></tr>}
                        {g.items.map(a => {
                          const jh = jiraHref(v.jiraBase, a.jiraKey);
                          const midStage = a.stage !== 'TODO' && a.stage !== 'DONE';
                          return (
                            <tr class={`row${sel.has(a.assetId) ? ' picked' : ''}`}>
                              <td class="c"><input type="checkbox" aria-label={`${a.name} 고르기`} checked={sel.has(a.assetId)} onChange={() => toggle(a.assetId)} /></td>
                              <td><button type="button" class="thumb-btn" aria-label={`${a.name} 카드 열기`} onClick={() => setOpenId(a.assetId)}><Thumb asset={a} size="sm" /></button></td>
                              <td><button type="button" class="link-btn" onClick={() => setOpenId(a.assetId)}>{a.name}</button>
                                <span class="row-meta small faint">{[groupBy !== 'category' && a.category !== rtName.get(a.resourceTypeId) ? a.category : null, a.code, a.comments ? `댓글 ${a.comments}` : null, a.links ? `링크 ${a.links}` : null].filter(Boolean).join(' · ')}</span></td>
                              {groupBy !== 'group' && <td class="small">{groupName.get(a.resourceTypeId)} · {rtName.get(a.resourceTypeId)}</td>}
                              <td><select class={`field stage-select stage-${a.stage === 'DONE' ? 'done' : a.stage === 'TODO' ? 'todo' : 'mid'}`} aria-label={`${a.name} 단계`} value={a.stage} disabled={ro} onChange={e => move([a.assetId], (e.target as HTMLSelectElement).value)}>
                                {stagesOf(a, v.parts, v.pipelines).map(s => <option value={s.id}>{s.name}</option>)}
                              </select></td>
                              <td class="st-cell">{midStage
                                ? <StatusSelect value={a.sub} label={`${a.name} 세부 상태`} disabled={ro} options={SUBS} onChange={st => void apply({ kind: 'assetPart', assetIds: [a.assetId], partId: a.stage, status: st })} />
                                : <span class={`label-chip st-${a.sub}`}>{LABEL[a.sub]}</span>}</td>
                              <td>{midStage
                                ? <Field value={a.assignee ?? ''} label={`${a.name} 담당`} placeholder="담당" list="asset-people" disabled={ro} onCommit={t => apply({ kind: 'assetPart', assetIds: [a.assetId], partId: a.stage, assignee: t })} />
                                : <span class="faint small">{a.assignee ?? '—'}</span>}</td>
                              <td><select class="field" aria-label={`${a.name} 배치`} value={a.batchId ?? ''} disabled={ro} onChange={e => void apply({ kind: 'assetField', assetIds: [a.assetId], field: 'batch_id', value: (e.target as HTMLSelectElement).value || null })}>
                                <option value="">미배정</option>{v.batches.map(b => <option value={b.batchId}>{b.name}</option>)}
                              </select></td>
                              <td><DueCell own={a.dueDate} batchDue={a.batchId ? batchById.get(a.batchId)?.dueDate ?? null : null} done={a.stage === 'DONE'} label={`${a.name} 마감일`} disabled={ro}
                                onCommit={d2 => apply({ kind: 'assetField', assetIds: [a.assetId], field: 'due_date', value: d2 })} /></td>
                              <td class="small">{a.jiraKey ? (jh ? <a href={jh} target="_blank" rel="noreferrer">{a.jiraKey}</a> : a.jiraKey) : <span class="faint">—</span>}</td>
                              <td><PartDots asset={a} parts={v.parts} pipelines={v.pipelines} /></td>
                            </tr>
                          );
                        })}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
              {shown.length > limit && <button type="button" class="btn sm" style="margin-top: 10px" onClick={() => setLimit(l => l + 300)}>다음 {Math.min(300, shown.length - limit)}개 더 보기 ({limit} / {shown.length})</button>}
            </>
          )}

          {view === 'board' && shown.length > 0 && (
            <>
              <div class="list-opts small">
                {v.pipelines.length > 0 && <>
                  <span class="faint">파이프라인</span>
                  <select class="field ghost-field" aria-label="보드 파이프라인" value={pipeSel || pipe === 'all' ? pipe : 'all'} onChange={e => setPipe((e.target as HTMLSelectElement).value)}>
                    <option value="all">모두(전체 파트 순서)</option>
                    {v.assets.some(a => !a.pipelineId || !v.pipelines.some(p => p.pipelineId === a.pipelineId)) && <option value="base">파이프라인 고르지 않음</option>}
                    {v.pipelines.map(p => <option value={p.pipelineId}>{p.name}</option>)}
                  </select>
                </>}
                <span class="faint">열</span>
                <div class="segmented wide" role="radiogroup" aria-label="보드 열">
                  <button type="button" role="radio" aria-checked={!partBoard} class={!partBoard ? 'on' : ''} onClick={() => setBoardBy('stage')}>제작 단계</button>
                  {boardParts.map(p => <button type="button" role="radio" aria-checked={boardBy === p.partId} class={boardBy === p.partId ? 'on' : ''} onClick={() => setBoardBy(p.partId)}>{p.name} 상태</button>)}
                </div>
                <span class="faint">{partBoard ? `${partBoard.name} 파트의 상태별 열입니다. 이 파트가 "해당 없음"인 에셋은 빠집니다.` : '카드는 지금 작업 중인 파트 열에 있습니다. 앞 열로 끌면 지나친 파트는 완료, "해당 없음"인 파트 열에 놓으면 그 파트가 켜집니다.'}{pipeSel && boardShown.length < shown.length ? ` 다른 파이프라인 에셋 ${shown.length - boardShown.length}개는 이 보드에 없습니다.` : ''}</span>
              </div>
              <div class="kanban" role="list" aria-label="보드">
                {boardCols.map(col => {
                  const blocked = dragIds.length > 0 && !canDrop(col.id);
                  return (
                    <div class={`kb-col${blocked ? ' blocked' : ''}${over?.col === col.id ? ' over' : ''}`} role="listitem" aria-label={`${col.name} 열`} data-col={col.id}
                      onDragOver={e => { if (!dragIds.length) return; e.preventDefault(); const el = e.currentTarget as HTMLElement; setOver({ col: col.id, index: dropIndex(e, el) }); }}
                      onDragLeave={e => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(o => (o?.col === col.id ? null : o)); }}
                      onDrop={e => { e.preventDefault(); onDrop(col.id, dropIndex(e, e.currentTarget as HTMLElement)); }}>
                      <div class="kb-head"><b>{col.name}</b><span class="kb-n">{col.items.length}</span>{blocked && <span class="small faint">놓을 수 없음</span>}</div>
                      <div class="kb-list">
                        {col.items.map((a, i) => {
                          const due = dueOf(a);
                          const late = !!due && due < t0 && a.stage !== 'DONE';
                          return (
                            <>
                              {over?.col === col.id && over.index === i && <div class="kb-drop-line" />}
                              <div class={`kb-card${sel.has(a.assetId) ? ' picked' : ''}${dragIds.includes(a.assetId) ? ' dragging' : ''}`} draggable={!ro} data-id={a.assetId}
                                onDragStart={e => { const ids = sel.has(a.assetId) ? selIds : [a.assetId]; setDragIds(ids); e.dataTransfer?.setData('text/plain', ids.join(',')); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; }}
                                onDragEnd={() => { setDragIds([]); setOver(null); }}
                                onClick={e => { if ((e.target as HTMLElement).closest('input, select, a, button')) return; if (e.shiftKey) toggle(a.assetId); else setOpenId(a.assetId); }}>
                                <Thumb asset={a} size="cover" />
                                <input type="checkbox" class="kb-check" aria-label={`${a.name} 고르기`} checked={sel.has(a.assetId)} onChange={() => toggle(a.assetId)} />
                                <div class="kb-body">
                                  <span class="kb-name">{a.name}</span>
                                  <span class="kb-meta small faint">{a.category ?? rtName.get(a.resourceTypeId)}{a.batchId ? ` · ${batchById.get(a.batchId)?.name}` : ''}</span>
                                  <div class="kb-badges">
                                    {!partBoard && a.stage !== 'TODO' && a.stage !== 'DONE'
                                      ? <StatusSelect value={a.sub} label={`${a.name} 세부 상태`} disabled={ro} options={SUBS} onChange={st => void apply({ kind: 'assetPart', assetIds: [a.assetId], partId: a.stage, status: st })} />
                                      : null}
                                    {due && <span class={`label-chip${late ? ' overdue' : ''}`}>{due.slice(5).replace('-', '/')}</span>}
                                    {a.assignee && <span class="label-chip">{a.assignee}</span>}
                                    {a.jiraKey && <span class="label-chip">{a.jiraKey}</span>}
                                    {a.comments > 0 && <span class="label-chip" title="댓글">💬 {a.comments}</span>}
                                  </div>
                                  <PartDots asset={a} parts={v.parts} pipelines={v.pipelines} />
                                </div>
                              </div>
                            </>
                          );
                        })}
                        {over?.col === col.id && over.index >= col.items.length && <div class="kb-drop-line" />}
                        {col.items.length === 0 && <div class="kb-empty small faint">여기로 끌어 옮깁니다</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      )}

      {tab === 'batches' && (
        <section class="card">
          <div class="card-head"><div><h2>배치</h2><p class="small muted" style="margin-top: 2px">업데이트(마일스톤) 안의 납품 묶음입니다. 왼쪽 손잡이(⠿)나 줄을 길게 눌러 끌면 순서가 바뀝니다. 마감일은 그 배치 에셋의 모든 파트가 완료되는 날 기준입니다. 에셋 마감일이 비어 있으면 배치 마감일을 따릅니다.</p></div></div>
          <div class="card-body" style="padding-top: 4px">
            <div class="table-wrap ref-wrap">
              <table class="grid edit ref batch-table">
                <colgroup><col style="width: 44px" /><col /><col style="width: 170px" /><col style="width: 90px" /><col style="width: 90px" /><col style="width: 200px" /><col style="width: 48px" /></colgroup>
                <thead><tr><th aria-label="순서" /><th>배치</th><th>마감일</th><th class="n">에셋</th><th class="n">완료</th><th>진행</th><th aria-label="행 작업" /></tr></thead>
                <BatchRows batches={v.batches} ro={ro} apply={apply}>{b => (
                    <>
                      <td><Field class="field" value={b.name} label={`${b.name} 배치 이름`} disabled={ro} onCommit={t => apply({ kind: 'batchField', batchId: b.batchId, field: 'name', value: t })} /></td>
                      <td><input class="field" type="date" aria-label={`${b.name} 마감일`} value={b.dueDate ?? ''} disabled={ro} onChange={e => void apply({ kind: 'batchField', batchId: b.batchId, field: 'due_date', value: (e.target as HTMLInputElement).value || null })} /></td>
                      <td class="n num">{b.count}</td>
                      <td class="n num">{b.done}</td>
                      <td><span class="share"><span class="num small">{fmtPct(b.progress)}</span><span class="bar"><span class="fill" style={{ width: `${Math.round(b.progress * 100)}%` }} /></span></span></td>
                      <td class="n">{!ro && <button type="button" class="btn ghost icon-btn" aria-label={`${b.name} 배치 지우기`} title="지우면 이 배치의 에셋은 미배정이 됩니다" onClick={() => void apply({ kind: 'deleteBatch', batchId: b.batchId })}><IconX /></button>}</td>
                    </>
                )}</BatchRows>
              </table>
            </div>
            {!ro && (
              <div class="inline" style="margin-top: 10px">
                <input class="field" aria-label="새 배치 이름" placeholder="새 배치 이름 (예: 1차)" value={newBatch.name} onInput={e => setNewBatch({ ...newBatch, name: (e.target as HTMLInputElement).value })} />
                <input class="field" type="date" aria-label="새 배치 마감일" value={newBatch.due} onInput={e => setNewBatch({ ...newBatch, due: (e.target as HTMLInputElement).value })} />
                <button type="button" class="btn sm" disabled={!newBatch.name.trim()} onClick={async () => {
                  if (await apply({ kind: 'createBatch', updateId: v.updateId!, name: newBatch.name, dueDate: newBatch.due || null })) setNewBatch({ name: '', due: '' });
                }}><IconPlus />배치 더하기</button>
                {v.batches.some(b => b.dueDate) && <span class="small faint">가장 가까운 마감 {fmtDate(v.batches.filter(b => b.dueDate).map(b => b.dueDate!).sort()[0])}</span>}
              </div>
            )}
          </div>
        </section>
      )}

      {tab === 'volumes' && (
        <section class="card">
          <div class="card-head"><div><h2>물량 대조</h2><p class="small muted" style="margin-top: 2px">계획 물량과 등록 에셋 수를 비교합니다. 물량이 계획의 기준이고, 에셋은 그 안의 실제 목록입니다.</p></div></div>
          <div class="card-body" style="padding-top: 4px">
            <div class="table-wrap ref-wrap">
              <table class="grid ref vol-compare">
                <colgroup><col /><col class="tri-col" /><col class="tri-col" /><col style="width: 90px" /><col style="width: 90px" /><col style="width: 270px" /></colgroup>
                <thead><tr><th>리소스 종류</th><th class="n">물량 <span class="unit">{MODE_LABEL.MIN} · {MODE_LABEL.TARGET} · {MODE_LABEL.STRETCH}</span></th><th class="n">등록 에셋 <span class="unit">같은 순서</span></th><th class="n">차이 <span class="unit">{MODE_LABEL.STRETCH}</span></th><th class="n">완료</th><th>맞추기</th></tr></thead>
                <tbody>
                  {v.groups.map(g => (
                    <>
                      <tr class="group group-strong"><td colSpan={6}><span class="group-head"><b>{g.name}</b><span class="group-count">{g.resources.length}종</span></span></td></tr>
                      {g.resources.map(r => {
                        const reg = [r.registered.MIN, r.registered.MIN + r.registered.TARGET, r.registered.total];
                        const diff = r.registered.total - (r.volume.stretch ?? 0);
                        return (
                          <tr class="row in-group">
                            <td><b>{r.name}</b>{r.manualProgress && <span class="tag" title="에셋을 만들면 완료 수량은 에셋 상태로 다시 셉니다. '빈 에셋 만들기'는 손으로 넣은 완료 수량을 앞 에셋부터 완료로 옮깁니다" style="margin-left: 6px">손 입력 진척 있음</span>}</td>
                            <td class="n num">{[r.volume.min, r.volume.target, r.volume.stretch].map(x => (x == null ? '—' : x)).join(' · ')}</td>
                            <td class="n num">{reg.join(' · ')}</td>
                            <td class={`n num${diff < 0 ? ' warn-num' : diff > 0 ? ' bad-num' : ''}`}>{diff === 0 ? '0' : diff > 0 ? `+${diff}` : `−${-diff}`}</td>
                            <td class="n num">{r.done}</td>
                            <td>{!ro && <span class="inline nowrap">
                              <button type="button" class="btn sm" disabled={reg[2] >= (r.volume.stretch ?? 0) && reg[0] >= (r.volume.min ?? 0) && reg[1] >= (r.volume.target ?? 0)}
                                title="물량만큼 이름 미정 에셋을 만듭니다(템플릿 구간별로 모자란 만큼)" onClick={() => void apply({ kind: 'fillAssets', updateId: v.updateId!, resourceTypeId: r.resourceTypeId })}>빈 에셋 만들기</button>
                              <button type="button" class="btn sm" disabled={r.registered.total === 0 || (reg[0] === r.volume.min && reg[1] === r.volume.target && reg[2] === r.volume.stretch)}
                                title="물량(최소안 · 기본안 · 최대안)을 등록 에셋 수에 맞춥니다" onClick={() => void apply({ kind: 'volumeFromAssets', updateId: v.updateId!, resourceTypeId: r.resourceTypeId })}>물량을 에셋에</button>
                            </span>}</td>
                          </tr>
                        );
                      })}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {confirm && (
        <div class="overlay" onClick={e => { if (e.target === e.currentTarget) setConfirm(null); }}>
          <div class="card dialog confirm-dialog" role="dialog" aria-label="단계 되돌리기 확인">
            <h2 style="font-size: 16px">단계를 되돌리시겠습니까?</h2>
            <p class="small muted" style="margin: 8px 0 14px">{confirm.text} 변경 이력에서 되돌릴 수 있습니다.</p>
            <div class="inline" style="justify-content: flex-end">
              <button type="button" class="btn sm ghost" onClick={() => setConfirm(null)}>그만두기</button>
              <button type="button" class="btn sm primary" onClick={() => { const c = confirm; setConfirm(null); void apply({ kind: 'moveStage', assetIds: c.ids, stage: c.stage }); }}>되돌리기</button>
            </div>
          </div>
        </div>
      )}

      {open && <CardWindow view={v} asset={open} stages={stages} readOnly={ro} version={props.version} apply={apply} move={move} onClose={() => setOpenId(null)} />}
    </div>
  );
}
