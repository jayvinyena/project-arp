import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './styles.css';
import { render, Component } from 'preact';
import type { ComponentChildren } from 'preact';
import { App } from './App.tsx';

// 캡처·확인용: ?theme=dark|light
const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;

/** 화면에서 예기치 못한 오류가 나도 작업 사본(브라우저 저장소)은 남아 있다. 다시 열면 되살리기를 제안한다 */
class ErrorBoundary extends Component<{ children: ComponentChildren }, { error: Error | null }> {
  state = { error: null as Error | null };
  componentDidCatch(error: Error) {
    console.error('[ARP] 화면 오류', error);
    this.setState({ error });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div class="welcome">
        <div class="card welcome-card">
          <h1 style="font-size: 22px">문제가 생겼습니다</h1>
          <p class="muted">화면을 그리다 예기치 못한 오류가 났습니다. 저장하지 않은 작업은 이 브라우저에 사본이 있습니다. 새로 수정하면 시작 화면에서 복구할 수 있습니다.</p>
          <pre class="small faint" style="white-space: pre-wrap; margin: 0">{String(this.state.error.message ?? this.state.error)}</pre>
          <div class="actions">
            <button class="btn primary lg" onClick={() => location.reload()}>새로 고치기</button>
            <button class="btn lg" onClick={() => this.setState({ error: null })}>그대로 다시 시도</button>
          </div>
        </div>
      </div>
    );
  }
}

// 비동기 오류는 앱이 알림으로 보여 준다(App이 'arp:error'를 듣는다)
const report = (message: string) => window.dispatchEvent(new CustomEvent('arp:error', { detail: message }));
window.addEventListener('error', e => report(e.message || '알 수 없는 오류'));
window.addEventListener('unhandledrejection', e => report(String((e.reason as Error)?.message ?? e.reason)));

render(<ErrorBoundary><App /></ErrorBoundary>, document.getElementById('root')!);

// 설치형 앱: 배포 빌드에서만 서비스 워커를 등록한다(개발 서버에서는 캐시가 방해된다)
if (import.meta.env.PROD && 'serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('./sw.js').catch(e => console.warn('[ARP] 서비스 워커 등록 실패', e)); });
}
