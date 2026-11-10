// 화면 스레드 → 계산 스레드 요청. 응답은 Promise로 돌아온다.
import type { LaunchSnapshot, LaunchCompare, LaunchEdit, MaxScaleResult, HeadcountResult } from '../../../core/launch.ts';
import type { PlanMode } from '../../../engine/types.ts';
import type { NewProjectInput } from '../../../core/new-project.ts';
import type { ImportReport } from '../../../core/import-legacy.ts';
import type { HistoryBatch } from '../../../core/history.ts';
import type { CalibrationView, CalibrationPreview } from '../../../core/calibration.ts';
import type { ProgressImportReport } from '../../../core/progress-io.ts';
import type { Seen, Notice } from '../../../core/notice.ts';
import type { Edit, EditResult } from '../../../core/edits.ts';
import type { PlanView, UpdateDetail, TypeView, CapacityView, ProgressView, SetupView } from '../../../core/plan.ts';
import type { Finding } from '../../../core/pipeline.ts';
import type { ScenarioOp, ScenarioAction, ScenarioSummary, SimMeta, CompareView, Sensitivity, ApplyResult } from '../../../core/scenarios.ts';
import type { AdvisorOptions, AdvisorResult } from '../../../core/advisor.ts';
import type { AssetsView, AssetDetail } from '../../../core/assets.ts';
import type { AssetImportReport } from '../../../core/asset-io.ts';
import type { SheetScan, SheetPlan, SheetImportReport } from '../../../core/sheet-import.ts';
import type { DashboardView } from '../../../core/dashboard.ts';
import type { SetupStatus } from '../../../core/onboarding.ts';
import type { NewsItem, NewsSummary } from '../../../core/news.ts';

export interface View { snapshot: LaunchSnapshot; compare: LaunchCompare; meta: Record<string, string | null>; setup: SetupStatus; /** 소식 시각(최근 순) — 새 소식 수 */ newsTimes: string[] }

const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// 계산 스레드가 뜨지 못하거나 메시지를 못 읽으면 기다리는 요청을 모두 실패로 끝내고 알린다(멈춘 채로 두지 않는다)
const failAll = (message: string) => {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
  window.dispatchEvent(new CustomEvent('arp:error', { detail: message }));
};
worker.onerror = e => { e.preventDefault(); failAll(`계산 스레드를 시작하지 못했습니다(${e.message || '알 수 없는 오류'}). 페이지를 새로 고침하십시오.`); };
worker.onmessageerror = () => failAll('계산 스레드 응답을 읽지 못했습니다. 페이지를 새로 고침하십시오.');

/** 이 브라우저의 표시(편집 중 표시에 같이 남긴다: 같은 이름이라도 다른 PC면 읽기 전용으로 연다) */
export const DEVICE = (() => {
  try {
    let d = localStorage.getItem('arp.device');
    if (!d) { d = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; localStorage.setItem('arp.device', d); }
    return d;
  } catch { return 'unknown'; }
})();

worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
  const p = pending.get(ev.data.id);
  if (!p) return;
  pending.delete(ev.data.id);
  if (ev.data.ok) p.resolve(ev.data.result); else p.reject(new Error(ev.data.error));
};

function call<T>(type: string, payload?: unknown, transfer: Transferable[] = []): Promise<T> {
  const id = (seq += 1);
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker.postMessage({ id, type, payload }, transfer);
  });
}

