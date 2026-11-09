// 프로젝트 파일(.arp) 만들기 · 검증 · 간이 부하 계산 (0단계 도구, Node 22.5+ 내장 node:sqlite)
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validate as coreValidate } from '../../core/pipeline.ts';
import { nodeDb } from './pipeline.mjs';
import { migrate, LATEST_SCHEMA } from '../../core/migrate.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SCHEMA_SQL = readFileSync(`${ROOT}schema/schema-v1.sql`, 'utf8');
export const APP_ID = 1095913521;
export const SCHEMA_VERSION = LATEST_SCHEMA;

// 참조 순서대로 넣어야 외래 키가 통과한다
export const TABLE_ORDER = [
  'meta', 'settings', 'holidays',
  'parts', 'part_overlaps',
  'resource_groups', 'resource_types', 'resource_parts', 'effort_profiles', 'efforts', 'effort_mix',
  'update_types', 'type_templates', 'updates', 'volumes', 'progress',
  'capacity',
  'scenarios', 'scenario_changes',
  'batches', 'assets', 'asset_parts', 'asset_links', 'asset_comments',
  'change_log',
];

/** data: { 표 이름: [행 객체, ...] } → 새 .arp 파일 */
export function createProjectFile(path, data) {
  if (existsSync(path)) rmSync(path);
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);
  migrate(nodeDb(db)); // 새 파일도 최신 구조로
  db.exec('BEGIN');
  try {
    for (const table of TABLE_ORDER) {
      for (const row of data[table] || []) insertRow(db, table, row);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  return db;
}

export function insertRow(db, table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => `:${c}`).join(', ')})`;
  const params = {};
  for (const c of cols) params[c] = typeof row[c] === 'boolean' ? Number(row[c]) : row[c];
  try {
    db.prepare(sql).run(params);
  } catch (error) {
    throw new Error(`${table} 행을 넣지 못함: ${JSON.stringify(row)} → ${error.message}`);
  }
}

export function openProjectFile(path) {
  const db = new DatabaseSync(path);
  const appId = db.prepare('PRAGMA application_id').get().application_id;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (appId !== APP_ID) throw new Error(`ARP 파일이 아닙니다 (application_id ${appId})`);
  if (version > SCHEMA_VERSION) throw new Error(`더 새 구조(v${version})의 파일입니다`);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(nodeDb(db)); // 옛 구조면 최신으로(파일에 바로 쓴다)
  return db;
}

/** 모든 검증 규칙을 돌려 문제 목록을 돌려준다 (실제 구현: core/pipeline.ts) */
export function validate(db) {
  return coreValidate(nodeDb(db));
}

// ───────── 근무 달력 ─────────

export function monthsBetween(start, end) {
  const out = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (out.length > 1200) break;
  }
  return out;
}

/** 그 달의 근무일 수 = 근무 요일 날 수 − 근무 요일에 걸친 휴일 수 */
export function workdaysInMonth(month, workWeekdays, holidaySet) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let count = 0;
  for (let d = 1; d <= days; d += 1) {
    const date = new Date(Date.UTC(y, m - 1, d));
    const weekdayIndex = (date.getUTCDay() + 6) % 7; // 월=0 … 일=6
    if (workWeekdays[weekdayIndex] !== '1') continue;
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    if (holidaySet.has(iso)) continue;
    count += 1;
  }
  return count;
}

// ───────── 간이 부하 (기간 전체 합계, 일정 배치 없음) ─────────

/**
 * 파트별 [필요 공수 합계, 작업 가능량 합계, 부하율].
 * 1단계 엔진 전에 샘플이 의도대로(정상/과부하) 만들어졌는지 보는 용도.
 */
export function quickLoad(db, planMode = 'TARGET') {
  const s = db.prepare('SELECT * FROM settings').get();
  const qtyCol = { MIN: 'min_qty', TARGET: 'target_qty', STRETCH: 'stretch_qty' }[planMode];
  const holidays = new Set(db.prepare('SELECT date FROM holidays').all().map(r => r.date));
  const months = monthsBetween(s.horizon_start_month, s.horizon_end_month);
  const workdays = Object.fromEntries(months.map(m => [m, workdaysInMonth(m, s.work_weekdays, holidays)]));

  const mix = {};
  for (const r of db.prepare('SELECT * FROM effort_mix').all()) (mix[r.part_id] ||= []).push(r);
  const efforts = {};
  for (const r of db.prepare('SELECT * FROM efforts').all()) efforts[`${r.resource_type_id}|${r.part_id}|${r.profile_id}`] = r.days;
  const done = {};
  for (const r of db.prepare('SELECT * FROM progress').all()) done[`${r.update_id}|${r.resource_type_id}|${r.part_id}`] = r.completed_qty;

  const mixedDays = (rt, part) => {
    const base = efforts[`${rt}|${part}|BASE`];
    const shares = mix[part];
    if (!shares || !shares.length) return base;
    return shares.reduce((sum, m) => sum + m.share * (efforts[`${rt}|${part}|${m.profile_id}`] ?? base), 0);
  };

  const parts = db.prepare('SELECT * FROM parts WHERE active = 1 ORDER BY sort_order').all();
  const result = Object.fromEntries(parts.map(p => [p.part_id, { partId: p.part_id, name: p.name, demandDays: 0, capacityDays: 0 }]));

  const stages = db.prepare(`
    SELECT v.update_id, v.resource_type_id, v.${qtyCol} AS qty, v.outsource_qty, v.difficulty, v.reuse_rate, rp.part_id, rp.rework_rate
    FROM volumes v
    JOIN updates u ON u.update_id = v.update_id AND u.status IN ('PLANNED', 'IN_PROGRESS')
    JOIN resource_parts rp ON rp.resource_type_id = v.resource_type_id
    JOIN parts p ON p.part_id = rp.part_id AND p.active = 1`).all();
  for (const st of stages) {
    const remaining = Math.max(0, (st.qty ?? 0) - st.outsource_qty - (done[`${st.update_id}|${st.resource_type_id}|${st.part_id}`] ?? 0));
    const days = mixedDays(st.resource_type_id, st.part_id) ?? 0;
    result[st.part_id].demandDays += remaining * days * st.difficulty * (1 - st.reuse_rate) * (1 + st.rework_rate) * (1 + s.buffer_rate);
  }

  for (const c of db.prepare('SELECT * FROM capacity').all()) {
    if (!(c.month in workdays) || !result[c.part_id]) continue;
    result[c.part_id].capacityDays += c.headcount * workdays[c.month] * c.utilization * c.productivity + c.outsource_days + c.support_days;
  }
  return Object.values(result).map(r => ({ ...r, loadRate: r.capacityDays > 0 ? r.demandDays / r.capacityDays : Infinity }));
}
