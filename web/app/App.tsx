// 앱 틀: 시작 화면, 옆 메뉴, 파일 열기·저장(자동 저장, 편집 중 표시, 저장 전 충돌 확인)
import { humanKey } from './ui/LaunchPage.tsx';
import { TEMPLATE_LEAVES_OUT } from '../../core/import-spec.ts';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import type { JSX } from 'preact';
import { rpc, DEVICE } from './lib/rpc.ts';
import type { View } from './lib/rpc.ts';
import { pickFile, fetchSample, saveInPlace, saveAs, SaveConflictError, canSaveInPlace, pickXlsx, fetchBytes } from './lib/files.ts';
import { ImportReport } from './ui/ImportReport.tsx';
import { SheetImportDialog } from './ui/SheetImport.tsx';
import { SetupGuide, setupDone } from './ui/SetupGuide.tsx';
import { NewsPage } from './ui/NewsPage.tsx';
import type { SheetScan, SheetPlan } from '../../core/sheet-import.ts';
import { ImportGuide } from './ui/ImportGuide.tsx';
import { HistoryPage } from './ui/HistoryPage.tsx';
import { CalibrationPage } from './ui/CalibrationPage.tsx';
import { AdvisorPage } from './ui/AdvisorPage.tsx';
import { SetupPage } from './ui/SetupPage.tsx';
import { setModeNames } from './lib/modes.ts';
import { HelpPanel, PageEyebrow, helpDoc } from './ui/Help.tsx';
import type { HelpPage } from './ui/Help.tsx';
import type { ScenarioAction } from '../../core/scenarios.ts';
import type { Notice, Seen } from '../../core/notice.ts';
import { idb, rememberRecent, ensurePermission } from './lib/idb.ts';
import type { Recovery, RecentFile } from './lib/idb.ts';
import { LATEST_SCHEMA } from '../../core/migrate.ts';
import { fmtShortDate, localToday, fmtDateTime } from './lib/format.ts';
import type { ImportReport as ImportReportData } from '../../core/import-legacy.ts';
import type { OpenedFile } from './lib/files.ts';
import type { LaunchEdit } from '../../core/launch.ts';
import type { PlanMode } from '../../engine/types.ts';
import { LaunchPage } from './ui/LaunchPage.tsx';
import { NewProject } from './ui/NewProject.tsx';
import { PlanPage } from './ui/PlanPage.tsx';
import { TemplatesPage } from './ui/TemplatesPage.tsx';
import { CapacityPage } from './ui/CapacityPage.tsx';
import { ProgressPage } from './ui/ProgressPage.tsx';
import { AssetsPage } from './ui/AssetsPage.tsx';
import { DashboardPage } from './ui/DashboardPage.tsx';
import { SimulationPage } from './ui/SimulationPage.tsx';
import type { ScenarioOp } from '../../core/scenarios.ts';
import type { Edit } from '../../core/edits.ts';
import type { NewProjectInput } from '../../core/new-project.ts';
import { IconLogo, IconLaunch, IconCalendar, IconSliders, IconCheck, IconFolder, IconSave, IconAlert, IconLock, IconLayers, IconUsers, IconProgress, IconHistory, IconDownload, IconTune, IconX, IconTarget, IconSettings, IconImage, IconChart, IconWiden, IconNarrow, IconBell, IconEye } from './ui/icons.tsx';

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';
type Page = HelpPage;
/** 보기 모드에서 보이는 화면 */
const VIEWER_PAGES: Page[] = ['news', 'dashboard', 'assets', 'plan'];
const PAGES: Page[] = ['news', 'dashboard', 'assets', 'progress', 'launch', 'plan', 'simulation', 'advisor', 'setup', 'capacity', 'templates', 'calibration', 'history'];
/** 파일마다 마지막으로 본 화면(이 브라우저). 데이터 점검은 열 때마다 다시 보는 화면이 아니라 빼 둔다 */
const lastPageOf = (name: string): Page | null => { try { const p = localStorage.getItem(`arp.lastPage.${name}`) as Page | null; return p && PAGES.includes(p) ? p : null; } catch { return null; } };
const rememberPage = (name: string, page: Page) => { try { if (PAGES.includes(page)) localStorage.setItem(`arp.lastPage.${name}`, page); } catch { /* 없어도 된다 */ } };
const readGuideHidden = (name: string) => { try { return localStorage.getItem(`arp.setupGuide.hidden.${name}`) === '1'; } catch { return false; } };
const readNewsSeen = (name: string) => { try { return localStorage.getItem(`arp.newsSeen.${name}`); } catch { return null; } };
const writeNewsSeen = (name: string, at: string) => { try { localStorage.setItem(`arp.newsSeen.${name}`, at); } catch { /* 없어도 된다 */ } };
const writeGuideHidden = (name: string) => { try { localStorage.setItem(`arp.setupGuide.hidden.${name}`, '1'); } catch { /* 없어도 된다 */ } };
interface FileState {
  name: string; handle: FileSystemFileHandle | null; lastModified: number; readOnly: boolean; lockedBy: string | null; isSample: boolean;
  /** 보기 모드(docs/26-viewer.md): 파일에 아무것도 쓰지 않고, 바뀌면 다시 읽는다 */
  viewer?: boolean;
}

const LOCK_FRESH_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;
const AUTOSAVE_MS = 2000;

const storage = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 저장소를 못 써도 앱은 돈다 */ } },
};

/** 지운 뒤 알림 글(되돌리기 단추가 붙는다, docs/34 T3). 기록이 사라지는 큰 지우기는 먼저 확인 창을 띄운다 */
const UNDO_NOTICE: Record<string, string> = {
  deleteBatch: '배치를 지웠습니다', deleteAssets: '에셋을 지웠습니다', removeLink: '링크를 지웠습니다', removeComment: '댓글을 지웠습니다',
  deleteNews: '소식을 지웠습니다', deletePerson: '작업자를 지웠습니다', deleteTeam: '지원 팀을 지웠습니다', deletePart: '파트를 지웠습니다',
  deletePipeline: '파이프라인을 지웠습니다', deleteResource: '리소스를 지웠습니다', removeHoliday: '휴일을 뺐습니다', deleteType: '유형을 지웠습니다',
  removeTemplateResource: '템플릿에서 리소스를 뺐습니다', removeResource: '물량에서 리소스를 뺐습니다', deleteUpdate: '업데이트를 지웠습니다',
  completeRow: '그 줄을 모두 완료로 바꿨습니다', fillCapacity: '인력을 한 번에 채웠습니다', dropResourcePart: '공수 · 기록을 지웠습니다',
  moveStage: '단계를 옮겼습니다', fillAssets: '빈 에셋을 만들었습니다',
};

/** 알림: 오류는 빨갛게(role=alert), 되돌릴 수 있으면 "되돌리기" */
function Toast(props: { t: { text: string; bad?: boolean; undo?: string }; onUndo: (batchId: string) => void; onClose: () => void }) {
  return (
    <div class={`toast${props.t.bad ? ' bad' : ''}`} role={props.t.bad ? 'alert' : 'status'}>
      <span class="toast-text">{props.t.text}</span>
      {props.t.undo && <button type="button" class="toast-undo" onClick={() => props.onUndo(props.t.undo!)}>되돌리기</button>}
      <button type="button" class="toast-x" aria-label="알림 닫기" onClick={props.onClose}>×</button>
    </div>
  );
}

