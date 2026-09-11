import { runTier1Tasks, summarizeTier1Runs } from './runner';

async function main(): Promise<void> {
  const started = Date.now();
  const records = await runTier1Tasks();
  for (const record of records) {
    // JSONL: one machine-readable Portable Run Evidence seed per task invocation.
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
  // Keep the source split visible: a controlled script must never be mistaken for a product measurement.
  process.stdout.write(`${JSON.stringify(summarizeTier1Runs(records))}\n`);
  const elapsed = Date.now() - started;
  if (elapsed > 90_000) {
    process.stderr.write(`Harness Lab Tier 1 exceeded its 90s budget (${elapsed}ms); investigate before relying on it as a commit gate.\n`);
  }
  if (records.some((record) => record.outcome !== 'passed')) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`Harness Lab runner crashed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
