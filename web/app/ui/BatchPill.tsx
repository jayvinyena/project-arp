// 배치 판정 표시(docs/33): 업데이트 계획 · 현황판 · 에셋 배치 표가 함께 쓴다.
import type { BatchRow } from '../../../core/plan.ts';
import { fmtShortDate, fmtWorkdays } from '../lib/format.ts';
import { BATCH_STATUS } from '../lib/terms.ts';

export { BATCH_STATUS };

/** 판정 알약: 늦음이면 +영업일, 빠듯이면 여유 영업일. 물량 밖이면 따로 알약 */
export function BatchPill(props: { b: BatchRow }) {
  const s = BATCH_STATUS[props.b.status];
  const extra = props.b.status === 'LATE' && props.b.lateWorkdays ? ` ${fmtWorkdays(props.b.lateWorkdays)}` : props.b.status === 'TIGHT' && props.b.slackWorkdays != null ? ` 여유 ${fmtWorkdays(props.b.slackWorkdays, false)}` : '';
  return (
    <span class="batch-pills">
      <span class={`pill ${s.tone}`} data-icon={s.icon} title={props.b.reason ? `가장 늦게 끝나는 곳: ${props.b.reason.partName} · ${props.b.reason.resourceName}` : undefined}>{s.text}{extra}</span>
      {props.b.overQty > 0 && <span class="pill plain warn" title="배치 에셋이 물량보다 많아 계산에 넣지 못한 에셋 수입니다. 물량을 늘리거나 에셋을 줄이십시오">물량 밖 {props.b.overQty}</span>}
    </span>
  );
}

/** 완료 예정 글자: 날짜 또는 "기간 밖" */
export const batchWhen = (b: BatchRow) => (b.completion ? fmtShortDate(b.completion) : '기간 밖');
