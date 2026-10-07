import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { workerComplianceProtocol } from '../SessionManager';
import { AgentConfig } from '../../types';

const cfg = (over: Partial<AgentConfig>): AgentConfig => ({
  id: 'a', role: 'senior-dev', name: 'Dev', skill: '', skills: [],
  provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
  model: 'deepseek-v4-flash', systemPrompt: '', autoApprove: false,
  allowedTools: ['read', 'write', 'execute'],
  ...over,
});

describe('workerComplianceProtocol', () => {
  it('keeps the shipped coordinator runtime guidance byte-for-byte unchanged by content receipt support', () => {
    const prompt = workerComplianceProtocol(cfg({ role: 'pm', allowedTools: ['delegate'] }), 'a');
    expect(createHash('sha256').update(prompt).digest('hex')).toBe('65b5d24520586cd612a9605554b8ce049619e5842486e07dbd9c0f93febcd8f3');
    expect(prompt).not.toContain('declare_turn_deliverable');
    expect(prompt).not.toContain('deliver_declared_content');
    expect(prompt).not.toContain('publish_content_receipt');
  });

  it('injects the protocol for worker agents (incl. the shared fresh-read rule)', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    expect(out).toMatch(/Cite from a fresh read, never from memory/i); // shared by every agent
    expect(out).toContain('Carrying out an assigned task');
    expect(out).toMatch(/do not reply with only a plan/i);
    expect(out).toMatch(/Do NOT tell the requester to run a command/i);
    expect(out).toMatch(/When the request is to run an exact command, that is, the user or coordinator hands you the command and\s+asks for its result, call run_command with it as your first tool call/);
    expect(out).toMatch(/this rule comes before the fresh-read rule and the ground-first rule below/i);
    expect(out).toMatch(/do not\s+first confirm that its script exists, read package\.json, list or search files, or look through earlier\s+turns/i);
    // A task that names its own check is not a request to run that check before the work.
    expect(out).toMatch(/A command that is only named as the\s+check for other work is run after that work, not first/);
  });

  // Field run of v0.9.92: an Architect given `npm run check:docs` searched, read package.json, searched again,
  // ran the command, and ran it a second time to be sure the result was from this turn. The rule was a bullet
  // in the third section, under two sections that tell an agent to read before it acts, and it named only one
  // of the two as superseded.
  it('puts what to do with a handed command before the read-first rules', () => {
    const runs = workerComplianceProtocol(cfg({}), 'pm');
    const first = runs.indexOf('## An exact command is run first (required)');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(runs.indexOf('## Cite from a fresh read'));
    expect(first).toBeLessThan(runs.indexOf('## Ground the task in the REAL code'));
    expect(runs).toMatch(/Run it\s+once: a result you received in this turn is current, so do not repeat the command to confirm it/);
    expect(runs.match(/as your first tool call/g)).toHaveLength(1);
    expect(runs).not.toContain('You cannot run commands in this session');

    const cannot = workerComplianceProtocol(cfg({ allowedTools: ['read', 'search', 'write'] }), 'pm');
    const blocked = cannot.indexOf('## You cannot run commands in this session (required)');
    expect(blocked).toBeGreaterThanOrEqual(0);
    expect(blocked).toBeLessThan(cannot.indexOf('## Cite from a fresh read'));
    expect(blocked).toBeLessThan(cannot.indexOf('## Ground the task in the REAL code'));
    expect(cannot).not.toContain('An exact command is run first');
  });

  it('includes the P2 worker-protocol rules (from dogfood findings)', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    // Re-read before claiming "already done" (caught: agent claimed a change from stale memory).
    expect(out).toMatch(/READ the relevant file\(s\).*current contents/is);
    expect(out).toMatch(/never rely on\s+your memory/i);
    // Don't weaken tests to pass (caught: agent changed an assertion to match buggy output).
    expect(out).toMatch(/fixing the CODE, never by weakening the tests/i);
    // Small, verifiable steps.
    expect(out).toMatch(/small, verifiable steps/i);
    // Todo hygiene: mark the final step completed before reporting done.
    expect(out).toMatch(/todo list honest/i);
    expect(out).toMatch(/mark the FINAL step completed/i);
  });

  it('makes workers ground the task in the real code before acting (weak-model failure mode)', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    expect(out).toMatch(/Ground the task in the REAL code before you act/i);
    expect(out).toMatch(/instruction tells you the INTENT/i);
    expect(out).toMatch(/RECONCILE the instruction with what you found/i);
    expect(out).toMatch(/do not invent a function, file, import, or pattern/i);
    expect(out).toMatch(/instruction CONFLICTS with reality/i);
  });

  it('does NOT give the coordinator the worker-only ground-first / task protocol', () => {
    const out = workerComplianceProtocol(cfg({ role: 'pm', allowedTools: ['read', 'search', 'delegate', 'message'] }), 'a');
    expect(out).toMatch(/Cite from a fresh read, never from memory/i);
    expect(out).toMatch(/read it this turn/i);
    expect(out).not.toContain('Carrying out an assigned task'); // not the worker protocol
    expect(out).not.toMatch(/Ground the task in the REAL code/i);
  });

  it('gives any delegate-holding agent the same fresh-read rule', () => {
    const out = workerComplianceProtocol(cfg({ role: 'custom', allowedTools: ['read', 'delegate'] }), 'pm');
    expect(out).toMatch(/Cite from a fresh read, never from memory/i);
  });

  it('uses the supplied coordinator id rather than a PM role or delegate capability', () => {
    const secondPm = cfg({ id: 'pm-2', role: 'pm', allowedTools: ['delegate'] });

    expect(workerComplianceProtocol(secondPm, 'pm')).toContain('Carrying out an assigned task');
    expect(workerComplianceProtocol(secondPm, 'pm')).not.toContain('## How to delegate');
    expect(workerComplianceProtocol(cfg({ id: 'pm', role: 'pm' }), 'pm')).toContain('## How to delegate');
  });

  it('does not retain the transcript-visibility instruction after structural receipt publication', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    expect(out).not.toContain('A tool result is not a user-visible reply');
    expect(out).not.toMatch(/"I read it" is not "I\s*showed it to you\./i);
    expect(out).not.toMatch(/Do not rely on tool-card rendering/i);
  });

  it('still applies to read-only workers like the reviewer', () => {
    const out = workerComplianceProtocol(cfg({ role: 'reviewer', allowedTools: ['read', 'search', 'message'] }), 'pm');
    expect(out).toContain('deliverable');
    expect(out).toContain('Blocked: this agent does not have Write files');
    expect(out).toContain('Blocked: this agent does not have Run commands');
    expect(out).toMatch(/do not inspect package scripts, search conversation history/i);
    expect(out).toMatch(/Reading a script or a previous run is not execution/i);
    expect(out).not.toMatch(/YOU run it/i);
  });

  // Agent Builder has no "Run commands" or "Write files" switch. A permission is what a ticked capability
  // results in, and the form says so under each capability. The way on an agent names has to be one the
  // requester can find, so the words the guidance uses are checked against the form's own.
  it('names a way on that Agent Builder really offers', () => {
    const out = workerComplianceProtocol(cfg({ role: 'reviewer', allowedTools: ['read', 'search', 'message'] }), 'pm');
    expect(out).toMatch(/in Agent Builder, under Tools, tick a capability whose resulting\s+permissions include Run commands, or send the task to a capable agent/);
    expect(out).toMatch(/in Agent Builder, under Tools, tick a capability whose resulting permissions include Write files, or send the task to a capable agent/);
    expect(out).toMatch(/Agent Builder has no separate\s+Run commands switch/);
    expect(out).not.toMatch(/enable (Run commands|Write files) in Agent Builder/i);

    const builder = readFileSync(join(process.cwd(), 'src/views/AgentBuilderPanel.ts'), 'utf8');
    expect(builder).toContain('<h2>Tools</h2>');
    expect(builder).toContain('Resulting permissions: ');
    // Under a capability the form writes them in lower case; its notice beside Save capitalises them.
    expect(builder).toMatch(/case 'write': return 'write files';\s+case 'execute': return 'run commands';/);
    expect(builder).toMatch(/write: 'Write files', execute: 'Run commands'/);
  });
});

describe('coordinator delegation protocol reaches EXISTING agents (prompt-freeze regression)', () => {
  // An agent's systemPrompt is copied from its role template at creation and PERSISTED, so a template edit
  // only ever reaches NEW agents. A field report caught this: the delegation rule was fixed, but a PM created
  // earlier kept blocking on assign_task and the user could not reach it. The rule must be appended at
  // RUNTIME (so old PMs get it) and must SUPERSEDE the frozen copy still in their prompt.
  it('appends the non-blocking delegation rule to a coordinator at runtime', () => {
    const pm = workerComplianceProtocol({ id: 'pm', role: 'pm', allowedTools: ['delegate'] } as never, 'pm');
    expect(pm).toMatch(/dispatch_task/);
    expect(pm).toMatch(/collect_ready_tasks/);
    expect(pm).toMatch(/END YOUR TURN/i);
    expect(pm).toMatch(/SUPERSEDES any earlier delegation instruction/i);
    expect(pm).toMatch(/no blocking delegation tool/i);
  });

  it('does not give a non-coordinator worker delegation rules', () => {
    const worker = workerComplianceProtocol({ role: 'senior-dev', allowedTools: ['write'] } as never, 'pm');
    expect(worker).not.toMatch(/dispatch_task/);
  });
});
