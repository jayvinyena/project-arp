// 엑셀로 내보내기: 보고용 결과 + 데이터. 시트 이름과 머리글은 한국어.
import type { SqlDb } from './db.ts';
import type { PlanMode } from '../engine/types.ts';
import type { ProjectSession } from './pipeline.ts';
import { planView, capacityView } from './plan.ts';
import { historyView } from './history.ts';
import type { Cell } from './xlsx-write.ts';

const STATUS: Record<string, string> = { ON_TRACK: '목표 안', TIGHT: '빠듯', LATE: '늦음', UNFINISHED: '기간 안에 못 끝냄', NO_RELEASE_DATE: '출시일 없음' };
const LIFE: Record<string, string> = { PLANNED: '계획', IN_PROGRESS: '진행 중', DONE: '완료', CANCELLED: '취소' };
const MODE: Record<PlanMode, string> = { MIN: '최저안', TARGET: '목표안', STRETCH: '확장안' };
const r1 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 10) / 10);

export function exportSheets(db: SqlDb, session: ProjectSession, planMode: PlanMode = 'TARGET'): Record<string, Cell[][]> {
  const v = planView(db, session, planMode);
  const meta = Object.fromEntries(db.all('SELECT key, value FROM meta').map(r => [String(r.key), r.value]));
  const sheets: Record<string, Cell[][]> = {};

  sheets['요약'] = [
    ['항목', '값'],
    ['프로젝트', String(meta.project_name ?? '')],
    ['내보낸 시각', new Date().toISOString()],
    ['물량 구간', MODE[planMode]],
    ['계획 기간', `${v.horizon.start} ~ ${v.horizon.end}`],
    ['계산 가능', v.blocked ? '아니요(데이터 점검 시트 참고)' : '예'],
    ['계산 대상 업데이트', v.rows.filter(r => r.live).length],
    ['늦음·못 끝냄', v.rows.filter(r => r.result && (r.result.status === 'LATE' || r.result.status === 'UNFINISHED')).length],
  ];

  sheets['업데이트 전망'] = [
    ['순위', '업데이트', '유형', '상태', '작업 시작', '제작 완료 목표', '출시', '목표 물량', '필요 공수(인·일)', `완료 예정(${MODE[planMode]})`, '최저안 완료', '확장안 완료', '판정', '늦은 영업일', '근거 파트', '근거 리소스'],
    ...v.rows.map(r => [
      r.live ? r.priority : null, r.name, r.typeName, LIFE[r.status] ?? r.status, r.startDate, r.freezeDate, r.releaseDate, r.totals.target,
      r1(r.result?.requiredDays), r.result?.completion ?? (r.result ? '기간 밖' : null), r.range?.min ?? null, r.range?.stretch ?? null,
      r.result ? STATUS[r.result.status] : null, r.result?.lateWorkdays ?? null,
      r.result?.reason?.partName ?? null, r.result?.reason?.resourceName ?? null,
    ]),
  ];

  const months = v.horizon.months;
  sheets['파트 부하'] = [
    ['파트', '항목', ...months],
    ...v.parts.flatMap(p => [
      [p.name, '작업 가능량(인·일)', ...p.months.map(m => r1(m.capacity))],
      [p.name, '배정(인·일)', ...p.months.map(m => r1(m.assigned))],
      [p.name, '가동 비율', ...p.months.map(m => Math.round(m.utilization * 1000) / 1000)],
      [p.name, '달 끝 남은 일(인·일)', ...p.months.map(m => r1(m.remaining))],
    ]),
  ];

  sheets['물량'] = [
    ['업데이트', '분류', '리소스', '최저', '목표', '확장', '외주', '필수', '업데이트 안 순위', '난이도', '재사용률'],
    ...db.all(`SELECT u.name AS u, coalesce(g.name, '') AS g, r.name AS r, v.* FROM volumes v
        JOIN updates u ON u.update_id = v.update_id JOIN resource_types r ON r.resource_type_id = v.resource_type_id
        LEFT JOIN resource_groups g ON g.group_id = r.group_id ORDER BY u.priority, u.sort_order, g.sort_order, r.sort_order`)
      .map(x => [x.u, x.g, x.r, x.min_qty, x.target_qty, x.stretch_qty, x.outsource_qty, Number(x.required) === 1 ? '필수' : '선택', x.priority, x.difficulty, x.reuse_rate] as Cell[]),
  ];

  const cap = capacityView(db);
  sheets['인력'] = [
    ['파트', '달', '인원', '가동률', '생산성', '외주(인·일)', '지원(인·일)'],
    ...cap.parts.flatMap(p => p.cells.map((c, i) => [p.name, cap.months[i], c?.headcount ?? null, c?.utilization ?? null, c?.productivity ?? null, c?.outsource_days ?? null, c?.support_days ?? null] as Cell[])),
  ];

  sheets['공수'] = [
    ['리소스', '파트', '공수 판', '1개당 인·일', '재작업률'],
    ...db.all(`SELECT r.name AS r, p.name AS p, coalesce(ep.name, e.profile_id) AS prof, e.days, rp.rework_rate FROM efforts e
        JOIN resource_types r ON r.resource_type_id = e.resource_type_id JOIN parts p ON p.part_id = e.part_id
        JOIN resource_parts rp ON rp.resource_type_id = e.resource_type_id AND rp.part_id = e.part_id
        LEFT JOIN effort_profiles ep ON ep.profile_id = e.profile_id ORDER BY r.sort_order, p.sort_order, e.profile_id`)
      .map(x => [x.r, x.p, x.prof, x.days, x.rework_rate] as Cell[]),
  ];

  sheets['실적'] = [
    ['업데이트', '리소스', '파트', '완료 수량', '기준일'],
    ...db.all(`SELECT u.name AS u, r.name AS r, p.name AS p, a.completed_qty, a.as_of FROM progress a
        JOIN updates u ON u.update_id = a.update_id JOIN resource_types r ON r.resource_type_id = a.resource_type_id JOIN parts p ON p.part_id = a.part_id
        ORDER BY u.priority, r.sort_order, p.sort_order`).map(x => [x.u, x.r, x.p, x.completed_qty, x.as_of] as Cell[]),
  ];

  sheets['데이터 점검'] = [
    ['등급', '코드', '문제', '위치', '내용'],
    ...v.findings.map(f => [f.level === 'ERROR' ? '오류' : '주의', f.code, f.title, f.key, f.detail] as Cell[]),
  ];

  const h = historyView(db, 500);
  sheets['변경 이력'] = [
    ['시각', '편집자', '이유', '동작', '대상', '위치', '항목', '이전', '이후'],
    ...h.batches.flatMap(b => b.entries.map(e => [b.at, b.editor, b.reason, e.action, e.target, e.key, e.field,
      e.old === undefined ? null : JSON.stringify(e.old), e.next === undefined ? null : JSON.stringify(e.next)] as Cell[])),
  ];
  return sheets;
}
