import { readHarnessLabConfiguration, runA4FixtureRepairDemo, runProjectKnowledgeABProbe, runTier1AB, runTier2AB } from './ab';
import { parseTier2Route } from './tier2';

export interface ABCLIArgs {
  readonly left: string;
  readonly right: string;
  readonly routes: readonly string[];
  readonly n?: number;
  readonly demoA4Repair: boolean;
}

/** Parse explicit A/B arms. Routes and N are both required before this CLI may start a real backend. */
export function parseABCliArgs(args: readonly string[]): ABCLIArgs {
  let left: string | undefined;
  let right: string | undefined;
  const routes: string[] = [];
  let n: number | undefined;
  let demoA4Repair = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--left' || arg === '--right' || arg === '--route' || arg === '--n') {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value.`);
      if (arg === '--left') left = value;
      else if (arg === '--right') right = value;
      else if (arg === '--route') routes.push(value);
      else if (!/^\d+$/.test(value) || Number(value) <= 0) throw new Error('--n requires a positive integer.');
      else n = Number(value);
    } else if (arg === '--demo-a4-repair') {
      demoA4Repair = true;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('Usage: npm run lab:ab -- --left <config.json> --right <config.json> [--demo-a4-repair | --route <connection-id>:<model-id> --n <positive-integer>]');
    } else {
      throw new Error(`Unknown Harness Lab A/B argument: ${arg}`);
    }
  }
  if (!left || !right) throw new Error('Harness Lab A/B requires explicit --left and --right configuration files.');
  if (demoA4Repair && (routes.length > 0 || n !== undefined)) throw new Error('A controlled A/B demo cannot be combined with real-model routes.');
  if (!demoA4Repair && (routes.length === 0) !== (n === undefined)) throw new Error('Tier 2 A/B requires both at least one --route and --n.');
  return { left, right, routes, n, demoA4Repair };
}

async function main(): Promise<void> {
  const args = parseABCliArgs(process.argv.slice(2));
  const [left, right] = await Promise.all([readHarnessLabConfiguration(args.left), readHarnessLabConfiguration(args.right)]);
  if (args.demoA4Repair) {
    process.stdout.write(`${JSON.stringify(await runA4FixtureRepairDemo(left, right))}\n`);
    return;
  }
  const tier1 = await runTier1AB(left, right);
  for (const record of tier1.records) process.stdout.write(`${JSON.stringify(record)}\n`);
  process.stdout.write(`${JSON.stringify(tier1.summary)}\n`);
  // P1 is an intentional contrast: apply-edit must fail its apply_patch-only fixture and apply-patch
  // must pass it. Every other Tier 1 failure remains a failed A/B run.
  if (tier1.records.some((entry) => !isExpectedTier1Outcome(entry, left, right))) process.exitCode = 1;
  if (left.projectKnowledgeDisclosure !== undefined || right.projectKnowledgeDisclosure !== undefined) {
    const probe = await runProjectKnowledgeABProbe(left, right);
    process.stdout.write(`${JSON.stringify(probe)}\n`);
    if (!probe.armsDiffer || probe.contextByteDelta === 0) process.exitCode = 1;
  }
  if (args.routes.length === 0 || args.n === undefined) return;
  const tier2 = await runTier2AB(left, right, args.routes.map(parseTier2Route), args.n);
  for (const record of tier2.records) process.stdout.write(`${JSON.stringify(record)}\n`);
  process.stdout.write(`${JSON.stringify(tier2.summary)}\n`);
  if (tier2.records.some((entry) => entry.record.outcome !== 'passed')) process.exitCode = 1;
}

function isExpectedTier1Outcome(
  entry: Awaited<ReturnType<typeof runTier1AB>>['records'][number],
  left: Awaited<ReturnType<typeof readHarnessLabConfiguration>>,
  right: Awaited<ReturnType<typeof readHarnessLabConfiguration>>,
): boolean {
  if (entry.record.taskId !== 'P1') return entry.record.outcome === 'passed';
  const implementation = entry.side === 'left' ? left.implementation : right.implementation;
  return entry.record.outcome === (implementation === 'apply-patch' ? 'passed' : 'failed');
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Harness Lab A/B runner crashed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
