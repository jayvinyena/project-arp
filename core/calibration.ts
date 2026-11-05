// 공수 보정 제안: 실적(완료 수량 + 실투입 인·일)과 기준 공수를 비교해 리소스·파트별 공수 배율을 제안한다.
// 기준 = 완료 수량 × 공수(프로필 섞은 값) × 난이도 × (1 − 재사용률) × (1 + 재작업률). 여유율은 계획 여유라 넣지 않는다.
import type { SqlDb } from './db.ts';
import type { ProjectData, PlanMode } from '../engine/types.ts';
import { runPlan } from '../engine/index.ts';

export interface CalibrationRow {
  resourceTypeId: string;
  resourceName: string;
  partId: string;
  partName: string;
  /** 지금 기본 공수(1개당 인·일) */
  baseDays: number;
  /** 실적이 있는 완료 수량 합 */
  units: number;
  /** 실투입 인·일 합 */
  spentDays: number;
  /** 같은 완료 수량의 기준 인·일 */
  standardDays: number;
  /** 실투입 ÷ 기준. 1보다 크면 기준보다 더 들었다 */
  ratio: number;
  /** 제안 기본 공수 = 지금 × 배율 */
  suggestedBase: number;
  /** 근거가 충분한가(완료 3개 이상, 실투입 5인·일 이상) */
  enough: boolean;
}

export interface CalibrationView {
  rows: CalibrationRow[];
  parts: { partId: string; name: string; units: number; spentDays: number; standardDays: number; ratio: number | null }[];
  /** 실투입이 들어간 실적 칸 수 */
  samples: number;
}

export const MIN_UNITS = 3;
export const MIN_SPENT = 5;

export function calibrationView(db: SqlDb): CalibrationView {
  const mix = new Map<string, { profile: string; share: number }[]>();
  for (const m of db.all('SELECT part_id, profile_id, share FROM effort_mix')) {
    const k = String(m.part_id);
    if (!mix.has(k)) mix.set(k, []);
    mix.get(k)!.push({ profile: String(m.profile_id), share: Number(m.share) });
  }
  const efforts = new Map(db.all('SELECT resource_type_id, part_id, profile_id, days FROM efforts').map(e => [`${e.resource_type_id}|${e.part_id}|${e.profile_id}`, Number(e.days)]));
  const mixed = (rt: string, part: string) => {
    const base = efforts.get(`${rt}|${part}|BASE`) ?? 0;
    const shares = mix.get(part);
    return shares?.length ? shares.reduce((a, m) => a + m.share * (efforts.get(`${rt}|${part}|${m.profile}`) ?? base), 0) : base;
  };
  const rows = db.all(`SELECT a.resource_type_id AS rt, a.part_id AS part, a.completed_qty AS done, a.spent_days AS spent,
        v.difficulty, v.reuse_rate, rp.rework_rate, r.name AS rname, p.name AS pname
      FROM progress a
      JOIN volumes v ON v.update_id = a.update_id AND v.resource_type_id = a.resource_type_id
      JOIN resource_parts rp ON rp.resource_type_id = a.resource_type_id AND rp.part_id = a.part_id
      JOIN resource_types r ON r.resource_type_id = a.resource_type_id
      JOIN parts p ON p.part_id = a.part_id
      WHERE a.spent_days > 0 AND a.completed_qty > 0`);
  const acc = new Map<string, CalibrationRow>();
  for (const x of rows) {
    const rt = String(x.rt);
    const part = String(x.part);
    const key = `${rt}|${part}`;
    if (!acc.has(key)) {
      acc.set(key, {
        resourceTypeId: rt, resourceName: String(x.rname), partId: part, partName: String(x.pname),
        baseDays: efforts.get(`${rt}|${part}|BASE`) ?? 0, units: 0, spentDays: 0, standardDays: 0, ratio: 1, suggestedBase: 0, enough: false,
      });
    }
    const row = acc.get(key)!;
    const done = Number(x.done);
    row.units += done;
    row.spentDays += Number(x.spent);
    row.standardDays += done * mixed(rt, part) * Number(x.difficulty ?? 1) * Math.max(0, 1 - Number(x.reuse_rate ?? 0)) * (1 + Number(x.rework_rate ?? 0));
  }
  const list = [...acc.values()].map(r => {
    const ratio = r.standardDays > 0 ? r.spentDays / r.standardDays : 1;
    return { ...r, ratio, suggestedBase: Math.round(r.baseDays * ratio * 100) / 100, enough: r.units >= MIN_UNITS && r.spentDays >= MIN_SPENT };
  }).sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1));
  const parts = db.all('SELECT part_id, name FROM parts WHERE active = 1 ORDER BY sort_order').map(p => {
    const mine = list.filter(r => r.partId === p.part_id);
    const spent = mine.reduce((a, r) => a + r.spentDays, 0);
    const std = mine.reduce((a, r) => a + r.standardDays, 0);
    return { partId: String(p.part_id), name: String(p.name), units: mine.reduce((a, r) => a + r.units, 0), spentDays: spent, standardDays: std, ratio: std > 0 ? spent / std : null };
  });
  return { rows: list, parts, samples: rows.length };
}

export interface CalibrationPreview {
  updates: { updateId: string; name: string; before: string | null; after: string | null; beforeStatus: string; afterStatus: string }[];
}

/** 고른 보정을 적용하면 업데이트 완료 예정이 어떻게 바뀌나(메모리에서만 계산) */
export function calibrationPreview(data: ProjectData, picks: { resourceTypeId: string; partId: string; ratio: number }[], planMode: PlanMode = 'TARGET'): CalibrationPreview {
  const ratio = new Map(picks.map(p => [`${p.resourceTypeId}|${p.partId}`, p.ratio]));
  const after = { ...data, efforts: data.efforts.map(e => (ratio.has(`${e.resource_type_id}|${e.part_id}`) ? { ...e, days: Math.round(e.days * ratio.get(`${e.resource_type_id}|${e.part_id}`)! * 100) / 100 } : e)) };
  const a = runPlan(data, { planMode });
  const b = runPlan(after, { planMode });
  return {
    updates: a.updates.map(u => {
      const x = b.updates.find(y => y.updateId === u.updateId)!;
      return { updateId: u.updateId, name: u.name, before: u.expectedCompletionDate, after: x.expectedCompletionDate, beforeStatus: u.status, afterStatus: x.status };
    }),
  };
}
