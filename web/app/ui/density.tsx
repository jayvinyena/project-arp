// 표 줄 간격(보통 · 촘촘): 표마다 이 브라우저에 기억한다(docs/34 D2).
import { useState } from 'preact/hooks';

export function useDensity(key: string) {
  const store = `arp.density.${key}`;
  const [dense, setDense] = useState(() => { try { return localStorage.getItem(store) === 'dense'; } catch { return false; } });
  const pick = (d: boolean) => { setDense(d); try { localStorage.setItem(store, d ? 'dense' : 'normal'); } catch { /* 저장 못 해도 이번엔 바뀜 */ } };
  const toggle = (
    <div class="segmented mini density" role="radiogroup" aria-label="줄 간격">
      <button type="button" role="radio" aria-checked={!dense} class={dense ? '' : 'on'} onClick={() => pick(false)}>보통</button>
      <button type="button" role="radio" aria-checked={dense} class={dense ? 'on' : ''} onClick={() => pick(true)}>촘촘</button>
    </div>
  );
  return { dense, cls: dense ? ' dense' : '', toggle };
}
