// 에셋 제작 현황(docs/20-asset-management.md 7절): ① 항목(분류) ② 물량 대조 ③ 에셋(카드 · 표, 파트별 상태) ④ 배치 · 에셋 상세 패널.
// 파트 상태의 "완료 · 해당 없음"은 작업 진척 완료 수량으로 자동 집계된다(core/assets.ts).
import { useState, useEffect, useRef } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { Field } from './SetupPage.tsx';
import { rpc } from '../lib/rpc.ts';
import type { AssetsView, AssetItem, AssetStatus, Tier } from '../../../core/assets.ts';
import type { Edit } from '../../../core/edits.ts';
import { fmtPct, fmtDate } from '../lib/format.ts';
import { MODE_LABEL } from '../lib/modes.ts';
import { IconPlus, IconX, IconDownload, IconFolder, IconImage, IconGrid, IconList } from './icons.tsx';

const STATUS: { s: AssetStatus; label: string }[] = [
  { s: 'TODO', label: '대기' }, { s: 'WIP', label: '진행' }, { s: 'REVIEW', label: '검수 요청' }, { s: 'RETAKE', label: '수정' },
  { s: 'DONE', label: '완료' }, { s: 'HOLD', label: '보류' }, { s: 'OMIT', label: '해당 없음' },
];
const LABEL = Object.fromEntries(STATUS.map(x => [x.s, x.label])) as Record<AssetStatus, string>;
const TIERS: Tier[] = ['MIN', 'TARGET', 'STRETCH'];
type Filter = 'all' | 'open' | 'done' | 'REVIEW' | 'RETAKE' | 'HOLD' | 'WIP';
const FILTERS: { f: Filter; label: string }[] = [
  { f: 'all', label: '전체 상태' }, { f: 'open', label: '끝나지 않음' }, { f: 'done', label: '모두 완료' },
  { f: 'WIP', label: '진행 있음' }, { f: 'REVIEW', label: '검수 요청 있음' }, { f: 'RETAKE', label: '수정 있음' }, { f: 'HOLD', label: '보류 있음' },
];
const isDone = (a: AssetItem) => Object.values(a.parts).length > 0 && Object.values(a.parts).every(p => p.status === 'DONE' || p.status === 'OMIT');

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
        const url = it ? URL.createObjectURL(new Blob([it.data], { type: it.mime })) : null;
        if (url) thumbCache.set(k, url);
        for (const cb of cbs.get(k) ?? []) cb(url);
      }
    } catch { for (const k of keys) for (const cb of cbs.get(k) ?? []) cb(null); }
  }, 30);
}

