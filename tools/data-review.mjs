// 데이터 정비 도구: 옛 운영 시트(.xlsx) 또는 프로젝트 파일(.arp)을 받아
//   ① (.xlsx면) 새 프로젝트 파일로 가져오고
//   ② 계산 대상 업데이트의 출시 달까지 인력 기간을 늘리고(가장 가까운 앞 달 인원 복사, 변경 이력에 남음)
//   ③ 아트 PM이 확인할 점검용 엑셀을 만든다.
//   node tools/data-review.mjs <입력.xlsx|입력.arp> [--out 폴더] [--no-extend]
// 결과는 입력 파일 옆(기본) 또는 --out 폴더에 "<이름>.arp", "<이름> 데이터 점검.xlsx"로 남는다. 실제 데이터는 저장소에 넣지 않는다(private\).
import { readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readXlsx } from '../core/xlsx.ts';
import { legacyToRows, writeImported } from '../core/import-legacy.ts';
import { SCHEMA_SQL, openProjectFile } from './lib/project-db.mjs';
import { nodeDb } from './lib/pipeline.mjs';
import { ProjectSession } from '../core/pipeline.ts';
import { applyEdit } from '../core/edits.ts';
import { writeXlsx } from './lib/xlsx-write.mjs';

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
if (!input || !existsSync(input)) { console.error('사용법: node tools/data-review.mjs <입력.xlsx|입력.arp> [--out 폴더] [--no-extend]'); process.exit(1); }
const outAt = args.indexOf('--out');
const outDir = outAt >= 0 ? args[outAt + 1] : dirname(input);
const name = basename(input, extname(input));
const arpPath = join(outDir, `${name}.arp`);
const reviewPath = join(outDir, `${name} 데이터 점검.xlsx`);
const r1 = x => Math.round(x * 10) / 10;
const pct = x => `${Math.round(x * 100)}%`;

// ① 프로젝트 파일 준비
let importReport = null;
if (extname(input).toLowerCase() === '.xlsx') {
  const sheets = await readXlsx(new Uint8Array(readFileSync(input)));
  const { rows, report } = legacyToRows(sheets, { projectName: name });
  importReport = report;
  if (existsSync(arpPath)) rmSync(arpPath);
  const raw = new DatabaseSync(arpPath);
  writeImported(nodeDb(raw), SCHEMA_SQL, rows);
  raw.close();
  console.log(`가져오기: ${input} → ${arpPath}`);
} else if (input !== arpPath) {
  copyFileSync(input, arpPath);
}
const raw = openProjectFile(arpPath);
const db = nodeDb(raw);
const session = new ProjectSession(db);
const ctx = { editor: '데이터 정비', batchId: `review-${Date.now().toString(36)}`, reason: '데이터 정비: 출시 달까지 인력 기간 늘리기' };

// ② 인력 기간을 계산 대상 업데이트의 출시 달까지
const settings = db.get('SELECT horizon_start_month AS s, horizon_end_month AS e FROM settings WHERE id = 1');
const before = { start: String(settings.s), end: String(settings.e) };
const lastRelease = String(db.get("SELECT max(substr(release_date, 1, 7)) AS m FROM updates WHERE status IN ('PLANNED', 'IN_PROGRESS')")?.m ?? '');
let extended = null;
if (!args.includes('--no-extend') && lastRelease && lastRelease > before.end) {
  applyEdit(db, session, { kind: 'horizon', startMonth: before.start, endMonth: lastRelease }, ctx);
  extended = { from: before.end, to: lastRelease };
  console.log(`인력 기간: ${before.start} ~ ${before.end} → ${lastRelease} (새 달은 가장 가까운 앞 달 인원 복사)`);
}

// ③ 계산
const out = session.calculate({ planMode: 'TARGET' });
const res = out.result;
const findings = out.findings;
const parts = db.all('SELECT part_id, name FROM parts WHERE active = 1 ORDER BY sort_order');
const partName = new Map(parts.map(p => [String(p.part_id), String(p.name)]));
const resName = new Map(db.all('SELECT resource_type_id AS id, name FROM resource_types').map(r => [String(r.id), String(r.name)]));
const groupOf = new Map(db.all('SELECT t.resource_type_id AS id, coalesce(g.name, \'(분류 없음)\') AS g FROM resource_types t LEFT JOIN resource_groups g ON g.group_id = t.group_id').map(r => [String(r.id), String(r.g)]));
const updates = db.all('SELECT * FROM updates ORDER BY priority');
const updName = new Map(updates.map(u => [String(u.update_id), String(u.name)]));

