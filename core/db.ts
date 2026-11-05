// DB 연결 모양. Node(node:sqlite)와 브라우저(SQLite WebAssembly)가 같은 계산 흐름을 쓰도록 이 모양으로 감싼다.
export interface SqlDb {
  /** 여러 문장을 결과 없이 실행 */
  exec(sql: string): void;
  /** 행 객체 목록 */
  all(sql: string, params?: unknown[]): Record<string, unknown>[];
  /** 첫 행 또는 undefined */
  get(sql: string, params?: unknown[]): Record<string, unknown> | undefined;
  /** 한 문장 실행, 바뀐 행 수 */
  run(sql: string, params?: unknown[]): number;
}
