// 계산 흐름: (시나리오 얹기) → 검증 → 데이터 읽기 → 엔진. Node 도구와 브라우저 앱이 같이 쓴다.
import type { SqlDb } from './db.ts';
import type { ProjectData, PlanMode, PlanResult } from '../engine/types.ts';
import { runPlan } from '../engine/index.ts';
import { PRELUDE, RULES, RULE_TABLES } from '../rules/validation-rules.mjs';

export interface Finding { code: string; level: 'ERROR' | 'WARN'; title: string; key: string; detail: string }

/** 모든 규칙(only를 주면 그 표들을 읽는 규칙만)을 돌려 문제 목록을 돌려준다 */
export function validate(db: SqlDb, only?: Set<string>): Finding[] {
  db.exec(PRELUDE);
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (only && !(RULE_TABLES as Record<string, string[]>)[rule.code]?.some(t => only.has(t))) continue;
    let rows: Record<string, unknown>[];
    try {
      rows = db.all(rule.sql);
    } catch (error) {
      throw new Error(`규칙 ${rule.code} SQL 오류: ${(error as Error).message}`);
    }
    for (const r of rows) findings.push({ code: rule.code, level: rule.level, title: rule.title, key: String(r.key), detail: String(r.detail) });
  }
  return findings;
}

const ENGINE_TABLES = [
  'holidays', 'parts', 'part_overlaps', 'resource_types', 'resource_parts', 'efforts', 'effort_mix',
  'update_types', 'updates', 'volumes', 'progress', 'capacity',
] as const;

export type EngineTable = 'settings' | typeof ENGINE_TABLES[number];
export const ALL_ENGINE_TABLES: EngineTable[] = ['settings', ...ENGINE_TABLES];

function readTable(db: SqlDb, table: EngineTable): unknown {
  return table === 'settings' ? db.get('SELECT * FROM settings WHERE id = 1') : db.all(`SELECT * FROM ${table}`);
}

/** 계산에 쓰는 표를 읽어 엔진 입력 모양으로 */
export function readProjectData(db: SqlDb): ProjectData {
  const data: Record<string, unknown> = {};
  for (const table of ALL_ENGINE_TABLES) data[table] = readTable(db, table);
  return data as unknown as ProjectData;
}

// 시나리오 대상 표의 기본 키 칸. target_key는 이 칸 값들을 '|'로 이은 것(settings는 'settings')
export const KEY_COLUMNS: Record<string, string[]> = {
  settings: [],
  part_overlaps: ['from_part_id', 'to_part_id'],
  resource_parts: ['resource_type_id', 'part_id'],
  efforts: ['resource_type_id', 'part_id', 'profile_id'],
  effort_mix: ['part_id', 'profile_id'],
  updates: ['update_id'],
  volumes: ['update_id', 'resource_type_id'],
  capacity: ['part_id', 'month'],
};

/** 기본 키로 찾는 WHERE 절과 값(색인을 쓴다). 키 모양이 맞지 않으면 null */
export function keyWhere(target: string, targetKey: string): { sql: string; params: unknown[] } | null {
  const cols = KEY_COLUMNS[target];
  if (!cols) return null;
  if (cols.length === 0) return { sql: 'id = 1', params: [] };
  const parts = targetKey.split('|');
  if (parts.length !== cols.length) return null;
  return { sql: cols.map(c => `${c} = ?`).join(' AND '), params: parts };
}

const columnCache = new WeakMap<SqlDb, Map<string, Set<string>>>();
export function tableColumns(db: SqlDb, table: string): Set<string> {
  let m = columnCache.get(db);
  if (!m) { m = new Map(); columnCache.set(db, m); }
  let cols = m.get(table);
  if (!cols) { cols = new Set(db.all(`PRAGMA table_info(${table})`).map(col => String(col.name))); m.set(table, cols); }
  return cols;
}

export interface SkippedChange { seq: number; target: string; target_key: string; why: string }

/**
 * 시나리오 변경을 원본에 잠시 얹고 fn을 부른 뒤 되돌린다(SAVEPOINT). 원본은 바뀌지 않는다.
 */
