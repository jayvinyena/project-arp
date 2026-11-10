// 새 버전 알림 띠(docs/32 5): 서비스 워커가 새 버전을 받아 이 탭을 넘겨받으면(controllerchange) main.tsx가 'arp-update'를 보낸다.
// 화면은 캐시에서 뜬 옛 버전 그대로라, 새로 고침해야 새 버전(새 파일 구조)이 적용된다. 저장 안 된 변경이 있으면 브라우저가 떠나기 전에 묻는다.
// 띠는 화면 위에 떠 있어(고정 위치) 아래 내용을 밀지 않는다.
import { useEffect, useState } from 'preact/hooks';

export function UpdateBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const on = () => setShow(true);
    window.addEventListener('arp-update', on);
    return () => window.removeEventListener('arp-update', on);
  }, []);
  if (!show) return null;
  return (
    <div class="update-banner" role="status" aria-label="새 버전 알림">
      <span><b>새 버전이 있습니다.</b> 새로 고침하면 적용됩니다(저장하지 않은 변경이 있으면 먼저 저장하십시오).</span>
      <button type="button" class="btn sm primary" onClick={() => location.reload()}>새로 고침</button>
      <button type="button" class="btn sm ghost" onClick={() => setShow(false)}>나중에</button>
    </div>
  );
}
