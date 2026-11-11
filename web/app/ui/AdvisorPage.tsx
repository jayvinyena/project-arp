// 마감 맞추기: 모든 업데이트가 마감을 지키도록 인원·외주·물량·우선순위를 어떻게 바꿀지 제안하고, 시나리오로 만든다
import { UPDATE_STATUS } from '../lib/terms.ts';
import { useState, useEffect } from 'preact/hooks';
import { PageEyebrow } from './Help.tsx';
import { rpc } from '../lib/rpc.ts';
import type { AdvisorResult, AdvisorOptions, Outcome } from '../../../core/advisor.ts';
import type { PlanMode } from '../../../engine/types.ts';
import { fmtDays, fmtInt, fmtShortDate, fmtWorkdays } from '../lib/format.ts';
import { ModeSwitch } from './PlanPage.tsx';
import { IconAlert, IconCheck, IconSliders, IconSpark } from './icons.tsx';

type Lever = 'headcount' | 'outsource' | 'volume' | 'priority';
const LEVERS: { key: Lever; label: string; help: string }[] = [
  { key: 'headcount', label: '인원 늘리기', help: '늦는 업데이트의 시작 ~ 마감 달에 파트 인원을 0.5명씩' },
  { key: 'outsource', label: '외주 맡기기', help: '같은 기간에 파트 외주를 달마다 10인·일씩' },
  { key: 'volume', label: '물량 줄이기', help: '선택 리소스부터, 다음은 모든 리소스를 최소안 물량으로' },
  { key: 'priority', label: '우선순위 바꾸기', help: '앞 업데이트에 여유가 있을 때만 순서를 변경합니다' },
];
const KIND_TEXT: Record<string, string> = { headcount: '인원', outsource: '외주', volumeToMin: '물량', priority: '순서' };

function Result(props: { o: Outcome; showLate: boolean }) {
  const { o } = props;
  if (o.unfinished) return <span class="pill bad" data-icon={UPDATE_STATUS.UNFINISHED.icon}>{UPDATE_STATUS.UNFINISHED.text}</span>;
  if (o.late > 0) return <span class="pill bad" data-icon={UPDATE_STATUS.LATE.icon}>{fmtShortDate(o.completion)} · {UPDATE_STATUS.LATE.text} {fmtWorkdays(o.late)}</span>;
  if (!o.deadline) return <span class="pill plain">{fmtShortDate(o.completion)} · 마감 없음</span>;
  return <span class="pill ok" data-icon={UPDATE_STATUS.ON_TRACK.icon}>{fmtShortDate(o.completion)}{props.showLate ? ` · ${UPDATE_STATUS.ON_TRACK.text}` : ''}</span>;
}

