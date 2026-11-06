// 엑셀로 가져오기 창: ① 양식 받기(빈 양식 · 예시 양식) ② 규격 요약 ③ 채운 파일 선택
import { useEffect, useState } from 'preact/hooks';
import { specSummary } from '../../../core/import-spec.ts';
import { IconX, IconDownload, IconFolder } from './icons.tsx';

export function ImportGuide(props: {
  busy: boolean;
  onTemplate: (example: boolean) => Promise<void>;
  onPick: () => void;
  onClose: () => void;
}) {
  const [getting, setGetting] = useState<'' | 'blank' | 'example'>('');
  const rows = specSummary();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);
  const get = async (example: boolean) => {
    setGetting(example ? 'example' : 'blank');
    try { await props.onTemplate(example); } finally { setGetting(''); }
  };
  return (
    <div class="overlay" onClick={e => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="card dialog wide import-guide" role="dialog" aria-label="엑셀로 가져오기">
        <div class="dialog-head">
          <div><h2 style="font-size: 17px">엑셀로 가져오기</h2><p class="small muted" style="margin-top: 2px">정해진 양식에 데이터를 채워 새 프로젝트를 만듭니다.</p></div>
          <button type="button" class="btn ghost icon-btn" aria-label="닫기" onClick={props.onClose}><IconX /></button>
        </div>
        <div class="drawer-body import-steps">
          <section class="import-step">
            <span class="step-badge">1</span>
            <div class="import-step-body">
              <h3>양식 받기</h3>
              <p class="small muted">첫 시트 "안내"에 칸마다 형식과 설명이 있습니다. 예시 양식은 작은 예시 프로젝트가 채워져 있어 값을 바꿔 그대로 가져올 수 있습니다. 이미 있는 프로젝트는 앱 왼쪽 아래 "편집용 엑셀 내보내기"로 같은 양식을 받습니다.</p>
              <div class="inline" style="margin-top: 10px">
                <button type="button" class="btn" disabled={!!getting} onClick={() => void get(false)}><IconDownload />{getting === 'blank' ? '만드는 중…' : '빈 양식 받기'}</button>
                <button type="button" class="btn" disabled={!!getting} onClick={() => void get(true)}><IconDownload />{getting === 'example' ? '만드는 중…' : '예시 양식 받기'}</button>
              </div>
            </div>
          </section>
          <section class="import-step">
            <span class="step-badge">2</span>
            <div class="import-step-body">
              <h3>양식 채우기</h3>
              <p class="small muted">필수 시트 6개를 채웁니다. 시트 이름과 머리글은 바꾸지 않습니다(열 순서는 바꿔도 됩니다). ID는 시트 사이를 잇는 값입니다.</p>
              <div class="table-wrap" style="margin-top: 10px">
                <table class="grid spec-table">
                  <thead><tr><th>시트</th><th>구분</th><th>꼭 입력할 칸</th><th>내용</th></tr></thead>
                  <tbody>
                    {rows.map(r => (
                      <tr class={`row${r.required ? '' : ' muted-row'}`}>
                        <td><b>{r.name}</b></td>
                        <td>{r.required ? <span class="pill accent plain">필수</span> : <span class="pill plain">선택</span>}</td>
                        <td class="small">{r.columns.join(' · ')}</td>
                        <td class="small muted">{r.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p class="small faint" style="margin-top: 8px">옛 도구(구글 시트)에서 내려받은 파일(01_Part_Master 등 영문 시트)도 그대로 가져올 수 있습니다.</p>
            </div>
          </section>
        </div>
        <div class="import-foot">
          <span class="step-badge">3</span>
          <div style="flex: 1; min-width: 0">
            <b>채운 파일 선택</b>
            <p class="small muted">가져온 뒤 바꾼 값 · 건너뛴 행을 보고서로 보여 줍니다. 원본 엑셀은 바뀌지 않습니다.</p>
          </div>
          <button type="button" class="btn primary" disabled={props.busy} onClick={props.onPick}><IconFolder />채운 파일 선택</button>
        </div>
      </div>
    </div>
  );
}
