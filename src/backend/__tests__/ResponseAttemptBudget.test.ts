import { describe, expect, it } from 'vitest';
import { ResponseAttemptBudget, ResponseBudgetExhausted } from '../ResponseAttemptBudget';

describe('one logical response attempt/time budget (transport activation is separate)', () => {
  it('shares the original maxRetries+1 cap across stream, repair, fallback and JSON retry callers', () => {
    const budget = new ResponseAttemptBudget(3, 900_000, () => 0);
    const stream = () => budget.takeAttempt();
    const repair = () => budget.takeAttempt();
    const fallback = () => budget.takeAttempt();
    stream(); repair(); fallback(); fallback();
    expect(budget.attempts).toBe(4); expect(budget.canAttempt).toBe(false);
    expect(() => stream()).toThrow(ResponseBudgetExhausted);
    expect(budget.attempts).toBe(4);
  });

  it('allows one send and no fallback at maxRetries=0', () => {
    const budget = new ResponseAttemptBudget(0, 1000, () => 0);
    expect(budget.takeAttempt()).toBe(1000);
    expect(() => budget.takeAttempt()).toThrow(ResponseBudgetExhausted);
  });

  it('starts provider time only at the first admitted send, not during prompt build or a first consent wait', async () => {
    let now = 0;
    const budget = new ResponseAttemptBudget(3, 100, () => now);
    now = 60_000;
    await budget.waitForHost(async () => { now += 300_000; });
    expect(budget.elapsedMs).toBe(0);
    expect(budget.takeAttempt()).toBe(100);
    now += 20;
    expect(budget.remainingMs).toBe(80);
  });

  it('charges headers, body, repair work and backoff to one remaining wall-clock ceiling', () => {
    let now = 0;
    const budget = new ResponseAttemptBudget(20, 90, () => now);
    budget.takeAttempt(); now += 40; // headers/body
    now += 5; // backoff
    expect(budget.takeAttempt()).toBe(45);
    now += 40; // next failed body
    now += 5; // backoff crosses the ceiling
    expect(budget.canAttempt).toBe(false);
    expect(() => budget.takeAttempt()).toThrow(ResponseBudgetExhausted);
    expect(budget.attempts).toBe(2);
  });

  it('excludes nested/overlapping host waits once, while disallowing attempts inside the wait', async () => {
    let now = 0;
    const budget = new ResponseAttemptBudget(3, 100, () => now);
    budget.takeAttempt(); now += 20;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const first = budget.waitForHost(async () => { await pending; });
    now += 200;
    await budget.waitForHost(async () => { now += 300; expect(budget.canAttempt).toBe(false); });
    expect(budget.remainingMs).toBe(80);
    now += 400; release(); await first;
    expect(budget.remainingMs).toBe(80);
    now += 10;
    expect(budget.takeAttempt()).toBe(70);
    expect(budget.attempts).toBe(2);
  });

  it('resumes the same clock when a host wait rejects and preserves the original error', async () => {
    let now = 0;
    const budget = new ResponseAttemptBudget(3, 100, () => now);
    const denied = new Error('PRIVATE_DENIED');
    budget.takeAttempt(); now = 30;
    await expect(budget.waitForHost(async () => { now += 1000; throw denied; })).rejects.toBe(denied);
    expect(budget.remainingMs).toBe(70);
    now += 10; expect(budget.remainingMs).toBe(60);
    expect(budget.attempts).toBe(1);
  });

  it('does not regain attempts or elapsed time after all attempts were spent, a backward clock, or a late consent', async () => {
    let now = 100;
    const budget = new ResponseAttemptBudget(0, 100, () => now);
    budget.takeAttempt(); now = 140; expect(budget.remainingMs).toBe(60);
    now = 110; expect(budget.remainingMs).toBe(60);
    await budget.waitForHost(async () => { now = 1000; });
    expect(budget.remainingMs).toBe(60); expect(budget.canAttempt).toBe(false);
  });

  it('keeps original failures as causes, never interpolates their private text into the fixed budget error', () => {
    const budget = new ResponseAttemptBudget(0, 100, () => 0);
    budget.takeAttempt();
    const cause = new Error('PRIVATE https://private.invalid/?key=secret');
    const error = budget.exhausted(cause);
    expect(error).toMatchObject({ name: 'ResponseBudgetExhausted', attempts: 1, maxAttempts: 1, elapsedMs: 0, totalMs: 100 });
    expect(error.cause).toBe(cause);
    expect(error.message).not.toMatch(/PRIVATE|private.invalid|secret/);
  });

  it('keeps the attempt cap but has no implicit time ceiling when time is unbounded', () => {
    let now = 0; const budget = new ResponseAttemptBudget(1, Infinity, () => now);
    expect(budget.takeAttempt()).toBe(Infinity); now += 3_600_000;
    expect(budget.canAttempt).toBe(true); expect(budget.takeAttempt()).toBe(Infinity);
    expect(budget.canAttempt).toBe(false); expect(() => budget.takeAttempt()).toThrow(ResponseBudgetExhausted);
  });

  it.each([[-1, 100], [1.5, 100], [Infinity, 100], [Number.MAX_SAFE_INTEGER, 100], [1, 0], [1, NaN]])(
    'rejects invalid retry/time limits %s/%s without sending', (retries, total) => {
      expect(() => new ResponseAttemptBudget(retries, total)).toThrow('Invalid response retry budget.');
    },
  );
});
