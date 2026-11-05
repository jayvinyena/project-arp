// 앱 틀: 시작 화면, 옆 메뉴, 파일 열기·저장(자동 저장, 편집 중 표시, 저장 전 충돌 확인)
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { rpc } from './lib/rpc.ts';
import type { View } from './lib/rpc.ts';
import { pickFile, fetchSample, saveInPlace, saveAs, SaveConflictError, canSaveInPlace, pickXlsx, fetchBytes } from './lib/files.ts';
import { ImportReport } from './ui/ImportReport.tsx';
import { HistoryPage } from './ui/HistoryPage.tsx';
import { CalibrationPage } from './ui/CalibrationPage.tsx';
import type { Notice, Seen } from '../../core/notice.ts';
import { idb, rememberRecent, ensurePermission } from './lib/idb.ts';
import type { Recovery, RecentFile } from './lib/idb.ts';
import { LATEST_SCHEMA } from '../../core/migrate.ts';
import { fmtShortDate } from './lib/format.ts';
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
import { SimulationPage } from './ui/SimulationPage.tsx';
import type { ScenarioOp } from '../../core/scenarios.ts';
import type { Edit } from '../../core/edits.ts';
import type { NewProjectInput } from '../../core/new-project.ts';
import { IconLogo, IconLaunch, IconCalendar, IconSliders, IconCheck, IconFolder, IconSave, IconAlert, IconLock, IconLayers, IconUsers, IconProgress, IconHistory, IconDownload, IconTune, IconX } from './ui/icons.tsx';

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';
type Page = 'launch' | 'plan' | 'progress' | 'simulation' | 'templates' | 'capacity' | 'calibration' | 'history' | 'check';
interface FileState { name: string; handle: FileSystemFileHandle | null; lastModified: number; readOnly: boolean; lockedBy: string | null; isSample: boolean }

const LOCK_FRESH_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;
const AUTOSAVE_MS = 2000;

const storage = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 저장소를 못 써도 앱은 돈다 */ } },
};

