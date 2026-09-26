import { describe, expect, it } from 'vitest';
import { ROLE_TEMPLATES } from '../../roles/RoleConfig';
import { parseAgentCatalog } from '../catalog';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  LEGACY_AGENT_CATALOG_TEMPLATE_MAP,
  roleTemplateCatalogEntries,
  roleTemplateCatalogKeys,
} from '../roleTemplateCatalog';

describe('Marketplace role-template catalog', () => {
  it('has exactly the same keys as Create a team', () => {
    expect(roleTemplateCatalogKeys()).toEqual(Object.keys(ROLE_TEMPLATES).sort());
    expect(roleTemplateCatalogKeys()).toHaveLength(52);
  });

  it('projects every template into a valid role card', () => {
    const entries = roleTemplateCatalogEntries();
    expect(() => parseAgentCatalog(entries, { knownSkillIds: new Set(entries.flatMap((entry) => entry.skills)) })).not.toThrow();
    expect(entries.every((entry) => entry.roleTemplateKey === entry.id)).toBe(true);
  });

  it('reconciles every entry from the retired 13-card catalog to a shipped template', () => {
    const legacy = JSON.parse(readFileSync(resolve(__dirname, '../../../marketplace/agents.json'), 'utf8')) as Array<{ id: string }>;
    expect(Object.keys(LEGACY_AGENT_CATALOG_TEMPLATE_MAP).sort()).toEqual(legacy.map((entry) => entry.id).sort());
    for (const target of Object.values(LEGACY_AGENT_CATALOG_TEMPLATE_MAP)) {
      expect(ROLE_TEMPLATES[target], target).toBeDefined();
    }
  });
});
