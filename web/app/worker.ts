// 계산 스레드: SQLite(WebAssembly) + 계산 흐름 + 런칭 로직이 모두 여기서 돈다. 화면 스레드는 메시지만 주고받는다.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { ProjectSession } from '../../core/pipeline.ts';
import {
  launchSnapshot, compareLaunchModes, applyLaunchEdit, maxLaunchScale, headcountForLaunch, findLaunchId,
} from '../../core/launch.ts';
import type { LaunchEdit } from '../../core/launch.ts';
import type { PlanMode } from '../../engine/types.ts';
import { openFromBytes, exportBytes, wrap } from '../lib/wasm-db.ts';
import type { Sqlite3, WasmDb } from '../lib/wasm-db.ts';
import type { SqlDb } from '../../core/db.ts';
import { writeNewProject } from '../../core/new-project.ts';
import type { NewProjectInput } from '../../core/new-project.ts';
import schemaSql from '../../schema/schema-v1.sql?raw';
import { readXlsx } from '../../core/xlsx.ts';
import { legacyToRows, writeImported } from '../../core/import-legacy.ts';
import { historyView, undoBatch } from '../../core/history.ts';
import { exportSheets } from '../../core/export.ts';
import { writeXlsx } from '../../core/xlsx-write.ts';
import { calibrationView, calibrationPreview } from '../../core/calibration.ts';
import { progressTemplate, importProgress } from '../../core/progress-io.ts';
import { outlookNow, noticeSince } from '../../core/notice.ts';
import type { Seen } from '../../core/notice.ts';
import { applyEdit } from '../../core/edits.ts';
import type { Edit } from '../../core/edits.ts';
import { planView, typesView, capacityView, updateDetail, updateDays, progressView } from '../../core/plan.ts';
import { applyScenarioOp, listScenarios, compareScenarios, sensitivity, applyScenarioToBase, simMeta } from '../../core/scenarios.ts';
import type { ScenarioOp, ScenarioAction } from '../../core/scenarios.ts';
import { adviseDeadlines, adviceToScenario } from '../../core/advisor.ts';
import type { AdvisorOptions } from '../../core/advisor.ts';

export const APP_VERSION = 'arp-next 0.2.0';

let sqlite3: Sqlite3 | null = null;
let db: WasmDb | null = null;
let sql: SqlDb | null = null;
let session: ProjectSession | null = null;
let batchId = newBatchId();

