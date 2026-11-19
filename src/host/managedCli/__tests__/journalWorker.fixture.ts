// A separate Node process (bundled by the test) that publishes through the real generation journal, like a second
// VS Code window: `write <folder> <value> <go file>` waits for the go file, then publishes one generation after
// whatever it reads, deciding again from the winner each time it loses. `read <folder> <ms>` reads in a loop and
// reports every result that is not a valid record.

import { existsSync } from 'node:fs';
import { publishGeneration, readJournal, type JournalSpec } from '../generationJournal';

interface TestRecord { schema: 'test/1'; generation: number; previousRecordDigest: string | null; value: string }

const [mode, folder, arg, go] = process.argv.slice(2);
const spec: JournalSpec<TestRecord> = {
  folder,
  prefix: 'test',
  parse: (value) => {
    const record = value as Partial<TestRecord>;
    return record.schema === 'test/1' && typeof record.value === 'string'
      ? { ok: true, record: record as TestRecord }
      : { ok: false, detail: 'not a test record' };
  },
};

if (mode === 'write') {
  while (!existsSync(go)) { /* spin until every writer is ready */ }
  let losses = 0;
  for (;;) {
    const current = readJournal(spec);
    if (current.kind !== 'ok') { process.stdout.write(`error ${current.kind}`); process.exit(1); }
    const result = publishGeneration(spec, current, { schema: 'test/1', value: `${arg} after ${current.record.value}` });
    if (result.outcome === 'published') { process.stdout.write(JSON.stringify({ generation: result.entry.generation, losses })); break; }
    losses++;
  }
} else if (mode === 'read') {
  const until = Date.now() + Number(arg);
  let reads = 0;
  const bad: string[] = [];
  while (Date.now() < until) {
    const current = readJournal(spec);
    reads++;
    if (current.kind !== 'ok') bad.push(current.kind);
  }
  process.stdout.write(JSON.stringify({ reads, bad }));
}
