// A separate Node process (bundled by the test) that changes control through the product control store, like a second
// VS Code window. Its file systems are the real ones, with a pause or a kill injected at one point of the write order:
//   reduce <root> <count> <go>    waits for the go file, then publishes <count> reductions; prints the epochs reported
//   pause <root> <point> <dir>    one reduction that stops at <point> (beforeA | betweenRegions): it creates
//                                 <dir>\paused and waits for <dir>\go
//   die <root> <point>            one reduction that kills its own process at <point> (beforeGeneration |
//                                 afterGeneration | betweenRegions | afterFloor)
//   read <root> <stop>            reads control until the stop file exists; prints reads, floor decreases, non-ok views
// This process never creates the floor, so every 64-byte write at a position above 0 is a floor record write.

import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ControlChange } from '../contracts';
import { FLOOR_REGION_B } from '../controlFloor';
import { createControlStore, nodeControlFs, type ControlFs } from '../controlStore';
import { nodeJournalFs, type JournalFs } from '../generationJournal';

const [mode, root, arg, extra] = process.argv.slice(2);

function waitFor(file: string): void {
  while (!existsSync(file)) { const until = Date.now() + 2; while (Date.now() < until) { /* spin */ } }
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

function die(): never {
  process.kill(process.pid, 'SIGKILL');
  for (;;) { /* the signal ends the process */ }
}

const isRegionA = (position: number, length: number) => length === 64 && position > 0 && position < FLOOR_REGION_B;
const isRegionB = (position: number, length: number) => length === 64 && position > FLOOR_REGION_B;

function store(fs: ControlFs = nodeControlFs, journalFs: JournalFs = nodeJournalFs) {
  return createControlStore({ root, admissionState: () => 'open', fs, journalFs });
}

// Each writer's records differ from every other writer's. Two writers that decide the same record on the same
// predecessor in the same millisecond write identical bytes: one of them may then be delayed past the kept
// generations, link the trimmed name again, and find its own digest named by the next generation. Its change is the
// one in force, so it is counted, and the two report one epoch. The test is about distinct decisions.
let decisions = 0;
const writer = process.pid * 1_000_000;

function reduction(label: string): ControlChange {
  return { kind: 'reduction', label, apply: (current) => ({ ...current, decidedAt: new Date(writer + decisions++).toISOString() }) };
}

async function main(): Promise<void> {
  if (mode === 'reduce') {
    waitFor(extra);
    const control = store();
    const reported: number[] = [];
    let busy = 0;
    for (let index = 0; index < Number(arg); index++) {
      for (;;) {
        const result = await control.publish(reduction(`r${index}`));
        if (result.outcome === 'published') { reported.push(result.snapshot.record.reductionEpoch); break; }
        if (result.outcome === 'busy') { busy++; continue; }
        print({ error: result });
        process.exit(1);
      }
    }
    print({ reported, busy });
  } else if (mode === 'pause') {
    const signals = extra;
    let paused = false;
    const pause = () => {
      if (paused) return;
      paused = true;
      writeFileSync(path.join(signals, 'paused'), '');
      waitFor(path.join(signals, 'go'));
    };
    const fs: ControlFs = {
      ...nodeControlFs,
      write: (fd, buffer, offset, length, position) => {
        if (arg === 'beforeA' && isRegionA(position, length)) pause();
        if (arg === 'betweenRegions' && isRegionB(position, length)) pause();
        return nodeControlFs.write(fd, buffer, offset, length, position);
      },
    };
    const result = await store(fs).publish(reduction('paused'));
    print(result.outcome === 'published' ? { reported: [result.snapshot.record.reductionEpoch] } : { error: result });
  } else if (mode === 'die') {
    const fs: ControlFs = {
      ...nodeControlFs,
      write: (fd, buffer, offset, length, position) => {
        if (arg === 'afterGeneration' && isRegionA(position, length)) die();
        if (arg === 'betweenRegions' && isRegionB(position, length)) die();
        return nodeControlFs.write(fd, buffer, offset, length, position);
      },
    };
    const journalFs: JournalFs = {
      ...nodeJournalFs,
      link: (existing, created) => {
        if (arg === 'beforeGeneration') die();
        nodeJournalFs.link(existing, created);
      },
    };
    const result = await store(fs, journalFs).publish(reduction('killed'));
    if (arg === 'afterFloor' && result.outcome === 'published') die();
    print({ unexpected: result });
  } else if (mode === 'read') {
    const control = store();
    let reads = 0;
    let decreases = 0;
    let last = 0;
    const notOk: string[] = [];
    // The stop file is written after every reducer has exited, so the stop is looked for before each read: the last
    // read then starts after the last reduction. Looked for after the read, a read begun just before the final
    // reduction ended the loop one epoch behind (89 of 90, Node 22, 2026-10-22).
    for (;;) {
      const stopped = existsSync(arg);
      const view = control.read();
      reads++;
      if (view.kind !== 'readable' || view.authority !== 'ok') {
        notOk.push(view.kind === 'readable' ? view.authority : view.kind === 'unusable' ? view.reason : view.kind);
      } else {
        if (view.floor < last) decreases++;
        last = Math.max(last, view.floor);
      }
      if (stopped) break;
    }
    print({ reads, decreases, notOk: notOk.slice(0, 20), notOkCount: notOk.length, last });
  }
}

void main();
