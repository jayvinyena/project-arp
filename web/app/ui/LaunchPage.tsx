// 런칭 물량 설계 화면: 날짜 · 구간 비교 · 파트 부하 · 역산 · 물량 표
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import type { View } from '../lib/rpc.ts';
import { rpc } from '../lib/rpc.ts';
import type { LaunchEdit, MaxScaleResult, HeadcountResult, ModeOutcome } from '../../../core/launch.ts';
import type { PlanMode, UpdateStatus } from '../../../engine/types.ts';
import { fmtDate, fmtShortDate, fmtDays, fmtPct, fmtHeads, fmtInt } from '../lib/format.ts';
import { VolumeTable } from './VolumeTable.tsx';
import type { Edit } from '../../../core/edits.ts';
import { IconAlert, IconSpark, IconUsers } from './icons.tsx';

import { MODE_LABEL } from '../lib/modes.ts';
export { MODE_LABEL };
const STATUS: Record<UpdateStatus, { text: string; tone: string }> = {
  ON_TRACK: { text: '목표 안', tone: 'ok' },
  TIGHT: { text: '빠듯', tone: 'warn' },
  LATE: { text: '늦음', tone: 'bad' },
  UNFINISHED: { text: '기간 안에 못 끝남', tone: 'bad' },
  NO_RELEASE_DATE: { text: '출시일 없음', tone: '' },
};

function slackText(m: ModeOutcome): { text: string; tone: string } {
  if (m.slackWorkdays == null) return { text: '판단 불가', tone: '' };
  if (m.slackWorkdays < 0) return { text: `${-m.slackWorkdays}영업일 여유`, tone: 'ok' };
  if (m.slackWorkdays === 0) return { text: '여유 없음', tone: 'warn' };
  return { text: `${m.slackWorkdays}영업일 늦음`, tone: 'bad' };
}

/** 'LAUNCH|PROP' 같은 키를 '런칭 · 프랍'처럼 이름으로 */
export function humanKey(key: string, names: Record<string, string>): string {
  return key.split(/([|>,])/).map(seg => (seg === '|' ? ' · ' : seg === '>' ? ' → ' : names[seg.trim()] ?? seg)).join('');
}

function horizonEndText(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return y && m ? `${y}년 ${m}월 이후` : '기간 밖';
}

