// 공용 창(docs/34 T4): 모든 창이 같은 규칙으로 동작한다.
//   aria-modal · 열 때 창(또는 data-autofocus 칸)에 초점 · Tab은 창 안에서만 돈다 · Esc로 닫기 · 닫으면 연 자리로 초점이 돌아간다.
//   바깥(어두운 곳)을 누르면 닫기(backdrop = false면 닫지 않음 — 가져오기처럼 실수로 닫히면 안 되는 창).
import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog(props: {
  label: string; onClose?: () => void; class?: string; children: ComponentChildren;
  /** 바깥을 누르면 닫는다(기본 예) */
  backdrop?: boolean;
  /** 옆에서 나오는 서랍(안내 · 상세) */
  as?: 'div' | 'aside';
}) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const before = document.activeElement as HTMLElement | null;
    // 기본은 창 자체에(칸이 많은 창에서 실수로 입력이 시작되지 않게). data-autofocus를 단 칸이 있으면 그 칸에
    const first = el.querySelector<HTMLElement>('[data-autofocus]');
    (first ?? el).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      // 창 안에 또 창이 열려 있으면 맨 위 창만 반응한다
      const top = [...document.querySelectorAll('[aria-modal="true"]')].pop();
      if (top !== el) return;
      if (e.key === 'Escape') {
        // 입력 칸 안의 Esc는 칸 편집 취소가 먼저(칸이 처리하고 초점이 빠진 뒤 한 번 더 누르면 닫힘)
        const t = e.target as HTMLElement;
        if (t.closest?.('input:not([type=checkbox]):not([type=radio]), textarea, select')) return;
        if (close.current) { e.preventDefault(); e.stopPropagation(); close.current(); }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(x => x.offsetParent !== null);
      if (!items.length) { e.preventDefault(); el.focus(); return; }
      const a = items[0];
      const z = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === a || document.activeElement === el)) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, []);
  const Tag = (props.as ?? 'div') as 'div';
  const cls = props.as === 'aside' ? props.class ?? 'drawer card' : `card dialog${props.class ? ` ${props.class}` : ''}`;
  return (
    <div class="overlay" onClick={e => { if (e.target === e.currentTarget && props.backdrop !== false && props.onClose) props.onClose(); }}>
      <Tag ref={ref as never} class={cls} role="dialog" aria-modal="true" aria-label={props.label} tabIndex={-1}>
        {props.children}
      </Tag>
    </div>
  );
}