export const rpc = {
  init: () => call<{ sqlite: string }>('init'),
  open: (bytes: ArrayBuffer) => call<View & { migration: { from: number; to: number; notes: string[] } | null }>('open', { bytes }, [bytes]),
  view: () => call<View>('view'),
  create: (input: NewProjectInput) => call<View>('create', { input }),
  importLegacy: (bytes: ArrayBuffer, projectName: string) => call<View & { report: ImportReport }>('importLegacy', { bytes, projectName }, [bytes]),
  edit: (edit: LaunchEdit, editor: string) => call<View & { changed: boolean }>('edit', { edit, editor }),
  maxScale: (planMode: PlanMode) => call<MaxScaleResult & { ms: number }>('maxScale', { planMode }),
  headcount: (planMode: PlanMode) => call<HeadcountResult & { ms: number }>('headcount', { planMode }),
  apply: (edit: Edit, editor: string) => call<EditResult>('apply', { edit, editor }),
  plan: (planMode: PlanMode) => call<PlanView>('plan', { planMode }),
  detail: (updateId: string, planMode: PlanMode) => call<{ detail: UpdateDetail | null; days: { blocked: boolean; byResource: Record<string, number>; total: number } | null; findings: Finding[] }>('detail', { updateId, planMode }),
  types: () => call<TypeView[]>('types'),
  capacity: () => call<CapacityView>('capacity'),
  progress: (updateId: string | null) => call<ProgressView>('progress', { updateId }),
  dashboard: (updateId: string | null, planMode: PlanMode) => call<DashboardView & { forecast: { completion: string | null; status: string } | null }>('dashboard', { updateId, planMode }),
  assets: (updateId: string | null) => call<AssetsView>('assets', { updateId }),
  news: (since: string | null) => call<{ items: NewsItem[]; summary: NewsSummary }>('news', { since }),
  assetDetail: (assetId: string) => call<AssetDetail>('assetDetail', { assetId }),
  thumbs: (assetIds: string[]) => call<{ items: { assetId: string; mime: string; data: Uint8Array; updatedAt: string }[] }>('thumbs', { assetIds }),
  assetBook: (updateId: string | null) => call<{ bytes: ArrayBuffer }>('assetBook', { updateId }),
  importAssets: (bytes: ArrayBuffer, editor: string) => call<AssetImportReport>('importAssets', { bytes, editor }, [bytes]),
  scanAssetFile: (bytes: ArrayBuffer) => call<{ kind: 'arp' } | { kind: 'sheet'; scan: SheetScan }>('scanAssetFile', { bytes }),
  importSheet: (bytes: ArrayBuffer, plan: SheetPlan, editor: string) => call<SheetImportReport>('importSheet', { bytes, plan, editor }),
  scenarios: () => call<{ scenarios: ScenarioSummary[]; meta: SimMeta }>('scenarios'),
  scenarioOp: (op: ScenarioOp) => call<{ changed: boolean; createdId?: string; groupNo?: number }>('scenarioOp', { op }),
  compare: (ids: string[], planMode: PlanMode) => call<CompareView>('compare', { ids, planMode }),
  sensitivity: (scenarioId: string | null, updateId: string, planMode: PlanMode) => call<Sensitivity & { ms: number }>('analyze', { scenarioId, updateId, planMode, what: 'sensitivity' }),
  maxScaleOf: (scenarioId: string | null, updateId: string, planMode: PlanMode) => call<MaxScaleResult & { ms: number }>('analyze', { scenarioId, updateId, planMode, what: 'maxScale' }),
  headcountOf: (scenarioId: string | null, updateId: string, planMode: PlanMode) => call<HeadcountResult & { ms: number }>('analyze', { scenarioId, updateId, planMode, what: 'headcount' }),
  setup: () => call<SetupView>('setup'),
  advise: (options: AdvisorOptions) => call<AdvisorResult>('advise', { options }),
  adviceScenario: (name: string, actions: ScenarioAction[]) => call<{ scenarioId: string }>('adviceScenario', { name, actions }),
  applyScenario: (scenarioId: string, editor: string, force: boolean) => call<ApplyResult>('applyScenario', { scenarioId, editor, force }),
  history: () => call<{ batches: HistoryBatch[]; total: number }>('history'),
  undo: (batchId: string, editor: string, force: boolean) => call<{ reverted: number }>('undo', { batchId, editor, force }),
  exportXlsx: (planMode: PlanMode) => call<{ bytes: ArrayBuffer }>('exportXlsx', { planMode }),
  snapshot: () => call<{ bytes: ArrayBuffer }>('snapshot'),
  progressTemplate: () => call<{ bytes: ArrayBuffer }>('progressTemplate'),
  exportTemplate: () => call<{ bytes: ArrayBuffer }>('exportTemplate'),
  importTemplate: (example: boolean) => call<{ bytes: ArrayBuffer }>('importTemplate', { example }),
  importProgress: (bytes: ArrayBuffer, editor: string) => call<ProgressImportReport>('importProgress', { bytes, editor }, [bytes]),
  calibration: () => call<CalibrationView>('calibration'),
  calibrationPreview: (picks: { resourceTypeId: string; partId: string; ratio: number }[]) => call<CalibrationPreview>('calibrationPreview', { picks }),
  calibrate: (picks: { resourceTypeId: string; partId: string; ratio: number }[], editor: string) => call<{ changed: number }>('calibrate', { picks, editor }),
  notice: (prev: Seen | null, me: string) => call<{ now: Seen['updates'] | null; notice: Notice | null }>('notice', { prev, me }),
  lock: (holder: string | null) => call<Record<string, string | null>>('lock', { holder, device: holder ? DEVICE : null }),
  export: () => call<{ bytes: ArrayBuffer; dataVersion: number }>('export'),
};
