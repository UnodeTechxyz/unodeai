import { createHash, randomUUID } from 'node:crypto';

/** Host-only receipt custody. No model input may construct or promote these tokens. */
export interface WorkbookDeliveryFragment { unit: string; start: number; end: number; total: number }
export interface WorkbookDeliveryScope { sourceVersion: string; selection: string; sourceSha256?: string }
export interface WorkbookDeliveryFact {
  id: string; scope: WorkbookDeliveryScope; payload_sha256: string;
  state: 'prepared' | 'payload-submitted' | 'observed' | 'unknown';
  route?: 'http' | 'claude' | 'codex'; submitted_units: string[]; observed_units: string[];
}
interface Prepared {
  holder: object; characters: number; idOffset: number; fragments: WorkbookDeliveryFragment[]; fact: WorkbookDeliveryFact;
}
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const strength = { prepared: 0, unknown: 1, 'payload-submitted': 2, observed: 3 };

/**
 * One calling agent's ephemeral receipt custody. Final transport hooks supply their actual bounded text;
 * preparation is deliberately insufficient. Durable/portable projections must contain facts, not payloads.
 */
export class WorkbookDeliveryRegistry {
  private readonly prepared = new Map<object, Prepared>();
  private readonly coverage = new Map<object, Map<string, Map<string, { total: number; spans: Array<[number, number]> }>>>();

  prepare(holder: object, scope: WorkbookDeliveryScope, payload: string, fragments: readonly WorkbookDeliveryFragment[], id = `workbook-delivery-${randomUUID()}`): object {
    if (!/^(?:workbook|office)-delivery-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) || !payload || !payload.includes(id)
      || (scope.sourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(scope.sourceSha256))) throw new Error('invalid-delivery-id');
    for (const fragment of fragments) {
      if (!fragment.unit || ![fragment.start, fragment.end, fragment.total].every(value => Number.isSafeInteger(value) && value >= 0)
        || fragment.start > fragment.end || fragment.end > fragment.total) throw new Error('invalid-delivery-fragment');
    }
    const token = {}; this.prepared.set(token, { holder, characters: payload.length, idOffset: payload.indexOf(id), fragments: fragments.map(fragment => ({ ...fragment })),
      fact: { id, scope: { ...scope }, payload_sha256: digest(payload), state: 'prepared', submitted_units: [], observed_units: [] } });
    return token;
  }

  /** Call only at actual dispatch, or at the exact observed CLI result event; history append is preparation. */
  private record(token: object, holder: object, text: string, route: NonNullable<WorkbookDeliveryFact['route']>, evidence: 'payload-submitted' | 'observed' | 'unknown') {
    const entry = this.prepared.get(token); if (!entry || entry.holder !== holder) return undefined;
    const before = JSON.stringify(entry.fact);
    const complete = text.length === entry.characters && digest(text) === entry.fact.payload_sha256;
    // A shortened/changed result never attests the discarded remainder; a later real exact observation may.
    const state = complete ? evidence : 'unknown';
    const submitted = state === 'payload-submitted' || state === 'observed' ? this.recordCoverage(entry, 'payload-submitted', route) : [];
    const observed = state === 'observed' ? this.recordCoverage(entry, 'observed', route) : [];
    if (strength[state] >= strength[entry.fact.state]) {
      entry.fact.state = state; entry.fact.route = route; entry.fact.submitted_units = submitted; entry.fact.observed_units = observed;
    }
    return before === JSON.stringify(entry.fact) ? undefined : structuredClone(entry.fact);
  }

  facts(holder: object): WorkbookDeliveryFact[] {
    return [...this.prepared.values()].filter(entry => entry.holder === holder).map(entry => structuredClone(entry.fact));
  }

  fact(holder: object, id: string): WorkbookDeliveryFact | undefined {
    const held = [...this.prepared.values()].find(entry => entry.holder === holder && entry.fact.id === id);
    return held ? structuredClone(held.fact) : undefined;
  }

  /** Actual decoded text from a final route payload. An id alone, truncated data or a prose claim cannot attest a page. */
  recordText(holder: object, text: string, route: NonNullable<WorkbookDeliveryFact['route']>, evidence: 'payload-submitted' | 'observed' | 'unknown'): WorkbookDeliveryFact[] {
    const facts: WorkbookDeliveryFact[] = [];
    for (const [token, entry] of this.prepared) {
      if (entry.fact.route === route && strength[entry.fact.state] >= strength[evidence]) continue;
      if (entry.holder !== holder) continue;
      let found = text.indexOf(entry.fact.id); if (found < 0) continue;
      let candidate = '';
      // Retain only length/offset/SHA, not source text. Wrapping notices may move the page but cannot change its bytes.
      while (found >= 0) {
        const start = found - entry.idOffset;
        candidate = start >= 0 ? text.slice(start, start + entry.characters) : '';
        if (candidate.length === entry.characters && digest(candidate) === entry.fact.payload_sha256) break;
        found = text.indexOf(entry.fact.id, found + entry.fact.id.length);
      }
      const fact = this.record(token, holder, candidate, route, evidence);
      if (fact) facts.push(fact);
    }
    return facts;
  }

  private recordCoverage(entry: Prepared, evidence: 'payload-submitted' | 'observed', route: NonNullable<WorkbookDeliveryFact['route']>): string[] {
    let scopes = this.coverage.get(entry.holder); if (!scopes) this.coverage.set(entry.holder, scopes = new Map());
    const scopeKey = JSON.stringify([entry.fact.scope, evidence, route]); let units = scopes.get(scopeKey); if (!units) scopes.set(scopeKey, units = new Map());
    const complete: string[] = [];
    for (const fragment of entry.fragments) {
      let unit = units.get(fragment.unit);
      if (!unit) units.set(fragment.unit, unit = { total: fragment.total, spans: [] });
      if (unit.total !== fragment.total) continue; // Conflicting lengths do not manufacture complete coverage.
      unit.spans.push([fragment.start, fragment.end]); unit.spans.sort((left, right) => left[0] - right[0]);
      const merged: Array<[number, number]> = [];
      for (const span of unit.spans) {
        const last = merged[merged.length - 1]; if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else merged.push([...span]);
      }
      unit.spans = merged;
      if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] === unit.total && !complete.includes(fragment.unit)) complete.push(fragment.unit);
    }
    return complete;
  }

  release(holder: object): void {
    for (const [token, entry] of this.prepared) if (entry.holder === holder) this.prepared.delete(token);
    this.coverage.delete(holder);
  }
}
