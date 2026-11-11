// 새 프로젝트 마법사: 기본 정보 → 파트 → 리소스 → 런칭
import { useState } from 'preact/hooks';
import type { NewProjectInput, NewPart, NewResource, InputProblem } from '../../../core/new-project.ts';
import { defaultNewProject, checkNewProject, fixedKoreanHolidays, monthsBetween } from '../../../core/new-project.ts';
import { IconLogo, IconPlus, IconX, IconAlert } from './icons.tsx';

const STEPS: { key: InputProblem['step']; label: string }[] = [
  { key: 'basic', label: '기본 정보' },
  { key: 'parts', label: '파트' },
  { key: 'resources', label: '리소스' },
  { key: 'launch', label: '런칭' },
];
const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

const num = (v: string): number => (v.trim() === '' ? NaN : Number(v));
const pct = (r: number) => (Number.isFinite(r) ? String(Math.round(r * 1000) / 10) : '');

function Problems(props: { list: InputProblem[] }) {
  if (!props.list.length) return null;
  return (
    <div class="banner bad" role="alert">
      <IconAlert />
      <div><b>고칠 곳이 있습니다</b><ul class="small">{props.list.map(p => <li>{p.message}</li>)}</ul></div>
    </div>
  );
}

function Basic(props: { v: NewProjectInput; set: (p: Partial<NewProjectInput>) => void }) {
  const { v, set } = props;
  const [usePublic, setUsePublic] = useState(v.holidays.some(h => h.kind === 'PUBLIC'));
  const [company, setCompany] = useState({ date: '', name: '' });
  const months = /^\d{4}-\d{2}$/.test(v.horizonStart) && /^\d{4}-\d{2}$/.test(v.horizonEnd) && v.horizonEnd >= v.horizonStart
    ? monthsBetween(v.horizonStart, v.horizonEnd).length : 0;
  const companyDays = v.holidays.filter(h => h.kind === 'COMPANY');
  const withPublic = (on: boolean, start = v.horizonStart, end = v.horizonEnd) =>
    [...(on && /^\d{4}-\d{2}$/.test(start) && /^\d{4}-\d{2}$/.test(end) ? fixedKoreanHolidays(start, end) : []), ...companyDays];
  const setHorizon = (start: string, end: string) => set({ horizonStart: start, horizonEnd: end, holidays: withPublic(usePublic, start, end) });

  return (
    <div class="form">
      <label class="form-row">
        <span class="form-label">프로젝트 이름</span>
        <input class="field" value={v.name} onInput={e => set({ name: (e.target as HTMLInputElement).value })} />
      </label>
      <div class="form-row">
        <span class="form-label">계획 기간</span>
        <div class="inline">
          <input class="field" type="month" aria-label="계획 시작 달" value={v.horizonStart} onInput={e => setHorizon((e.target as HTMLInputElement).value, v.horizonEnd)} />
          <span class="faint">~</span>
          <input class="field" type="month" aria-label="계획 끝 달" value={v.horizonEnd} onInput={e => setHorizon(v.horizonStart, (e.target as HTMLInputElement).value)} />
          {months > 0 && <span class="tag">{months}개월</span>}
        </div>
        <span class="form-help">인력은 이 기간의 모든 달에 만들어집니다. 최대 60개월.</span>
      </div>
      <div class="form-row">
        <span class="form-label">근무 요일</span>
        <div class="segmented" role="group" aria-label="근무 요일">
          {WEEKDAYS.map((d, i) => (
            <button type="button" class={v.workWeekdays[i] === '1' ? 'on' : ''} aria-pressed={v.workWeekdays[i] === '1'}
              onClick={() => set({ workWeekdays: v.workWeekdays.split('').map((c, j) => (j === i ? (c === '1' ? '0' : '1') : c)).join('') })}>{d}</button>
          ))}
        </div>
      </div>
      <label class="form-row">
        <span class="form-label">여유율</span>
        <div class="inline"><input class="field narrow" inputMode="decimal" value={pct(v.bufferRate)} onInput={e => set({ bufferRate: num((e.target as HTMLInputElement).value) / 100 })} /><span class="faint">%</span></div>
        <span class="form-help">예상 못 한 일을 위해 모든 필요 공수에 더합니다.</span>
      </label>
      <div class="form-row">
        <span class="form-label">휴일</span>
        <label class="check">
          <input type="checkbox" checked={usePublic} onChange={e => { const on = (e.target as HTMLInputElement).checked; setUsePublic(on); set({ holidays: withPublic(on) }); }} />
          날짜가 고정된 공휴일 넣기 <span class="faint">({v.holidays.filter(h => h.kind === 'PUBLIC').length}일)</span>
        </label>
        <span class="form-help">설·추석·대체 공휴일은 해마다 날짜가 달라 아래에 직접 입력하십시오.</span>
        <div class="inline">
          <input class="field" type="date" aria-label="휴무일 날짜" value={company.date} onInput={e => setCompany({ ...company, date: (e.target as HTMLInputElement).value })} />
          <input class="field" placeholder="이름 (예: 창립기념일)" aria-label="휴무일 이름" value={company.name} onInput={e => setCompany({ ...company, name: (e.target as HTMLInputElement).value })} />
          <button type="button" class="btn sm" disabled={!company.date} onClick={() => {
            set({ holidays: [...v.holidays.filter(h => h.date !== company.date), { date: company.date, name: company.name.trim() || '휴무일', kind: 'COMPANY' }] });
            setCompany({ date: '', name: '' });
          }}><IconPlus />더하기</button>
        </div>
        {companyDays.length > 0 && (
          <div class="chips">{companyDays.map(h => (
            <span class="tag">{h.date} {h.name}
              <button type="button" class="chip-x" aria-label={`${h.name} 빼기`} onClick={() => set({ holidays: v.holidays.filter(x => x !== h) })}><IconX /></button>
            </span>
          ))}</div>
        )}
      </div>
    </div>
  );
}