export function App() {
  const [editor, setEditor] = useState(storage.get('arp.editor') ?? '');
  const [file, setFile] = useState<FileState | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [version, setVersion] = useState(0);
  const [planMode, setPlanMode] = useState<PlanMode>('TARGET');
  const [page, setPage] = useState<Page>((new URLSearchParams(location.search).get('page') as Page) || 'launch');
  // 지금 업데이트(마일스톤): 현황판 · 에셋 · 작업 진척 · 시뮬레이션이 함께 쓴다(docs/23-ux-review.md 6.3). 파일을 열면 비운다
  const [curUpdate, setCurUpdate] = useState<string | null>(null);
  const [guideHidden, setGuideHidden] = useState(false);
  /** 이 브라우저에서 소식 화면을 마지막으로 본 시각(새 소식 수) */
  const [newsSeen, setNewsSeen] = useState<string | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const [save, setSave] = useState<{ state: SaveState; at?: number; message?: string }>({ state: 'saved' });
  /** 알림: 글 · 오류 여부 · 되돌릴 묶음(지운 뒤 "되돌리기", docs/34 T3) */
  const [toast, setToast] = useState<{ text: string; bad?: boolean; undo?: string } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  // 화면 폭: 기본(가운데 1240px) · 넓게(창 폭 전부). 모든 화면에 적용, 이 브라우저에 기억
  // 좁은 화면: 저장 · 닫기 · 내보내기를 "파일" 메뉴로 접는다(docs/34 A-01)
  const [footOpen, setFootOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  // 가로 메뉴(좁은 화면)에서 지금 화면 항목을 가운데로(docs/34 A-02)
  useEffect(() => {
    const nav = navRef.current; const el = nav?.querySelector<HTMLElement>('.nav-item.active');
    if (!nav || !el || nav.scrollWidth <= nav.clientWidth + 1) return;
    const nr = nav.getBoundingClientRect(); const er = el.getBoundingClientRect();
    nav.scrollLeft += (er.left - nr.left) - (nr.width - er.width) / 2;
  }, [page, view != null]);
  useEffect(() => {
    if (!footOpen) return;
    const off = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !footRef.current?.contains(e.target as Node)) setFootOpen(false); };
    document.addEventListener('pointerdown', off); document.addEventListener('keydown', off);
    return () => { document.removeEventListener('pointerdown', off); document.removeEventListener('keydown', off); };
  }, [footOpen]);
  const [wide, setWide] = useState(() => { try { return localStorage.getItem('arp.width') === 'wide'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('arp.width', wide ? 'wide' : 'normal'); } catch { /* 없어도 된다 */ } }, [wide]);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(new URLSearchParams(location.search).has('new'));
  const [imported, setImported] = useState<ImportReportData | null>(null);
  const [sheetImport, setSheetImport] = useState<{ name: string; bytes: ArrayBuffer; scan: SheetScan; busy: boolean } | null>(null);
  const [importing, setImporting] = useState(new URLSearchParams(location.search).has('importGuide'));
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [backup, setBackup] = useState<{ name: string; bytes: ArrayBuffer; from: number } | null>(null);
  const snapshotTimer = useRef<number | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [help, setHelp] = useState<Page | null>(null);
  const fileRef = useRef<FileState | null>(null);
  fileRef.current = file;
  const saveTimer = useRef<number | undefined>(undefined);
  const saving = useRef(false);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;
  /** 지금 연 파일의 세대: 열기·만들기·닫기마다 바뀐다. 늦게 끝난 저장이 닫은 파일을 되살리지 않게 */
  const fileGen = useRef(0);
  /** 마지막으로 저장한 고침 번호(editSeq). 같으면 저장 안 된 고침이 없다 */
  const savedSeq = useRef(0);
  const unsaved = () => editSeq.current !== savedSeq.current;

  // 새 알림이 오면 타이머를 새로(연달아 뜬 알림이 일찍 사라지지 않게). 되돌리기가 있으면 8초
  const showToast = (m: string, opts: { bad?: boolean; undo?: string } = {}) => {
    setToast({ text: m, ...opts });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), opts.undo ? 8000 : opts.bad ? 6000 : 4000);
  };
  const me = editor.trim() || '이름 없음';
  const meRef = useRef(me);
  meRef.current = me;

  // ───────── 저장 ─────────
  // 경쟁 상태 막기:
  //  - 저장(내보내기)을 시작한 뒤 수정한 내용이 있으면 저장이 끝나도 "저장 대기"로 두고 다시 저장한다(editSeq)
  //  - 저장 중에 들어온 저장 요청은 버리지 않고 끝난 뒤 한 번 더 한다(pendingSave)
  //  - 파일의 마지막 수정 시각은 화면을 다시 그리기 전에도 최신이어야 하므로 fileRef에 바로 쓴다
  const editSeq = useRef(0);
  const pendingSave = useRef(false);
  const writeRef = useRef<() => Promise<boolean>>(async () => false);

  const setFileNow = (next: FileState) => { fileRef.current = next; setFile(next); };
  // 파일마다 마지막으로 본 화면을 기억(되살리기 · 다시 열기도 그 화면으로)
  useEffect(() => { if (file) rememberPage(file.name, page); }, [page, file?.name]);
  // 보기 모드: 보이는 화면만(다른 화면으로 가는 단추를 눌러도 현황판으로)
  useEffect(() => { if (file?.viewer && !VIEWER_PAGES.includes(page)) setPage('dashboard'); }, [file?.viewer, page]);
  // 보기 모드: 편집하는 사람이 저장하면(파일 수정 시각이 바뀌면) 다시 읽는다 — 1분마다 · 창으로 돌아올 때(docs/26-viewer.md 3절)
  useEffect(() => {
    if (!file?.viewer || !file.handle) return undefined;
    let stop = false;
    const check = async () => {
      try {
        const cur = fileRef.current;
        if (stop || !cur?.viewer || !cur.handle) return;
        const disk = await cur.handle.getFile();
        if (disk.lastModified <= cur.lastModified) return;
        const v = await rpc.open(await disk.arrayBuffer());
        if (stop || fileRef.current !== cur) return;
        setFileNow({ ...cur, lastModified: disk.lastModified });
        setView(v);
        setVersion(x => x + 1);
        showToast(`최신 저장본으로 바꿨습니다(${new Date(disk.lastModified).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 저장)`);
      } catch { /* 다음 확인 때 다시 */ }
    };
    const t = window.setInterval(() => void check(), 60000);
    const onFocus = () => { if (document.visibilityState !== 'hidden') void check(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { stop = true; window.clearInterval(t); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [file?.handle, file?.viewer]);
  const projectKey = (v: View | null) => (v ? `${v.meta.project_name ?? ''}|${v.meta.created_at ?? ''}` : '');

  /** 이 프로젝트의 복구 사본만 지운다(다른 프로젝트 사본은 남긴다) */
  const dropRecoveryFor = async (key: string) => {
    const r = await idb.get<Recovery>('recovery');
    if (r && r.projectKey && r.projectKey === key) { await idb.del('recovery'); setRecovery(null); }
  };
  /** 지금 상태를 복구 사본으로(세대가 바뀌었으면 남기지 않는다) */
  const snapshotNow = async (gen: number, name: string, projectName: string, key: string) => {
    try {
      if (gen !== fileGen.current) return;
      const { bytes } = await rpc.snapshot();
      if (gen !== fileGen.current) return;
      await idb.set('recovery', { name, at: Date.now(), bytes, projectName, projectKey: key } satisfies Recovery);
    } catch { /* 사본을 못 남겨도 작업은 계속 */ }
  };

  const scheduleAutosave = () => {
    const f = fileRef.current;
    if (!f?.handle || f.readOnly) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void writeRef.current(); }, AUTOSAVE_MS);
  };

  const writeNow = useCallback(async (): Promise<boolean> => {
    const f = fileRef.current;
    if (!f || f.readOnly) return false;
    if (saving.current) { pendingSave.current = true; return false; }
    saving.current = true;
    const seq = editSeq.current;
    const gen = fileGen.current;
    const key = projectKey(viewRef.current);
    setSave({ state: 'saving' });
    let ok = false;
    try {
      // 새 위치에 처음 저장할 때도 편집 중 표시를 남긴다
      if (!f.handle) await rpc.lock(meRef.current);
      const { bytes } = await rpc.export();
      if (gen !== fileGen.current) return false;
      const cur = fileRef.current ?? f;
      if (cur.handle) {
        const lastModified = await saveInPlace(cur.handle, bytes, cur.lastModified);
        if (gen !== fileGen.current) return true; // 그 사이 닫았다: 저장은 됐지만 닫은 파일을 되살리지 않는다
        setFileNow({ ...cur, lastModified });
      } else {
        const r = await saveAs(bytes, cur.name.endsWith('.arp') ? cur.name : `${cur.name}.arp`);
        if (gen !== fileGen.current) return !!r;
        if (!r) { setSave({ state: 'dirty' }); return false; }
        setFileNow({ ...cur, handle: r.handle, lastModified: r.lastModified, name: r.name, isSample: false });
      }
      ok = true;
      savedSeq.current = seq;
      // 수정한 것을 저장했을 때만 그 프로젝트의 복구 사본을 지운다(열 때의 편집 중 표시 저장으로는 지우지 않는다)
      if (seq > 0) void dropRecoveryFor(key);
      void refreshSeen(false);
      const savedFile = fileRef.current;
      if (savedFile?.handle) void rememberRecent(savedFile.handle, savedFile.name);
      if (editSeq.current !== seq) { setSave({ state: 'dirty' }); scheduleAutosave(); } else setSave({ state: 'saved', at: Date.now() });
      return true;
    } catch (error) {
      if (error instanceof SaveConflictError) {
        setSave({ state: 'conflict', message: '다른 곳에서 파일이 변경되었습니다. 다른 이름으로 저장하거나 다시 여십시오.' });
      } else {
        setSave({ state: 'error', message: (error as Error).message });
      }
      return false;
    } finally {
      saving.current = false;
      if (pendingSave.current) {
        pendingSave.current = false;
        if (ok && gen === fileGen.current) void writeRef.current();
      }
    }
  }, []);

  /** 충돌·오류 때 빠져나갈 길: 지금 내용을 다른 이름(새 파일)으로 저장하고 그 파일로 계속 편집 */
  const saveAsNew = async () => {
    const f = fileRef.current;
    if (!f || saving.current) return;
    const gen = fileGen.current;
    try {
      await rpc.lock(me);
      const { bytes } = await rpc.export();
      const r = await saveAs(bytes, f.name.endsWith('.arp') ? f.name : `${f.name}.arp`);
      if (!r || gen !== fileGen.current) return;
      setFileNow({ ...f, handle: r.handle, lastModified: r.lastModified, name: r.name, isSample: false, readOnly: false, lockedBy: null });
      savedSeq.current = editSeq.current;
      setSave({ state: 'saved', at: Date.now() });
      void dropRecoveryFor(projectKey(viewRef.current));
      if (r.handle) void rememberRecent(r.handle, r.name);
      showToast(`"${r.name}"(으)로 저장했습니다. 이후 변경은 이 파일에 저장됩니다.`);
    } catch (error) {
      showToast(`저장하지 못했습니다: ${(error as Error).message}`);
    }
  };
  writeRef.current = writeNow;

  // 예기치 못한 비동기 오류(main.tsx가 'arp:error'로 알린다)
  useEffect(() => {
    const onError = (e: Event) => showToast(`문제가 생겼습니다: ${(e as CustomEvent<string>).detail}`);
    window.addEventListener('arp:error', onError);
    return () => window.removeEventListener('arp:error', onError);
  }, []);

  // 화면 안내: 각 화면의 "이 화면 안내" 버튼('arp:help') · 키보드 ?(입력 칸 밖에서)
  useEffect(() => {
    const onHelp = (e: Event) => setHelp((e as CustomEvent<Page>).detail);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (!document.querySelector('.app')) return;
      e.preventDefault();
      setHelp(h => (h ? null : pageRef.current));
    };
    window.addEventListener('arp:help', onHelp);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('arp:help', onHelp); window.removeEventListener('keydown', onKey); };
  }, []);

  // Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void writeNow(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [writeNow]);

  // 편집 중 표시 갱신(5분마다)
  useEffect(() => {
    if (!file?.handle || file.readOnly) return undefined;
    const t = window.setInterval(async () => { await rpc.lock(me); await writeNow(); }, HEARTBEAT_MS);
    return () => window.clearInterval(t);
  }, [file?.handle, file?.readOnly, me, writeNow]);

  // 저장 안 된 변경이 있으면 떠나기 전에 묻는다
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => { if (save.state === 'dirty' || save.state === 'saving' || ((save.state === 'conflict' || save.state === 'error') && unsaved())) { e.preventDefault(); } };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [save.state]);

  // ───────── 열기 ─────────
  const open = async (opened: OpenedFile, isSample: boolean, opts: { view?: boolean } = {}) => {
    const asViewer = opts.view ?? new URLSearchParams(location.search).has('view');
    setBusy(true);
    try {
      // SQLite 머리(60–63바이트) = 구조 버전. 옛 구조면 바꾸기 전 원본을 남겨 둔다
      const version = new DataView(opened.bytes).getUint32(60, false);
      const original = version < LATEST_SCHEMA ? opened.bytes.slice(0) : null;
      const v = await rpc.open(opened.bytes);
      if (original && v.migration && v.migration.from !== v.migration.to) setBackup({ name: opened.name, bytes: original, from: v.migration.from });
      if (opened.handle) void rememberRecent(opened.handle, opened.name);
      if (v.migration && v.migration.from !== v.migration.to) {
        showToast(`옛 구조(v${v.migration.from}) 파일을 새 구조(v${v.migration.to})로 변경했습니다. 저장하면 새 구조로 남습니다.`);
      }
      const holder = v.meta.lock_holder;
      const beat = v.meta.lock_heartbeat_at ? Date.parse(v.meta.lock_heartbeat_at) : 0;
      // 다른 사람이거나, 같은 이름이라도 다른 PC(브라우저)에서 편집 중이면 읽기 전용
      const otherDevice = !!v.meta.lock_device && v.meta.lock_device !== DEVICE;
      const lockedByOther = !!holder && (holder !== me || otherDevice) && Date.now() - beat < LOCK_FRESH_MS;
      const state: FileState = {
        name: opened.name, handle: opened.handle, lastModified: opened.lastModified,
        readOnly: lockedByOther || asViewer, lockedBy: lockedByOther ? holder : null, isSample, viewer: asViewer,
      };
      fileGen.current += 1;
      window.clearTimeout(saveTimer.current);
      window.clearTimeout(snapshotTimer.current);
      setFileNow(state);
      editSeq.current = 0;
      savedSeq.current = 0;
      setView(v);
      setVersion(x => x + 1);
      setCurUpdate(null);
      setGuideHidden(readGuideHidden(opened.name));
      const seen = readNewsSeen(opened.name);
      setNewsSeen(seen);
      // 처음 화면: 주소의 page → 보기 모드면 새 소식이 있을 때 소식, 아니면 현황판 →
      //   이 파일에서 마지막으로 본 화면 → 제작 기록이 있으면 현황판, 없으면 런칭(docs/23 6.2)
      const forced = new URLSearchParams(location.search).get('page') as Page | null;
      if (asViewer) setPage(forced && VIEWER_PAGES.includes(forced) ? forced : v.newsTimes.some(t => !seen || t > seen) ? 'news' : 'dashboard');
      else setPage(forced || lastPageOf(opened.name) || (v.setup.records ? 'dashboard' : 'launch'));
      // 편집 중 표시를 쓰고 저장할 때까지는 "저장 중"(보기 모드는 파일에 쓰지 않는다)
      setSave({ state: opened.handle && !lockedByOther && !asViewer ? 'saving' : 'saved' });
      if (opened.handle && !lockedByOther && !asViewer) {
        await rpc.lock(me);
        await writeNow();
      }
      if (!isSample) void refreshSeen(true);
    } catch (error) {
      showToast(`열지 못했습니다: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    // 진행 중인 저장이 끝날 때까지 기다린다(최대 15초)
    for (let i = 0; i < 150 && saving.current; i += 1) await new Promise(r => setTimeout(r, 100));
    window.clearTimeout(saveTimer.current);
    const f = fileRef.current;
    if (f?.handle && !f.readOnly) {
      await rpc.lock(null);
      const ok = await writeNow();
      if (!ok && unsaved()) {
        await snapshotNow(fileGen.current, f.name, viewRef.current?.snapshot.projectName ?? f.name, projectKey(viewRef.current));
        if (!window.confirm('저장하지 못했습니다. 그래도 닫으시겠습니까?\n수정한 내용은 이 브라우저의 복구 사본에 남아 있습니다.')) { await rpc.lock(me); return; }
      }
    } else if (f && !f.readOnly && !f.isSample && unsaved()) {
      await snapshotNow(fileGen.current, f.name, viewRef.current?.snapshot.projectName ?? f.name, projectKey(viewRef.current));
      if (!window.confirm('저장하지 않은 변경이 있습니다. 그래도 닫으시겠습니까?\n수정한 내용은 이 브라우저의 복구 사본에 남아 있습니다.')) return;
    }
    fileGen.current += 1;
    window.clearTimeout(snapshotTimer.current);
    fileRef.current = null;
    setFile(null);
    setView(null);
  };

  // 화면 캡처·둘러보기용: ?sample=normal 이면 예시를 바로 연다
  useEffect(() => {
    const sample = new URLSearchParams(location.search).get('sample');
    const params = new URLSearchParams(location.search);
    if (sample && params.has('opfs')) {
      // 시험용: 예시를 브라우저 개인 저장소(OPFS)에 파일로 두고 그 핸들로 연다 → 자동 저장·편집 중 표시·충돌 확인을 화면 없이 시험
      void (async () => {
        const f = await fetchSample(sample);
        const dir = await navigator.storage.getDirectory();
        const handle = await dir.getFileHandle(`${sample}.arp`, { create: true });
        if (!params.has('keep')) { const w = await handle.createWritable(); await w.write(f.bytes); await w.close(); }
        const file = await handle.getFile();
        await open({ name: file.name, bytes: await file.arrayBuffer(), handle, lastModified: file.lastModified }, false);
      })().catch(e => showToast(String(e)));
    } else if (sample) void fetchSample(sample).then(f => open(f, true)).catch(e => showToast(String(e)));
    const legacySample = params.get('importSample');
    if (legacySample) void fetchBytes(`../${legacySample}.xlsx`).then(bytes => importLegacy({ name: `${legacySample}.xlsx`, bytes })).catch(e => showToast(String(e)));
    void rpc.init();
  }, []);

  // ───────── 새로 만들기 ─────────
  /** 새 파일을 저장할 곳: 보통은 저장 위치 고르기, 시험(?opfs)은 브라우저 개인 저장소 */
  const saveNewFile = async (bytes: ArrayBuffer, name: string) => {
    if (new URLSearchParams(location.search).has('opfs')) {
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle(name, { create: true });
      const w = await handle.createWritable(); await w.write(bytes); await w.close();
      return { handle, lastModified: (await handle.getFile()).lastModified, name };
    }
    return saveAs(bytes, name);
  };

  const createProject = async (input: NewProjectInput) => {
    try {
      await rpc.create(input);
      const fileName = `${input.name.trim().replace(/[\\/:*?"<>|]/g, '_') || '새 프로젝트'}.arp`;
      await rpc.lock(me);
      const { bytes } = await rpc.export();
      const saved = await saveNewFile(bytes, fileName);
      const state: FileState = saved?.handle
        ? { name: saved.name, handle: saved.handle, lastModified: saved.lastModified, readOnly: false, lockedBy: null, isSample: false }
        : { name: fileName, handle: null, lastModified: Date.now(), readOnly: false, lockedBy: null, isSample: false };
      fileGen.current += 1;
      setFileNow(state);
      editSeq.current = 0;
      savedSeq.current = saved?.handle ? 0 : -1;
      setView(await rpc.view());
      setVersion(x => x + 1);
      setCurUpdate(null);
      setGuideHidden(false);
      setPage('launch');
      setSave(saved?.handle ? { state: 'saved', at: Date.now() } : { state: 'dirty' });
      setCreating(false);
      if (!saved?.handle) showToast('저장 위치를 선택하지 않았습니다. 왼쪽 아래 "다른 이름으로 저장"으로 저장하십시오.');
    } catch (error) {
      showToast(`만들지 못했습니다: ${(error as Error).message}`);
    }
  };

  // ───────── 작업 복구 사본 · 최근 파일 ─────────
  useEffect(() => {
    void idb.get<Recovery>('recovery').then(r => setRecovery(r ?? null));
    void idb.get<RecentFile[]>('recent').then(r => setRecent(r ?? []));
  }, [file]);

  // 저장 안 된 변경이 생기면 1.5초 뒤 브라우저 저장소에 사본을 둔다(창을 닫아도 복구)
  useEffect(() => {
    window.clearTimeout(snapshotTimer.current);
    const pendingEdits = save.state === 'dirty' || ((save.state === 'conflict' || save.state === 'error') && unsaved());
    if (!pendingEdits || !file || file.readOnly) return;
    const gen = fileGen.current;
    const name = file.name;
    const projectName = view?.snapshot.projectName ?? file.name;
    const key = projectKey(view);
    snapshotTimer.current = window.setTimeout(() => { void snapshotNow(gen, name, projectName, key); }, 1500);
  }, [version, save.state]);

  const restore = async (r: Recovery) => {
    await open({ name: r.name, bytes: r.bytes, handle: null, lastModified: r.at }, false);
    const restored = fileRef.current;
    if (restored) setFileNow({ ...restored, isSample: false });
    editSeq.current = 1;
    savedSeq.current = 0;
    setSave({ state: 'dirty' });
    setRecovery(null);
    showToast('저장하지 않았던 작업을 복구했습니다. 다른 이름으로 저장하십시오.');
  };

  /** 보기 모드 → 편집으로 다시 열기(쓰기 권한을 묻는다. 다른 사람이 편집 중이면 읽기 전용) */
  const editInstead = async () => {
    const f = fileRef.current;
    if (!f?.handle) return;
    if (!(await ensurePermission(f.handle, 'readwrite'))) { showToast('파일을 쓸 권한을 받지 못했습니다.'); return; }
    const disk = await f.handle.getFile();
    await open({ name: disk.name, bytes: await disk.arrayBuffer(), handle: f.handle, lastModified: disk.lastModified }, false, { view: false });
  };

  const openRecent = async (r: RecentFile, asViewer = false) => {
    try {
      if (!(await ensurePermission(r.handle, asViewer ? 'read' : 'readwrite'))) { showToast(asViewer ? '파일을 읽을 권한을 받지 못했습니다.' : '파일을 쓸 권한을 받지 못했습니다.'); return; }
      const f = await r.handle.getFile();
      await open({ name: f.name, bytes: await f.arrayBuffer(), handle: r.handle, lastModified: f.lastModified }, false, { view: asViewer });
    } catch (error) {
      showToast(`열지 못했습니다(옮겼거나 삭제한 파일일 수 있습니다): ${(error as Error).message}`);
    }
  };

  const download = (bytes: ArrayBuffer, name: string, type: string) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const exportXlsx = async () => {
    try {
      const { bytes } = await rpc.exportXlsx(planMode);
      const base = (view?.snapshot.projectName ?? 'ARP').replace(/[\\/:*?"<>|]/g, '_');
      download(bytes, `${base} ${localToday()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (error) {
      showToast(`내보내지 못했습니다: ${(error as Error).message}`);
    }
  };

  const exportTemplate = async () => {
    try {
      const { bytes } = await rpc.exportTemplate();
      const base = (view?.snapshot.projectName ?? 'ARP').replace(/[\\/:*?"<>|]/g, '_');
      download(bytes, `${base} 편집용 ${localToday()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      showToast('편집용 엑셀을 내려받았습니다. 다시 가져오면 새 프로젝트 파일이 되고, 파이프라인 · 에셋 · 작업자 · 소식 · 이력은 빠집니다(엑셀 "안내" 시트 참고).');
    } catch (error) {
      showToast(`내보내지 못했습니다: ${(error as Error).message}`);
    }
  };

  // ───────── 변화 알림: 내가 지난번에 본 뒤 바뀐 것 ─────────
  // 편집자별로 따로 둔다(한 컴퓨터를 여럿이 쓸 때도 각자 지난번 본 것과 비교)
  const seenKey = (v: View | null) => (v ? `seen:${me}:${v.meta.project_name ?? ''}|${v.meta.created_at ?? ''}` : '');
  const refreshSeen = async (show: boolean) => {
    const v = await rpc.view().catch(() => null);
    const key = seenKey(v);
    if (!key) return;
    const prev = (await idb.get<Seen>(key)) ?? null;
    const r = await rpc.notice(prev, me).catch(() => null);
    if (!r?.now) return; // 계산이 막힌 상태면 비교하지 않는다
    if (show) setNotice(r.notice);
    await idb.set(key, { at: new Date().toISOString(), updates: r.now } satisfies Seen);
  };

  // 작업 진척 엑셀
  const onTemplate = async () => {
    const { bytes } = await rpc.progressTemplate();
    download(bytes, `${(view?.snapshot.projectName ?? 'ARP').replace(/[\\/:*?"<>|]/g, '_')} 작업 진척 양식.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  const onImportProgress = async () => {
    const picked = await pickXlsx();
    if (!picked) return;
    try {
      const r = await rpc.importProgress(picked.bytes, me);
      if (r.changedCells) markChanged(true);
      showToast(`작업 진척을 입력했습니다 · ${r.changedCells}칸 바뀜${r.unchanged ? `, ${r.unchanged}칸 그대로` : ''}${r.skipped.length ? ` · 건너뛴 행 ${r.skipped.length}개(${r.skipped.slice(0, 2).map(s => `${s.row}행 ${s.reason}`).join(', ')})` : ''}`);
    } catch (error) {
      showToast(`넣지 못했습니다: ${(error as Error).message}`);
    }
  };
  // 에셋 엑셀
  const onExportAssets = async (updateId: string | null) => {
    const { bytes } = await rpc.assetBook(updateId);
    download(bytes, `${(view?.snapshot.projectName ?? 'ARP').replace(/[\\/:*?"<>|]/g, '_')} 에셋.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  const onImportAssets = async () => {
    const picked = await pickXlsx();
    if (!picked) return;
    try {
      // ARP 에셋 양식이 아니면 팀 제작 리스트로 보고 가져오기 창을 연다
      const kind = await rpc.scanAssetFile(picked.bytes);
      if (kind.kind === 'sheet') { setSheetImport({ name: picked.name, bytes: picked.bytes, scan: kind.scan, busy: false }); return; }
      const r = await rpc.importAssets(picked.bytes, me);
      if (r.created || r.changed) markChanged(true);
      showToast(`에셋을 입력했습니다 · 새로 ${r.created}개, 바뀜 ${r.changed}개${r.unchanged ? `, 그대로 ${r.unchanged}개` : ''}${r.batches ? ` · 새 배치 ${r.batches}개` : ''}${r.skipped.length ? ` · 건너뛴 행 ${r.skipped.length}개(${r.skipped.slice(0, 2).map(s => `${s.row}행 ${s.reason}`).join(', ')})` : ''}`);
    } catch (error) {
      showToast(`넣지 못했습니다: ${(error as Error).message}`);
    }
  };
  const onImportSheet = async (plan: SheetPlan) => {
    if (!sheetImport) return;
    setSheetImport({ ...sheetImport, busy: true });
    try {
      const r = await rpc.importSheet(sheetImport.bytes, plan, me);
      if (r.created || r.changed || r.volumesAdded || r.resourcesCreated.length) markChanged(true);
      setSheetImport(null);
      const skipped = r.skipped.length ? ` · 건너뛴 행 ${r.skipped.length}개(${r.skipped.slice(0, 2).map(s => `${s.sheet} ${s.row}행 ${s.reason}`).join(', ')})` : '';
      showToast(`제작 리스트를 가져왔습니다 · 새로 ${r.created}개, 바뀜 ${r.changed}개${r.unchanged ? `, 그대로 ${r.unchanged}개` : ''}${r.resourcesCreated.length ? ` · 새 리소스 종류 ${r.resourcesCreated.length}개(공수 0 — 데이터 점검에서 채우십시오)` : ''}${r.volumesAdded ? ` · 물량에 더한 리소스 ${r.volumesAdded}곳` : ''}${r.jiraBaseSet ? ' · Jira 주소 설정' : ''}${r.newAssignees ? ` · 작업자 명단에 없는 담당 ${r.newAssignees}명(인력 › 작업자 › 담당에서 찾기)` : ''}${skipped}`);
    } catch (error) {
      setSheetImport(s => (s ? { ...s, busy: false } : s));
      showToast(`넣지 못했습니다: ${(error as Error).message}`);
    }
  };
  const onCalibrate = async (picks: { resourceTypeId: string; partId: string; ratio: number }[]) => {
    try {
      const r = await rpc.calibrate(picks, me);
      if (r.changed) markChanged(true);
      showToast(`공수 ${r.changed}곳을 보정했습니다. 변경 이력에서 되돌릴 수 있습니다.`);
      return true;
    } catch (error) {
      showToast((error as Error).message);
      return false;
    }
  };

  const onUndo = async (batchId: string, force: boolean): Promise<{ ok: boolean; needsForce?: boolean }> => {
    if (fileRef.current?.readOnly) return { ok: false };
    try {
      const r = await rpc.undo(batchId, me, force);
      markChanged(true);
      showToast(`되돌렸습니다 · ${r.reverted}칸`);
      return { ok: true };
    } catch (error) {
      const m = (error as Error).message;
      showToast(m);
      return { ok: false, needsForce: m.includes('그래도 되돌리') };
    }
  };

  // ───────── 옛 시트 가져오기 ─────────
  const importLegacy = async (picked: { name: string; bytes: ArrayBuffer } | null): Promise<boolean> => {
    if (!picked) return false;
    setBusy(true);
    try {
      const base = picked.name.replace(/\.xlsx$/i, '').trim() || '가져온 프로젝트';
      const v = await rpc.importLegacy(picked.bytes, base);
      setFileNow({ name: `${base}.arp`, handle: null, lastModified: Date.now(), readOnly: false, lockedBy: null, isSample: false });
      editSeq.current = 1;
      setView(v);
      setVersion(x => x + 1);
      setCurUpdate(null);
      setGuideHidden(readGuideHidden(`${base}.arp`));
      setPage('launch');
      setSave({ state: 'dirty' });
      setImported(v.report);
      return true;
    } catch (error) {
      showToast(`가져오지 못했습니다: ${(error as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  // ───────── 고치기(업데이트·유형·인력) ─────────
  const onApply = async (edit: Edit): Promise<boolean> => {
    if (fileRef.current?.readOnly) return false;
    try {
      const r = await rpc.apply(edit, me);
      if (r.changed) {
        editSeq.current += 1;
        setVersion(x => x + 1);
        setSave(s => (s.state === 'conflict' ? s : { state: 'dirty' }));
        scheduleAutosave();
        setView(await rpc.view());
        const done = UNDO_NOTICE[edit.kind];
        if (done) showToast(`${done}${(r as { note?: string }).note ? ` · ${(r as { note?: string }).note}` : ''}`, { undo: r.batchId });
        else if ((r as { note?: string }).note) showToast(String((r as { note?: string }).note));
      }
      return true;
    } catch (error) {
      showToast((error as Error).message, { bad: true });
      return false;
    }
  };

  // ───────── 시나리오 ─────────
  const markChanged = (planData: boolean) => {
    editSeq.current += 1;
    setVersion(x => x + 1);
    setSave(s => (s.state === 'conflict' ? s : { state: 'dirty' }));
    scheduleAutosave();
    if (planData) void rpc.view().then(setView);
  };

  const onScenario = async (op: ScenarioOp): Promise<{ ok: boolean; createdId?: string }> => {
    if (fileRef.current?.readOnly) return { ok: false };
    try {
      const r = await rpc.scenarioOp(op);
      if (r.changed) markChanged(false);
      return { ok: true, createdId: r.createdId };
    } catch (error) {
      showToast((error as Error).message);
      return { ok: false };
    }
  };

  const [simFocus, setSimFocus] = useState<string | null>(null);
  // 다른 화면(작업 진척 · 물량 표)에서 에셋 화면으로: 업데이트 · 리소스 종류를 넘긴다
  // partId · who · status = 에셋 화면 거르기, back = 카드를 닫으면 돌아갈 화면(현황판 → 카드 → 현황판, docs/34 B-02)
  const [assetFocus, setAssetFocus] = useState<{ updateId: string; resourceTypeId?: string; assetId?: string; partId?: string; who?: string; status?: string; back?: 'dashboard' } | null>(null);
  useEffect(() => {
    const go = (e: Event) => { const d = (e as CustomEvent<{ updateId: string; resourceTypeId?: string; assetId?: string; partId?: string; who?: string; status?: string; back?: 'dashboard' }>).detail; setAssetFocus({ ...d }); setPage('assets'); };
    window.addEventListener('arp:assets', go);
    return () => window.removeEventListener('arp:assets', go);
  }, []);
  useEffect(() => { if (page !== 'simulation') setSimFocus(null); }, [page]);
  const onAdviceScenario = async (name: string, actions: ScenarioAction[]): Promise<boolean> => {
    if (fileRef.current?.readOnly) return false;
    try {
      const r = await rpc.adviceScenario(name, actions);
      markChanged(false);
      setSimFocus(r.scenarioId);
      setPage('simulation');
      showToast(`시나리오 "${name}"를 만들었습니다. 원본과 비교한 뒤 반영할 수 있습니다.`);
      return true;
    } catch (error) {
      showToast((error as Error).message);
      return false;
    }
  };

  const onApplyScenario = async (scenarioId: string, force: boolean): Promise<boolean> => {
    if (fileRef.current?.readOnly) return false;
    try {
      const r = await rpc.applyScenario(scenarioId, me, force);
      markChanged(true);
      showToast(`원본에 반영했습니다 · 변경 ${r.applied}줄${r.skipped ? ` (대상이 없어 건너뛴 ${r.skipped}줄)` : ''}`);
      return true;
    } catch (error) {
      showToast((error as Error).message);
      return false;
    }
  };

  // ───────── 고치기 ─────────
  const onEdit = async (edit: LaunchEdit): Promise<boolean> => {
    if (fileRef.current?.readOnly) return false;
    try {
      const v = await rpc.edit(edit, me);
      setView(v);
      if (v.changed) {
        editSeq.current += 1;
        setVersion(x => x + 1);
        setSave(s => (s.state === 'conflict' ? s : { state: 'dirty' }));
        scheduleAutosave();
        const done = UNDO_NOTICE[edit.kind];
        if (done) showToast(done, { undo: v.batchId });
      }
      return true;
    } catch (error) {
      showToast((error as Error).message, { bad: true });
      return false;
    }
  };

  if (creating && (!file || !view)) {
    return (
      <>
        <NewProject onCancel={() => setCreating(false)} onCreate={createProject} />
        {toast && <Toast t={toast} onUndo={id => { setToast(null); void onUndo(id, false); }} onClose={() => setToast(null)} />}
      </>
    );
  }

  // 물량 템플릿 이름(프로젝트마다): 화면들이 그리기 전에 채운다
  if (view) setModeNames(view.meta);
  if (!file || !view) {
    return (
      <div class="welcome">
        <div class="card welcome-card">
          <div class="brand"><span class="brand-mark"><IconLogo /></span>아트 리소스 플래너</div>
          <div>
            <h1 style="font-size: 24px">런칭과 업데이트에 필요한<br />아트 물량을 설계합니다</h1>
            <p class="muted" style="margin-top: 8px">프로젝트 파일(.arp)을 열면 바로 계산합니다. 데이터는 이 컴퓨터의 파일에만 저장됩니다.</p>
          </div>
          {recovery && (
            <div class="banner warn">
              <IconAlert />
              <div style="flex: 1">
                <b>저장하지 않은 작업이 있습니다</b>
                <p class="small muted">{recovery.projectName} · {fmtDateTime(recovery.at)}</p>
                <div class="inline" style="margin-top: 8px">
                  <button class="btn sm primary" onClick={() => void restore(recovery)}>되살리기</button>
                  <button class="btn sm ghost" onClick={() => { void idb.del('recovery'); setRecovery(null); }}>버리기</button>
                </div>
              </div>
            </div>
          )}
          {recent.length > 0 && (
            <div class="recent">
              <span class="small muted">최근 파일</span>
              {recent.map(r => (
                <div class="recent-row">
                  <button type="button" class="recent-item" onClick={() => void openRecent(r)}>
                    <IconFolder /><span>{r.name}</span><span class="small faint">{fmtDateTime(r.at)}</span>
                  </button>
                  <button type="button" class="btn sm" aria-label={`${r.name} 보기로 열기`} title="고치지 않고 보기만(파일에 쓰지 않음)" onClick={() => void openRecent(r, true)}><IconEye />보기</button>
                </div>
              ))}
            </div>
          )}
          <label style="display: flex; flex-direction: column; gap: 6px">
            <span class="small muted">내 이름 · 변경 이력과 편집 중 표시에 남습니다</span>
            <input class="field" value={editor} placeholder="예: 김아트" onInput={e => { const v = (e.target as HTMLInputElement).value; setEditor(v); storage.set('arp.editor', v); }} />
          </label>
          <div class="actions">
            <button class="btn primary lg" disabled={busy} onClick={async () => { const f = await pickFile(); if (f) await open(f, false); }}><IconFolder />프로젝트 파일 열기</button>
            <button class="btn lg" disabled={busy} title="고치지 않고 보기만 합니다. 파일에 아무것도 쓰지 않아 편집하는 사람을 막지 않습니다" onClick={async () => { const f = await pickFile(); if (f) await open(f, false, { view: true }); }}><IconEye />보기로 열기</button>
            <button class="btn lg" disabled={busy} onClick={() => setCreating(true)}>새 프로젝트 만들기</button>
            <button class="btn lg" disabled={busy} onClick={() => setImporting(true)}>엑셀에서 가져오기</button>
            <button class="btn ghost lg" disabled={busy} onClick={async () => open(await fetchSample('normal'), true)}>예시 프로젝트로 둘러보기</button>
          </div>
          {importing && (
            <ImportGuide busy={busy} onClose={() => setImporting(false)}
              onTemplate={async example => {
                try {
                  const { bytes } = await rpc.importTemplate(example);
                  download(bytes, example ? 'ARP 가져오기 양식(예시).xlsx' : 'ARP 가져오기 양식.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                } catch (error) { showToast(`양식을 만들지 못했습니다: ${(error as Error).message}`); }
              }}
              onPick={async () => { const f = await pickXlsx(); if (f) { setImporting(false); if (!(await importLegacy(f))) setImporting(true); } }} />
          )}
          <p class="small faint">{canSaveInPlace ? '크롬·엣지에서는 수정한 내용이 연 파일에 바로 저장됩니다.' : '이 브라우저에서는 저장할 때 파일을 내려받습니다. 크롬·엣지를 사용하면 연 파일에 바로 저장됩니다.'}</p>
        </div>
        {toast && <Toast t={toast} onUndo={id => { setToast(null); void onUndo(id, false); }} onClose={() => setToast(null)} />}
      </div>
    );
  }

  const errors = view.compare.findings.filter(f => f.level === 'ERROR').length;
  const warns = view.compare.findings.filter(f => f.level === 'WARN').length;
  const saveLabel: Record<SaveState, { dot: string; text: string }> = {
    saved: { dot: 'ok', text: file.handle ? '저장됨' : file.isSample ? '예시 파일' : '저장 안 함' },
    dirty: { dot: 'warn', text: file.handle ? '저장 대기 중' : '저장 안 된 변경 있음' },
    saving: { dot: 'busy', text: '저장 중…' },
    conflict: { dot: 'bad', text: '충돌: 저장하지 않았습니다' },
    error: { dot: 'bad', text: '저장 실패' },
  };
  const sl = saveLabel[save.state];
  const names: Record<string, string> = Object.fromEntries([
    ...view.snapshot.parts.map(p => [p.partId, p.name]),
    ...view.snapshot.rows.map(r => [r.resourceTypeId, r.name]),
    ...view.snapshot.addable.map(r => [r.resourceTypeId, r.name]),
    ...(view.snapshot.launch ? [[view.snapshot.launch.updateId, view.snapshot.launch.name]] : []),
  ]);

  // 소식: 이 브라우저에서 마지막으로 본 뒤 올라온 수
  const unread = view.newsTimes.filter(t => !newsSeen || t > newsSeen).length;
  const newsNav = (
    <button class={`nav-item${page === 'news' ? ' active' : ''}`} title={helpDoc('news').short} aria-current={page === 'news' ? 'page' : undefined} onClick={() => setPage('news')}>
      <IconBell />소식{unread > 0 && <span class="end pill accent" aria-label={`새 소식 ${unread}`}>{unread}</span>}
    </button>
  );
  const navItem = (p: Page, icon: JSX.Element) => (
    <button class={`nav-item${page === p ? ' active' : ''}`} title={helpDoc(p).short} aria-current={page === p ? 'page' : undefined} onClick={() => setPage(p)}>{icon}{helpDoc(p).name}</button>
  );

  return (
    <div class={`app${wide ? ' wide' : ''}`}>
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark"><IconLogo /></span>ARP
          {/* 화면 폭: 모든 화면에 적용, 이 브라우저에 기억 */}
          <button type="button" class={`width-toggle${wide ? ' on' : ''}`} aria-pressed={wide} aria-label={wide ? '기본 폭으로 보기' : '넓게 보기'}
            data-tip={wide ? '기본 폭으로 보기' : '넓게 보기 · 모든 화면'} onClick={() => setWide(w => !w)}>{wide ? <IconNarrow /> : <IconWiden />}</button>
        </div>
        <div class="project-chip">
          <div class="small faint">프로젝트</div>
          <div class="name" title={file.name}>{view.snapshot.projectName}</div>
          <div class="small faint" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{file.name}</div>
        </div>
        <nav class="nav" aria-label="메뉴" ref={navRef}>
          {file.viewer ? (
            <>
              <div class="nav-label">보기</div>
              {newsNav}
              {navItem('dashboard', <IconChart />)}
              {navItem('assets', <IconImage />)}
              {navItem('plan', <IconCalendar />)}
            </>
          ) : (<>
          {/* 메뉴 4묶음(docs/23-ux-review.md 6.1): 매일 보는 현황 → 결정할 때 계획 → 처음 한 번 기준 정보 → 기록 · 점검 */}
          <div class="nav-label">현황</div>
          {navItem('dashboard', <IconChart />)}
          {navItem('assets', <IconImage />)}
          {navItem('progress', <IconProgress />)}
          {newsNav}
          <div class="nav-label">계획</div>
          {navItem('launch', <IconLaunch />)}
          {navItem('plan', <IconCalendar />)}
          {navItem('simulation', <IconSliders />)}
          {navItem('advisor', <IconTarget />)}
          <div class="nav-label">기준 정보</div>
          {navItem('setup', <IconSettings />)}
          {navItem('capacity', <IconUsers />)}
          {navItem('templates', <IconLayers />)}
          {navItem('calibration', <IconTune />)}
          <div class="nav-label">기록 · 점검</div>
          <button class={`nav-item${page === 'check' ? ' active' : ''}`} title={helpDoc('check').short} aria-current={page === 'check' ? 'page' : undefined} onClick={() => setPage('check')}>
            <IconCheck />데이터 점검
            {(errors > 0 || warns > 0) && <span class={`end pill ${errors ? 'bad' : 'warn'}`}>{errors || warns}</span>}
          </button>
          {navItem('history', <IconHistory />)}
          </>)}
        </nav>
        <div class={`sidebar-foot${footOpen ? ' open' : ''}`} ref={footRef}>
          {file.viewer
            ? <div class="save-state"><span class="dot accent" />보기 모드</div>
            : <div class="save-state" title={save.message ?? ''}><span class={`dot ${sl.dot}`} />{sl.text}</div>}
          <button type="button" class="btn sm foot-toggle" aria-expanded={footOpen} aria-haspopup="true" onClick={() => setFootOpen(o => !o)}><IconFolder />파일</button>
          <div class="foot-menu" onClick={e => { if ((e.target as HTMLElement).closest('button')) setFootOpen(false); }}>
          {!file.handle && !file.viewer && <div class="small faint editor">수정한 내용을 남기려면 다른 이름으로 저장하십시오</div>}
          <div style="display: flex; gap: 6px">
            {!file.viewer && <button class="btn sm" disabled={file.readOnly || save.state === 'saving'} onClick={() => void writeNow()} title="저장 (Ctrl+S)"><IconSave />{file.handle ? '저장' : '다른 이름으로 저장'}</button>}
            {file.handle && !file.readOnly && (save.state === 'conflict' || save.state === 'error') && <button class="btn sm" onClick={() => void saveAsNew()}>다른 이름으로</button>}
            <button class="btn sm" title="이 파일을 닫고 시작 화면으로 돌아갑니다" onClick={() => void close()}>파일 닫기</button>
          </div>
          <button class="btn sm ghost" style="justify-content: flex-start" title="업데이트 전망 · 파트 부하 등 보고용 표(다시 가져올 수 없음)" onClick={() => void exportXlsx()}><IconDownload />보고용 엑셀 내보내기</button>
          {!file.viewer && <button class="btn sm ghost" style="justify-content: flex-start" title={`가져오기 양식 형식. 엑셀에서 수정한 뒤 다시 가져오면 새 프로젝트 파일이 됩니다. ${TEMPLATE_LEAVES_OUT}`} onClick={() => void exportTemplate()}><IconDownload />편집용 엑셀 내보내기</button>}
          <div class="small faint editor">{file.viewer ? `보는 사람 ${me}` : `편집자 ${me}`}</div>
          </div>
        </div>
      </aside>
      <main class="main">
        {file.viewer && (
          <div class="page" style="margin-bottom: 16px">
            <div class="banner viewer-banner" role="status"><IconEye /><div style="flex: 1"><b>보기 모드</b>
              <p class="small muted">마지막 저장 {fmtDateTime(file.lastModified)}{view.meta.lock_holder && Date.now() - Date.parse(view.meta.lock_heartbeat_at ?? '') < LOCK_FRESH_MS ? ` · 지금 ${view.meta.lock_holder}님이 편집 중` : ''}{file.handle ? ' · 저장되면 1분 안에 최신으로 바뀝니다' : ''}</p></div>
              {file.handle && canSaveInPlace && <button type="button" class="btn sm" onClick={() => void editInstead()}>편집으로 열기</button>}
            </div>
          </div>
        )}
        {file.readOnly && !file.viewer && (
          <div class="page" style="margin-bottom: 16px">
            <div class="banner warn"><IconLock /><div><b>{file.lockedBy}님이 편집 중이라 읽기 전용으로 열었습니다</b><p class="small muted">편집을 마치거나 30분 동안 저장이 없으면 수정할 수 있습니다.</p></div></div>
          </div>
        )}
        {notice && (
          <div class="page" style="margin-bottom: 16px">
            <div class="banner notice" role="status">
              <IconAlert />
              <div style="flex: 1">
                <b>지난번({fmtDateTime(notice.since)})에 본 뒤 바뀐 것</b>
                <ul class="small">
                  {notice.changed.slice(0, 5).map(c => (
                    <li>{c.name}: 완료 예정 {c.before ? fmtShortDate(c.before) : '기간 밖'} → {c.after ? fmtShortDate(c.after) : '기간 밖'}{c.deltaDays ? ` (${c.deltaDays > 0 ? '+' : '−'}${Math.abs(c.deltaDays)}일)` : ''}</li>
                  ))}
                  {notice.added.length > 0 && <li>새 업데이트: {notice.added.join(', ')}</li>}
                  {notice.removed.length > 0 && <li>계산에서 빠진 업데이트: {notice.removed.join(', ')}</li>}
                  {notice.editsByOthers > 0 && <li>{notice.editors.join(', ')}님이 {notice.editsByOthers}번 수정했습니다 · 변경 이력에서 볼 수 있습니다</li>}
                </ul>
              </div>
              <button type="button" class="btn ghost icon-btn" aria-label="알림 닫기" onClick={() => setNotice(null)}><IconX /></button>
            </div>
          </div>
        )}
        {backup && (
          <div class="page" style="margin-bottom: 16px">
            <div class="banner warn"><IconAlert /><div style="flex: 1"><b>옛 구조(v{backup.from}) 파일을 새 구조로 바꿔 열었습니다</b>
              <p class="small muted">저장하면 새 구조로 남습니다. 옛 앱에서도 열어야 하면 바꾸기 전 원본을 받아 두십시오.</p>
              <div class="inline" style="margin-top: 8px">
                <button class="btn sm" onClick={() => download(backup.bytes, backup.name.replace(/\.arp$/i, '') + `.v${backup.from}.bak.arp`, 'application/x-sqlite3')}><IconDownload />원본 받기</button>
                <button class="btn sm ghost" onClick={() => setBackup(null)}>닫기</button>
              </div></div></div>
          </div>
        )}
        {save.state === 'conflict' && (
          <div class="page" style="margin-bottom: 16px">
            <div class="banner bad"><IconAlert /><div style="flex: 1"><b>저장하지 않았습니다</b><p class="small muted">{save.message}</p>
              <div class="inline" style="margin-top: 8px"><button class="btn sm primary" onClick={() => void saveAsNew()}><IconSave />다른 이름으로 저장</button></div></div></div>
          </div>
        )}
        {/* 처음 할 일 안내: 화면 맨 위(docs/23-ux-review.md 6.4) */}
        {(page === 'dashboard' || page === 'launch') && !file.viewer && !guideHidden && !setupDone(view.setup) && (
          <div class="page" style="margin-bottom: 16px">
            <SetupGuide status={view.setup} onGo={p => setPage(p)} onHide={() => { setGuideHidden(true); writeGuideHidden(file.name); }} />
          </div>
        )}
        {page === 'launch' && <LaunchPage view={view} version={version} planMode={planMode} setPlanMode={setPlanMode} readOnly={file.readOnly} onEdit={onEdit} onApply={onApply} onMakeScenario={onAdviceScenario} />}
        {page === 'plan' && <PlanPage version={version} planMode={planMode} setPlanMode={setPlanMode} readOnly={file.readOnly} names={names} onApply={onApply} onGo={p => setPage(p)} />}
        {page === 'news' && <NewsPage version={version} readOnly={file.readOnly} project={view.snapshot.projectName} seenAt={newsSeen}
          onSeen={() => { const at = new Date().toISOString(); writeNewsSeen(file.name, at); setNewsSeen(at); }} onApply={onApply} onToast={showToast} />}
        {page === 'dashboard' && <DashboardPage version={version} planMode={planMode} setPlanMode={setPlanMode} onGo={p => setPage(p)} viewer={!!file.viewer} updateId={curUpdate} onUpdate={setCurUpdate} />}
        {page === 'assets' && <AssetsPage version={version} readOnly={file.readOnly} onApply={onApply} onExport={onExportAssets} onImport={onImportAssets} focus={assetFocus} onBack={p => setPage(p)} updateId={curUpdate} onUpdate={setCurUpdate} />}
        {page === 'progress' && <ProgressPage version={version} readOnly={file.readOnly} onApply={onApply} onTemplate={onTemplate} onImport={onImportProgress} updateId={curUpdate} onUpdate={setCurUpdate} />}
        {page === 'calibration' && <CalibrationPage version={version} readOnly={file.readOnly} onCalibrate={onCalibrate} onGoProgress={() => setPage('progress')} />}
        {page === 'simulation' && <SimulationPage version={version} planMode={planMode} setPlanMode={setPlanMode} readOnly={file.readOnly} onScenario={onScenario} onApplyScenario={onApplyScenario} onGoPlan={() => setPage('plan')} focus={simFocus} updateId={curUpdate} onUpdate={setCurUpdate} />}
        {page === 'advisor' && <AdvisorPage version={version} planMode={planMode} setPlanMode={setPlanMode} readOnly={file.readOnly} onMakeScenario={onAdviceScenario} />}
        {page === 'setup' && <SetupPage version={version} readOnly={file.readOnly} onApply={onApply} onNext={() => setPage('capacity')} />}
        {page === 'templates' && <TemplatesPage version={version} readOnly={file.readOnly} onApply={onApply} />}
        {page === 'capacity' && <CapacityPage version={version} readOnly={file.readOnly} onApply={onApply} onNext={() => setPage('launch')} />}
        {page === 'history' && <HistoryPage version={version} readOnly={file.readOnly} onUndo={onUndo} />}
        {page === 'check' && <ChecksPage view={view} names={names} onGo={p => setPage(p)} />}
      </main>
      {imported && (
        <ImportReport report={imported} findings={view.compare.findings}
          onClose={() => setImported(null)}
          onCheck={() => { setImported(null); setPage('check'); }}
          onSave={async () => { if (await writeNow()) setImported(null); }} />
      )}
      {sheetImport && <SheetImportDialog fileName={sheetImport.name} scan={sheetImport.scan} busy={sheetImport.busy} onImport={p => void onImportSheet(p)} onClose={() => setSheetImport(null)} />}
      {help && <HelpPanel page={help} onClose={() => setHelp(null)} onGo={p => { setHelp(null); setPage(p); }} />}
      {toast && <Toast t={toast} onUndo={id => { setToast(null); void onUndo(id, false); }} onClose={() => setToast(null)} />}
    </div>
  );
}

/** 규칙 영역 → 고치는 화면(규칙 코드 첫 글자, docs/34 A-04) */
const FIX_PAGE: Record<string, { page: Page; label: string }> = {
  S: { page: 'setup', label: '프로젝트 설정' }, P: { page: 'setup', label: '파트 · 파이프라인' }, E: { page: 'setup', label: '리소스 · 공수' },
  U: { page: 'plan', label: '업데이트 계획' }, V: { page: 'launch', label: '물량' }, A: { page: 'progress', label: '작업 진척' },
  C: { page: 'capacity', label: '인력' }, T: { page: 'templates', label: '유형 템플릿' }, X: { page: 'simulation', label: '시뮬레이션' }, B: { page: 'assets', label: '에셋 · 배치' },
};
/** 설정 키 이름 */
const SETTING_LABEL: Record<string, string> = {
  settings: '설정', 'settings.buffer_rate': '여유율', 'settings.default_overlap_rate': '기본 겹침률', 'settings.load_rates': '부하율 기준',
  'settings.work_weekdays': '근무 요일', 'settings.late_warn_workdays': '늦음 경고 영업일',
};

function ChecksPage(props: { view: View; names: Record<string, string>; onGo: (p: Page) => void }) {
  const findings = props.view.compare.findings;
  const errors = findings.filter(f => f.level === 'ERROR');
  const warns = findings.filter(f => f.level !== 'ERROR');
  const where = (key: string) => SETTING_LABEL[key] ?? humanKey(key, props.names);
  const list = (items: typeof findings, title: string, desc: string) => items.length > 0 && (
    <section class="card">
      <div class="card-head"><div><h2>{title} {items.length}개</h2><p class="small muted" style="margin-top: 2px">{desc}</p></div></div>
      <div class="card-body" style="padding-top: 4px">
        {items.map(f => {
          const fix = FIX_PAGE[f.code[0]];
          return (
            <div class="finding">
              <span class={`pill ${f.level === 'ERROR' ? 'bad' : 'warn'}`}>{f.level === 'ERROR' ? '오류' : '주의'}</span>
              <div style="flex: 1; min-width: 0"><div style="font-weight: 600">{f.title}</div><div class="small muted">{where(f.key)} · {f.detail}</div></div>
              {fix && <button type="button" class="btn sm" title={`${fix.label} 화면에서 고칩니다`} onClick={() => props.onGo(fix.page)}>{fix.label}에서 고치기 →</button>}
            </div>
          );
        })}
      </div>
    </section>
  );
  return (
    <div class="page">
      <header class="page-head"><div><PageEyebrow page="check" /><h1>데이터 점검</h1>
        <p class="muted" style="margin-top: 6px">{findings.length ? `고칠 곳 ${errors.length}개 · 살펴볼 곳 ${warns.length}개. 오류가 있으면 계산하지 않습니다. 주의는 계산하되 표시만 합니다.` : '오류가 있으면 계산하지 않습니다. 주의는 계산하되 표시만 합니다.'}</p></div></header>
      {findings.length === 0 && <div class="banner ok" role="status"><IconCheck /><div><b>문제가 없습니다</b><p class="small muted">모든 점검 규칙을 통과했습니다.</p></div></div>}
      {list(errors, '오류', '고치기 전에는 계산하지 않습니다.')}
      {list(warns, '주의', '계산은 하지만 결과가 실제와 다를 수 있는 곳입니다.')}
    </div>
  );
}
