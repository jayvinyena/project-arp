// 칸 고치기 공통: 고치기가 거절되면(onCommit이 false로 끝나면) 칸을 원래 값으로 되돌린다
export function afterCommit(result: unknown, reset: () => void): void {
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    void (result as Promise<unknown>).then(ok => { if (ok === false) reset(); }, () => reset());
  } else if (result === false) reset();
}
