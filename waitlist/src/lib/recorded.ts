// Finds a recorded e2e run in deployments/testnet-v2.json. A pool redeploy (deploy-v2 --record-only/--replace)
// moves the old entry, with its e2e records, to previous.<mode> (a list, newest last), so the run may live in
// the current pools.<mode> or in an earlier entry. Pure; unit-tested.

export interface RecordedHit<T = Record<string, any>> {
  run: T;
  /** Address of the pool the run was made on (the entry that holds the record). */
  pool: string;
  /** True when the run belongs to an earlier pool, not the current one. */
  earlier: boolean;
}

export function findRecordedRun(doc: any, mode: string, key: string): RecordedHit {
  const cur = doc?.pools?.[mode];
  if (cur?.[key]) return { run: cur[key], pool: cur.pool, earlier: false };
  const prev: any[] = Array.isArray(doc?.previous?.[mode]) ? doc.previous[mode] : [];
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i]?.[key]) return { run: prev[i][key], pool: prev[i].pool, earlier: true };
  }
  throw new Error(`deployments/testnet-v2.json: no recorded run ${key} under pools.${mode} or previous.${mode}`);
}