function Parts(props: { v: NewProjectInput; set: (p: Partial<NewProjectInput>) => void }) {
  const { v, set } = props;
  const update = (i: number, patch: Partial<NewPart>) => set({ parts: v.parts.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= v.parts.length) return;
    const swap = <T,>(arr: T[]) => { const a = [...arr]; [a[i], a[j]] = [a[j], a[i]]; return a; };
    set({ parts: swap(v.parts), resources: v.resources.map(r => ({ ...r, efforts: swap(r.efforts) })) });
  };
  const remove = (i: number) => set({ parts: v.parts.filter((_, j) => j !== i), resources: v.resources.map(r => ({ ...r, efforts: r.efforts.filter((_, j) => j !== i) })) });
  const add = () => set({ parts: [...v.parts, { name: '', headcount: 1, utilization: 0.8 }], resources: v.resources.map(r => ({ ...r, efforts: [...r.efforts, null] })) });
  return (
    <div class="form">
      <p class="muted">공정 순서대로 입력하십시오. 리소스는 위에서 아래 순서로 파트를 거칩니다.</p>
      <div class="table-wrap">
        <table class="grid edit">
          <thead><tr><th style="width: 40px">순서</th><th>파트 이름</th><th class="n">인원</th><th class="n">가동률</th><th style="width: 120px" /></tr></thead>
          <tbody>
            {v.parts.map((p, i) => (
              <tr class="row">
                <td class="faint num">{i + 1}</td>
                <td><input class="field" aria-label={`${i + 1}번째 파트 이름`} value={p.name} onInput={e => update(i, { name: (e.target as HTMLInputElement).value })} /></td>
                <td class="n"><input class="field narrow n" inputMode="decimal" aria-label={`${p.name || i + 1} 인원`} value={Number.isFinite(p.headcount) ? String(p.headcount) : ''} onInput={e => update(i, { headcount: num((e.target as HTMLInputElement).value) })} /> <span class="faint">명</span></td>
                <td class="n"><input class="field narrow n" inputMode="decimal" aria-label={`${p.name || i + 1} 가동률`} value={pct(p.utilization)} onInput={e => update(i, { utilization: num((e.target as HTMLInputElement).value) / 100 })} /> <span class="faint">%</span></td>
                <td class="n">
                  <button type="button" class="btn ghost icon-btn" aria-label="위로" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" class="btn ghost icon-btn" aria-label="아래로" disabled={i === v.parts.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" class="btn ghost icon-btn" aria-label={`${p.name || i + 1} 빼기`} onClick={() => remove(i)}><IconX /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div><button type="button" class="btn sm" onClick={add}><IconPlus />파트 더하기</button></div>
      <p class="form-help">인원·가동률은 모든 달에 같은 값으로 들어갑니다. 채용·충원 같은 달별 변화는 만든 뒤 수정할 수 있습니다.</p>
    </div>
  );
}

function Resources(props: { v: NewProjectInput; set: (p: Partial<NewProjectInput>) => void }) {
  const { v, set } = props;
  const update = (i: number, patch: Partial<NewResource>) => set({ resources: v.resources.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const groups = [...new Set(v.resources.map(r => r.group).filter(Boolean))];
  return (
    <div class="form">
      <p class="muted">리소스 1개를 그 파트가 만드는 데 드는 <b>인·일</b>을 입력하십시오. 거치지 않는 파트는 비워 두십시오.</p>
      <datalist id="np-groups">{groups.map(g => <option value={g} />)}</datalist>
      <div class="table-wrap">
        <table class="grid edit">
          <thead><tr><th>분류</th><th>리소스 이름</th>{v.parts.map(p => <th class="n">{p.name || '이름 없음'}</th>)}<th style="width: 44px" /></tr></thead>
          <tbody>
            {v.resources.map((r, i) => (
              <tr class="row">
                <td><input class="field" list="np-groups" aria-label={`${i + 1}번째 리소스 분류`} value={r.group} onInput={e => update(i, { group: (e.target as HTMLInputElement).value })} /></td>
                <td><input class="field" aria-label={`${i + 1}번째 리소스 이름`} value={r.name} onInput={e => update(i, { name: (e.target as HTMLInputElement).value })} /></td>
                {v.parts.map((p, pi) => (
                  <td class="n">
                    <input class="field narrow n" inputMode="decimal" placeholder="—" aria-label={`${r.name || i + 1} ${p.name} 공수`}
                      value={r.efforts[pi] == null ? '' : String(r.efforts[pi])}
                      onInput={e => {
                        const t = (e.target as HTMLInputElement).value.trim();
                        update(i, { efforts: r.efforts.map((x, j) => (j === pi ? (t === '' ? null : Number(t)) : x)) });
                      }} />
                  </td>
                ))}
                <td class="n"><button type="button" class="btn ghost icon-btn" aria-label={`${r.name || i + 1} 빼기`} onClick={() => set({ resources: v.resources.filter((_, j) => j !== i) })}><IconX /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div><button type="button" class="btn sm" onClick={() => set({ resources: [...v.resources, { group: groups[groups.length - 1] ?? '', name: '', efforts: v.parts.map(() => null) }] })}><IconPlus />리소스 더하기</button></div>
    </div>
  );
}

function Launch(props: { v: NewProjectInput; set: (p: Partial<NewProjectInput>) => void }) {
  const { v, set } = props;
  const l = v.launch;
  const months = v.horizonEnd >= v.horizonStart ? monthsBetween(v.horizonStart, v.horizonEnd).length : 0;
  return (
    <div class="form">
      <label class="check">
        <input type="checkbox" checked={!!l} onChange={e => set({ launch: (e.target as HTMLInputElement).checked ? (defaultNewProject().launch) : null })} />
        런칭 계획을 지금 만들기
      </label>
      {l && (
        <>
          <label class="form-row">
            <span class="form-label">런칭 이름</span>
            <input class="field" value={l.name} onInput={e => set({ launch: { ...l, name: (e.target as HTMLInputElement).value } })} />
          </label>
          <div class="form-row">
            <span class="form-label">날짜</span>
            <div class="dates">
              {([['startDate', '작업 시작'], ['freezeDate', '제작 완료 목표'], ['releaseDate', '출시']] as const).map(([k, label]) => (
                <div class={`date-chip${k === 'freezeDate' ? ' key' : ''}`}>
                  <label for={`np-${k}`}>{label}</label>
                  <input id={`np-${k}`} type="date" value={l[k] ?? ''} onInput={e => set({ launch: { ...l, [k]: (e.target as HTMLInputElement).value || (k === 'freezeDate' ? null : '') } })} />
                </div>
              ))}
            </div>
            <span class="form-help">물량은 만든 뒤 런칭 물량 설계 화면에서 입력합니다. 처음엔 모두 0입니다.</span>
          </div>
        </>
      )}
      <div class="summary">
        <div><span class="faint small">계획 기간</span><b>{months}개월</b></div>
        <div><span class="faint small">파트</span><b>{v.parts.length}개</b></div>
        <div><span class="faint small">리소스 종류</span><b>{v.resources.length}개</b></div>
        <div><span class="faint small">휴일</span><b>{v.holidays.length}일</b></div>
      </div>
    </div>
  );
}

export function NewProject(props: { onCancel: () => void; onCreate: (input: NewProjectInput) => Promise<void> }) {
  const [v, setV] = useState<NewProjectInput>(() => defaultNewProject());
  const [step, setStep] = useState(0);
  const [shown, setShown] = useState<InputProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<NewProjectInput>) => { setV(prev => ({ ...prev, ...patch })); setShown([]); };
  const problemsAt = (i: number) => checkNewProject(v).filter(p => p.step === STEPS[i].key);

  const next = async () => {
    const here = problemsAt(step);
    if (here.length) { setShown(here); return; }
    if (step < STEPS.length - 1) { setStep(step + 1); setShown([]); return; }
    const all = checkNewProject(v);
    if (all.length) { setShown(all); setStep(STEPS.findIndex(s => s.key === all[0].step)); return; }
    setBusy(true);
    try { await props.onCreate(v); } finally { setBusy(false); }
  };

  return (
    <div class="welcome">
      <div class="card wizard">
        <div class="wizard-head">
          <div class="brand"><span class="brand-mark"><IconLogo /></span>새 프로젝트</div>
          <ol class="stepper">
            {STEPS.map((s, i) => (
              <li class={i === step ? 'active' : i < step ? 'done' : ''}>
                <button type="button" disabled={i > step} onClick={() => { setStep(i); setShown([]); }}>
                  <span class="step-no">{i < step ? '✓' : i + 1}</span>{s.label}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div class="wizard-body">
          <h1 style="font-size: 22px">{STEPS[step].label}</h1>
          <Problems list={shown} />
          {step === 0 && <Basic v={v} set={set} />}
          {step === 1 && <Parts v={v} set={set} />}
          {step === 2 && <Resources v={v} set={set} />}
          {step === 3 && <Launch v={v} set={set} />}
        </div>
        <div class="wizard-foot">
          <button type="button" class="btn ghost" onClick={props.onCancel}>그만두기</button>
          <div style="display: flex; gap: 8px">
            {step > 0 && <button type="button" class="btn" onClick={() => { setStep(step - 1); setShown([]); }}>이전</button>}
            <button type="button" class="btn primary" disabled={busy} onClick={() => void next()}>
              {step < STEPS.length - 1 ? '다음' : busy ? '만드는 중…' : '만들고 저장 위치 고르기'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
