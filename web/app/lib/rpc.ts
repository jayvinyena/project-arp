// 화면 스레드 → 계산 스레드 요청. 응답은 Promise로 돌아온다.
import type { LaunchSnapshot, LaunchCompare, LaunchEdit, MaxScaleResult, HeadcountResult } from '../../../core/launch.ts';
import type { PlanMode } from '../../../engine/types.ts';
import type { NewProjectInput } from '../../../core/new-project.ts';
import type { ImportReport } from '../../../core/import-legacy.ts';
import type { HistoryBatch } from '../../../core/history.ts';
import type { Edit, EditResult } from '../../../core/edits.ts';
import type { PlanView, UpdateDetail, TypeView, CapacityView, ProgressView } from '../../../core/plan.ts';
import type { Finding } from '../../../core/pipeline.ts';
import type { ScenarioOp, ScenarioSummary, SimMeta, CompareView, Sensitivity, ApplyResult } from '../../../core/scenarios.ts';

export interface View { snapshot: LaunchSnapshot; compare: LaunchCompare; meta: Record<string, string | null> }

const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

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
  scenarios: () => call<{ scenarios: ScenarioSummary[]; meta: SimMeta }>('scenarios'),
  scenarioOp: (op: ScenarioOp) => call<{ changed: boolean; createdId?: string; groupNo?: number }>('scenarioOp', { op }),
  compare: (ids: string[], planMode: PlanMode) => call<CompareView>('compare', { ids, planMode }),
  sensitivity: (scenarioId: string | null, updateId: string, planMode: PlanMode) => call<Sensitivity & { ms: number }>('analyze', { scenarioId, updateId, planMode, what: 'sensitivity' }),
  maxScaleOf: (scenarioId: string | null, updateId: string, planMode: PlanMode) => call<MaxScaleResult & { ms: number }>('analyze', { scenarioId, updateId, planMode, what: 'maxScale' }),
  headcountOf: (scenarioId: string | null, updateId: string, planMode: PlanMode) => call<HeadcountResult & { ms: number }>('analyze', { scenarioId, updateId, planMode, what: 'headcount' }),
  applyScenario: (scenarioId: string, editor: string, force: boolean) => call<ApplyResult>('applyScenario', { scenarioId, editor, force }),
  history: () => call<{ batches: HistoryBatch[]; total: number }>('history'),
  undo: (batchId: string, editor: string, force: boolean) => call<{ reverted: number }>('undo', { batchId, editor, force }),
  exportXlsx: (planMode: PlanMode) => call<{ bytes: ArrayBuffer }>('exportXlsx', { planMode }),
  snapshot: () => call<{ bytes: ArrayBuffer }>('snapshot'),
  lock: (holder: string | null) => call<Record<string, string | null>>('lock', { holder }),
  export: () => call<{ bytes: ArrayBuffer; dataVersion: number }>('export'),
};
