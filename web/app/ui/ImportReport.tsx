// 가져오기 보고서: 무엇을 얼마나 가져왔고, 무엇을 바꾸거나 건너뛰었는지
import { useState } from 'preact/hooks';
import type { ImportReport as Report } from '../../../core/import-legacy.ts';
import type { Finding } from '../../../core/pipeline.ts';
import { fmtInt } from '../lib/format.ts';
import { IconX, IconSave, IconAlert, IconCheck } from './icons.tsx';

const LABEL: Record<string, string> = {
  parts: '파트', resource_groups: '리소스 분류', resource_types: '리소스 종류', efforts: '공수', update_types: '업데이트 유형',
  type_templates: '유형 템플릿 물량', updates: '업데이트', volumes: '물량', progress: '작업 진척', capacity: '인력(파트×달)', holidays: '휴일',
};

export function ImportReport(props: { report: Report; findings: Finding[]; onSave: () => void; onClose: () => void; onCheck: () => void }) {
  const r = props.report;
  const [showSkipped, setShowSkipped] = useState(r.skipped.length <= 5);
  const errors = props.findings.filter(f => f.level === 'ERROR').length;
  const warns = props.findings.filter(f => f.level === 'WARN').length;
  return (
    <div class="overlay">
      <div class="card dialog wide" role="dialog" aria-label="가져오기 보고서">
        <div class="dialog-head">
          <div><h2>엑셀에서 가져왔습니다</h2><p class="small muted" style="margin-top: 2px">계획 기간 {r.horizon?.start} ~ {r.horizon?.end} · 아직 저장하지 않았습니다</p></div>
          <button type="button" class="btn ghost icon-btn" aria-label="닫기" onClick={props.onClose}><IconX /></button>
        </div>
        <div class="drawer-body" style="max-height: min(70vh, 640px)">
          <div class="summary import-counts">
            {Object.entries(LABEL).filter(([k]) => r.counts[k] != null).map(([k, label]) => (
              <div><span class="faint small">{label}</span><b>{fmtInt(r.counts[k])}</b></div>
            ))}
          </div>
          {errors > 0
            ? <div class="banner bad"><IconAlert /><div><b>계산 전에 고칠 곳 {errors}개</b><p class="small muted">데이터 점검에서 수정할 곳과 방법을 볼 수 있습니다.{warns ? ` 주의 ${warns}개도 있습니다.` : ''}</p>
              <button type="button" class="btn sm" style="margin-top: 8px" onClick={props.onCheck}>데이터 점검 보기</button></div></div>
            : <div class="banner ok"><IconCheck /><div><b>바로 계산할 수 있습니다</b>{warns > 0 && <p class="small muted">주의 {warns}개는 데이터 점검에서 볼 수 있습니다.</p>}</div></div>}
          <section>
            <h3 class="sub">자동으로 바꾸거나 채운 것 ({r.adjustments.length})</h3>
            <ul class="report-list">{r.adjustments.map(a => <li>{a}</li>)}</ul>
          </section>
          {r.skipped.length > 0 && (
            <section>
              <h3 class="sub">건너뛴 행 ({r.skipped.length})</h3>
              {showSkipped
                ? <ul class="report-list">{r.skipped.map(a => <li>{a}</li>)}</ul>
                : <button type="button" class="btn sm ghost" onClick={() => setShowSkipped(true)}>{r.skipped.length}개 보기</button>}
            </section>
          )}
          {r.ignoredSheets.length > 0 && (
            <section>
              <h3 class="sub">가져오지 않은 시트 ({r.ignoredSheets.length})</h3>
              <ul class="report-list faint">{r.ignoredSheets.map(a => <li>{a}</li>)}</ul>
            </section>
          )}
        </div>
        <div class="wizard-foot">
          <button type="button" class="btn ghost" onClick={props.onClose}>나중에 저장</button>
          <button type="button" class="btn primary" onClick={props.onSave}><IconSave />저장 위치 고르기</button>
        </div>
      </div>
    </div>
  );
}