export function App() {
  const [editor, setEditor] = useState(storage.get('arp.editor') ?? '');
  const [file, setFile] = useState<FileState | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [version, setVersion] = useState(0);
  const [planMode, setPlanMode] = useState<PlanMode>('TARGET');
  const [page, setPage] = useState<Page>((new URLSearchParams(location.search).get('page') as Page) || 'launch');
  const [save, setSave] = useState<{ state: SaveState; at?: number; message?: string }>({ state: 'saved' });
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(new URLSearchParams(location.search).has('new'));
  const [imported, setImported] = useState<ImportReportData | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [backup, setBackup] = useState<{ name: string; bytes: ArrayBuffer; from: number } | null>(null);
  const snapshotTimer = useRef<number | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | null>(null);
  const fileRef = useRef<FileState | null>(null);
  fileRef.current = file;
  const saveTimer = useRef<number | undefined>(undefined);
  const saving = useRef(false);

  const showToast = (m: string) => { setToast(m); window.setTimeout(() => setToast(null), 4000); };
  const me = editor.trim() || '이름 없음';

  // ───────── 저장 ─────────
  // 경쟁 상태 막기:
  //  - 저장(내보내기)을 시작한 뒤 고친 내용이 있으면 저장이 끝나도 "저장 대기"로 두고 다시 저장한다(editSeq)
  //  - 저장 중에 들어온 저장 요청은 버리지 않고 끝난 뒤 한 번 더 한다(pendingSave)
  //  - 파일의 마지막 수정 시각은 화면을 다시 그리기 전에도 최신이어야 하므로 fileRef에 바로 쓴다
  const editSeq = useRef(0);
  const pendingSave = useRef(false);
  const writeRef = useRef<() => Promise<boolean>>(async () => false);

  const setFileNow = (next: FileState) => { fileRef.current = next; setFile(next); };

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
    setSave({ state: 'saving' });
    let ok = false;
    try {
      const { bytes } = await rpc.export();
      const cur = fileRef.current ?? f;
      if (cur.handle) {
        const lastModified = await saveInPlace(cur.handle, bytes, cur.lastModified);
        setFileNow({ ...cur, lastModified });
      } else {
        const r = await saveAs(bytes, cur.name.endsWith('.arp') ? cur.name : `${cur.name}.arp`);
        if (!r) { setSave({ state: 'dirty' }); return false; }
        setFileNow({ ...cur, handle: r.handle, lastModified: r.lastModified, name: r.name, isSample: false });
      }
      ok = true;
      void idb.del('recovery');
      void refreshSeen(false);
      const savedFile = fileRef.current;
      if (savedFile?.handle) void rememberRecent(savedFile.handle, savedFile.name);
      if (editSeq.current !== seq) { setSave({ state: 'dirty' }); scheduleAutosave(); } else setSave({ state: 'saved', at: Date.now() });
      return true;
    } catch (error) {
      if (error instanceof SaveConflictError) {
        setSave({ state: 'conflict', message: '다른 곳에서 파일이 바뀌었어요. 다른 이름으로 저장하거나 다시 열어 주세요.' });
      } else {
        setSave({ state: 'error', message: (error as Error).message });
      }
      return false;
    } finally {
      saving.current = false;
      if (pendingSave.current) {
        pendingSave.current = false;
        if (ok) void writeRef.current();
      }
    }
  }, []);
  writeRef.current = writeNow;

  // 예기치 못한 비동기 오류(main.tsx가 'arp:error'로 알린다)
  useEffect(() => {
    const onError = (e: Event) => showToast(`문제가 생겼어요: ${(e as CustomEvent<string>).detail}`);
    window.addEventListener('arp:error', onError);
    return () => window.removeEventListener('arp:error', onError);
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
    const onLeave = (e: BeforeUnloadEvent) => { if (save.state === 'dirty' || save.state === 'saving') { e.preventDefault(); } };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [save.state]);

  // ───────── 열기 ─────────
  const open = async (opened: OpenedFile, isSample: boolean) => {
    setBusy(true);
    try {
      // SQLite 머리(60–63바이트) = 구조 버전. 옛 구조면 바꾸기 전 원본을 남겨 둔다
      const version = new DataView(opened.bytes).getUint32(60, false);
      const original = version < LATEST_SCHEMA ? opened.bytes.slice(0) : null;
      const v = await rpc.open(opened.bytes);
      if (original && v.migration && v.migration.from !== v.migration.to) setBackup({ name: opened.name, bytes: original, from: v.migration.from });
      if (opened.handle) void rememberRecent(opened.handle, opened.name);
      if (v.migration && v.migration.from !== v.migration.to) {
        showToast(`옛 구조(v${v.migration.from}) 파일을 새 구조(v${v.migration.to})로 바꿨어요. 저장하면 새 구조로 남아요.`);
      }
      const holder = v.meta.lock_holder;
      const beat = v.meta.lock_heartbeat_at ? Date.parse(v.meta.lock_heartbeat_at) : 0;
      const lockedByOther = !!holder && holder !== me && Date.now() - beat < LOCK_FRESH_MS;
      const state: FileState = {
        name: opened.name, handle: opened.handle, lastModified: opened.lastModified,
        readOnly: lockedByOther, lockedBy: lockedByOther ? holder : null, isSample,
      };
      setFileNow(state);
      editSeq.current = 0;
      setView(v);
      setVersion(x => x + 1);
      setPage(p => (p === 'check' ? 'launch' : p));
      // 편집 중 표시를 쓰고 저장할 때까지는 "저장 중"
      setSave({ state: opened.handle && !lockedByOther ? 'saving' : 'saved' });
      if (opened.handle && !lockedByOther) {
        await rpc.lock(me);
        await writeNow();
      }
      if (!isSample) void refreshSeen(true);
    } catch (error) {
      showToast(`열지 못했어요: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    const f = fileRef.current;
    if (f?.handle && !f.readOnly) { await rpc.lock(null); await writeNow(); }
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
      setFileNow(state);
      editSeq.current = 0;
      setView(await rpc.view());
      setVersion(x => x + 1);
      setPage('launch');
      setSave(saved?.handle ? { state: 'saved', at: Date.now() } : { state: 'dirty' });
      setCreating(false);
      if (!saved?.handle) showToast('저장 위치를 고르지 않았어요. 왼쪽 아래 "다른 이름으로 저장"으로 저장해 주세요.');
    } catch (error) {
      showToast(`만들지 못했어요: ${(error as Error).message}`);
    }
  };

  // ───────── 작업 복구 사본 · 최근 파일 ─────────
  useEffect(() => {
    void idb.get<Recovery>('recovery').then(r => { if (r) setRecovery(r); });
    void idb.get<RecentFile[]>('recent').then(r => setRecent(r ?? []));
  }, [file]);

  // 저장 안 된 변경이 생기면 1.5초 뒤 브라우저 저장소에 사본을 둔다(창을 닫아도 복구)
  useEffect(() => {
    if (save.state !== 'dirty' || !file || file.readOnly) return;
    window.clearTimeout(snapshotTimer.current);
    snapshotTimer.current = window.setTimeout(async () => {
      try {
        const { bytes } = await rpc.snapshot();
        await idb.set('recovery', { name: file.name, at: Date.now(), bytes, projectName: view?.snapshot.projectName ?? file.name } satisfies Recovery);
      } catch { /* 사본을 못 남겨도 작업은 계속 */ }
    }, 1500);
  }, [version, save.state]);

  const restore = async (r: Recovery) => {
    await open({ name: r.name, bytes: r.bytes, handle: null, lastModified: r.at }, false);
    const restored = fileRef.current;
    if (restored) setFileNow({ ...restored, isSample: false });
    editSeq.current = 1;
    setSave({ state: 'dirty' });
    setRecovery(null);
    showToast('저장하지 않았던 작업을 되살렸어요. 다른 이름으로 저장해 주세요.');
  };

  const openRecent = async (r: RecentFile) => {
    try {
      if (!(await ensurePermission(r.handle))) { showToast('파일을 쓸 권한을 받지 못했어요.'); return; }
      const f = await r.handle.getFile();
      await open({ name: f.name, bytes: await f.arrayBuffer(), handle: r.handle, lastModified: f.lastModified }, false);
    } catch (error) {
      showToast(`열지 못했어요(옮겼거나 지운 파일일 수 있어요): ${(error as Error).message}`);
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
      download(bytes, `${base} ${new Date().toISOString().slice(0, 10)}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (error) {
      showToast(`내보내지 못했어요: ${(error as Error).message}`);
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

  // 실적 엑셀
  const onTemplate = async () => {
    const { bytes } = await rpc.progressTemplate();
    download(bytes, `${(view?.snapshot.projectName ?? 'ARP').replace(/[\\/:*?"<>|]/g, '_')} 실적 양식.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  };
  const onImportProgress = async () => {
    const picked = await pickXlsx();
    if (!picked) return;
    try {
      const r = await rpc.importProgress(picked.bytes, me);
      if (r.changedCells) markChanged(true);
      showToast(`실적을 넣었어요 · ${r.changedCells}칸 바뀜${r.unchanged ? `, ${r.unchanged}칸 그대로` : ''}${r.skipped.length ? ` · 건너뛴 행 ${r.skipped.length}개(${r.skipped.slice(0, 2).map(s => `${s.row}행 ${s.reason}`).join(', ')})` : ''}`);
    } catch (error) {
      showToast(`넣지 못했어요: ${(error as Error).message}`);
    }
  };
  const onCalibrate = async (picks: { resourceTypeId: string; partId: string; ratio: number }[]) => {
    try {
      const r = await rpc.calibrate(picks, me);
      if (r.changed) markChanged(true);
      showToast(`공수 ${r.changed}곳을 보정했어요. 변경 이력에서 되돌릴 수 있어요.`);
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
      showToast(`되돌렸어요 · ${r.reverted}칸`);
      return { ok: true };
    } catch (error) {
      const m = (error as Error).message;
      showToast(m);
      return { ok: false, needsForce: m.includes('그래도 되돌리') };
    }
  };

  // ───────── 옛 시트 가져오기 ─────────
  const importLegacy = async (picked: { name: string; bytes: ArrayBuffer } | null) => {
    if (!picked) return;
    setBusy(true);
    try {
      const base = picked.name.replace(/\.xlsx$/i, '').trim() || '가져온 프로젝트';
      const v = await rpc.importLegacy(picked.bytes, base);
      setFileNow({ name: `${base}.arp`, handle: null, lastModified: Date.now(), readOnly: false, lockedBy: null, isSample: false });
      editSeq.current = 1;
      setView(v);
      setVersion(x => x + 1);
      setPage('launch');
      setSave({ state: 'dirty' });
      setImported(v.report);
    } catch (error) {
      showToast(`가져오지 못했어요: ${(error as Error).message}`);
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
      }
      return true;
    } catch (error) {
      showToast((error as Error).message);
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

  const onApplyScenario = async (scenarioId: string, force: boolean): Promise<boolean> => {
    if (fileRef.current?.readOnly) return false;
    try {
      const r = await rpc.applyScenario(scenarioId, me, force);
      markChanged(true);
      showToast(`원본에 반영했어요 · 변경 ${r.applied}줄${r.skipped ? ` (대상이 없어 건너뛴 ${r.skipped}줄)` : ''}`);
      return true;
    } catch (error) {
      showToast((error as Error).message);
      return false;
    }
  };

  // ───────── 고치기 ─────────
  const onEdit = async (edit: LaunchEdit) => {
    if (fileRef.current?.readOnly) return;
    try {
      const v = await rpc.edit(edit, me);
      setView(v);
      if (v.changed) {
        editSeq.current += 1;
        setVersion(x => x + 1);
        setSave(s => (s.state === 'conflict' ? s : { state: 'dirty' }));
        scheduleAutosave();
      }
    } catch (error) {
      showToast((error as Error).message);
    }
  };

  if (creating && (!file || !view)) {
    return (
      <>
        <NewProject onCancel={() => setCreating(false)} onCreate={createProject} />
        {toast && <div class="toast" role="status">{toast}</div>}
      </>
    );
  }

  if (!file || !view) {
    return (
      <div class="welcome">
        <div class="card welcome-card">
          <div class="brand"><span class="brand-mark"><IconLogo /></span>아트 리소스 플래너</div>
          <div>
            <h1 style="font-size: 24px">런칭과 업데이트에 필요한<br />아트 물량을 설계해요</h1>
            <p class="muted" style="margin-top: 8px">프로젝트 파일(.arp)을 열면 바로 계산해요. 데이터는 이 컴퓨터의 파일에만 저장돼요.</p>
          </div>
          {recovery && (
            <div class="banner warn">
              <IconAlert />
              <div style="flex: 1">
                <b>저장하지 않은 작업이 있어요</b>
                <p class="small muted">{recovery.projectName} · {new Date(recovery.at).toLocaleString('ko-KR')}</p>
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
                <button type="button" class="recent-item" onClick={() => void openRecent(r)}>
                  <IconFolder /><span>{r.name}</span><span class="small faint">{new Date(r.at).toLocaleDateString('ko-KR')}</span>
                </button>
              ))}
            </div>
          )}
          <label style="display: flex; flex-direction: column; gap: 6px">
            <span class="small muted">내 이름 · 변경 이력과 편집 중 표시에 남아요</span>
            <input class="field" value={editor} placeholder="예: 김아트" onInput={e => { const v = (e.target as HTMLInputElement).value; setEditor(v); storage.set('arp.editor', v); }} />
          </label>
          <div class="actions">
            <button class="btn primary lg" disabled={busy} onClick={async () => { const f = await pickFile(); if (f) await open(f, false); }}><IconFolder />프로젝트 파일 열기</button>
            <button class="btn lg" disabled={busy} onClick={() => setCreating(true)}>새 프로젝트 만들기</button>
            <button class="btn lg" disabled={busy} onClick={async () => importLegacy(await pickXlsx())}>기존 시트(.xlsx) 가져오기</button>
            <button class="btn ghost lg" disabled={busy} onClick={async () => open(await fetchSample('normal'), true)}>예시 프로젝트로 둘러보기</button>
          </div>
          <p class="small faint">{canSaveInPlace ? '크롬·엣지에서는 고친 내용이 연 파일에 바로 저장돼요.' : '이 브라우저에서는 저장할 때 파일을 내려받아요. 크롬·엣지를 쓰면 연 파일에 바로 저장돼요.'}</p>
        </div>
        {toast && <div class="toast" role="status">{toast}</div>}
      </div>
    );
  }

  const errors = view.compare.findings.filter(f => f.level === 'ERROR').length;
  const warns = view.compare.findings.filter(f => f.level === 'WARN').length;
  const saveLabel: Record<SaveState, { dot: string; text: string }> = {
    saved: { dot: 'ok', text: file.handle ? '저장됨' : file.isSample ? '예시 파일' : '저장 안 함' },
    dirty: { dot: 'warn', text: file.handle ? '저장 대기 중' : '저장 안 된 변경 있음' },
    saving: { dot: 'busy', text: '저장 중…' },
    conflict: { dot: 'bad', text: '충돌: 저장하지 않았어요' },
    error: { dot: 'bad', text: '저장 실패' },
  };
  const sl = saveLabel[save.state];
  const names: Record<string, string> = Object.fromEntries([
    ...view.snapshot.parts.map(p => [p.partId, p.name]),
    ...view.snapshot.rows.map(r => [r.resourceTypeId, r.name]),
    ...view.snapshot.addable.map(r => [r.resourceTypeId, r.name]),
    ...(view.snapshot.launch ? [[view.snapshot.launch.updateId, view.snapshot.launch.name]] : []),
  ]);

  return (
    <div class="app">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark"><IconLogo /></span>ARP</div>
        <div class="project-chip">
          <div class="small faint">프로젝트</div>
          <div class="name" title={file.name}>{view.snapshot.projectName}</div>
          <div class="small faint" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{file.name}</div>
        </div>
        <nav class="nav" aria-label="메뉴">
          <div class="nav-label">계획</div>
          <button class={`nav-item${page === 'launch' ? ' active' : ''}`} onClick={() => setPage('launch')}><IconLaunch />런칭 물량 설계</button>
          <button class={`nav-item${page === 'plan' ? ' active' : ''}`} onClick={() => setPage('plan')}><IconCalendar />업데이트 계획</button>
          <button class={`nav-item${page === 'progress' ? ' active' : ''}`} onClick={() => setPage('progress')}><IconProgress />진행 실적</button>
          <button class={`nav-item${page === 'simulation' ? ' active' : ''}`} onClick={() => setPage('simulation')}><IconSliders />시뮬레이션</button>
          <div class="nav-label" style="margin-top: 12px">기준 정보</div>
          <button class={`nav-item${page === 'templates' ? ' active' : ''}`} onClick={() => setPage('templates')}><IconLayers />유형 템플릿</button>
          <button class={`nav-item${page === 'capacity' ? ' active' : ''}`} onClick={() => setPage('capacity')}><IconUsers />인력</button>
          <button class={`nav-item${page === 'calibration' ? ' active' : ''}`} onClick={() => setPage('calibration')}><IconTune />공수 보정</button>
          <button class={`nav-item${page === 'history' ? ' active' : ''}`} onClick={() => setPage('history')}><IconHistory />변경 이력</button>
          <button class={`nav-item${page === 'check' ? ' active' : ''}`} onClick={() => setPage('check')}>
            <IconCheck />데이터 점검
            {(errors > 0 || warns > 0) && <span class={`end pill ${errors ? 'bad' : 'warn'}`}>{errors || warns}</span>}
          </button>
        </nav>
        <div class="sidebar-foot">
          <div class="save-state" title={save.message ?? ''}><span class={`dot ${sl.dot}`} />{sl.text}</div>
          {!file.handle && <div class="small faint editor">고친 내용을 남기려면 다른 이름으로 저장해 주세요</div>}
          <div style="display: flex; gap: 6px">
            <button class="btn sm" disabled={file.readOnly || save.state === 'saving'} onClick={() => void writeNow()} title="저장 (Ctrl+S)"><IconSave />{file.handle ? '저장' : '다른 이름으로 저장'}</button>
            <button class="btn sm ghost" onClick={() => void close()}>닫기</button>
          </div>
          <button class="btn sm ghost" style="justify-content: flex-start" onClick={() => void exportXlsx()}><IconDownload />엑셀로 내보내기</button>
          <div class="small faint editor">편집자 {me}</div>
        </div>
      </aside>
      <main class="main">
        {file.readOnly && (
          <div class="page" style="margin-bottom: 16px">
            <div class="banner warn"><IconLock /><div><b>{file.lockedBy}님이 편집 중이라 읽기 전용으로 열었어요</b><p class="small muted">편집을 마치거나 30분 동안 저장이 없으면 고칠 수 있어요.</p></div></div>
          </div>
        )}
        {notice && (
          <div class="page" style="margin-bottom: 16px">
            <div class="banner notice" role="status">
              <IconAlert />
              <div style="flex: 1">
                <b>지난번({new Date(notice.since).toLocaleDateString('ko-KR')})에 본 뒤 바뀐 것</b>
                <ul class="small">
                  {notice.changed.slice(0, 5).map(c => (
                    <li>{c.name}: 완료 예정 {c.before ? fmtShortDate(c.before) : '기간 밖'} → {c.after ? fmtShortDate(c.after) : '기간 밖'}{c.deltaDays ? ` (${c.deltaDays > 0 ? '+' : '−'}${Math.abs(c.deltaDays)}일)` : ''}</li>
                  ))}
                  {notice.added.length > 0 && <li>새 업데이트: {notice.added.join(', ')}</li>}
                  {notice.removed.length > 0 && <li>계산에서 빠진 업데이트: {notice.removed.join(', ')}</li>}
                  {notice.editsByOthers > 0 && <li>{notice.editors.join(', ')}님이 {notice.editsByOthers}번 고쳤어요 · 변경 이력에서 볼 수 있어요</li>}
                </ul>
              </div>
              <button type="button" class="btn ghost icon-btn" aria-label="알림 닫기" onClick={() => setNotice(null)}><IconX /></button>
            </div>
          </div>
        )}
        {backup && (
          <div class="page" style="margin-bottom: 16px">
            <div class="banner warn"><IconAlert /><div style="flex: 1"><b>옛 구조(v{backup.from}) 파일을 새 구조로 바꿔 열었어요</b>
              <p class="small muted">저장하면 새 구조로 남아요. 옛 앱에서도 열어야 하면 바꾸기 전 원본을 받아 두세요.</p>
              <div class="inline" style="margin-top: 8px">
                <button class="btn sm" onClick={() => download(backup.bytes, backup.name.replace(/\.arp$/i, '') + `.v${backup.from}.bak.arp`, 'application/x-sqlite3')}><IconDownload />원본 받기</button>
                <button class="btn sm ghost" onClick={() => setBackup(null)}>닫기</button>
              </div></div></div>
          </div>
        )}
        {save.state === 'conflict' && (
          <div class="page" style="margin-bottom: 16px">
            <div class="banner bad"><IconAlert /><div><b>저장하지 않았어요</b><p class="small muted">{save.message}</p></div></div>
          </div>
        )}
        {page === 'launch' && <LaunchPage view={view} version={version} planMode={planMode} setPlanMode={setPlanMode} readOnly={file.readOnly} onEdit={onEdit} />}
        {page === 'plan' && <PlanPage version={version} planMode={planMode} setPlanMode={setPlanMode} readOnly={file.readOnly} names={names} onApply={onApply} />}
        {page === 'progress' && <ProgressPage version={version} readOnly={file.readOnly} onApply={onApply} onTemplate={onTemplate} onImport={onImportProgress} />}
        {page === 'calibration' && <CalibrationPage version={version} readOnly={file.readOnly} onCalibrate={onCalibrate} onGoProgress={() => setPage('progress')} />}
        {page === 'simulation' && <SimulationPage version={version} planMode={planMode} setPlanMode={setPlanMode} readOnly={file.readOnly} onScenario={onScenario} onApplyScenario={onApplyScenario} />}
        {page === 'templates' && <TemplatesPage version={version} readOnly={file.readOnly} onApply={onApply} />}
        {page === 'capacity' && <CapacityPage version={version} readOnly={file.readOnly} onApply={onApply} />}
        {page === 'history' && <HistoryPage version={version} readOnly={file.readOnly} onUndo={onUndo} />}
        {page === 'check' && <ChecksPage view={view} />}
      </main>
      {imported && (
        <ImportReport report={imported} findings={view.compare.findings}
          onClose={() => setImported(null)}
          onCheck={() => { setImported(null); setPage('check'); }}
          onSave={async () => { if (await writeNow()) setImported(null); }} />
      )}
      {toast && <div class="toast" role="status">{toast}</div>}
    </div>
  );
}

function ChecksPage(props: { view: View }) {
  const findings = props.view.compare.findings;
  return (
    <div class="page">
      <header class="page-head"><div><div class="eyebrow">데이터 점검</div><h1>고칠 곳 {findings.length}개</h1>
        <p class="muted" style="margin-top: 6px">오류가 있으면 계산하지 않아요. 주의는 계산하되 표시만 해요.</p></div></header>
      <section class="card"><div class="card-body">
        {findings.length === 0 && <p class="muted">문제가 없어요.</p>}
        {findings.map(f => (
          <div class="finding">
            <span class={`pill ${f.level === 'ERROR' ? 'bad' : 'warn'}`}>{f.level === 'ERROR' ? '오류' : '주의'}</span>
            <div><div style="font-weight: 600">{f.title} <span class="faint code">{f.code}</span></div><div class="small muted">{f.key} · {f.detail}</div></div>
          </div>
        ))}
      </div></section>
    </div>
  );
}
