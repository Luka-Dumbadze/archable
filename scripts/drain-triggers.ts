// scripts/drain-triggers.ts: drains pgmq 'triggers' once, as the cron route will (P4.D2.8).
//   pnpm tsx scripts/drain-triggers.ts [--qty 10]
import { parseArgs } from 'node:util';
import { controlDb, runtimeDb } from '../apps/api/src/db';
import { createTriggerDrainer } from '../apps/api/src/turn-wiring';

const { values } = parseArgs({ options: { qty: { type: 'string', default: '10' } } });
const results = await createTriggerDrainer()(Number(values.qty));
console.log(JSON.stringify(results, null, 2));
await runtimeDb.end();
await controlDb.end();