function Thumb(props: { asset: AssetItem; size?: 'sm' }) {
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
    }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => { alive = false; io.disconnect(); };
  }, [props.asset.assetId, at]);
  return (
    <div ref={ref} class={`thumb${props.size === 'sm' ? ' sm' : ''}${url ? ' has' : ''}`}>
      {url ? <img src={url} alt="" loading="lazy" /> : <span class="thumb-empty" aria-hidden="true">{props.asset.name.slice(0, 2)}</span>}
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

function StatusSelect(props: { value: AssetStatus; label: string; disabled: boolean; onChange: (s: AssetStatus) => void }) {
  return (
    <select class={`st-select st-${props.value}`} aria-label={props.label} value={props.value} disabled={props.disabled}
      onChange={e => props.onChange((e.target as HTMLSelectElement).value as AssetStatus)}>
      {STATUS.map(x => <option value={x.s}>{x.label}</option>)}
    </select>
  );
}

function PartDots(props: { asset: AssetItem; parts: AssetsView['parts'] }) {
  return (
    <span class="part-dots">
      {props.parts.filter(p => props.asset.parts[p.partId]).map(p => {
        const s = props.asset.parts[p.partId];
        return <span class={`pdot st-${s.status}`} title={`${p.name}: ${LABEL[s.status]}${s.doneAt ? ` · ${s.doneAt}` : ''}`}><span class="pdot-name">{p.name.slice(0, 2)}</span></span>;
      })}
    </span>
  );
}

function jiraHref(base: string | null, key: string | null) {
  return base && key ? `${base}${encodeURIComponent(key)}` : null;
}

// ───────── 에셋 상세 패널 ─────────
function AssetDrawer(props: { view: AssetsView; asset: AssetItem; readOnly: boolean; apply: (e: Edit) => Promise<boolean>; onClose: () => void }) {
  const { view, asset: a, readOnly: ro, apply } = props;
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rt = view.groups.flatMap(g => g.resources).find(r => r.resourceTypeId === a.resourceTypeId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    const onPaste = (e: ClipboardEvent) => { const f = [...(e.clipboardData?.files ?? [])].find(x => x.type.startsWith('image/')); if (f) { e.preventDefault(); void putThumb(f); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('paste', onPaste); };
  }, [a.assetId]);
  const putThumb = async (file: Blob) => {
    if (ro) return;
    setBusy(true);
    try {
      const t = await makeThumb(file);
      await apply({ kind: 'assetThumb', assetId: a.assetId, data: t.data, mime: t.mime, width: t.width, height: t.height });
    } finally { setBusy(false); }
  };
  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => { const f = input.files?.[0]; if (f) void putThumb(f); };
    input.click();
  };
  const href = jiraHref(view.jiraBase, a.jiraKey);
  return (
    <div class="overlay" onClick={e => { if (e.target === e.currentTarget) props.onClose(); }}>
      <aside class="drawer card asset-drawer" role="dialog" aria-label="에셋 상세">
        <div class="dialog-head">
          <div style="flex: 1; min-width: 0">
            <Field class="title-input" value={a.name} label="에셋 이름" disabled={ro} onCommit={t => apply({ kind: 'assetField', assetIds: [a.assetId], field: 'name', value: t })} />
            <p class="small muted">{view.groups.find(g => g.resources.some(r => r.resourceTypeId === a.resourceTypeId))?.name} · {rt?.name} · 진행 {fmtPct(a.progress)}{a.retakes ? ` · 리테이크 ${a.retakes}회` : ''}</p>
          </div>
          <button type="button" class="btn ghost icon-btn" aria-label="닫기" onClick={props.onClose}><IconX /></button>
        </div>
        <div class="drawer-body">
          <div class="asset-top">
            <div class={`thumb-drop${drag ? ' drag' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); const f = [...(e.dataTransfer?.files ?? [])].find(x => x.type.startsWith('image/')); if (f) void putThumb(f); }}>
              <Thumb asset={a} />
              {!ro && (
                <div class="thumb-actions">
                  <button type="button" class="btn sm" disabled={busy} onClick={pick}><IconImage />{busy ? '줄이는 중…' : a.thumbAt ? '썸네일 바꾸기' : '썸네일 넣기'}</button>
                  {a.thumbAt && <button type="button" class="btn sm" onClick={() => void apply({ kind: 'assetThumb', assetId: a.assetId, data: null })}>지우기</button>}
                  <span class="small faint">끌어놓기 · 붙여넣기(Ctrl+V)도 됩니다. 긴 변 256px로 줄여 저장합니다.</span>
                </div>
              )}
            </div>
            <div class="asset-fields">
              <label class="form-row"><span class="form-label">코드</span>
                <Field value={a.code ?? ''} label="에셋 코드" placeholder="예: CK_0123" disabled={ro} onCommit={t => apply({ kind: 'assetField', assetIds: [a.assetId], field: 'code', value: t })} /></label>
              <label class="form-row"><span class="form-label">배치</span>
                <select class="field" aria-label="배치" value={a.batchId ?? ''} disabled={ro} onChange={e => void apply({ kind: 'assetField', assetIds: [a.assetId], field: 'batch_id', value: (e.target as HTMLSelectElement).value || null })}>
                  <option value="">미배정</option>
                  {view.batches.map(b => <option value={b.batchId}>{b.name}{b.dueDate ? ` · ${b.dueDate}` : ''}</option>)}
                </select></label>
              <div class="form-row"><span class="form-label">포함 템플릿</span>
                <div class="segmented" role="radiogroup" aria-label="포함 템플릿">
                  {TIERS.map(t => <button type="button" role="radio" aria-checked={a.tier === t} class={a.tier === t ? 'on' : ''} disabled={ro}
                    onClick={() => void apply({ kind: 'assetField', assetIds: [a.assetId], field: 'tier', value: t })}>{MODE_LABEL[t]}</button>)}
                </div></div>
              <label class="form-row"><span class="form-label">Jira</span>
                <span class="inline nowrap">
                  <Field value={a.jiraKey ?? ''} label="에셋 Jira 키" placeholder="ABC-123" disabled={ro} onCommit={t => apply({ kind: 'assetField', assetIds: [a.assetId], field: 'jira_key', value: t })} />
                  {href ? <a class="btn sm" href={href} target="_blank" rel="noreferrer">열기</a> : a.jiraKey && <span class="small faint" title="프로젝트 · 파트 · 리소스 화면에서 Jira 주소를 입력하십시오">주소 없음</span>}
                </span></label>
            </div>
          </div>
          <section>
            <h3 class="sub-h">파트별 상태</h3>
            <div class="table-wrap ref-wrap">
              <table class="grid edit ref asset-parts-table">
                <colgroup><col style="width: 110px" /><col style="width: 140px" /><col style="width: 150px" /><col /><col style="width: 140px" /><col style="width: 80px" /></colgroup>
                <thead><tr><th>파트</th><th>상태</th><th>완료일</th><th>담당</th><th>Jira</th><th class="n">리테이크</th></tr></thead>
                <tbody>
                  {view.parts.filter(p => a.parts[p.partId]).map(p => {
                    const s = a.parts[p.partId];
                    const jh = jiraHref(view.jiraBase, s.jiraKey);
                    return (
                      <tr class="row">
                        <td><b>{p.name}</b></td>
                        <td><StatusSelect value={s.status} label={`${p.name} 상태`} disabled={ro} onChange={st => void apply({ kind: 'assetPart', assetIds: [a.assetId], partId: p.partId, status: st })} /></td>
                        <td>{s.status === 'DONE'
                          ? <input class="field" type="date" aria-label={`${p.name} 완료일`} value={s.doneAt ?? ''} disabled={ro} onChange={e => void apply({ kind: 'assetPart', assetIds: [a.assetId], partId: p.partId, doneAt: (e.target as HTMLInputElement).value || null })} />
                          : <span class="faint small">{s.startedAt ? `시작 ${s.startedAt}` : '—'}</span>}</td>
                        <td><Field value={s.assignee ?? ''} label={`${p.name} 담당`} placeholder="이름" disabled={ro} onCommit={t => apply({ kind: 'assetPart', assetIds: [a.assetId], partId: p.partId, assignee: t })} /></td>
                        <td><span class="inline nowrap"><Field value={s.jiraKey ?? ''} label={`${p.name} Jira 키`} placeholder="ABC-123" disabled={ro} onCommit={t => apply({ kind: 'assetPart', assetIds: [a.assetId], partId: p.partId, jiraKey: t })} />
                          {jh && <a class="jira-link" href={jh} target="_blank" rel="noreferrer" aria-label={`${s.jiraKey} 열기`}>↗</a>}</span></td>
                        <td class="n num">{s.retakes || <span class="faint">0</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p class="small faint" style="margin-top: 6px">"완료"와 "해당 없음"이 작업 진척의 완료 수량에 들어갑니다. "수정"으로 돌리면 리테이크를 1회 셉니다.</p>
          </section>
          <label class="form-row"><span class="form-label">메모</span>
            <Field value={a.note ?? ''} label="에셋 메모" placeholder="참고 링크 · 특이 사항" disabled={ro} onCommit={t => apply({ kind: 'assetField', assetIds: [a.assetId], field: 'note', value: t })} /></label>
          <div class="viewer-slot small faint">에셋 뷰어(큰 이미지 · 여러 장 · 3D 미리보기)는 다음 단계에서 이 자리에 들어갑니다.</div>
          {!ro && (
            <div class="danger-zone">
              {confirmDelete
                ? <><span class="small">"{a.name}"을 삭제하시겠습니까? 상태는 변경 이력에서 되돌릴 수 있지만 썸네일은 돌아오지 않습니다.</span>
                  <button type="button" class="btn sm danger" onClick={async () => { if (await apply({ kind: 'deleteAssets', assetIds: [a.assetId] })) props.onClose(); }}>지우기</button>
                  <button type="button" class="btn sm ghost" onClick={() => setConfirmDelete(false)}>그만두기</button></>
                : <button type="button" class="btn sm" onClick={() => setConfirmDelete(true)}>이 에셋 지우기</button>}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// ───────── 화면 ─────────
export function AssetsPage(props: {
  version: number; readOnly: boolean;
  onApply: (e: Edit) => Promise<boolean>;
  onExport: (updateId: string | null) => Promise<void>;
  onImport: () => Promise<void>;
  /** 다른 화면에서 넘어올 때: 업데이트 · 리소스 종류 */
  focus?: { updateId: string; resourceTypeId?: string } | null;
}) {
  const ro = props.readOnly;
  const [updateId, setUpdateId] = useState<string | null>(props.focus?.updateId ?? null);
  const [v, setV] = useState<AssetsView | null>(null);
  const [group, setGroup] = useState<string>('all');
  const [batch, setBatch] = useState<string>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'card' | 'table'>(() => { try { return (localStorage.getItem('arp.assets.mode') as 'card' | 'table') || 'card'; } catch { return 'card'; } });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [add, setAdd] = useState({ rt: '', names: '' });
  const [newBatch, setNewBatch] = useState({ name: '', due: '' });
  const [bulk, setBulk] = useState({ part: '', status: 'DONE' as AssetStatus, batch: '' });
  const [focusRt, setFocusRt] = useState<string | null>(props.focus?.resourceTypeId ?? null);

  useEffect(() => { if (props.focus) { setUpdateId(props.focus.updateId); setFocusRt(props.focus.resourceTypeId ?? null); } }, [props.focus]);
  useEffect(() => { void rpc.assets(updateId).then(x => { setV(x); if (!updateId) setUpdateId(x.updateId); }); }, [props.version, updateId]);
  useEffect(() => { try { localStorage.setItem('arp.assets.mode', mode); } catch { /* 저장 못 해도 된다 */ } }, [mode]);
  useEffect(() => {
    if (!v || !focusRt) return;
    const g = v.groups.find(x => x.resources.some(r => r.resourceTypeId === focusRt));
    if (g) setGroup(g.groupId ?? '_');
    setFocusRt(null);
  }, [v, focusRt]);
  useEffect(() => { setSel(new Set()); }, [updateId, group, batch, filter]);

  if (!v) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  const apply = props.onApply;
  const groupOf = (g: AssetsView['groups'][number]) => g.groupId ?? '_';
  const curGroups = group === 'all' ? v.groups : v.groups.filter(g => groupOf(g) === group);
  const rts = curGroups.flatMap(g => g.resources);
  const rtIds = new Set(rts.map(r => r.resourceTypeId));
  const query = q.trim().toLowerCase();
  const shown = v.assets.filter(a => rtIds.has(a.resourceTypeId)
    && (batch === 'all' || (batch === 'none' ? !a.batchId : a.batchId === batch))
    && (filter === 'all' || (filter === 'done' ? isDone(a) : filter === 'open' ? !isDone(a) : Object.values(a.parts).some(p => p.status === filter)))
    && (!query || a.name.toLowerCase().includes(query) || (a.code ?? '').toLowerCase().includes(query) || (a.jiraKey ?? '').toLowerCase().includes(query)));
  const byRt = rts.map(r => ({ r, items: shown.filter(a => a.resourceTypeId === r.resourceTypeId) })).filter(x => x.items.length);
  const batchName = new Map(v.batches.map(b => [b.batchId, b.name]));
  const toggle = (id: string) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selIds = [...sel].filter(id => shown.some(a => a.assetId === id));
  const open = openId ? v.assets.find(a => a.assetId === openId) ?? null : null;
  const volTotal = rts.reduce((s, r) => s + (r.volume.target ?? 0), 0);
  const addRt = add.rt || rts[0]?.resourceTypeId || '';
  const bulkPart = bulk.part || v.parts[0]?.partId || '';
  // 위 숫자 칸: 고른 분류의 에셋 기준(전체면 마일스톤 전체)
  const inGroup = v.assets.filter(a => rtIds.has(a.resourceTypeId));
  const anyStatus = (st: AssetStatus) => inGroup.filter(a => Object.values(a.parts).some(p => p.status === st)).length;
  const t = {
    assets: inGroup.length, done: inGroup.filter(isDone).length,
    progress: inGroup.length ? inGroup.reduce((x, a) => x + a.progress, 0) / inGroup.length : 0,
    review: anyStatus('REVIEW'), retake: anyStatus('RETAKE'), hold: anyStatus('HOLD'),
  };
  const all = v.totals;
  const scope = group === 'all' ? '마일스톤 전체' : curGroups[0]?.name ?? '';

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <PageEyebrow page="assets" />
          <h1>에셋 제작 현황</h1>
          <p class="muted" style="margin-top: 6px">개별 에셋의 파트별 상태를 관리합니다. "완료"는 작업 진척의 완료 수량으로 자동 집계되어 완료 예정 계산에 바로 반영됩니다.</p>
        </div>
        <label class="inline"><span class="small faint">마일스톤</span>
          <select class="field" aria-label="마일스톤" value={v.updateId ?? ''} onChange={e => { setUpdateId((e.target as HTMLSelectElement).value); setGroup('all'); setBatch('all'); }}>
            {v.updates.map(u => <option value={u.updateId}>{u.name}{u.live ? '' : ' (완료 · 취소)'}</option>)}
          </select></label>
      </header>

      <div class="stat-row">
        <div class="stat"><span class="stat-label">등록 에셋</span><b class="stat-num">{t.assets}</b><span class="small faint">{scope} · {MODE_LABEL.TARGET} 물량 {volTotal}개</span></div>
        <div class="stat"><span class="stat-label">모든 파트 완료</span><b class="stat-num">{t.done}</b><span class="small faint">공수 기준 진행 {fmtPct(t.progress)}</span></div>
        <div class="stat"><span class="stat-label">검수 요청</span><b class="stat-num warn-num">{t.review}</b><span class="small faint">리드 확인 대기</span></div>
        <div class="stat"><span class="stat-label">수정 · 보류</span><b class="stat-num bad-num">{t.retake} · {t.hold}</b><span class="small faint">리테이크 · 멈춤</span></div>
      </div>

      <section class="card">
        <div class="card-head">
          <div class="step-title"><span class="step-badge">1</span><div><h2>항목</h2><p class="small muted" style="margin-top: 2px">분류(마이쿠키 · 동료쿠키 · 트리처 등)를 고릅니다. 숫자는 모든 파트가 끝난 에셋 / 등록 에셋입니다.</p></div></div>
        </div>
        <div class="card-body" style="padding-top: 0">
          <nav class="group-tabs" role="tablist" aria-label="항목">
            <button type="button" role="tab" aria-selected={group === 'all'} class={`group-tab${group === 'all' ? ' on' : ''}`} onClick={() => setGroup('all')}>
              <span>전체</span><span class="gt-num">{all.done} / {all.assets}</span>
              <span class="gt-bar"><span style={{ width: `${Math.round(all.progress * 100)}%` }} /></span></button>
            {v.groups.map(g => (
              <button type="button" role="tab" aria-selected={group === groupOf(g)} class={`group-tab${group === groupOf(g) ? ' on' : ''}`} onClick={() => setGroup(groupOf(g))}>
                <span>{g.name}</span><span class="gt-num">{g.done} / {g.total}</span>
                <span class="gt-bar"><span style={{ width: `${Math.round(g.progress * 100)}%` }} /></span>
              </button>
            ))}
          </nav>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="step-title"><span class="step-badge">2</span><div><h2>물량 대조</h2><p class="small muted" style="margin-top: 2px">계획 물량과 등록 에셋 수를 비교합니다. 물량이 계획의 기준이고, 에셋은 그 안의 실제 목록입니다.</p></div></div>
        </div>
        <div class="card-body" style="padding-top: 4px">
          <div class="table-wrap ref-wrap">
            <table class="grid ref vol-compare">
              <colgroup><col /><col class="tri-col" /><col class="tri-col" /><col style="width: 90px" /><col style="width: 90px" /><col style="width: 270px" /></colgroup>
              <thead><tr><th>리소스 종류</th><th class="n">물량 <span class="unit">{MODE_LABEL.MIN} · {MODE_LABEL.TARGET} · {MODE_LABEL.STRETCH}</span></th><th class="n">등록 에셋 <span class="unit">같은 순서</span></th><th class="n">차이 <span class="unit">{MODE_LABEL.STRETCH}</span></th><th class="n">완료</th><th>맞추기</th></tr></thead>
              <tbody>
                {rts.map(r => {
                  const reg = [r.registered.MIN, r.registered.MIN + r.registered.TARGET, r.registered.total];
                  const vol = [r.volume.min, r.volume.target, r.volume.stretch];
                  const diff = r.registered.total - (r.volume.stretch ?? 0);
                  return (
                    <tr class="row">
                      <td><b>{r.name}</b>{r.manualProgress && <span class="tag" title="에셋을 만들면 완료 수량은 에셋 상태로 다시 셉니다. '빈 에셋 만들기'는 손으로 넣은 완료 수량을 앞 에셋부터 완료로 옮깁니다" style="margin-left: 6px">손 입력 진척 있음</span>}</td>
                      <td class="n num">{vol.map(x => (x == null ? '—' : x)).join(' · ')}</td>
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
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head assets-head">
          <div class="step-title"><span class="step-badge">3</span><div><h2>에셋</h2><p class="small muted" style="margin-top: 2px">카드나 줄을 눌러 상세를 엽니다. 표 보기에서는 칸에서 바로 상태를 바꿉니다.</p></div></div>
          <div class="inline">
            <button type="button" class="btn sm" onClick={() => void props.onExport(v.updateId)}><IconDownload />엑셀 받기</button>
            {!ro && <button type="button" class="btn sm" onClick={() => void props.onImport()}><IconFolder />엑셀 넣기</button>}
          </div>
        </div>
        <div class="card-body" style="padding-top: 4px">
          <div class="asset-toolbar">
            <select class="field" aria-label="배치 거르기" value={batch} onChange={e => setBatch((e.target as HTMLSelectElement).value)}>
              <option value="all">모든 배치</option><option value="none">미배정</option>
              {v.batches.map(b => <option value={b.batchId}>{b.name}</option>)}
            </select>
            <select class="field" aria-label="상태 거르기" value={filter} onChange={e => setFilter((e.target as HTMLSelectElement).value as Filter)}>
              {FILTERS.map(f => <option value={f.f}>{f.label}</option>)}
            </select>
            <input class="field" type="search" aria-label="에셋 찾기" placeholder="이름 · 코드 · Jira 찾기" value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />
            <span class="small faint">{shown.length}개</span>
            <span style="flex: 1" />
            <div class="segmented" role="radiogroup" aria-label="보기">
              <button type="button" role="radio" aria-checked={mode === 'card'} class={mode === 'card' ? 'on' : ''} onClick={() => setMode('card')}><IconGrid />카드</button>
              <button type="button" role="radio" aria-checked={mode === 'table'} class={mode === 'table' ? 'on' : ''} onClick={() => setMode('table')}><IconList />표</button>
            </div>
          </div>

          {!ro && (
            <div class="asset-add">
              <select class="field" aria-label="더할 리소스 종류" value={addRt} onChange={e => setAdd({ ...add, rt: (e.target as HTMLSelectElement).value })}>
                {rts.map(r => <option value={r.resourceTypeId}>{r.name}</option>)}
              </select>
              <input class="field" aria-label="새 에셋 이름" placeholder="새 에셋 이름(쉼표로 여러 개)" value={add.names} onInput={e => setAdd({ ...add, names: (e.target as HTMLInputElement).value })}
                onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget.nextElementSibling as HTMLButtonElement | null)?.click(); }} />
              <button type="button" class="btn sm" disabled={!add.names.trim() || !addRt} onClick={async () => {
                const names = add.names.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
                if (await apply({ kind: 'createAssets', updateId: v.updateId!, resourceTypeId: addRt, names, batchId: batch !== 'all' && batch !== 'none' ? batch : null })) setAdd({ ...add, names: '' });
              }}><IconPlus />에셋 더하기</button>
            </div>
          )}

          {/* 고른 에셋 한 번에 고치기: 자리를 늘 확보(고르기 전후로 화면이 움직이지 않게) */}
          <div class={`bulk-bar${selIds.length ? ' on' : ''}`} aria-live="polite">
            {selIds.length === 0
              ? <span class="small faint">카드나 줄의 체크를 눌러 여러 에셋을 고르면 상태 · 배치를 한 번에 바꿉니다.</span>
              : <>
                <b class="small">{selIds.length}개 선택</b>
                {!ro && <>
                  <select class="field" aria-label="일괄 파트" value={bulkPart} onChange={e => setBulk({ ...bulk, part: (e.target as HTMLSelectElement).value })}>{v.parts.map(p => <option value={p.partId}>{p.name}</option>)}</select>
                  <select class="field" aria-label="일괄 상태" value={bulk.status} onChange={e => setBulk({ ...bulk, status: (e.target as HTMLSelectElement).value as AssetStatus })}>{STATUS.map(x => <option value={x.s}>{x.label}</option>)}</select>
                  <button type="button" class="btn sm" onClick={() => void apply({ kind: 'assetPart', assetIds: selIds, partId: bulkPart, status: bulk.status })}>상태 바꾸기</button>
                  <span class="bulk-sep" />
                  <select class="field" aria-label="옮길 배치" value={bulk.batch} onChange={e => setBulk({ ...bulk, batch: (e.target as HTMLSelectElement).value })}>
                    <option value="">미배정</option>{v.batches.map(b => <option value={b.batchId}>{b.name}</option>)}
                  </select>
                  <button type="button" class="btn sm" onClick={() => void apply({ kind: 'assetField', assetIds: selIds, field: 'batch_id', value: bulk.batch || null })}>배치 옮기기</button>
                </>}
                <span style="flex: 1" />
                <button type="button" class="btn sm ghost" onClick={() => setSel(new Set())}>선택 풀기</button>
              </>}
          </div>

          {shown.length === 0 && (
            <div class="empty-assets">
              <p class="muted">{v.assets.length ? '조건에 맞는 에셋이 없습니다.' : '아직 등록된 에셋이 없습니다.'}</p>
              <p class="small faint">위 "물량 대조"의 "빈 에셋 만들기"로 물량만큼 한 번에 만들거나, "에셋 더하기" · "엑셀 넣기"로 등록합니다.</p>
            </div>
          )}

          {mode === 'card' && byRt.map(({ r, items }) => (
            <div class="asset-section">
              <div class="asset-section-head"><b>{r.name}</b><span class="group-count">{items.length}</span><span class="small faint">{r.steps.map(s => v.parts.find(p => p.partId === s)?.name).join(' → ')}</span></div>
              <div class="asset-grid">
                {items.map(a => (
                  <div class={`asset-card${sel.has(a.assetId) ? ' picked' : ''}`}>
                    <button type="button" class="asset-card-open" aria-label={`${a.name} 상세`} onClick={() => setOpenId(a.assetId)}>
                      <Thumb asset={a} />
                      <span class="asset-card-name">{a.name}</span>
                      <span class="asset-card-meta small faint">{a.batchId ? batchName.get(a.batchId) : '미배정'} · {MODE_LABEL[a.tier]}{a.jiraKey ? ` · ${a.jiraKey}` : ''}</span>
                      <PartDots asset={a} parts={v.parts} />
                      <span class="mini-bar"><span style={{ width: `${Math.round(a.progress * 100)}%` }} /></span>
                    </button>
                    <input type="checkbox" class="asset-check" aria-label={`${a.name} 고르기`} checked={sel.has(a.assetId)} onChange={() => toggle(a.assetId)} />
                  </div>
                ))}
              </div>
            </div>
          ))}

          {mode === 'table' && shown.length > 0 && (
            <div class="table-wrap ref-wrap">
              <table class="grid edit ref asset-table">
                <colgroup><col style="width: 40px" /><col style="width: 52px" /><col style="width: 220px" /><col style="width: 110px" /><col style="width: 84px" />{v.parts.map(() => <col style="width: 112px" />)}<col style="width: 96px" /><col style="width: 90px" /></colgroup>
                <thead><tr>
                  <th class="c"><input type="checkbox" aria-label="보이는 에셋 모두 고르기" checked={selIds.length > 0 && selIds.length === shown.length} onChange={e => setSel((e.target as HTMLInputElement).checked ? new Set(shown.map(a => a.assetId)) : new Set())} /></th>
                  <th aria-label="썸네일" /><th>에셋</th><th>배치</th><th>포함</th>
                  {v.parts.map(p => <th>{p.name}</th>)}
                  <th>Jira</th><th class="n">진행</th>
                </tr></thead>
                <tbody>
                  {byRt.map(({ r, items }) => (
                    <>
                      <tr class="group group-strong"><td colSpan={7 + v.parts.length}><span class="group-head"><b>{r.name}</b><span class="group-count">{items.length}</span></span></td></tr>
                      {items.map(a => (
                        <tr class={`row${sel.has(a.assetId) ? ' picked' : ''}`}>
                          <td class="c"><input type="checkbox" aria-label={`${a.name} 고르기`} checked={sel.has(a.assetId)} onChange={() => toggle(a.assetId)} /></td>
                          <td><Thumb asset={a} size="sm" /></td>
                          <td><button type="button" class="link-btn" onClick={() => setOpenId(a.assetId)}>{a.name}</button>{a.code && <span class="small faint"> {a.code}</span>}</td>
                          <td class="small">{a.batchId ? batchName.get(a.batchId) : <span class="faint">미배정</span>}</td>
                          <td class="small">{MODE_LABEL[a.tier]}</td>
                          {v.parts.map(p => {
                            const s = a.parts[p.partId];
                            return <td class="st-cell">{s
                              ? <StatusSelect value={s.status} label={`${a.name} ${p.name} 상태`} disabled={ro} onChange={st => void apply({ kind: 'assetPart', assetIds: [a.assetId], partId: p.partId, status: st })} />
                              : <span class="faint small" title="이 리소스가 거치지 않는 파트">—</span>}</td>;
                          })}
                          <td class="small">{a.jiraKey ? (jiraHref(v.jiraBase, a.jiraKey) ? <a href={jiraHref(v.jiraBase, a.jiraKey)!} target="_blank" rel="noreferrer">{a.jiraKey}</a> : a.jiraKey) : <span class="faint">—</span>}</td>
                          <td class="n num">{fmtPct(a.progress)}</td>
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

      <section class="card">
        <div class="card-head">
          <div class="step-title"><span class="step-badge">4</span><div><h2>배치</h2><p class="small muted" style="margin-top: 2px">마일스톤 안의 납품 묶음입니다. 마감일은 그 배치 에셋의 모든 파트가 완료되는 날 기준입니다. 배치별 완료 예측은 다음 단계에서 더합니다.</p></div></div>
        </div>
        <div class="card-body" style="padding-top: 4px">
          <div class="table-wrap ref-wrap">
            <table class="grid edit ref batch-table">
              <colgroup><col style="width: 80px" /><col /><col style="width: 170px" /><col style="width: 90px" /><col style="width: 90px" /><col style="width: 200px" /><col style="width: 48px" /></colgroup>
              <thead><tr><th>순서</th><th>배치</th><th>마감일</th><th class="n">에셋</th><th class="n">완료</th><th>진행</th><th aria-label="행 작업" /></tr></thead>
              <tbody>
                {v.batches.length === 0 && <tr><td colSpan={7} class="muted small">배치가 없습니다. 아래에서 더합니다.</td></tr>}
                {v.batches.map((b, i) => (
                  <tr class="row">
                    <td><span class="prio">
                      <button type="button" class="btn ghost icon-btn" aria-label={`${b.name} 앞으로`} disabled={ro || i === 0} onClick={() => void apply({ kind: 'moveBatch', batchId: b.batchId, direction: -1 })}>↑</button>
                      <button type="button" class="btn ghost icon-btn" aria-label={`${b.name} 뒤로`} disabled={ro || i === v.batches.length - 1} onClick={() => void apply({ kind: 'moveBatch', batchId: b.batchId, direction: 1 })}>↓</button>
                    </span></td>
                    <td><Field class="field" value={b.name} label={`${b.name} 배치 이름`} disabled={ro} onCommit={t2 => apply({ kind: 'batchField', batchId: b.batchId, field: 'name', value: t2 })} /></td>
                    <td><input class="field" type="date" aria-label={`${b.name} 마감일`} value={b.dueDate ?? ''} disabled={ro} onChange={e => void apply({ kind: 'batchField', batchId: b.batchId, field: 'due_date', value: (e.target as HTMLInputElement).value || null })} /></td>
                    <td class="n num">{b.count}</td>
                    <td class="n num">{b.done}</td>
                    <td><span class="share"><span class="num small">{fmtPct(b.progress)}</span><span class="bar"><span class="fill" style={{ width: `${Math.round(b.progress * 100)}%` }} /></span></span></td>
                    <td class="n">{!ro && <button type="button" class="btn ghost icon-btn" aria-label={`${b.name} 배치 지우기`} title="지우면 이 배치의 에셋은 미배정이 됩니다" onClick={() => void apply({ kind: 'deleteBatch', batchId: b.batchId })}><IconX /></button>}</td>
                  </tr>
                ))}
              </tbody>
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

      {open && <AssetDrawer view={v} asset={open} readOnly={ro} apply={apply} onClose={() => setOpenId(null)} />}
    </div>
  );
}