const sheets = {};

// 요약
const totalReq = res ? res.parts.reduce((a, p) => a + p.requiredDays, 0) : 0;
const totalCap = res ? res.parts.reduce((a, p) => a + p.capacityDays, 0) : 0;
sheets['요약'] = [
  ['항목', '값', '설명'],
  ['프로젝트', name, ''],
  ['계획 기간', `${res?.horizon.start ?? before.start} ~ ${res?.horizon.end ?? before.end}`, extended ? `인력 기간을 ${extended.from} → ${extended.to}로 늘림(앞 달 인원 복사). 실제 인원으로 고쳐 주세요` : ''],
  ['계산', out.blocked ? '막힘(데이터 점검 오류)' : '됨', out.blocked ? '"데이터 점검" 시트의 오류를 먼저 고쳐 주세요' : ''],
  ['필요 공수 합(목표안)', r1(totalReq), '인·일'],
  ['작업 가능량 합', r1(totalCap), '인·일'],
  ['필요 ÷ 가능', totalCap ? r1(totalReq / totalCap) : '', '1이 넘으면 기간 안에 다 못 함'],
  [],
  ['파트', '필요 공수', '작업 가능량', '부하율', '판정'],
  ...(res ? res.parts.map(p => [p.name, r1(p.requiredDays), r1(p.capacityDays), pct(p.loadRate), p.loadRate > 1 ? '넘침' : '여유']) : []),
  [],
  ['업데이트', '시작', '제작 완료 목표', '출시', '완료 예정', '판정', '필요 공수'],
  ...(res ? res.updates.map(u => [u.name, u.startDate ?? '', u.freezeDate ?? '', u.releaseDate ?? '', u.expectedCompletionDate ?? '기간 안에 못 끝남', ({ ON_TRACK: '목표 안', TIGHT: '빠듯', LATE: '늦음', UNFINISHED: '못 끝냄', NO_RELEASE_DATE: '출시일 없음' })[u.status] ?? u.status, r1(u.requiredDays)]) : []),
];

// 필요 공수 큰 순: 업데이트 × 리소스
if (res) {
  const byKey = new Map();
  for (const g of res.stages) {
    const k = `${g.updateId}|${g.resourceTypeId}`;
    const cur = byKey.get(k) ?? { updateId: g.updateId, rt: g.resourceTypeId, req: 0, perPart: {} };
    cur.req += g.requiredDays;
    cur.perPart[g.partId] = (cur.perPart[g.partId] ?? 0) + g.requiredDays;
    byKey.set(k, cur);
  }
  const rows = [...byKey.values()].sort((a, b) => b.req - a.req);
  let acc = 0;
  sheets['필요 공수 큰 순'] = [
    ['업데이트', '분류', '리소스', '목표 수량', '외주 수량', '1개당 기본 공수 합(인·일)', '필요 공수(인·일)', ...parts.map(p => `${p.name}`), '전체 대비', '누적', '확인 메모'],
    ...rows.map(r => {
      acc += r.req;
      const v = db.get('SELECT target_qty, outsource_qty FROM volumes WHERE update_id = ? AND resource_type_id = ?', [r.updateId, r.rt]);
      const unit = Number(db.get("SELECT coalesce(sum(days), 0) AS d FROM efforts WHERE resource_type_id = ? AND profile_id = 'BASE'", [r.rt])?.d ?? 0);
      return [updName.get(r.updateId) ?? r.updateId, groupOf.get(r.rt) ?? '', resName.get(r.rt) ?? r.rt, v?.target_qty ?? '', v?.outsource_qty ?? 0, r1(unit), r1(r.req),
        ...parts.map(p => r1(r.perPart[String(p.part_id)] ?? 0)), totalReq ? pct(r.req / totalReq) : '', totalReq ? pct(acc / totalReq) : '', ''];
    }),
  ];
}

