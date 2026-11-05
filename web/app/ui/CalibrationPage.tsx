// 공수 보정: 실적(완료 + 실투입)으로 본 실제 공수와 기준 공수를 비교해 보정을 제안하고, 미리 보고, 적용한다
import { useState, useEffect } from 'preact/hooks';
import { rpc } from '../lib/rpc.ts';
import type { CalibrationView, CalibrationPreview } from '../../../core/calibration.ts';
import { fmtDays, fmtInt, fmtShortDate } from '../lib/format.ts';
import { IconSpark, IconAlert } from './icons.tsx';

const pct = (r: number) => `${r >= 1 ? '+' : '−'}${Math.abs(Math.round((r - 1) * 100))}%`;

export function CalibrationPage(props: { version: number; readOnly: boolean; onCalibrate: (picks: { resourceTypeId: string; partId: string; ratio: number }[]) => Promise<boolean>; onGoProgress: () => void }) {
  const [view, setView] = useState<CalibrationView | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<CalibrationPreview | null>(null);
  useEffect(() => {
    void rpc.calibration().then(v => {
      setView(v);
      setPicked(new Set(v.rows.filter(r => r.enough && Math.abs(r.ratio - 1) >= 0.05).map(r => `${r.resourceTypeId}|${r.partId}`)));
      setPreview(null);
    });
  }, [props.version]);
  if (!view) return <div class="page"><p class="muted">불러오는 중…</p></div>;
  const picks = view.rows.filter(r => picked.has(`${r.resourceTypeId}|${r.partId}`)).map(r => ({ resourceTypeId: r.resourceTypeId, partId: r.partId, ratio: r.ratio }));
  const toggle = (k: string) => { const s = new Set(picked); if (s.has(k)) s.delete(k); else s.add(k); setPicked(s); setPreview(null); };

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <div class="eyebrow">공수 보정</div>
          <h1>실적으로 공수 기준 다듬기</h1>
          <p class="muted" style="margin-top: 6px">진행 실적의 "완료 수량"과 "실투입 인·일"로 실제 공수를 구해 기준과 비교해요. 여유율은 빼고 비교해요.</p>
        </div>
      </header>

      {view.rows.length === 0 ? (
        <section class="card"><div class="card-body">
          <div class="banner warn"><IconAlert /><div><b>아직 비교할 실적이 없어요</b>
            <p class="small muted">진행 실적에서 완료 수량과 함께 "실투입 인·일"을 넣으면 여기서 보정을 제안해요.</p>
            <button class="btn sm" style="margin-top: 8px" onClick={props.onGoProgress}>진행 실적으로</button></div></div>
        </div></section>
      ) : (
        <>
          <div class="calib-parts">
            {view.parts.filter(p => p.ratio != null).map(p => (
              <section class="card calib-part">
                <span class="small faint">{p.name}</span>
                <b class={`num ${p.ratio! > 1.05 ? 'bad-ink' : p.ratio! < 0.95 ? 'ok-ink' : ''}`}>{pct(p.ratio!)}</b>
                <span class="small muted num">완료 {fmtInt(p.units)}개 · 실투입 {fmtDays(p.spentDays)} / 기준 {fmtDays(p.standardDays)}인·일</span>
              </section>
            ))}
          </div>

          <section class="card">
            <div class="card-head">
              <div><h2>리소스 · 파트별 제안</h2><p class="small muted" style="margin-top: 2px">배율 = 실투입 ÷ 기준. 근거가 충분한(완료 3개·실투입 5인·일 이상) 것을 미리 골라 두었어요.</p></div>
              <div class="inline">
                <button class="btn sm" disabled={!picks.length} onClick={async () => setPreview(await rpc.calibrationPreview(picks))}><IconSpark />미리 보기</button>
                {!props.readOnly && <button class="btn sm primary" disabled={!picks.length} onClick={async () => { if (await props.onCalibrate(picks)) setPreview(null); }}>{picks.length}개 적용</button>}
              </div>
            </div>
            <div class="card-body" style="padding-top: 8px">
              <div class="table-wrap">
                <table class="grid calib">
                  <thead><tr><th style="width: 36px" /><th>리소스</th><th>파트</th><th class="n">완료</th><th class="n">실투입 / 기준(인·일)</th><th class="n">배율</th><th class="n">공수 지금 → 제안</th><th>근거</th></tr></thead>
                  <tbody>
                    {view.rows.map(r => {
                      const k = `${r.resourceTypeId}|${r.partId}`;
                      return (
                        <tr class="row">
                          <td><input type="checkbox" aria-label={`${r.resourceName} ${r.partName} 고르기`} checked={picked.has(k)} disabled={props.readOnly} onChange={() => toggle(k)} /></td>
                          <td><b>{r.resourceName}</b></td>
                          <td>{r.partName}</td>
                          <td class="n num">{fmtInt(r.units)}개</td>
                          <td class="n num">{fmtDays(r.spentDays)} / {fmtDays(r.standardDays)}</td>
                          <td class="n"><span class={`delta ${r.ratio > 1.05 ? 'bad' : r.ratio < 0.95 ? 'good' : 'zero'}`}>{pct(r.ratio)}</span></td>
                          <td class="n num">{fmtDays(r.baseDays)} → <b>{fmtDays(r.suggestedBase)}</b></td>
                          <td>{r.enough ? <span class="pill ok">충분</span> : <span class="pill warn">적음</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {preview && (
                <div class="answer" style="margin-top: 14px">
                  <b>적용하면 · 목표안 완료 예정</b>
                  <div class="chips" style="margin-top: 6px">
                    {preview.updates.map(u => (
                      <span class="tag">{u.name} {u.before ? fmtShortDate(u.before) : '기간 밖'} → {u.after ? fmtShortDate(u.after) : '기간 밖'}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
