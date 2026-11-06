// 4단계 시뮬레이션: 시나리오(원본 위 변경 묶음) 만들기·동작 더하기·비교·민감도·원본에 반영.
// 동작 하나 = 사람이 한 번 고른 것(예: "모델링 +2명, 1~5월") = scenario_changes 여러 줄(같은 group_no, label).
import type { SqlDb } from './db.ts';
import type { PlanMode, PlanResult, ProjectData, UpdateStatus } from '../engine/types.ts';
import { runPlan } from '../engine/index.ts';
import type { ProjectSession, Finding, EngineTable } from './pipeline.ts';
import { validate, keyWhere, tableColumns, isAdd, upsertRow } from './pipeline.ts';
import { readModeNames } from './modes.ts';

export type ScenarioAction =
  | { kind: 'headcount'; partId: string; fromMonth: string; toMonth: string; delta: number }
  | { kind: 'outsource'; partId: string; fromMonth: string; toMonth: string; days: number }
  | { kind: 'aiShare'; partId: string; share: number }
  | { kind: 'volumeScale'; updateId: string; scale: number }
  | { kind: 'volumeToMin'; updateId: string; onlyOptional: boolean }
  | { kind: 'updateDates'; updateId: string; startDate?: string | null; freezeDate?: string | null; releaseDate?: string | null }
  | { kind: 'priority'; updateId: string; priority: number }
  | { kind: 'exclude'; updateId: string }
  | { kind: 'overlap'; rate: number; fromPartId?: string; toPartId?: string }
  | { kind: 'addUpdate'; name: string; typeId: string; startDate: string; freezeDate: string | null; releaseDate: string | null };

export type ScenarioOp =
  | { kind: 'create'; name: string; copyFrom?: string }
  | { kind: 'rename'; scenarioId: string; name: string }
  | { kind: 'delete'; scenarioId: string }
  | { kind: 'addAction'; scenarioId: string; action: ScenarioAction }
  | { kind: 'removeAction'; scenarioId: string; groupNo: number };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 달력에 있는 날짜만(2027-09-31 같은 날은 거절) */
const realDate = (d: string) => DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const fail = (m: string): never => { throw new Error(m); };
const fmtN = (n: number) => (Math.round(n * 10) / 10).toString();

function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while ((y < ey || (y === ey && m <= em)) && out.length < 600) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function dataVersion(db: SqlDb): number {
  return Number(db.get("SELECT value FROM meta WHERE key = 'data_version'")?.value ?? 0);
}

function nextScenarioId(db: SqlDb): string {
  const max = db.all("SELECT scenario_id AS id FROM scenarios WHERE scenario_id LIKE 'S%'")
    .reduce((m, r) => Math.max(m, Number(String(r.id).slice(1)) || 0), 0);
  return `S${String(max + 1).padStart(2, '0')}`;
}

interface Change { op: 'SET' | 'INSERT' | 'DELETE'; target: EngineTable; target_key: string; field: string | null; value: unknown }