// 공수 기준: 리소스 × 파트, 이상값 표시
const efforts = db.all(`SELECT rp.resource_type_id AS rt, rp.part_id AS part, rp.rework_rate AS rework,
    (SELECT days FROM efforts e WHERE e.resource_type_id = rp.resource_type_id AND e.part_id = rp.part_id AND e.profile_id = 'BASE') AS base,
    (SELECT days FROM efforts e WHERE e.resource_type_id = rp.resource_type_id AND e.part_id = rp.part_id AND e.profile_id = 'AI') AS ai
  FROM resource_parts rp JOIN parts p ON p.part_id = rp.part_id ORDER BY rp.resource_type_id, p.sort_order`);
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
// 같은 분류·같은 파트 안에서 비교한다(분류마다 규모가 달라 전체 중앙값과 비교하면 거의 모두 튄다). 비교 대상이 3개 이상일 때만
const peerKey = e => `${groupOf.get(String(e.rt)) ?? ''}|${e.part}`;
const peers = new Map();
for (const e of efforts) if (Number(e.base) > 0) peers.set(peerKey(e), [...(peers.get(peerKey(e)) ?? []), Number(e.base)]);
sheets['공수 기준'] = [
  ['분류', '리소스', '파트', '기본 공수(인·일/개)', 'AI 공수', '재작업률', '같은 분류·파트 중앙값', '표시', '확인 메모'],
  ...efforts.map(e => {
    const base = e.base == null ? null : Number(e.base);
    const group = peers.get(peerKey(e)) ?? [];
    const med = group.length >= 3 ? median(group) : 0;
    const flag = base == null ? '기본 공수 없음' : base === 0 ? '0: 이 파트에서는 할 일 없음(맞는지 확인)' : med && base >= med * 3 ? `같은 분류 중앙값의 ${Math.round(base / med * 10) / 10}배: 큰 편` : med && base <= med / 3 ? `같은 분류 중앙값의 ${Math.round(base / med * 100) / 100}배: 작은 편` : '';
    return [groupOf.get(String(e.rt)) ?? '', resName.get(String(e.rt)) ?? e.rt, partName.get(String(e.part)) ?? e.part, base ?? '', e.ai ?? '', e.rework, med ? r1(med) : '', flag, ''];
  }),
];

// 날짜 · 기간
const filledStart = importReport?.adjustments.some(a => a.includes('시작일이 빈 업데이트')) ? `${before.start}-01` : null;
sheets['날짜·기간'] = [
  ['업데이트', '상태', '시작', '제작 완료 목표', '출시', '확인할 것', '확인 메모'],
  ...updates.filter(u => u.status === 'PLANNED' || u.status === 'IN_PROGRESS').map(u => {
    const todo = [];
    if (filledStart && u.start_date === filledStart) todo.push('시작일이 비어 계획 기간 첫날로 채움 → 실제 시작일');
    if (!u.release_date) todo.push('출시일 없음');
    if (!u.freeze_date) todo.push('제작 완료 목표일 없음');
    if (u.release_date && String(u.release_date).slice(0, 7) > before.end) todo.push(`출시가 원래 인력 기간(${before.end}) 뒤`);
    return [u.name, u.status, u.start_date ?? '', u.freeze_date ?? '', u.release_date ?? '', todo.join(' · '), ''];
  }),
];

// 인력
if (res) {
  const months = [...new Set(res.partMonths.map(m => m.month))].sort();
  const cap = db.all('SELECT * FROM capacity');
  sheets['인력'] = [
    ['파트', '항목', ...months],
    ...parts.flatMap(p => [
      [p.name, '인원', ...months.map(m => cap.find(c => c.part_id === p.part_id && c.month === m)?.headcount ?? '')],
      [p.name, '작업 가능량(인·일)', ...months.map(m => r1(res.partMonths.find(x => x.partId === p.part_id && x.month === m)?.capacityDays ?? 0))],
      [p.name, '배정(인·일)', ...months.map(m => r1(res.partMonths.find(x => x.partId === p.part_id && x.month === m)?.assignedDays ?? 0))],
    ]),
  ];
}