export function withScenario<T>(db: SqlDb, scenarioId: string | undefined, fn: () => T): { value: T; skipped: SkippedChange[] } {
  if (!scenarioId) return { value: fn(), skipped: [] };
  if (!db.get('SELECT 1 AS ok FROM scenarios WHERE scenario_id = ?', [scenarioId])) throw new Error(`시나리오 없음: ${scenarioId}`);
  const changes = db.all('SELECT * FROM scenario_changes WHERE scenario_id = ? ORDER BY seq', [scenarioId]) as unknown as {
    seq: number; op: string; target: string; target_key: string; field: string | null; value_json: string | null;
  }[];
  const skipped: SkippedChange[] = [];
  const skip = (c: typeof changes[number], why: string) => skipped.push({ seq: c.seq, target: c.target, target_key: c.target_key, why });
  db.exec('SAVEPOINT scenario');
  try {
    for (const c of changes) {
      const where = keyWhere(c.target, c.target_key);
      if (!where) { skip(c, '대상 표·키가 아님'); continue; }
      const columns = tableColumns(db, c.target);
      if (c.op === 'SET') {
        if (!c.field || !columns.has(c.field)) { skip(c, '없는 항목'); continue; }
        if (db.run(`UPDATE ${c.target} SET ${c.field} = ? WHERE ${where.sql}`, [JSON.parse(c.value_json ?? 'null'), ...where.params]) === 0) skip(c, '대상 행 없음');
      } else if (c.op === 'DELETE') {
        if (db.run(`DELETE FROM ${c.target} WHERE ${where.sql}`, where.params) === 0) skip(c, '대상 행 없음');
      } else if (c.op === 'INSERT') {
        const row = JSON.parse(c.value_json ?? '{}') as Record<string, unknown>;
        const cols = Object.keys(row).filter(k => columns.has(k));
        db.run(`INSERT INTO ${c.target} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(k => row[k]));
      }
    }
    return { value: fn(), skipped };
  } finally {
    db.exec('ROLLBACK TO scenario');
    db.exec('RELEASE scenario');
  }
}

export interface CalculateOutput {
  blocked: boolean;
  findings: Finding[];
  skipped: SkippedChange[];
  result: PlanResult | null;
  timings: { validateMs: number; readMs: number; engineMs: number; totalMs: number };
}

/** 한 번의 계산. 오류가 있으면 엔진을 돌리지 않고 blocked = true */
export function calculate(db: SqlDb, options: { planMode?: PlanMode; scenarioId?: string } = {}): CalculateOutput {
  const t0 = performance.now();
  const { value, skipped } = withScenario(db, options.scenarioId, () => {
    const findings = validate(db);
    const t1 = performance.now();
    const blocked = findings.some(f => f.level === 'ERROR');
    const data = blocked ? null : readProjectData(db);
    const t2 = performance.now();
    return { findings, blocked, data, validateMs: t1 - t0, readMs: t2 - t1 };
  });
  const result = value.blocked || !value.data ? null : runPlan(value.data, { planMode: options.planMode });
  return {
    blocked: value.blocked,
    findings: value.findings,
    skipped,
    result,
    timings: {
      validateMs: value.validateMs,
      readMs: value.readMs,
      engineMs: result?.meta.elapsedMs ?? 0,
      totalMs: performance.now() - t0,
    },
  };
}

/**
 * 작업 세션: 파일 하나를 열어 두고 고치며 계속 계산할 때 쓴다(앱).
 * 엔진 입력을 메모리에 두고, 고친 표만 다시 읽는다. 브라우저에서 표 전체를 객체로 바꾸는 비용이 가장 크기 때문이다.
 * 시나리오는 그 시나리오가 건드리는 표만 SAVEPOINT 안에서 읽어 덮어 쓴다(원본 캐시는 그대로).
 */
export class ProjectSession {
  private readonly db: SqlDb;
  private readonly cache: Partial<Record<EngineTable, unknown>> = {};
  private readonly dirty = new Set<EngineTable>(ALL_ENGINE_TABLES);

  constructor(db: SqlDb) {
    this.db = db;
  }

  /** 원본 계산 데이터가 바뀐 횟수. 같은 값이면 원본 계산 결과를 다시 써도 된다 */
  revision = 0;

  /** 엔진이 쓰는 표를 직접 고친 뒤 알린다 */
  markDirty(...tables: EngineTable[]): void {
    for (const t of tables) this.dirty.add(t);
    if (tables.length) this.revision += 1;
  }

  /** 고치기 + 알리기 */
  edit(sql: string, params: unknown[], tables: EngineTable[]): number {
    const changed = this.db.run(sql, params);
    this.markDirty(...tables);
    return changed;
  }

  private baseData(): ProjectData {
    for (const t of this.dirty) this.cache[t] = readTable(this.db, t);
    this.dirty.clear();
    return { ...this.cache } as unknown as ProjectData;
  }

  /** 지금 원본 데이터(고친 표만 다시 읽음). 역산처럼 메모리에서 여러 번 돌릴 때 쓴다. 고치지 말고 복사해서 쓴다 */
  currentData(): ProjectData {
    return this.baseData();
  }

  /** 검증 한 번 + 데이터 준비. 시나리오가 있으면 그 표만 덮어 쓴 데이터 */
  /**
   * baseFindings(원본 검증 결과)를 주면, 시나리오가 건드린 표를 읽는 규칙만 다시 돌리고 나머지는 원본 결과를 쓴다(비교를 빠르게).
   */
  prepare(scenarioId?: string, options: { baseFindings?: Finding[] } = {}): { findings: Finding[]; blocked: boolean; data: ProjectData | null; skipped: SkippedChange[]; validateMs: number; readMs: number } {
    const t0 = performance.now();
    const base = this.baseData(); // 시나리오를 얹기 전에 원본 캐시를 맞춘다
    const scenarioTables = scenarioId
      ? (this.db.all('SELECT DISTINCT target FROM scenario_changes WHERE scenario_id = ?', [scenarioId]).map(r => String(r.target)) as EngineTable[])
        .filter(t => ALL_ENGINE_TABLES.includes(t))
      : [];
    const { value, skipped } = withScenario(this.db, scenarioId, () => {
      const tv = performance.now();
      let findings: Finding[];
      if (scenarioId && options.baseFindings) {
        const touched = new Set<string>(this.db.all('SELECT DISTINCT target FROM scenario_changes WHERE scenario_id = ?', [scenarioId]).map(r => String(r.target)));
        const rerun = new Set(RULES.filter(r => (RULE_TABLES as Record<string, string[]>)[r.code]?.some(t => touched.has(t))).map(r => r.code));
        findings = [...options.baseFindings.filter(f => !rerun.has(f.code)), ...validate(this.db, touched)];
      } else {
        findings = validate(this.db);
      }
      const t1 = performance.now();
      const blocked = findings.some(f => f.level === 'ERROR');
      let data: ProjectData | null = null;
      if (!blocked) {
        data = base;
        if (scenarioTables.length) {
          const overlay: Record<string, unknown> = { ...base };
          for (const t of scenarioTables) overlay[t] = readTable(this.db, t);
          data = overlay as unknown as ProjectData;
        }
      }
      const t2 = performance.now();
      return { findings, blocked, data, validateMs: t1 - tv, readMs: (t2 - t1) + (tv - t0) };
    });
    return { ...value, skipped };
  }

  calculate(options: { planMode?: PlanMode; scenarioId?: string } = {}): CalculateOutput {
    const t0 = performance.now();
    const value = this.prepare(options.scenarioId);
    const result = value.blocked || !value.data ? null : runPlan(value.data, { planMode: options.planMode });
    return {
      blocked: value.blocked,
      findings: value.findings,
      skipped: value.skipped,
      result,
      timings: { validateMs: value.validateMs, readMs: value.readMs, engineMs: result?.meta.elapsedMs ?? 0, totalMs: performance.now() - t0 },
    };
  }
}
