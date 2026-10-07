import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src', 'extension.ts'), 'utf8');

describe('custom gateway background-request disclosure', () => {
  it('states the actual background policy in the final modal before the profile is saved', () => {
    const start = source.indexOf('async function addCustomGateway()');
    const end = source.indexOf('\nasync function renameCustomGateway(', start);
    const body = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('modal: true');
    expect(body).toContain('Background requests: none.');
    expect(body).toContain('Saving this gateway does not authorize automatic network traffic.');
    expect(body.indexOf('showInformationMessage')).toBeLessThan(body.indexOf('customGatewayProfileStore.add'));
  });
});
