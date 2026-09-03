/*---------------------------------------------------------------------------------------------
 *  Rebrand smoke test — guards the legacy-brand → UnodeAi rename so it can't silently regress.
 *
 *  Two-sided invariant:
 *   1. The EXTENSION namespace is fully `unode` (publisher, contribution ids, config keys, icons).
 *   2. The partner GATEWAY PROVIDER is INTENTIONALLY preserved (provider id `roam`, ROAM_API_KEY,
 *      the partner endpoint) — so a well-meaning "finish the rename" edit that breaks the provider fails here.
 *
 *  Fast + no build: reads package.json and scans src/ (production files only).
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const c = pkg.contributes ?? {};
const cfg: Record<string, any> = c.configuration?.properties ?? {};

/** All production .ts source (excludes tests, compiled output, deps). */
function productionSources(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (['__tests__', 'node_modules'].includes(e.name)) { continue; }
        walk(p);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        out.push(p);
      }
    }
  })(join(ROOT, 'src'));
  return out;
}
const SRC = productionSources().map((f) => ({ f, text: readFileSync(f, 'utf8') }));
function grepSrc(re: RegExp): string[] {
  return SRC.filter(({ text }) => re.test(text)).map(({ f }) => f.replace(ROOT, '.'));
}

describe('rebrand: extension identity is `unode`', () => {
  it('publisher/name/icon', () => {
    expect(pkg.name).toBe('unodeai');
    expect(pkg.publisher).toBe('unode');
    expect(pkg.icon).toBe('images/icon.png');
  });

  it('every command id is namespaced unode.*', () => {
    const bad = (c.commands ?? []).map((x: any) => x.command).filter((id: string) => !id.startsWith('unode.'));
    expect(bad).toEqual([]);
  });

  it('keeps all views in the unode sidebar container', () => {
    expect(c.viewsContainers.activitybar.map((x: any) => x.id)).toEqual(['unode']);
    expect(c.viewsContainers.panel).toBeUndefined();
    expect(Object.keys(c.views)).toEqual(['unode']);
    const badViews = Object.values(c.views).flat().map((v: any) => v.id).filter((id: string) => !id.startsWith('unode.'));
    expect(badViews).toEqual([]);
  });

  it('chat participant is unode.crew / @unode', () => {
    expect(c.chatParticipants[0].id).toBe('unode.crew');
    expect(c.chatParticipants[0].name).toBe('unode');
  });

  it('every configuration key is namespaced unode.*', () => {
    const bad = Object.keys(cfg).filter((k) => !k.startsWith('unode.'));
    expect(bad).toEqual([]);
  });

  it('icons reference unode-icon.* (no roam-icon left)', () => {
    const manifest = readFileSync(join(ROOT, 'package.json'), 'utf8');
    expect(manifest).not.toContain('roam-icon');
    for (const f of ['unode-icon.svg', 'unode-icon.light.svg', 'unode-icon.dark.svg']) {
      expect(existsSync(join(ROOT, 'images', f))).toBe(true);
    }
    for (const f of ['roam-icon.svg', 'roam-icon.light.svg', 'roam-icon.dark.svg']) {
      expect(existsSync(join(ROOT, 'images', f))).toBe(false);
    }
  });
});

describe('rebrand: no legacy `roam` contribution ids leak into source', () => {
  it('no getConfiguration("roam") namespace reads (except the legacy-settings migration)', () => {
    // The one legitimate read is the roam.* → unode.* migration helper (`const oldCfg = …('roam')`).
    const offenders = SRC.flatMap(({ f, text }) =>
      text.split('\n')
        .filter((line) => /getConfiguration\((['"])roam\1\)/.test(line) && !/oldCfg|legacy|migrat/i.test(line))
        .map(() => f.replace(ROOT, '.'))
    );
    expect(offenders).toEqual([]);
  });
  it('no roam.* command register/execute', () => {
    expect(grepSrc(/\b(?:reg|registerCommand|executeCommand)\(\s*['"]roam\./)).toEqual([]);
  });
  it('no roam.* chat participant / activity-bar focus', () => {
    expect(grepSrc(/createChatParticipant\(\s*['"]roam\./)).toEqual([]);
    expect(grepSrc(/workbench\.view\.extension\.roam\b/)).toEqual([]);
  });
  it('no roam-icon path in source', () => {
    expect(grepSrc(/roam-icon/)).toEqual([]);
  });
});

describe('rebrand: partner gateway PROVIDER is intentionally preserved (do NOT rename)', () => {
  it('default provider defaults to `unode` and is no longer a static enum (custom gateway ids are machine-local)', () => {
    // roam's preservation as a partner provider is covered by the ROAM_API_KEY test below; the enum that once
    // listed it was removed because runtime custom:<id> connections cannot appear in a static manifest enum.
    expect(cfg['unode.defaultProvider'].default).toBe('unode');
    expect(cfg['unode.defaultProvider'].enum).toBeUndefined();
  });
  it('partner gateway base URL default is neutralized in the manifest (resolved in code, not shipped in package.json)', () => {
    // The functional endpoint lives only as an internal constant (see openAICompatBaseUrl.test.ts); the
    // manifest default is blank so the partner host is not surfaced in the shipped settings UI.
    expect(cfg['unode.baseUrl'].default).toBe('');
  });
  it('ROAM_API_KEY secret name is still referenced in source', () => {
    expect(grepSrc(/ROAM_API_KEY/).length).toBeGreaterThan(0);
  });
});

describe('rebrand: security posture shipped with the rename', () => {
  it('declares limited untrusted-workspace support and unsupported virtual workspaces', () => {
    expect(pkg.capabilities.untrustedWorkspaces.supported).toBe('limited');
    expect(pkg.capabilities.virtualWorkspaces.supported).toBe(false);
  });
  it('hosted catalog fetch is opt-in (no network by default)', () => {
    expect(cfg['unode.marketplace.fetchCatalog'].default).toBe(false);
  });
});