export function AdvisorPage(props: {
  version: number; planMode: PlanMode; setPlanMode: (m: PlanMode) => void; readOnly: boolean;
  onMakeScenario: (name: string, actions: AdvisorResult['actions']) => Promise<boolean>;
}) {
  const [deadline, setDeadline] = useState<'freeze' | 'release'>('freeze');
  const [levers, setLevers] = useState<Record<Lever, boolean>>({ headcount: true, outsource: false, volume: true, priority: true });
  const [maxHeads, setMaxHeads] = useState(5);
  const [maxOut, setMaxOut] = useState(40);
  const [result, setResult] = useState<AdvisorResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [making, setMaking] = useState(false);

  const options: AdvisorOptions = { planMode: props.planMode, deadline, levers, maxHeadsPerPart: maxHeads, maxOutsourceDays: maxOut };
  const key = JSON.stringify(options);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    rpc.advise(options)
      .then(r => { if (live) setResult(r); })
      .catch(e => { if (live) { setResult(null); setError((e as Error).message); } })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [props.version, key]);

  const r = result;
  const anyLever = Object.values(levers).some(Boolean);
  const lateBefore = r ? r.before.filter(o => o.late > 0).length : 0;
  const lateAfter = r ? r.after.filter(o => o.late > 0).length : 0;
  const make = async () => {
    if (!r) return;
    setMaking(true);
    const d = new Date();
    const stamp = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    await props.onMakeScenario(`마감 맞춤 ${stamp}`, r.actions);
    setMaking(false);
  };

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <PageEyebrow page="advisor" />
          <h1>모든 업데이트가 마감을 지키려면</h1>
          <p class="muted" style="margin-top: 6px">늦는 업데이트부터 허용한 수단을 조금씩 써 보고, 적게 바꾸면서 많이 당기는 쪽을 선택합니다. 다른 업데이트를 늦추면서 맞추지는 않습니다.</p>
        </div>
        <ModeSwitch value={props.planMode} onChange={props.setPlanMode} />
      </header>

      <section class="card">
        <div class="card-head"><div><h2>조건</h2><p class="small muted" style="margin-top: 2px">바꿔도 되는 것만 켜 두십시오. 변경하면 바로 다시 계산합니다.</p></div></div>
        <div class="card-body advisor-cond">
          <div class="form-row">
            <span class="form-label">맞출 날</span>
            <div class="segmented wide" role="radiogroup" aria-label="맞출 날">
              <button type="button" role="radio" aria-checked={deadline === 'freeze'} class={deadline === 'freeze' ? 'on' : ''} onClick={() => setDeadline('freeze')}>제작 완료 목표일</button>
              <button type="button" role="radio" aria-checked={deadline === 'release'} class={deadline === 'release' ? 'on' : ''} onClick={() => setDeadline('release')}>출시일</button>
            </div>
          </div>
          <div class="lever-grid">
            {LEVERS.map(l => (
              <label class={`lever${levers[l.key] ? ' on' : ''}`}>
                <input type="checkbox" checked={levers[l.key]} aria-label={l.label} onChange={() => setLevers({ ...levers, [l.key]: !levers[l.key] })} />
                <span><b>{l.label}</b><span class="small muted">{l.help}</span></span>
                {l.key === 'headcount' && levers.headcount && (
                  <span class="lever-cap small" onClick={e => e.preventDefault()}>파트마다 최대 +
                    <input class="field narrow n" type="number" min="0.5" step="0.5" aria-label="인원 상한" value={maxHeads}
                      onChange={e => { const v = Number((e.target as HTMLInputElement).value); if (v > 0) setMaxHeads(v); }} />명</span>
                )}
                {l.key === 'outsource' && levers.outsource && (
                  <span class="lever-cap small" onClick={e => e.preventDefault()}>파트·달마다 최대 +
                    <input class="field narrow n" type="number" min="10" step="10" aria-label="외주 상한" value={maxOut}
                      onChange={e => { const v = Number((e.target as HTMLInputElement).value); if (v > 0) setMaxOut(v); }} />인·일</span>
                )}
              </label>
            ))}
          </div>
        </div>
      </section>

      {error && <div class="banner bad"><IconAlert /><div><b>계산하지 못했습니다</b><p class="small muted">{error}</p></div></div>}
      {!r && !error && <p class="muted">계산 중…</p>}

      {r && (
        <div class={`stack${busy ? ' busy' : ''}`} aria-busy={busy}>
          {r.alreadyOk ? (
            <div class="banner ok" role="status"><IconCheck /><div><b>모든 업데이트가 이미 {deadline === 'freeze' ? '제작 완료 목표일' : '출시일'}을, 모든 배치가 마감일을 지킵니다</b><p class="small muted">바꿀 것이 없습니다.</p></div></div>
          ) : r.feasible ? (
            <div class="banner ok advisor-verdict" role="status"><IconSpark /><div style="flex: 1"><b>{r.steps.length}걸음을 바꾸면 늦던 {lateBefore}개가 모두 마감을 지킵니다</b>
              <p class="small muted">시나리오로 만들어 시뮬레이션에서 비교한 뒤 원본에 반영할 수 있습니다.</p></div>
              {!props.readOnly && <button class="btn primary" disabled={making || busy} onClick={() => void make()}><IconSliders />시나리오로 만들기</button>}
            </div>
          ) : (
            <div class="banner warn advisor-verdict" role="status"><IconAlert /><div style="flex: 1"><b>{anyLever ? `다 맞추지는 못했습니다 · 늦던 ${lateBefore}개 중 ${lateAfter}개가 남습니다` : '켜 둔 수단이 없습니다'}</b>
              <p class="small muted">{anyLever ? '상한을 올리거나 다른 수단을 켜십시오. 할 수 있는 만큼 당긴 제안도 시나리오로 만들 수 있습니다.' : '조건에서 바꿔도 되는 수단을 하나 이상 켜십시오.'}</p></div>
              {!props.readOnly && r.actions.length > 0 && <button class="btn" disabled={making || busy} onClick={() => void make()}><IconSliders />시나리오로 만들기</button>}
            </div>
          )}

          {!r.alreadyOk && (
            <div class="summary advisor-totals">
              <div><span class="small faint">더하는 인원</span><b>{fmtDays(r.totals.extraHeadMonths)}<span class="small muted"> 인·월</span></b></div>
              <div><span class="small faint">외주</span><b>{fmtInt(r.totals.outsourceDays)}<span class="small muted"> 인·일</span></b></div>
              <div><span class="small faint">줄이는 물량</span><b>{fmtInt(r.totals.cutUnits)}<span class="small muted"> 개</span></b></div>
              <div><span class="small faint">순서가 바뀌는 업데이트</span><b>{fmtInt(r.totals.reprioritized)}<span class="small muted"> 개</span></b></div>
            </div>
          )}

          <section class="card">
            <div class="card-head"><div><h2>업데이트별 완료 예정</h2><p class="small muted" style="margin-top: 2px">마감 = {deadline === 'freeze' ? '제작 완료 목표일(없으면 출시일)' : '출시일'} · 늦음은 영업일</p></div></div>
            <div class="card-body" style="padding-top: 8px">
              <div class="table-wrap">
                <table class="grid advisor-table">
                  <thead><tr><th>업데이트</th><th>마감</th><th>지금</th><th>제안대로 하면</th></tr></thead>
                  <tbody>
                    {r.before.map(b => {
                      const a = r.after.find(x => x.key === b.key)!;
                      return (
                        <tr class="row">
                          <td><b>{b.name}</b></td>
                          <td class="num">{fmtShortDate(b.deadline)}</td>
                          <td><Result o={b} showLate={false} /></td>
                          <td><Result o={a} showLate={b.late > 0} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {r.steps.length > 0 && (
            <section class="card">
              <div class="card-head"><div><h2>바꾸는 순서</h2><p class="small muted" style="margin-top: 2px">앞 걸음부터 효과가 큽니다. 시나리오에는 파트·기간별로 합쳐서 {r.actions.length}개 동작으로 들어갑니다.</p></div></div>
              <div class="card-body" style="padding-top: 8px">
                <ol class="advice-steps">
                  {r.steps.map(s => (
                    <li>
                      <span class={`tag kind-${s.kind}`}>{KIND_TEXT[s.kind]}</span>
                      <span class="advice-label">{s.label}</span>
                      <span class="small muted">{s.forUpdate}</span>
                      <span class="delta good">{s.rescued ? `기간 안으로 ${s.rescued}개` : s.days > 0 ? fmtWorkdays(-s.days) : '남은 일 줄임'}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          )}

          {r.stuck.length > 0 && (
            <section class="card">
              <div class="card-head"><div><h2>못 맞춘 업데이트</h2></div></div>
              <div class="card-body" style="padding-top: 8px">
                <ul class="report-list">
                  {r.stuck.map(s => <li><b>{s.name}</b> <span class="muted">— {s.why}</span></li>)}
                </ul>
              </div>
            </section>
          )}
          <p class="small faint">엔진 계산 {fmtInt(r.runs)}번 · {fmtInt(Math.round(r.ms))}ms{r.limited ? ' · 계산 상한에 닿아 멈췄습니다' : ''}</p>
        </div>
      )}
    </div>
  );
}
