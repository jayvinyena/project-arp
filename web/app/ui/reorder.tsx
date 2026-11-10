// 눌러서 끌어 순서 바꾸기(docs/27 4.3): 손잡이(⠿)를 누르면 바로, 행을 0.3초 길게 누르면 잡힌다.
// 끄는 동안 놓일 자리에 선을 그리고, 놓으면 새 순서 전체를 한 번에 넘긴다(이력 한 묶음). Esc = 취소.
// 키보드: 손잡이에 초점을 두고 ↑ · ↓(가로 목록은 ← · →)로 한 칸씩.
import { useState, useRef, useEffect } from 'preact/hooks';

const SKIP = 'input, select, textarea, a, button:not([data-reorder-handle]), label';

export interface Reorder {
  /** 잡은 항목 · 놓일 자리(0..n) */
  drag: { id: string; over: number } | null;
  /** 줄(또는 칩)에 펼쳐 넣는 속성 */
  item: (id: string) => Record<string, unknown>;
  /** 손잡이 단추 속성 */
  handle: (id: string, label: string) => Record<string, unknown>;
  /** 줄 class: dragging · drop-before · drop-after */
  cls: (id: string) => string;
}

export function useReorder(ids: string[], onReorder: (ids: string[]) => unknown, opts: { disabled?: boolean; axis?: 'y' | 'x'; delay?: number } = {}): Reorder {
  const axis = opts.axis ?? 'y';
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const press = useRef<{ id: string; x: number; y: number; timer: number; el: HTMLElement } | null>(null);
  const live = useRef<{ id: string; over: number } | null>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;

  const place = (id: string, over: number): string[] => {
    const list = idsRef.current.filter(x => x !== id);
    const from = idsRef.current.indexOf(id);
    const at = over > from ? over - 1 : over;
    list.splice(Math.max(0, Math.min(at, list.length)), 0, id);
    return list;
  };
  const overAt = (x: number, y: number, el: HTMLElement): number => {
    const box = el.closest('[data-reorder-box]') ?? el.parentElement!;
    const items = [...box.querySelectorAll<HTMLElement>('[data-reorder-id]')];
    const i = items.findIndex(it => { const r = it.getBoundingClientRect(); return axis === 'y' ? y < r.top + r.height / 2 : x < r.left + r.width / 2; });
    return i < 0 ? items.length : i;
  };
  const begin = (id: string) => {
    live.current = { id, over: idsRef.current.indexOf(id) };
    setDrag(live.current);
    document.body.classList.add('reordering');
  };
  const finish = (commit: boolean) => {
    const d = live.current;
    live.current = null;
    setDrag(null);
    document.body.classList.remove('reordering');
    if (!commit || !d) return;
    const next = place(d.id, d.over);
    if (next.join() !== idsRef.current.join()) void onReorder(next);
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (p && !live.current) {
        // 길게 누르기 전에 움직이면 끌기가 아니라 보통 동작(스크롤 · 글자 고르기)
        if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 6) { window.clearTimeout(p.timer); press.current = null; }
        return;
      }
      if (!live.current || !p) return;
      e.preventDefault();
      const over = overAt(e.clientX, e.clientY, p.el);
      if (over !== live.current.over) { live.current = { ...live.current, over }; setDrag(live.current); }
    };
    const up = () => {
      const p = press.current;
      if (p) window.clearTimeout(p.timer);
      press.current = null;
      if (live.current) finish(true);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && live.current) { press.current = null; finish(false); } };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); window.removeEventListener('keydown', key); };
  }, []);

  const start = (id: string, e: PointerEvent, immediate: boolean) => {
    if (opts.disabled || e.button !== 0 || live.current) return;
    const el = e.currentTarget as HTMLElement;
    const row = el.closest('[data-reorder-id]') as HTMLElement ?? el;
    const p = { id, x: e.clientX, y: e.clientY, timer: 0, el: row };
    press.current = p;
    if (immediate) { e.preventDefault(); begin(id); return; }
    p.timer = window.setTimeout(() => { if (press.current === p) begin(id); }, opts.delay ?? 300);
  };

  return {
    drag,
    item: (id: string) => ({
      'data-reorder-id': id,
      // 손잡이를 누른 것은 손잡이가 맡는다(줄의 길게 누르기 타이머를 또 걸면 끄는 도중 놓일 자리가 처음으로 돌아간다)
      onPointerDown: (e: PointerEvent) => { if ((e.target as HTMLElement).closest(`${SKIP}, [data-reorder-handle]`)) return; start(id, e, false); },
    }),
    handle: (id: string, label: string) => ({
      type: 'button', 'data-reorder-handle': '', class: 'reorder-handle', 'aria-label': `${label} 순서 옮기기(끌거나 ${axis === 'y' ? '↑ ↓' : '← →'})`, title: '끌어서 순서 바꾸기', disabled: opts.disabled,
      onPointerDown: (e: PointerEvent) => start(id, e, true),
      onKeyDown: (e: KeyboardEvent) => {
        const back = axis === 'y' ? 'ArrowUp' : 'ArrowLeft';
        const fwd = axis === 'y' ? 'ArrowDown' : 'ArrowRight';
        if (e.key !== back && e.key !== fwd) return;
        e.preventDefault();
        const i = idsRef.current.indexOf(id);
        const j = e.key === back ? i - 1 : i + 1;
        if (j < 0 || j >= idsRef.current.length) return;
        const next = idsRef.current.slice();
        [next[i], next[j]] = [next[j], next[i]];
        void onReorder(next);
      },
    }),
    cls: (id: string) => {
      if (!drag) return '';
      const i = ids.indexOf(id);
      const parts = [];
      if (drag.id === id) parts.push('dragging');
      if (drag.over === i && drag.id !== id && drag.over !== ids.indexOf(drag.id) + 1) parts.push('drop-before');
      if (i === ids.length - 1 && drag.over === ids.length && drag.id !== id) parts.push('drop-after');
      return parts.join(' ');
    },
  };
}

/** 손잡이 그림(⠿) */
export const Grip = () => (
  <svg class="icon grip" viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></g></svg>
);
