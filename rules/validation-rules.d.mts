// validation-rules.mjs의 형식(형식 검사용). 규칙을 더하면 RULE_TABLES에도 넣는다.
export interface Rule {
  code: string;
  level: 'ERROR' | 'WARN';
  title: string;
  fix: string;
  sql: string;
}
export declare const PRELUDE: string;
export declare const RULE_TABLES: Record<string, string[]>;
export declare const AREAS: Record<string, string>;
export declare const RULES: Rule[];
