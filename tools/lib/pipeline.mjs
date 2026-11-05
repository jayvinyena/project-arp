// Node 도구용: node:sqlite 연결을 core 계산 흐름에 넘긴다. 실제 흐름은 core/pipeline.ts.
import * as core from '../../core/pipeline.ts';

/** node:sqlite DatabaseSync → core SqlDb */
export function nodeDb(db) {
  if (db.__sqlDb) return db.__sqlDb;
  const bind = params => (params && params.length ? params : []);
  const wrapped = {
    exec: sql => db.exec(sql),
    all: (sql, params) => db.prepare(sql).all(...bind(params)),
    get: (sql, params) => db.prepare(sql).get(...bind(params)),
    run: (sql, params) => Number(db.prepare(sql).run(...bind(params)).changes),
  };
  Object.defineProperty(db, '__sqlDb', { value: wrapped });
  return wrapped;
}

export const validate = db => core.validate(nodeDb(db));
export const readProjectData = db => core.readProjectData(nodeDb(db));
export const withScenario = (db, scenarioId, fn) => core.withScenario(nodeDb(db), scenarioId, fn);
export const calculate = (db, options) => core.calculate(nodeDb(db), options);