// 데이터 점검 · 가져오기 보고서
sheets['데이터 점검'] = [
  ['수준', '규칙', '내용', '대상', '자세히'],
  ...findings.map(f => [f.level === 'ERROR' ? '오류' : '주의', f.code, f.title, f.key, f.detail]),
  ...(importReport ? [[], ['가져오기 보고서'], ...importReport.adjustments.map(a => ['', '', a])] : []),
];

// 확인 요청(PM)
const over = res ? res.parts.filter(p => p.loadRate > 1) : [];
// 인원이 0인 달(파트별)
const zeroMonths = parts.map(p => [p.name, db.all("SELECT month FROM capacity WHERE part_id = ? AND headcount = 0 AND month BETWEEN ? AND ? ORDER BY month", [p.part_id, res?.horizon.start.slice(0, 7) ?? before.start, res?.horizon.end.slice(0, 7) ?? before.end]).map(r => String(r.month))]).filter(([, ms]) => ms.length);
const zeroText = zeroMonths.map(([n, ms]) => `${n} ${ms[0]}${ms.length > 1 ? `~${ms[ms.length - 1]}` : ''}(${ms.length}달)`).join(', ');
// 물량이 거의 같은 업데이트 쌍(템플릿을 그대로 복사한 자리표시 값일 수 있다)
const liveIds = updates.filter(u => u.status === 'PLANNED' || u.status === 'IN_PROGRESS').map(u => String(u.update_id));
const volOf = id => new Map(db.all('SELECT resource_type_id AS r, target_qty AS q FROM volumes WHERE update_id = ?', [id]).map(v => [String(v.r), Number(v.q ?? 0)]));
const sameVolumes = [];
for (let i = 0; i < liveIds.length; i += 1) for (let j = i + 1; j < liveIds.length; j += 1) {
  const a = volOf(liveIds[i]); const b = volOf(liveIds[j]);
  const keys = new Set([...a.keys(), ...b.keys()]);
  if (keys.size < 3) continue;
  const same = [...keys].filter(k => a.get(k) === b.get(k)).length;
  if (same / keys.size >= 0.8) sameVolumes.push(`${updName.get(liveIds[i])} ↔ ${updName.get(liveIds[j])}(${same}/${keys.size}종 같음)`);
}
sheets['확인 요청'] = [
  ['순서', '확인할 것', '어디서', '왜'],
  [1, '필요 공수가 큰 리소스의 수량과 1개당 공수가 맞는지', '"필요 공수 큰 순" 위쪽부터(누적 80%까지)', over.length ? `필요 공수가 작업 가능량보다 큼(${over.map(p => `${p.name} ${pct(p.loadRate)}`).join(', ')})` : '부하 확인'],
  [2, '공수 기준의 0과 큰 값·작은 값', '"공수 기준"의 표시 칸', '임의 산정 값이 섞여 있을 수 있음'],
  [3, '빈 시작일·출시일·제작 완료 목표일', '"날짜·기간"', '빈 날짜는 계획 기간 첫날로 임시로 채웠거나 늦음을 판단하지 못함'],
  [4, '인원이 0인 달 · 늘린 달의 인원', '"인력"', [zeroText && `인원 0: ${zeroText}`, extended && `${extended.from} 뒤 달은 앞 달 인원을 복사함`].filter(Boolean).join(' · ') || '인력 기간 확인'],
  ...(sameVolumes.length ? [[5, '물량이 거의 같은 업데이트(템플릿을 그대로 복사한 자리표시 값인지)', '"필요 공수 큰 순"', sameVolumes.join(', ')]] : []),
  [sameVolumes.length ? 6 : 5, '고친 값은 앱에서 바로 넣기', `앱 → 프로젝트 파일 열기 → ${basename(arpPath)}`, '고칠 때마다 다시 계산되고 변경 이력이 남음'],
];

writeFileSync(reviewPath, writeXlsx(sheets));
raw.close();
console.log(`점검 엑셀: ${reviewPath}`);
console.log(`계산: ${out.blocked ? '막힘' : '됨'} · 필요 ${r1(totalReq)} / 가능 ${r1(totalCap)} 인·일 · 점검 ${findings.length}건(오류 ${findings.filter(f => f.level === 'ERROR').length})`);