function ModeCards(props: { modes: ModeOutcome[]; selected: PlanMode; onSelect: (m: PlanMode) => void; deadlineLabel: string; horizonEnd: string }) {
  return (
    <div class="grid-3" role="radiogroup" aria-label="물량 템플릿">
      {props.modes.map(m => {
        const st = m.launch ? STATUS[m.launch.status] : null;
        const unfinished = m.launch?.status === 'UNFINISHED';
        const sl = unfinished ? { text: `남은 일 ${fmtInt(m.launch?.remainingDays ?? 0)}인·일`, tone: 'bad' } : slackText(m);
        return (
          <button type="button" role="radio" aria-checked={props.selected === m.planMode}
            class={`mode-card${props.selected === m.planMode ? ' selected' : ''}`} onClick={() => props.onSelect(m.planMode)}>
            <div class="top">
              <span class="label">{MODE_LABEL[m.planMode]}</span>
              {st && <span class={`pill ${st.tone}`}>{st.text}</span>}
            </div>
            <div>
              <div class="small faint">아트 작업 완료 예정</div>
              <div class="big">{m.launch?.expectedCompletionDate ? fmtShortDate(m.launch.expectedCompletionDate) : horizonEndText(props.horizonEnd)}</div>
            </div>
            <div class="meta">
              <span class={`pill plain ${sl.tone}`}>{unfinished ? sl.text : `${props.deadlineLabel} 대비 ${sl.text}`}</span>
              <span class="num">{fmtInt(m.launchDays)} 인·일</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function PartLoad(props: { mode: ModeOutcome }) {
  const parts = props.mode.parts;
  // 100%를 넘는 파트끼리도 구분되게, 가장 큰 값에 맞춰 눈금을 줄이고 100% 선을 그린다
  const rateOf = (a: number, b: number) => (b > 0 ? a / b : 0);
  const scaleMax = Math.max(1, ...parts.map(p => Math.max(rateOf(p.launchDays, p.windowCapacity), rateOf(p.windowAssigned, p.windowCapacity))));
  return (
    <section class="card">
      <div class="card-head">
        <div>
          <h2>파트 부하 · {MODE_LABEL[props.mode.planMode]}</h2>
          <p class="small muted" style="margin-top: 2px">런칭 기간(시작 달 ~ 제작 완료 목표 달) 작업 가능량 대비</p>
        </div>
        <div class="legend"><span><i style="background: var(--accent)" />런칭 필요</span><span><i style="background: var(--bar-other)" />다른 업데이트 포함 배정</span></div>
      </div>
      <div class="card-body">
        {parts.map(p => {
          const launchRate = p.windowCapacity > 0 ? p.launchDays / p.windowCapacity : 0;
          const usedRate = p.windowCapacity > 0 ? p.windowAssigned / p.windowCapacity : 0;
          return (
            <div class="part-row">
              <div class="part-name">
                {p.name}
                {p.critical && <span class="pill bad" style="align-self: flex-start">병목</span>}
              </div>
              <div>
                <div class="bar" title={`배정 ${fmtPct(usedRate)}`}>
                  <span class="fill other" style={{ width: `${(usedRate / scaleMax) * 100}%` }} />
                  <span class={`fill${launchRate > 1 ? ' over' : ''}`} style={{ width: `${(launchRate / scaleMax) * 100}%` }} />
                  {scaleMax > 1.02 && <span class="cap" style={{ left: `${100 / scaleMax}%` }} title="작업 가능량 100%" />}
                </div>
                {p.maxWait > 0 && <div class="small faint" style="margin-top: 4px">인력 대기 최대 {p.maxWait}영업일</div>}
              </div>
              <div class="part-num"><b>{fmtPct(launchRate)}</b><span>{fmtInt(p.launchDays)} / {fmtInt(p.windowCapacity)}</span></div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Reverse(props: { planMode: PlanMode; version: number; names: Record<string, string>; resNames: Record<string, string>; deadlineLabel: string }) {
  const [scale, setScale] = useState<{ r: MaxScaleResult; v: number; mode: PlanMode } | null>(null);
  const [heads, setHeads] = useState<{ r: HeadcountResult; v: number; mode: PlanMode } | null>(null);
  const [busy, setBusy] = useState<'' | 'scale' | 'heads'>('');
  const [failed, setFailed] = useState(false);
  const runScale = async () => { setBusy('scale'); setFailed(false); try { setScale({ r: await rpc.maxScale(props.planMode), v: props.version, mode: props.planMode }); } catch { setFailed(true); } finally { setBusy(''); } };
  const runHeads = async () => { setBusy('heads'); setFailed(false); try { setHeads({ r: await rpc.headcount(props.planMode), v: props.version, mode: props.planMode }); } catch { setFailed(true); } finally { setBusy(''); } };
  // 물량·날짜·템플릿이 바뀌면 잠시 뒤 두 질문을 다시 계산한다(빈 카드 대신 늘 답이 보이게, 실데이터에서 수십 ms)
  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        setFailed(false);
        setBusy('scale');
        const r1 = await rpc.maxScale(props.planMode);
        if (!alive) return;
        setScale({ r: r1, v: props.version, mode: props.planMode });
        setBusy('heads');
        const r2 = await rpc.headcount(props.planMode);
        if (!alive) return;
        setHeads({ r: r2, v: props.version, mode: props.planMode });
      } catch { if (alive) setFailed(true); /* 계산이 막히면 버튼으로 다시 */ } finally { if (alive) setBusy(''); }
    }, 450);
    return () => { alive = false; window.clearTimeout(t); };
  }, [props.version, props.planMode]);
  const stale = (x: { v: number; mode: PlanMode } | null) => !!x && (x.v !== props.version || x.mode !== props.planMode);
  const mode = MODE_LABEL[props.planMode];
  // 진행 상태는 답 칸 오른쪽 위에 겹쳐 표시한다(문구가 생기고 사라져도 줄·카드 높이가 변하지 않게)
  const status = (which: 'scale' | 'heads', x: { v: number; mode: PlanMode } | null) => {
    if (busy === which || (!failed && (!x || stale(x)))) return <span class="ask-status working" aria-live="polite">계산 중…</span>;
    if (failed && (!x || stale(x))) return <span class="ask-status bad" aria-live="polite">계산하지 못했습니다</span>;
    return <span class="ask-status" aria-live="polite" />;
  };

  const changed = scale?.r.suggestion.filter(s => s.suggested !== s.current).slice(0, 6) ?? [];
  return (
    <section class="card">
      <div class="card-head"><div><h2>거꾸로 계산하기</h2><p class="small muted" style="margin-top: 2px">날짜를 지키려면 물량 · 인원을 얼마나 바꿔야 하는지 자동으로 계산합니다</p></div><span class="tag">{mode} 기준</span></div>
      <div class="card-body" style="padding-top: 4px">
        <div class="ask">
          <div class="ask-q">
            <span class="q">{props.deadlineLabel}까지 물량을 최대 얼마나?</span>
            <button class="btn sm" disabled={busy !== ''} onClick={runScale}><IconSpark />다시 계산</button>
          </div>
          {!scale && <div class="answer reserve-scale placeholder">{status('scale', scale)}</div>}
          {scale && (
            <div class={`answer reserve-scale${stale(scale) ? ' stale' : ''}`}>
              {status('scale', scale)}
              {scale.r.scale == null
                ? <span class="big">물량을 줄여도 맞추기 어렵습니다</span>
                : <span class="big">{mode} 물량의 {fmtPct(scale.r.scale)}</span>}
              <span class="small muted">
                {scale.r.scale == null ? '날짜나 인원을 바꿔야 합니다.'
                  : scale.r.currentOk ? `지금 인원으로 모든 리소스를 같은 비율로 ${fmtPct(scale.r.scale - 1)} 더 만들 수 있습니다.`
                    : `모든 리소스를 같은 비율로 ${fmtPct(1 - scale.r.scale)} 줄이면 맞습니다.`}
              </span>
              {changed.length > 0 && (
                <div class="chips">{changed.map(s => <span class="tag">{props.resNames[s.resourceTypeId] ?? s.resourceTypeId} {fmtInt(s.current)} → {fmtInt(s.suggested)}</span>)}</div>
              )}
            </div>
          )}
        </div>
        <div class="ask">
          <div class="ask-q">
            <span class="q">{mode} 물량을 지키려면 몇 명 더?</span>
            <button class="btn sm" disabled={busy !== ''} onClick={runHeads}><IconUsers />다시 계산</button>
          </div>
          {!heads && <div class="answer reserve-heads placeholder">{status('heads', heads)}</div>}
          {heads && (
            <div class={`answer reserve-heads${stale(heads) ? ' stale' : ''}`}>
              {status('heads', heads)}
              {heads.r.currentOk ? <span class="big">지금 인원으로 충분합니다</span>
                : !heads.r.feasible ? <span class="big">인원만으로는 어렵습니다</span>
                  : <div class="chips">{heads.r.additions.map(a => <span class="pill accent plain" style="height: 28px; font-size: 13px">{props.names[a.partId] ?? a.partId} +{fmtHeads(a.heads)}</span>)}</div>}
              {heads.r.feasible && !heads.r.currentOk && heads.r.months && (
                <span class="small muted">{heads.r.months.from} ~ {heads.r.months.to} 동안 더하면 {fmtDate(heads.r.completion)}에 끝납니다.</span>
              )}
              {!heads.r.feasible && <span class="small muted">날짜를 늦추거나 물량을 줄여야 합니다.</span>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function LaunchPage(props: {
  view: View; version: number; planMode: PlanMode; setPlanMode: (m: PlanMode) => void; readOnly: boolean; onEdit: (e: LaunchEdit) => unknown;
  onApply?: (e: Edit) => Promise<boolean>;
}) {
  const { snapshot, compare } = props.view;
  const launch = snapshot.launch;
  if (!launch) {
    return (
      <div class="page">
        <div class="banner warn"><IconAlert /><div><b>런칭 업데이트가 없습니다</b><p class="small muted">업데이트 유형이 "런칭"인 업데이트를 하나 만들면 여기서 물량을 설계할 수 있습니다.</p></div></div>
      </div>
    );
  }
  const deadlineLabel = launch.freezeDate ? '제작 완료 목표일' : '출시일';
  const selected = compare.modes.find(m => m.planMode === props.planMode) ?? compare.modes[1];
  const errors = compare.findings.filter(f => f.level === 'ERROR');
  const names = Object.fromEntries(snapshot.parts.map(p => [p.partId, p.name]));
  const resNames = Object.fromEntries(snapshot.rows.map(r => [r.resourceTypeId, r.name]));
  const allNames: Record<string, string> = { ...names, ...resNames, ...Object.fromEntries(snapshot.addable.map(a => [a.resourceTypeId, a.name])), [launch.updateId]: launch.name };
  const date = (field: 'start_date' | 'freeze_date' | 'release_date', label: string, value: string | null, key = false) => (
    <div class={`date-chip${key ? ' key' : ''}`}>
      <label for={`d-${field}`}>{label}</label>
      <input id={`d-${field}`} type="date" value={value ?? ''} disabled={props.readOnly}
        onChange={e => props.onEdit({ kind: 'date', field, value: (e.target as HTMLInputElement).value || null })} />
    </div>
  );

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <PageEyebrow page="launch" />
          <h1>{launch.name}</h1>
          <p class="muted" style="margin-top: 6px">물량 템플릿 세 가지({MODE_LABEL.MIN} · {MODE_LABEL.TARGET} · {MODE_LABEL.STRETCH})를 골라 보며, 아트 작업이 언제 끝나는지와 어느 파트가 막히는지 확인합니다.</p>
        </div>
        <div class="dates">
          {date('start_date', '작업 시작', launch.startDate)}
          {date('freeze_date', '제작 완료 목표', launch.freezeDate, true)}
          {date('release_date', '출시', launch.releaseDate)}
        </div>
      </header>

      {errors.length > 0 && (
        <div class="banner bad" role="alert">
          <IconAlert />
          <div>
            <b>계산할 수 없습니다 · 고칠 곳 {errors.length}개</b>
            <ul class="small">{errors.slice(0, 6).map(f => <li>{humanKey(f.key, allNames)} — {f.title} ({f.detail})</li>)}</ul>
            {errors.length > 6 && <p class="small muted">나머지는 데이터 점검에서 볼 수 있습니다.</p>}
          </div>
        </div>
      )}

      {(compare.blocked || compare.modes.length === 0) && (
        <div class="segmented wide" role="radiogroup" aria-label="물량 템플릿" style="margin-bottom: 4px">
          {(['MIN', 'TARGET', 'STRETCH'] as PlanMode[]).map(m => (
            <button type="button" role="radio" aria-checked={props.planMode === m} class={props.planMode === m ? 'on' : ''} onClick={() => props.setPlanMode(m)}>{MODE_LABEL[m]}</button>
          ))}
        </div>
      )}
      {!compare.blocked && compare.modes.length > 0 && (
        <>
          <ModeCards modes={compare.modes} selected={props.planMode} onSelect={props.setPlanMode} deadlineLabel={deadlineLabel} horizonEnd={snapshot.horizon.end} />
          <div class="grid-2">
            <PartLoad mode={selected} />
            <Reverse planMode={props.planMode} version={props.version} names={names} resNames={resNames} deadlineLabel={deadlineLabel} />
          </div>
        </>
      )}

      <VolumeTable
        updateId={launch.updateId}
        rows={snapshot.rows}
        addable={snapshot.addable}
        byResource={selected?.byResource ?? {}}
        totalDays={selected?.launchDays ?? 0}
        planMode={props.planMode}
        findings={compare.findings}
        blocked={compare.blocked}
        readOnly={props.readOnly}
        onEdit={props.onEdit}
        onCopy={props.onApply ? (from, to) => props.onApply!({ kind: 'copyQty', updateId: launch.updateId, from, to }) : undefined}
        onRename={props.onApply ? t => props.onApply!({ kind: 'modeName', mode: props.planMode, name: t }) : undefined}
        onSelectMode={props.setPlanMode}
      />
      <p class="small faint">계산 {fmtDays(compare.ms)}ms · 데이터 버전 {snapshot.dataVersion}</p>
    </div>
  );
}