function newBatchId(): string {
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function need() {
  if (!sql || !session || !db) throw new Error('열린 파일이 없습니다');
  return { sql, session, db };
}

function meta(s: SqlDb): Record<string, string | null> {
  return Object.fromEntries(s.all('SELECT key, value FROM meta').map(r => [String(r.key), r.value == null ? null : String(r.value)]));
}

function setMeta(s: SqlDb, key: string, value: string | null) {
  s.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

function view() {
  const { sql: s, session: ss } = need();
  return { snapshot: launchSnapshot(s), compare: compareLaunchModes(s, ss), meta: meta(s) };
}

const handlers: Record<string, (payload: any) => unknown> = {
  async init() {
    if (!sqlite3) sqlite3 = (await sqlite3InitModule()) as unknown as Sqlite3;
    return { sqlite: sqlite3.version.libVersion };
  },

  async open(p: { bytes: ArrayBuffer }) {
    if (!sqlite3) await handlers.init({});
    if (db) db.close();
    const opened = openFromBytes(sqlite3!, new Uint8Array(p.bytes));
    db = opened;
    sql = wrap(db);
    session = new ProjectSession(sql);
    batchId = newBatchId();
    return { ...view(), migration: opened.migration ?? null };
  },

  /** 새 프로젝트: 메모리에 새 DB를 만든다(저장은 화면 쪽이 export 후 다른 이름으로) */
  async create(p: { input: NewProjectInput }) {
    if (!sqlite3) await handlers.init({});
    const next = new sqlite3!.oo1.DB();
    try {
      writeNewProject(wrap(next), schemaSql, { ...p.input, appVersion: APP_VERSION, createdAt: new Date().toISOString() });
    } catch (error) {
      next.close();
      throw error;
    }
    if (db) db.close();
    db = next;
    sql = wrap(db);
    session = new ProjectSession(sql);
    batchId = newBatchId();
    return view();
  },

  /** 옛 도구 시트(.xlsx) → 메모리에 새 프로젝트 */
  async importLegacy(p: { bytes: ArrayBuffer; projectName: string }) {
    if (!sqlite3) await handlers.init({});
    const sheets = await readXlsx(new Uint8Array(p.bytes));
    const { rows, report } = legacyToRows(sheets, { projectName: p.projectName, appVersion: APP_VERSION });
    const next = new sqlite3!.oo1.DB();
    try {
      writeImported(wrap(next), schemaSql, rows);
    } catch (error) {
      next.close();
      throw error;
    }
    if (db) db.close();
    db = next;
    sql = wrap(db);
    session = new ProjectSession(sql);
    batchId = newBatchId();
    return { ...view(), report };
  },

  view() {
    return view();
  },

  edit(p: { edit: LaunchEdit; editor: string }) {
    const { sql: s, session: ss } = need();
    const changed = applyLaunchEdit(s, ss, p.edit, { editor: p.editor || '이름 없음', batchId: newBatchId() });
    return { changed, ...view() };
  },

  /** 업데이트·유형·인력 고치기 (3단계) */
  apply(p: { edit: Edit; editor: string }) {
    const { sql: s, session: ss } = need();
    return applyEdit(s, ss, p.edit, { editor: p.editor || '이름 없음', batchId: newBatchId() });
  },

  plan(p: { planMode: PlanMode }) {
    const { sql: s, session: ss } = need();
    return planView(s, ss, p.planMode);
  },

  detail(p: { updateId: string; planMode: PlanMode }) {
    const { sql: s, session: ss } = need();
    const detail = updateDetail(s, p.updateId);
    return { detail, days: detail ? updateDays(s, ss, p.updateId, p.planMode) : null, findings: ss.prepare().findings };
  },

  types() {
    return typesView(need().sql);
  },

  capacity() {
    return capacityView(need().sql);
  },

  progress(p: { updateId: string | null }) {
    return progressView(need().sql, p.updateId);
  },

  // ───────── 이력 · 되돌리기 · 내보내기 · 복구 사본 ─────────
  history() {
    return historyView(need().sql, 300);
  },

  undo(p: { batchId: string; editor: string; force: boolean }) {
    const { sql: s, session: ss } = need();
    return undoBatch(s, ss, p.batchId, { editor: p.editor || '이름 없음', batchId: newBatchId() }, p.force);
  },

  exportXlsx(p: { planMode: PlanMode }) {
    const { sql: s, session: ss } = need();
    const bytes = writeXlsx(exportSheets(s, ss, p.planMode));
    return { bytes: bytes.buffer };
  },

  /** 작업 복구용 사본: 데이터 버전·저장 기록을 건드리지 않는다 */
  snapshot() {
    const { db: d } = need();
    return { bytes: exportBytes(sqlite3!, d).buffer };
  },

  // ───────── 6단계: 실적 엑셀 · 공수 보정 · 변화 알림 ─────────
  progressTemplate() {
    return { bytes: writeXlsx(progressTemplate(need().sql)).buffer };
  },

  async importProgress(p: { bytes: ArrayBuffer; editor: string }) {
    const { sql: s, session: ss } = need();
    const sheets = await readXlsx(new Uint8Array(p.bytes));
    return importProgress(s, ss, sheets, { editor: p.editor || '이름 없음', batchId: newBatchId() }, new Date().toISOString().slice(0, 10));
  },

  calibration() {
    return calibrationView(need().sql);
  },

  calibrationPreview(p: { picks: { resourceTypeId: string; partId: string; ratio: number }[] }) {
    return calibrationPreview(need().session.currentData(), p.picks);
  },

  /** 고른 보정을 한 묶음으로 적용 */
  calibrate(p: { picks: { resourceTypeId: string; partId: string; ratio: number }[]; editor: string }) {
    const { sql: s, session: ss } = need();
    const ctx = { editor: p.editor || '이름 없음', batchId: newBatchId() };
    let changed = 0;
    // 고른 보정은 한꺼번에: 하나라도 실패하면 모두 되돌린다
    s.exec('SAVEPOINT calibrate');
    try {
      for (const pick of p.picks) if (applyEdit(s, ss, { kind: 'effortScale', ...pick }, ctx).changed) changed += 1;
      s.exec('RELEASE calibrate');
    } catch (error) {
      s.exec('ROLLBACK TO calibrate');
      s.exec('RELEASE calibrate');
      ss.markDirty('efforts');
      throw error;
    }
    return { changed };
  },

  /** 지난번 본 전망과 지금을 비교(prev가 없으면 지금 전망만) */
  notice(p: { prev: Seen | null; me: string }) {
    const { sql: s, session: ss } = need();
    const now = outlookNow(s, ss);
    return { now, notice: now && p.prev ? noticeSince(s, p.prev, now, p.me) : null };
  },

  // ───────── 시뮬레이션 ─────────
  scenarios() {
    const s = need().sql;
    return { scenarios: listScenarios(s), meta: simMeta(s) };
  },

  scenarioOp(p: { op: ScenarioOp }) {
    return applyScenarioOp(need().sql, p.op);
  },

  compare(p: { ids: string[]; planMode: PlanMode }) {
    const { sql: s, session: ss } = need();
    return compareScenarios(s, ss, p.ids, p.planMode);
  },

  /** 시나리오(또는 원본) 위에서 업데이트 하나의 민감도·최대 물량·필요 인원 */
  analyze(p: { scenarioId: string | null; updateId: string; planMode: PlanMode; what: 'sensitivity' | 'maxScale' | 'headcount' }) {
    const { session: ss } = need();
    const prepared = ss.prepare(p.scenarioId ?? undefined);
    if (prepared.blocked || !prepared.data) throw new Error('계산할 수 없는 상태예요. 데이터 점검을 먼저 봐 주세요.');
    const t = performance.now();
    const result = p.what === 'sensitivity' ? sensitivity(prepared.data, p.updateId, p.planMode)
      : p.what === 'maxScale' ? maxLaunchScale(prepared.data, p.updateId, p.planMode)
        : headcountForLaunch(prepared.data, p.updateId, p.planMode);
    return { ...result, ms: performance.now() - t };
  },

  /** 마감 맞춤 제안(원본 기준) */
  advise(p: { options: AdvisorOptions }) {
    const prepared = need().session.prepare();
    if (prepared.blocked || !prepared.data) throw new Error('계산할 수 없는 상태예요. 데이터 점검을 먼저 봐 주세요.');
    return adviseDeadlines(prepared.data, p.options);
  },

  adviceScenario(p: { name: string; actions: ScenarioAction[] }) {
    return { scenarioId: adviceToScenario(need().sql, p.name, p.actions) };
  },

  applyScenario(p: { scenarioId: string; editor: string; force: boolean }) {
    const { sql: s, session: ss } = need();
    return applyScenarioToBase(s, ss, p.scenarioId, { editor: p.editor || '이름 없음', batchId: newBatchId() }, p.force);
  },

  maxScale(p: { planMode: PlanMode }) {
    const { sql: s, session: ss } = need();
    const launchId = findLaunchId(s);
    if (!launchId) throw new Error('런칭 업데이트가 없습니다');
    const t = performance.now();
    return { ...maxLaunchScale(ss.currentData(), launchId, p.planMode), ms: performance.now() - t };
  },

  headcount(p: { planMode: PlanMode }) {
    const { sql: s, session: ss } = need();
    const launchId = findLaunchId(s);
    if (!launchId) throw new Error('런칭 업데이트가 없습니다');
    const t = performance.now();
    return { ...headcountForLaunch(ss.currentData(), launchId, p.planMode), ms: performance.now() - t };
  },

  /** 편집 중 표시 쓰기·지우기 (저장은 화면 쪽이 export 후 한다) */
  lock(p: { holder: string | null; device?: string | null }) {
    const { sql: s } = need();
    setMeta(s, 'lock_holder', p.holder);
    setMeta(s, 'lock_device', p.device ?? null);
    setMeta(s, 'lock_heartbeat_at', p.holder ? new Date().toISOString() : null);
    return meta(s);
  },

  /** 저장할 바이트. 데이터 버전을 올리고 다음 변경 이력 묶음을 연다 */
  export() {
    const { sql: s, db: d } = need();
    const m = meta(s);
    setMeta(s, 'data_version', String(Number(m.data_version ?? 0) + 1));
    setMeta(s, 'saved_by_app', APP_VERSION);
    setMeta(s, 'saved_at', new Date().toISOString());
    batchId = newBatchId();
    const bytes = exportBytes(sqlite3!, d);
    return { bytes: bytes.buffer, dataVersion: Number(m.data_version ?? 0) + 1 };
  },
};

self.onmessage = async (ev: MessageEvent<{ id: number; type: string; payload: unknown }>) => {
  const { id, type, payload } = ev.data;
  try {
    const handler = handlers[type];
    if (!handler) throw new Error(`알 수 없는 요청: ${type}`);
    const result = await handler(payload ?? {});
    const transfer = result && typeof result === 'object' && 'bytes' in result ? [(result as { bytes: ArrayBuffer }).bytes] : [];
    (self as unknown as Worker).postMessage({ id, ok: true, result }, transfer);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (error as Error).message ?? String(error) });
  }
};
