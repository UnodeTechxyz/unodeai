import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ExecutableSkillHost, RUN_SKILL_ACTION_TOOL } from '../ExecutableSkillHost';
import { SkillRegistry } from '../SkillRegistry';
import { resolveBundledSkillActionHandler } from '../SkillActionHandlers';

async function fixture(): Promise<{ temp: string; root: string; skill: string; registry: SkillRegistry }> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-skill-host-'));
  const root = path.join(temp, 'skills');
  const skill = path.join(root, 'rigor', 'action-skill');
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, 'SKILL.md'), `---\nname: action-skill\ndescription: Run an approved action when a local audit is requested.\n---\nUse the declared action.`);
  await fs.writeFile(path.join(skill, 'unode-actions.json'), JSON.stringify({
    version: 1,
    actions: [{ id: 'echo-input', description: 'Echo structured input.', handler: 'unode.echo-json.v1', declaredEffects: [] }],
  }));
  await fs.writeFile(path.join(temp, 'SkillActionRunner.js'), `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).message));`);
  return { temp, root, skill, registry: SkillRegistry.load(root) };
}

describe('ExecutableSkillHost', () => {
  it('never resolves inherited object properties as compiled action handlers', () => {
    expect(resolveBundledSkillActionHandler('constructor')).toBeUndefined();
    expect(resolveBundledSkillActionHandler('__proto__')).toBeUndefined();
    expect(resolveBundledSkillActionHandler('unode.echo-json.v1')).toBeTypeOf('function');
  });
  it('requires trust and an exact-digest run-once approval, then returns an audit receipt', async () => {
    const item = await fixture();
    const approve = vi.fn(async () => ({ allow: true }));
    try {
      const host = new ExecutableSkillHost({
        registry: item.registry, grantedNames: ['action-skill'], agentName: 'Auditor',
        workspaceRoot: item.temp, runnerPath: path.join(item.temp, 'SkillActionRunner.js'),
        isTrusted: () => true, requestApproval: approve,
      });
      expect(host.toolSpec()?.function.name).toBe(RUN_SKILL_ACTION_TOOL);
      const result = await host.run({ name: 'action-skill', action: 'echo-input', input: { message: 'hello' } });
      expect(result).toMatchObject({ status: 'success', exitCode: 0, contentSource: 'mixed-external' });
      expect(result.output).toContain('hello');
      expect(result.output).toContain('digest=sha256:');
      expect(approve).toHaveBeenCalledOnce();
      expect(approve.mock.calls[0][0].warning).toContain('user authority');
      expect(approve.mock.calls[0][0].handler).toBe('unode.echo-json.v1');
    } finally {
      await fs.rm(item.temp, { recursive: true, force: true });
    }
  });

  it('fails closed without trust or approval and invalidates changed content', async () => {
    const item = await fixture();
    try {
      const untrusted = new ExecutableSkillHost({
        registry: item.registry, grantedNames: ['action-skill'], agentName: 'Auditor',
        workspaceRoot: item.temp, runnerPath: path.join(item.temp, 'SkillActionRunner.js'), isTrusted: () => false,
      });
      expect(await untrusted.run({ name: 'action-skill', action: 'echo-input', input: {} }))
        .toMatchObject({ status: 'refused', reason: 'trust' });

      const missingApproval = new ExecutableSkillHost({
        registry: item.registry, grantedNames: ['action-skill'], agentName: 'Auditor',
        workspaceRoot: item.temp, runnerPath: path.join(item.temp, 'SkillActionRunner.js'), isTrusted: () => true,
      });
      expect(await missingApproval.run({ name: 'action-skill', action: 'echo-input', input: {} }))
        .toMatchObject({ status: 'refused', reason: 'consent' });

      const changed = new ExecutableSkillHost({
        registry: item.registry, grantedNames: ['action-skill'], agentName: 'Auditor',
        workspaceRoot: item.temp, runnerPath: path.join(item.temp, 'SkillActionRunner.js'), isTrusted: () => true,
        requestApproval: async () => {
          await fs.writeFile(path.join(item.skill, 'SKILL.md'), `---\nname: action-skill\ndescription: Run an approved action when a local audit is requested.\n---\nChanged after approval.`);
          return { allow: true };
        },
      });
      expect(await changed.run({ name: 'action-skill', action: 'echo-input', input: {} }))
        .toMatchObject({ status: 'refused', reason: 'consent' });
    } finally {
      await fs.rm(item.temp, { recursive: true, force: true });
    }
  });

  it('resolves at the timeout even when inherited output pipes never close', async () => {
    const item = await fixture();
    const proc = new EventEmitter() as any;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    proc.kill = vi.fn();
    const terminate = vi.fn();
    try {
      const host = new ExecutableSkillHost({
        registry: item.registry, grantedNames: ['action-skill'], agentName: 'Auditor',
        workspaceRoot: item.temp, runnerPath: path.join(item.temp, 'SkillActionRunner.js'),
        isTrusted: () => true, requestApproval: async () => ({ allow: true }),
        spawn: (() => proc) as any, terminate, timeoutMs: 1_000,
      });
      const started = Date.now();
      const result = await host.run({ name: 'action-skill', action: 'echo-input', input: {} });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result).toMatchObject({ status: 'failed' });
      expect(result.output).toContain('timedOut=true');
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(item.temp, { recursive: true, force: true });
    }
  });

  it('does not kill by a possibly reused pid after the fixed runner already exited', async () => {
    const item = await fixture();
    const proc = new EventEmitter() as any;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    proc.kill = vi.fn();
    const terminate = vi.fn();
    try {
      const host = new ExecutableSkillHost({
        registry: item.registry, grantedNames: ['action-skill'], agentName: 'Auditor',
        workspaceRoot: item.temp, runnerPath: path.join(item.temp, 'SkillActionRunner.js'),
        isTrusted: () => true, requestApproval: async () => ({ allow: true }),
        spawn: (() => {
          queueMicrotask(() => proc.emit('exit', 0));
          return proc;
        }) as any,
        terminate,
        timeoutMs: 1_000,
      });
      const result = await host.run({ name: 'action-skill', action: 'echo-input', input: {} });
      expect(result.output).toContain('timedOut=false');
      expect(result.output).toContain('exitCode=0');
      expect(terminate).not.toHaveBeenCalled();
    } finally {
      await fs.rm(item.temp, { recursive: true, force: true });
    }
  });
});