/** 동작 → 변경 줄과 사람이 읽는 이름. 지금 원본 값을 기준으로 계산한다(원본이 바뀌면 X02로 알린다) */
function expand(db: SqlDb, a: ScenarioAction): { label: string; changes: Change[] } {
  const partName = (id: string) => String(db.get('SELECT name FROM parts WHERE part_id = ?', [id])?.name ?? fail('없는 파트입니다.'));
  const updateName = (id: string) => String(db.get('SELECT name FROM updates WHERE update_id = ?', [id])?.name ?? fail('없는 업데이트입니다.'));
  const months = (from: string, to: string) => {
    if (!MONTH.test(from) || !MONTH.test(to) || to < from) fail('기간을 확인하십시오.');
    return monthsBetween(from, to);
  };
  const range = (from: string, to: string) => (from === to ? from : `${from}~${to}`);

  switch (a.kind) {
    case 'headcount':
    case 'outsource': {
      const name = partName(a.partId);
      const field = a.kind === 'headcount' ? 'headcount' : 'outsource_days';
      const add = a.kind === 'headcount' ? a.delta : a.days;
      if (!Number.isFinite(add) || add === 0) fail('0이 아닌 숫자를 입력하십시오.');
      const changes: Change[] = [];
      for (const m of months(a.fromMonth, a.toMonth)) {
        if (!db.get('SELECT 1 AS ok FROM capacity WHERE part_id = ? AND month = ?', [a.partId, m])) continue;
        // 절댓값이 아니라 더하기 값: 같은 칸에 동작을 여러 번 넣어도 더해지고, 중간 동작을 빼도 나머지가 맞다
        changes.push({ op: 'SET', target: 'capacity', target_key: `${a.partId}|${m}`, field, value: { add } });
      }
      if (!changes.length) fail('그 기간에 인력 행이 없습니다.');
      const sign = add > 0 ? '+' : '';
      return {
        label: a.kind === 'headcount' ? `${name} 인원 ${sign}${fmtN(add)}명 (${range(a.fromMonth, a.toMonth)})` : `${name} 외주 ${sign}${fmtN(add)}인·일/월 (${range(a.fromMonth, a.toMonth)})`,
        changes,
      };
    }
    case 'aiShare': {
      const name = partName(a.partId);
      if (!(a.share >= 0 && a.share <= 1)) fail('AI 비율은 0–100%입니다.');
      if (!db.get("SELECT 1 AS ok FROM effort_profiles WHERE profile_id = 'AI'")) fail('"AI 사용 시" 공수 프로필이 없습니다.');
      const changes: Change[] = [];
      for (const [profile, share] of [['BASE', 1 - a.share], ['AI', a.share]] as const) {
        // 넣기는 겹치면 덮어쓴다(같은 시나리오에 두 번 넣어도 된다)
        changes.push({ op: 'INSERT', target: 'effort_mix', target_key: `${a.partId}|${profile}`, field: null, value: { part_id: a.partId, profile_id: profile, share } });
      }
      // 그 밖의 프로필은 0으로: 합이 1이 되게(E06)
      for (const o of db.all("SELECT profile_id FROM effort_mix WHERE part_id = ? AND profile_id NOT IN ('BASE', 'AI')", [a.partId])) {
        changes.push({ op: 'SET', target: 'effort_mix', target_key: `${a.partId}|${o.profile_id}`, field: 'share', value: 0 });
      }
      return { label: `${name} AI 비율 ${Math.round(a.share * 100)}%`, changes };
    }
    case 'volumeScale': {
      const name = updateName(a.updateId);
      if (!(a.scale >= 0 && a.scale <= 10)) fail('배율은 0–1000%입니다.');
      const rows = db.all('SELECT * FROM volumes WHERE update_id = ?', [a.updateId]);
      const changes: Change[] = [];
      for (const v of rows) {
        for (const f of ['min_qty', 'target_qty', 'stretch_qty']) {
          if (v[f] == null) continue;
          changes.push({ op: 'SET', target: 'volumes', target_key: `${a.updateId}|${v.resource_type_id}`, field: f, value: Math.round(Number(v[f]) * a.scale) });
        }
      }
      if (!changes.length) fail('그 업데이트에 물량이 없습니다.');
      return { label: `${name} 물량 ×${Math.round(a.scale * 100)}%`, changes };
    }
    case 'volumeToMin': {
      // 목표·최대 물량을 최저 물량으로 맞춘다(최저가 없는 리소스는 그대로). onlyOptional이면 필수 리소스는 건드리지 않는다
      const name = updateName(a.updateId);
      const rows = db.all('SELECT * FROM volumes WHERE update_id = ? AND min_qty IS NOT NULL' + (a.onlyOptional ? ' AND required = 0' : ''), [a.updateId]);
      const changes: Change[] = [];
      for (const v of rows) {
        for (const f of ['target_qty', 'stretch_qty']) {
          changes.push({ op: 'SET', target: 'volumes', target_key: `${a.updateId}|${v.resource_type_id}`, field: f, value: Number(v.min_qty) });
        }
      }
      if (!changes.length) fail(a.onlyOptional ? '최소안 물량이 있는 선택 리소스가 없습니다.' : '최소안 물량이 있는 리소스가 없습니다.');
      return { label: `${name} ${a.onlyOptional ? '선택 리소스' : '모든 리소스'}를 ${readModeNames(db).MIN} 물량으로`, changes };
    }
    case 'updateDates': {
      const name = updateName(a.updateId);
      const changes: Change[] = [];
      const parts: string[] = [];
      for (const [f, v, label] of [['start_date', a.startDate, '시작'], ['freeze_date', a.freezeDate, '제작 완료 목표'], ['release_date', a.releaseDate, '출시']] as const) {
        if (v === undefined) continue;
        if (v != null && !realDate(v)) fail('날짜를 확인하십시오(YYYY-MM-DD, 달력에 있는 날).');
        changes.push({ op: 'SET', target: 'updates', target_key: a.updateId, field: f, value: v });
        parts.push(`${label} ${v ?? '없음'}`);
      }
      if (!changes.length) fail('바꿀 날짜를 선택하십시오.');
      return { label: `${name} ${parts.join(' · ')}`, changes };
    }
    case 'priority': {
      const name = updateName(a.updateId);
      if (!Number.isInteger(a.priority) || a.priority < 0) fail('우선순위는 0 이상의 정수입니다.');
      return { label: `${name} 우선순위 ${a.priority}`, changes: [{ op: 'SET', target: 'updates', target_key: a.updateId, field: 'priority', value: a.priority }] };
    }
    case 'exclude': {
      const name = updateName(a.updateId);
      return { label: `${name} 빼기`, changes: [{ op: 'SET', target: 'updates', target_key: a.updateId, field: 'status', value: 'CANCELLED' }] };
    }
    case 'overlap': {
      if (!(a.rate >= 0 && a.rate <= 1)) fail('겹침률은 0–100%입니다.');
      if (a.fromPartId && a.toPartId) {
        const key = `${a.fromPartId}|${a.toPartId}`;
        const exists = db.get('SELECT 1 AS ok FROM part_overlaps WHERE from_part_id = ? AND to_part_id = ?', [a.fromPartId, a.toPartId]);
        return {
          label: `겹침률 ${partName(a.fromPartId)} → ${partName(a.toPartId)} ${Math.round(a.rate * 100)}%`,
          changes: [exists
            ? { op: 'SET', target: 'part_overlaps', target_key: key, field: 'overlap_rate', value: a.rate }
            : { op: 'INSERT', target: 'part_overlaps', target_key: key, field: null, value: { from_part_id: a.fromPartId, to_part_id: a.toPartId, overlap_rate: a.rate } }],
        };
      }
      // 모든 파트 쌍: 기본값과 따로 정한 쌍 모두
      const pairs = db.all('SELECT from_part_id, to_part_id FROM part_overlaps');
      return {
        label: `겹침률 모두 ${Math.round(a.rate * 100)}%`,
        changes: [
          { op: 'SET', target: 'settings', target_key: 'settings', field: 'default_overlap_rate', value: a.rate },
          ...pairs.map(p => ({ op: 'SET' as const, target: 'part_overlaps' as const, target_key: `${p.from_part_id}|${p.to_part_id}`, field: 'overlap_rate', value: a.rate })),
        ],
      };
    }
    case 'addUpdate': {
      if (!a.name.trim()) fail('업데이트 이름을 입력하십시오.');
      for (const d of [a.startDate, a.freezeDate, a.releaseDate]) if (d != null && !realDate(d)) fail('날짜를 확인하십시오(YYYY-MM-DD, 달력에 있는 날).');
      if (!db.get('SELECT 1 AS ok FROM update_types WHERE update_type_id = ? AND is_launch = 0', [a.typeId])) fail('업데이트 유형을 선택하십시오.');
      const max = db.all("SELECT update_id AS id FROM updates WHERE update_id LIKE 'X%'").reduce((m, r) => Math.max(m, Number(String(r.id).slice(1)) || 0), 0);
      // 시나리오끼리 ID가 겹치지 않게 시나리오 변경 안의 가상 업데이트 ID도 본다
      const used = db.all("SELECT target_key FROM scenario_changes WHERE target = 'updates' AND op = 'INSERT'").reduce((m, r) => Math.max(m, Number(String(r.target_key).slice(1)) || 0), 0);
      const id = `X${String(Math.max(max, used) + 1).padStart(3, '0')}`;
      const priority = Number(db.get("SELECT coalesce(max(priority), 0) AS p FROM updates WHERE status IN ('PLANNED', 'IN_PROGRESS')")?.p ?? 0) + 1;
      const sortOrder = Number(db.get('SELECT coalesce(max(sort_order), 0) AS s FROM updates')?.s ?? 0) + 1;
      const changes: Change[] = [{
        op: 'INSERT', target: 'updates', target_key: id, field: null,
        value: { update_id: id, name: a.name.trim(), update_type_id: a.typeId, start_date: a.startDate, freeze_date: a.freezeDate, release_date: a.releaseDate, priority, status: 'PLANNED', sort_order: sortOrder },
      }];
      for (const t of db.all(`SELECT t.* FROM type_templates t JOIN resource_types r ON r.resource_type_id = t.resource_type_id
          WHERE t.update_type_id = ? AND r.active = 1`, [a.typeId])) {
        changes.push({ op: 'INSERT', target: 'volumes', target_key: `${id}|${t.resource_type_id}`, field: null, value: { update_id: id, resource_type_id: t.resource_type_id, min_qty: t.min_qty, target_qty: t.target_qty, stretch_qty: t.stretch_qty } });
      }
      return { label: `가상 업데이트 "${a.name.trim()}" 넣기`, changes };
    }
  }
}

