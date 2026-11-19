import { parseTier2Route, runTier2Tasks, summarizeTier2Runs } from './tier2';

export interface Tier2CliArgs {
  readonly routes: string[];
  readonly n: number;
}

/** Parse only an explicit invocation; no route, model, or run count has a spend-capable default. */
export function parseTier2CliArgs(args: readonly string[]): Tier2CliArgs {
  const routes: string[] = [];
  let n: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--route') {
      const route = args[++index];
      if (!route) {
        throw new Error('--route requires `<connection-id>:<model-id>`.');
      }
      routes.push(route);
    } else if (arg === '--n') {
      const raw = args[++index];
      if (!raw || !/^\d+$/.test(raw)) {
        throw new Error('--n requires a positive integer.');
      }
      n = Number(raw);
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('Usage: npm run lab:tier2 -- --route <connection-id>:<model-id> [--route <connection-id>:<model-id>] --n <positive-integer>');
    } else {
      throw new Error(`Unknown Tier 2 argument: ${arg}`);
    }
  }
  if (routes.length === 0) {
    throw new Error('Tier 2 requires at least one explicit --route.');
  }
  if (!n || n <= 0) {
    throw new Error('Tier 2 requires an explicit positive --n.');
  }
  return { routes, n };
}

async function main(): Promise<void> {
  const args = parseTier2CliArgs(process.argv.slice(2));
  const routes = args.routes.map(parseTier2Route);
  const records = await runTier2Tasks(routes, args.n);
  for (const record of records) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
  process.stdout.write(`${JSON.stringify(summarizeTier2Runs(records))}\n`);
  if (records.some((record) => record.outcome !== 'passed')) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Harness Lab Tier 2 runner crashed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
