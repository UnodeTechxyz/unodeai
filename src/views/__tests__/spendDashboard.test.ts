import { describe, expect, it } from 'vitest';
import { renderReferenceSavings, renderSpendSection } from '../spendDashboard';
import type { SpendViewModel } from '../../host/SpendCoordinator';

describe('Dashboard savings (v0.9.89)', () => {
  const priced = (actualUsd: number, premiumUsd: number) => ({ usage: { turns: 1, savings: { actualUsd, premiumUsd, source: 'Unode reference captured 2026-09-27' } } });

  it('prices both sides from the same dated reference and says so', () => {
    const html = renderReferenceSavings([priced(1, 4), priced(0.5, 2)]);
    expect(html).toContain('saved about <b>$4.50</b>');
    expect(html).toContain('Unode reference captured 2026-09-27');
  });

  it('makes no savings claim when any side is missing a price', () => {
    expect(renderReferenceSavings([priced(1, 4), { usage: { turns: 1, savings: 'unavailable' as const } }])).toBe('');
    expect(renderReferenceSavings([priced(1, 4), { usage: { turns: 2 } }])).toBe('');
  });
});

describe('Dashboard Spend section', () => {
  const view: SpendViewModel = {
    folderless: false, trackedSince: '2026-09-27', controlState: 'ok', remindersPaused: false, diagnostics: [],
    referenceMode: 'unselected', catalogs: [{ provider: 'unode', catalogId: 'u', capturedAt: '2026-09-27T21:13:20.000Z', stale: false, models: 94 }],
    requests: [], agents: [], openUnits: 0, coverageGaps: 2, pendingWrites: 0,
    targets: { request: {}, agents: {} }, targetDiagnostics: [], targetRevision: 'r', overTarget: false, overTargetAgents: [],
    project: {
      kind: 'project-period', title: 'Project, today', periodId: '2026-09-28@UTC', eligibleTokens: 150, eligibleNanoUsd: 0n,
      tokens: { input: 100, cached: 0, output: 50, total: 150 },
      rows: [{ label: 'Billed', tokens: 100, costText: '$0.01' }, { label: 'Reconstructed (not reported)', tokens: 50 }],
      unattributedUnits: 0, target: { tokens: { value: 100, repositoryNarrowed: false } }, percent: 150, counterEpoch: 'initial',
      reset: { scope: 'project-period', periodId: '2026-09-28@UTC' },
    },
    repository: { state: 'proposed' },
  };

  it('keeps provenance rows separate, says work continues and carries no ids in its links', () => {
    const html = renderSpendSection(view);
    expect(html).toContain('Reminders only');
    expect(html).toContain('Project, today — over target');
    expect(html).not.toContain('over target, work is continuing');
    expect(html).toContain('<td>Billed</td>');
    expect(html).toContain('<td>Reconstructed (not reported)</td>');
    expect(html).toContain('2 turn(s) may have used tokens');
    expect(html).toContain('Tracked since v0.9.89 (2026-09-27)');
    expect(html).toContain('command:unode.reviewRepositorySpendTargets');
    for (const href of html.match(/href="command:[^"]*"/g) ?? []) {
      expect(href).not.toContain('?');
    }
  });

  it('says usage is updating while settled usage is still being saved', () => {
    expect(renderSpendSection(view)).not.toContain('could not be saved yet');
    expect(renderSpendSection({ ...view, pendingWrites: 2 })).toContain('Usage updating: 2 usage record(s) could not be saved yet and are being retried');
  });
});