/** 시나리오 고치기. 만들기·동작 더하기는 새 ID·묶음 번호를 돌려준다 */
export function applyScenarioOp(db: SqlDb, op: ScenarioOp): { changed: boolean; createdId?: string; groupNo?: number } {
  const now = new Date().toISOString();
  const touch = (id: string) => db.run('UPDATE scenarios SET updated_at = ? WHERE scenario_id = ?', [now, id]);
  const mustExist = (id: string) => { if (!db.get('SELECT 1 AS ok FROM scenarios WHERE scenario_id = ?', [id])) fail('없는 시나리오입니다.'); };
  switch (op.kind) {
    case 'create': {
      const name = op.name.trim();
      if (!name) fail('시나리오 이름을 입력하십시오.');
      const id = nextScenarioId(db);
      db.run('INSERT INTO scenarios (scenario_id, name, note, base_data_version, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)', [id, name, dataVersion(db), now, now]);
      if (op.copyFrom) {
        mustExist(op.copyFrom);
        db.run(`INSERT INTO scenario_changes (scenario_id, seq, op, target, target_key, field, value_json, group_no, label)
          SELECT ?, seq, op, target, target_key, field, value_json, group_no, label FROM scenario_changes WHERE scenario_id = ?`, [id, op.copyFrom]);
      }
      return { changed: true, createdId: id };
    }
    case 'rename': {
      mustExist(op.scenarioId);
      const name = op.name.trim();
      if (!name) fail('이름은 비울 수 없습니다.');
      db.run('UPDATE scenarios SET name = ?, updated_at = ? WHERE scenario_id = ?', [name, now, op.scenarioId]);
      return { changed: true };
    }
    case 'delete': {
      db.run('DELETE FROM scenarios WHERE scenario_id = ?', [op.scenarioId]);
      return { changed: true };
    }
    case 'addAction': {
      mustExist(op.scenarioId);
      const { label, changes } = expand(db, op.action);
      const seq0 = Number(db.get('SELECT coalesce(max(seq), 0) AS s FROM scenario_changes WHERE scenario_id = ?', [op.scenarioId])?.s ?? 0);
      const groupNo = Number(db.get('SELECT coalesce(max(group_no), 0) AS g FROM scenario_changes WHERE scenario_id = ?', [op.scenarioId])?.g ?? 0) + 1;
      changes.forEach((c, i) => {
        db.run(`INSERT INTO scenario_changes (scenario_id, seq, op, target, target_key, field, value_json, group_no, label)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [op.scenarioId, seq0 + i + 1, c.op, c.target, c.target_key, c.field, JSON.stringify(c.value), groupNo, label]);
      });
      touch(op.scenarioId);
      return { changed: true, groupNo };
    }
    case 'removeAction': {
      db.run('DELETE FROM scenario_changes WHERE scenario_id = ? AND group_no = ?', [op.scenarioId, op.groupNo]);
      touch(op.scenarioId);
      return { changed: true };
    }
  }
}

// ───────── 보기 ─────────

export interface ScenarioSummary {
  scenarioId: string;
  name: string;
  baseDataVersion: number;
  stale: boolean;
  appliedAt: string | null;
  actions: { groupNo: number; label: string; count: number }[];
}

/** 시나리오를 만든 뒤 계획 데이터를 고친 적이 있나(변경 이력 기준) */
function isStale(db: SqlDb, scenarioId: string): boolean {
  return !!db.get('SELECT 1 AS ok FROM change_log c JOIN scenarios s ON s.scenario_id = ? WHERE c.at > s.created_at LIMIT 1', [scenarioId]);
}

export function listScenarios(db: SqlDb): ScenarioSummary[] {
  return db.all('SELECT * FROM scenarios ORDER BY created_at, scenario_id').map(s => ({
    scenarioId: String(s.scenario_id),
    name: String(s.name),
    baseDataVersion: Number(s.base_data_version),
    stale: s.applied_at == null && isStale(db, String(s.scenario_id)),
    appliedAt: s.applied_at == null ? null : String(s.applied_at),
    actions: db.all(`SELECT group_no, coalesce(label, target || ' ' || target_key) AS label, count(*) AS n FROM scenario_changes
        WHERE scenario_id = ? GROUP BY group_no ORDER BY group_no`, [s.scenario_id])
      .map(a => ({ groupNo: Number(a.group_no), label: String(a.label), count: Number(a.n) })),
  }));
}

export interface CompareCell { completion: string | null; status: UpdateStatus | null; lateWorkdays: number | null; delta: number | null; excluded: boolean }
export interface CompareView {
  planMode: PlanMode;
  columns: { id: string; name: string; blocked: boolean; errors: Finding[]; ms: number }[];
  rows: { updateId: string; name: string; virtual: boolean; cells: CompareCell[] }[];
  parts: { partId: string; name: string; loads: (number | null)[] }[];
  ms: number;
}

const baseCache = new WeakMap<ProjectSession, { revision: number; planMode: PlanMode; result: PlanResult }>();

/** 원본(id = 'BASE')과 시나리오들을 같은 구간으로 계산해 나란히. 차이는 원본 대비 영업일(+ 늦어짐) */
export function compareScenarios(db: SqlDb, session: ProjectSession, scenarioIds: string[], planMode: PlanMode = 'TARGET'): CompareView {
  const t0 = performance.now();
  const ids = ['BASE', ...scenarioIds.filter(id => id !== 'BASE')];
  const names = new Map(db.all('SELECT scenario_id, name FROM scenarios').map(r => [String(r.scenario_id), String(r.name)]));
  let baseFindings: Finding[] | undefined;
  const runs = ids.map(id => {
    const t = performance.now();
    // 원본은 전부 검증하고, 시나리오는 건드린 표의 규칙만 다시 검증한다
    const p = session.prepare(id === 'BASE' ? undefined : id, { baseFindings });
    if (id === 'BASE') baseFindings = p.findings;
    let result: PlanResult | null = null;
    if (!p.blocked && p.data) {
      if (id === 'BASE') {
        // 원본이 그대로면(시나리오만 고친 경우) 지난 원본 계산을 다시 쓴다
        const hit = baseCache.get(session);
        result = hit && hit.revision === session.revision && hit.planMode === planMode ? hit.result : runPlan(p.data, { planMode });
        baseCache.set(session, { revision: session.revision, planMode, result });
      } else {
        result = runPlan(p.data, { planMode });
      }
    }
    return {
      id, name: id === 'BASE' ? '원본' : names.get(id) ?? id, blocked: p.blocked,
      errors: p.findings.filter(f => f.level === 'ERROR'), result, data: p.data, ms: performance.now() - t,
    };
  });
  const base = runs[0].result;
  const dayIndex = (r: PlanResult, d: string | null) => (d ? r.daily.dates.indexOf(d) : -1);
  // 줄: 원본의 계산 대상 업데이트, 그다음 시나리오에서만 계산 대상인 업데이트(가상 업데이트 등)
  const live = (u: { status: string }) => u.status === 'PLANNED' || u.status === 'IN_PROGRESS';
  const baseIds = new Set((runs[0].data?.updates ?? []).map(u => u.update_id));
  const order: { updateId: string; name: string; virtual: boolean }[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    for (const u of [...(run.data?.updates ?? [])].sort((x, y) => x.priority - y.priority || x.sort_order - y.sort_order)) {
      if (seen.has(u.update_id) || !live(u)) continue;
      seen.add(u.update_id);
      order.push({ updateId: u.update_id, name: u.name, virtual: !baseIds.has(u.update_id) });
    }
  }
  const rows = order.map(o => ({
    ...o,
    cells: runs.map(run => {
      const u = run.result?.updates.find(x => x.updateId === o.updateId) ?? null;
      const b = base?.updates.find(x => x.updateId === o.updateId) ?? null;
      let delta: number | null = null;
      if (u && b && run.result && base && u.expectedCompletionDate && b.expectedCompletionDate) {
        // 같은 달력이면 영업일 순번 차이. 계획 기간이 다르면 날짜 차이를 영업일로 셀 수 없어 null
        const ui = dayIndex(run.result, u.expectedCompletionDate);
        const bi = dayIndex(run.result, b.expectedCompletionDate);
        if (ui >= 0 && bi >= 0) delta = ui - bi;
      }
      return {
        completion: u?.expectedCompletionDate ?? null,
        status: u?.status ?? null,
        lateWorkdays: u?.lateWorkdays ?? null,
        delta,
        excluded: !u && !!run.result,
      };
    }),
  }));
  const partList = base?.parts ?? runs.find(r => r.result)?.result?.parts ?? [];
  const parts = partList.map(p => ({
    partId: p.partId,
    name: p.name,
    loads: runs.map(run => run.result?.parts.find(x => x.partId === p.partId)?.loadRate ?? null),
  }));
  return {
    planMode,
    columns: runs.map(r => ({ id: r.id, name: r.name, blocked: r.blocked, errors: r.errors, ms: r.ms })),
    rows,
    parts,
    ms: performance.now() - t0,
  };
}

// ───────── 민감도 ─────────

export interface Sensitivity {
  updateId: string;
  months: { from: string; to: string } | null;
  baseCompletion: string | null;
  /** 파트마다 런칭 기간 동안 +1명일 때 완료 예정 변화(영업일, 음수 = 당겨짐). null = 판단할 수 없음 */
  parts: { partId: string; name: string; deltaWorkdays: number | null; completion: string | null }[];
}

/** "이 파트 1명 더하면 며칠 당겨지나": 업데이트의 시작 달 ~ 제작 완료 목표(없으면 출시) 달 동안 +1명 */
export function sensitivity(data: ProjectData, updateId: string, planMode: PlanMode = 'TARGET', delta = 1): Sensitivity {
  const u = data.updates.find(x => x.update_id === updateId);
  const parts = data.parts.filter(p => p.active === 1).sort((a, b) => a.sort_order - b.sort_order);
  const base = runPlan(data, { planMode });
  const bu = base.updates.find(x => x.updateId === updateId);
  const end = u?.freeze_date ?? u?.release_date ?? null;
  if (!u || !u.start_date || !bu) return { updateId, months: null, baseCompletion: null, parts: parts.map(p => ({ partId: p.part_id, name: p.name, deltaWorkdays: null, completion: null })) };
  const from = u.start_date.slice(0, 7) < data.settings.horizon_start_month ? data.settings.horizon_start_month : u.start_date.slice(0, 7);
  const toRaw = (end ?? `${data.settings.horizon_end_month}-28`).slice(0, 7);
  const to = toRaw > data.settings.horizon_end_month ? data.settings.horizon_end_month : toRaw;
  const idx = (r: PlanResult, d: string | null) => (d ? r.daily.dates.indexOf(d) : -1);
  return {
    updateId,
    months: { from, to },
    baseCompletion: bu.expectedCompletionDate,
    parts: parts.map(p => {
      const r = runPlan({ ...data, capacity: data.capacity.map(c => (c.part_id === p.part_id && c.month >= from && c.month <= to ? { ...c, headcount: c.headcount + delta } : c)) }, { planMode });
      const x = r.updates.find(y => y.updateId === updateId);
      const a = idx(base, bu.expectedCompletionDate);
      const b = idx(r, x?.expectedCompletionDate ?? null);
      return { partId: p.part_id, name: p.name, deltaWorkdays: a >= 0 && b >= 0 ? b - a : null, completion: x?.expectedCompletionDate ?? null };
    }),
  };
}

// ───────── 원본에 반영 ─────────

export interface ApplyResult { applied: number; skipped: number; findings: Finding[] }

/**
 * 시나리오 변경을 원본에 옮긴다. 한 트랜잭션: 쓰기 → 변경 이력(이유 = 시나리오 이름) → 검증.
 * 검증 오류가 생기면 되돌리고 이유를 알린다. 원본이 시나리오를 만든 뒤 바뀌었으면 force 없이는 거절한다.
 */
export function applyScenarioToBase(db: SqlDb, session: ProjectSession, scenarioId: string, ctx: { editor: string; batchId: string }, force = false): ApplyResult {
  const s = db.get('SELECT * FROM scenarios WHERE scenario_id = ?', [scenarioId]);
  if (!s) fail('없는 시나리오입니다.');
  if (s!.applied_at) fail('이미 원본에 반영한 시나리오입니다.');
  if (!force && isStale(db, scenarioId)) fail('시나리오를 만든 뒤 원본이 변경되었습니다. 결과를 다시 확인하고 그래도 반영하려면 "그래도 반영"을 누르십시오.');
  const changes = db.all('SELECT * FROM scenario_changes WHERE scenario_id = ? ORDER BY seq', [scenarioId]);
  const reason = `시나리오 반영: ${s!.name}`;
  const log = (action: string, target: string, key: string, field: string | null, oldV: unknown, newV: unknown) =>
    db.run(`INSERT INTO change_log (batch_id, at, editor, action, target, target_key, field, old_json, new_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ctx.batchId, new Date().toISOString(), ctx.editor, action, target, key, field, oldV === undefined ? null : JSON.stringify(oldV), newV === undefined ? null : JSON.stringify(newV), reason]);
  let applied = 0;
  let skipped = 0;
  const touched = new Set<EngineTable>();
  db.exec('SAVEPOINT apply_scenario');
  try {
    for (const c of changes) {
      const target = String(c.target);
      const where = keyWhere(target, String(c.target_key));
      if (!where) { skipped += 1; continue; }
      const columns = tableColumns(db, target);
      if (c.op === 'SET') {
        const field = String(c.field);
        if (!columns.has(field)) { skipped += 1; continue; }
        const before = db.get(`SELECT ${field} AS v FROM ${target} WHERE ${where.sql}`, where.params);
        if (!before) { skipped += 1; continue; }
        const raw = JSON.parse(String(c.value_json)) as unknown;
        const value = isAdd(raw) ? Math.max(0, Number(before.v ?? 0) + raw.add) : raw;
        db.run(`UPDATE ${target} SET ${field} = ? WHERE ${where.sql}`, [value, ...where.params]);
        log('UPDATE', target, String(c.target_key), field, before.v, value);
      } else if (c.op === 'INSERT') {
        const row = JSON.parse(String(c.value_json)) as Record<string, unknown>;
        const old = db.get(`SELECT * FROM ${target} WHERE ${where.sql}`, where.params);
        if (old) {
          // 이미 있는 행(예: 원본에 반영한 시나리오를 복제한 경우의 가상 업데이트): 다른 칸만 바꾼다
          for (const [k, v] of Object.entries(row)) {
            if (!columns.has(k) || old[k] === v) continue;
            db.run(`UPDATE ${target} SET ${k} = ? WHERE ${where.sql}`, [v, ...where.params]);
            log('UPDATE', target, String(c.target_key), k, old[k], v);
          }
        } else {
          upsertRow(db, target, row, columns);
          log('INSERT', target, String(c.target_key), null, undefined, row);
        }
      } else {
        const old = db.get(`SELECT * FROM ${target} WHERE ${where.sql}`, where.params);
        if (!old) { skipped += 1; continue; }
        db.run(`DELETE FROM ${target} WHERE ${where.sql}`, where.params);
        log('DELETE', target, String(c.target_key), null, old, undefined);
      }
      touched.add(target as EngineTable);
      applied += 1;
    }
    const findings = validate(db);
    if (findings.some(f => f.level === 'ERROR')) {
      db.exec('ROLLBACK TO apply_scenario');
      db.exec('RELEASE apply_scenario');
      const e = new Error(`반영하면 계산할 수 없는 상태가 되어 되돌렸습니다: ${findings.filter(f => f.level === 'ERROR').map(f => `${f.title}(${f.key})`).slice(0, 3).join(', ')}`);
      throw e;
    }
    db.run('UPDATE scenarios SET applied_at = ? WHERE scenario_id = ?', [new Date().toISOString(), scenarioId]);
    db.exec('RELEASE apply_scenario');
    session.markDirty(...touched);
    return { applied, skipped, findings };
  } catch (error) {
    // 위에서 이미 되돌린 경우를 빼고 되돌린다
    try { db.exec('ROLLBACK TO apply_scenario'); db.exec('RELEASE apply_scenario'); } catch { /* 이미 끝남 */ }
    throw error;
  }
}

// ───────── 화면용 목록 ─────────

export interface SimMeta {
  parts: { partId: string; name: string }[];
  updates: { updateId: string; name: string; live: boolean; startDate: string | null; freezeDate: string | null; releaseDate: string | null; priority: number }[];
  months: string[];
  types: { typeId: string; name: string }[];
  hasAI: boolean;
}

export function simMeta(db: SqlDb): SimMeta {
  const s = db.get('SELECT horizon_start_month AS a, horizon_end_month AS b FROM settings WHERE id = 1') ?? {};
  return {
    parts: db.all('SELECT part_id, name FROM parts WHERE active = 1 ORDER BY sort_order').map(p => ({ partId: String(p.part_id), name: String(p.name) })),
    updates: db.all("SELECT * FROM updates ORDER BY CASE WHEN status IN ('PLANNED', 'IN_PROGRESS') THEN 0 ELSE 1 END, priority, sort_order").map(u => ({
      updateId: String(u.update_id), name: String(u.name), live: u.status === 'PLANNED' || u.status === 'IN_PROGRESS',
      startDate: u.start_date == null ? null : String(u.start_date), freezeDate: u.freeze_date == null ? null : String(u.freeze_date),
      releaseDate: u.release_date == null ? null : String(u.release_date), priority: Number(u.priority),
    })),
    months: s.a && s.b ? monthsBetween(String(s.a), String(s.b)) : [],
    types: db.all('SELECT update_type_id, name FROM update_types WHERE is_launch = 0 AND active = 1 ORDER BY sort_order').map(t => ({ typeId: String(t.update_type_id), name: String(t.name) })),
    hasAI: !!db.get("SELECT 1 AS ok FROM effort_profiles WHERE profile_id = 'AI'"),
  };
}
