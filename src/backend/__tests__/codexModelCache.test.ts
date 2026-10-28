import { describe, expect, it } from 'vitest';
import {
  cachedCodexModelsFor,
  EMPTY_CODEX_MODEL_CACHE,
  rememberCodexModels,
  restoreCodexModelCacheV2,
} from '../codexModelCache';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const model = (id: string) => ({ id, name: id, vision: false, isDefault: false });
const NPM = 'C:\\npm\\codex.exe';
const EXT = 'C:\\ext\\codex.exe';

describe('Codex account models per program (v0.9.96)', () => {
  it('keeps one list per program, so two programs of the same version never share a list', () => {
    let cache = rememberCodexModels(EMPTY_CODEX_MODEL_CACHE, { program: NPM, cliVersion: '0.155.1', capturedAt: '2026-10-18T00:00:00Z', models: [model('gpt-a')] }, same);
    cache = rememberCodexModels(cache, { program: EXT, cliVersion: '0.155.1', capturedAt: '2026-10-18T00:01:00Z', models: [model('gpt-b')] }, same);
    expect(cachedCodexModelsFor(cache, NPM, undefined, same)?.models.map((m) => m.id)).toEqual(['gpt-a']);
    expect(cachedCodexModelsFor(cache, EXT, undefined, same)?.models.map((m) => m.id)).toEqual(['gpt-b']);
    expect(cachedCodexModelsFor(cache, 'C:\\other\\codex.exe', undefined, same)).toBeUndefined();
    expect(cachedCodexModelsFor(cache, undefined, undefined, same)).toBeUndefined();
  });

  it('does not offer a program\'s list once that program was measured at another version', () => {
    const cache = rememberCodexModels(EMPTY_CODEX_MODEL_CACHE, { program: NPM, cliVersion: '0.155.1', capturedAt: '2026-10-18T00:00:00Z', models: [model('gpt-a')] }, same);
    expect(cachedCodexModelsFor(cache, NPM, '0.155.1', same)).toBeDefined();
    expect(cachedCodexModelsFor(cache, NPM, '0.159.1', same)).toBeUndefined();
  });

  it('replaces a program\'s list with its newest one and bounds the programs kept', () => {
    let cache = EMPTY_CODEX_MODEL_CACHE;
    for (let index = 0; index < 12; index += 1) {
      cache = rememberCodexModels(cache, { program: `C:\\p${index}\\codex.exe`, cliVersion: '0.155.1', capturedAt: '2026-10-18T00:00:00Z', models: [model(`m${index}`)] }, same);
    }
    cache = rememberCodexModels(cache, { program: 'C:\\P11\\codex.exe', cliVersion: '0.155.1', capturedAt: '2026-10-18T01:00:00Z', models: [model('newer')] }, same);
    expect(cache.entries).toHaveLength(8);
    expect(cache.entries[0].models.map((m) => m.id)).toEqual(['newer']);
    expect(cachedCodexModelsFor(cache, 'C:\\p0\\codex.exe', undefined, same)).toBeUndefined();
  });

  it('reads the 0.9.95 list keyed by version alone, or anything malformed, as empty', () => {
    expect(restoreCodexModelCacheV2({ version: 1, latestCliVersion: '0.155.1', byCliVersion: { '0.155.1': [model('old')] } }).entries).toEqual([]);
    expect(restoreCodexModelCacheV2({ version: 2, entries: 'x' }).entries).toEqual([]);
    const restored = restoreCodexModelCacheV2({
      version: 2,
      entries: [
        { program: NPM, cliVersion: '0.155.1', capturedAt: '2026-10-18T00:00:00Z', models: [model('ok'), { id: 7 }] },
        { program: '', cliVersion: '0.155.1', capturedAt: '2026-10-18T00:00:00Z', models: [model('x')] },
        { program: EXT, cliVersion: 'latest', capturedAt: '2026-10-18T00:00:00Z', models: [model('x')] },
        { program: EXT, cliVersion: '0.155.1', capturedAt: 'yesterday', models: [model('x')] },
      ],
    });
    expect(restored.entries).toEqual([{ program: NPM, cliVersion: '0.155.1', capturedAt: '2026-10-18T00:00:00Z', models: [model('ok')] }]);
  });
});
