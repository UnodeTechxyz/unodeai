import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { build } from 'esbuild';
import JSZip from 'jszip';
import { EffectiveConnectionRegistry } from '../../routes/ConnectionRegistry';
import { ImageConnectionRegistry } from '../../image/ImageConnectionRegistry';
import type { MediaSelection } from '../../models/MediaModelSelection';
import { GENERATED_IMAGE_RECORD_LIMIT, ImageGenerationHost, type ImageGenerationPorts } from '../../image/ImageGenerationHost';
import { SpendCoordinator } from '../../host/SpendCoordinator';
import { FileSpendLedger } from '../../state/SpendStore';
import { parseUserTargets } from '../../models/spend/SpendTargets';
import { ImageOperationHistory, type ImageOperationRecord } from '../../image/ImageOperationHistory';
import { saveHost } from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { solidScreenshotPng, presentationWithImage } from './presentationImageFixtures';
import { presentationRouteRenderer } from './presentationRouteFixtures';
import { OpenAICompatBackend } from '../OpenAICompatBackend';
import { OfficeVisualDelivery } from '../../office/OfficeVisualDelivery';
import { OfficeRenderPureHost } from '../../office/OfficeRenderPureHost';
import { OfficeArtifactHistory, type OfficeArtifactRecord } from '../../office/OfficeArtifactHistory';

const png = solidScreenshotPng(1536, 1024);
let renderer: Awaited<ReturnType<typeof presentationRouteRenderer>>;
let previewWorker: string;
const cleanup: Array<() => Promise<unknown> | void> = [];
beforeAll(async () => {
  renderer = await presentationRouteRenderer(); previewWorker = join(dirname((renderer as any).workerPath), 'OfficeRenderPureWorker.cjs');
  await build({ entryPoints: ['src/office/OfficeRenderPureWorker.ts'], outfile: previewWorker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
});
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });
afterAll(removeTemporaryFolders);
it('records a real generated original as its own operation-scoped version without prompt, key or pixels', async () => {
  const records: OfficeArtifactRecord[] = [];
  const history = new OfficeArtifactHistory({ failed: () => { throw Error('unexpected storage failure'); }, write: async (_key, record) => { records.push(record); } });
  const f = await fixture({ officeHistory: history });
  const generated = await generate(f); await history.flush();
  expect(generated).toMatchObject({ quality: 'unknown', requested_quality: 'medium' });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ agentId: 'dev', operationId: generated.operation_id, origin: { kind: 'generated-image', model: 'gpt-image-2.6-flare', sha256: createHash('sha256').update(png).digest('hex') } });
  expect(records[0].derivations).toEqual([]);
  expect(records.find(record => record.kind === 'image')!.assetRef).toBe(`${generated.operation_id}:${generated.asset_id}`);
  const serialized = JSON.stringify(records);
  expect(serialized).not.toContain('fixture-secret-never-in-receipt'); expect(serialized).not.toContain(png.toString('base64'));
});
async function fixture(options: Parameters<typeof saveHost>[0] = {}) {
  const h = await saveHost(options); const tools = h.tools('dev');
  const profile = (endpoint = 'https://api.openai.com/v1', revision = 1) => new EffectiveConnectionRegistry({ registryRevision: revision,
    profiles: [{ connectionId: 'custom:image-test', revision, displayName: 'Image service', endpointBase: endpoint, secretRef: 'image-test-key' } as any] });
  let registry = profile(); let selected: string | undefined = 'custom:image-test'; let granted = true;
  let mediaChoice: MediaSelection | undefined;
  const connections = new ImageConnectionRegistry(() => registry, () => selected, agentId => agentId === 'dev' ? mediaChoice : undefined);
  const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }],
    usage: { input_tokens: 10, output_tokens: 20, input_tokens_details: { text_tokens: 10, image_tokens: 0, cached_tokens: 0 } } }), { headers: { 'x-request-id': 'req-fixture' } }));
  const secret = vi.fn(async () => 'fixture-secret-never-in-receipt');
  const preview = vi.fn();
  let usage: ImageGenerationPorts['usage'];
  const egress = vi.fn(async () => {});
  const host = new ImageGenerationHost(h.assets, { connections, secret, egress, egressCurrent: () => granted, fetch: transport, preview,
    usage: (agentId, attemptId) => usage?.(agentId, attemptId) });
  tools.setImageGeneration(host); tools.setPresentationRenderer(renderer);
  cleanup.push(() => h.assets.dispose(), () => { tools.retire(); host.dispose(); connections.dispose(); });
  return { h, tools, host, connections, transport, secret, preview, egress,
    setUsage(port: ImageGenerationPorts['usage']) { usage = port; },
    changeEndpoint(endpoint: string) { registry = profile(endpoint, 2); connections.invalidate('custom:image-test'); },
    memberChoice(choice: MediaSelection) { mediaChoice = choice; connections.invalidateMember('dev'); },
    off() { selected = undefined; connections.invalidate(); },
    revoke() { granted = false; connections.invalidate('custom:image-test'); },
  };
}
it('uses separate image models per member and aborts only the member whose selection changes', async () => {
  const f = await fixture();
  f.memberChoice({ connectionId: 'unode', modelId: 'gpt-image-2' });
  const override = f.connections.capture('dev');
  const defaultImage = f.connections.capture('another-member');
  expect(override).toMatchObject({ modelId: 'gpt-image-2', connectionId: 'unode' });
  expect(defaultImage).toMatchObject({ modelId: 'gpt-image-2.6-flare', connectionId: 'custom:image-test' });
  const changing = new AbortController(); const preserving = new AbortController();
  f.connections.watch(override, changing); f.connections.watch(defaultImage, preserving);
  f.memberChoice('off');
  expect(changing.signal.aborted).toBe(true);
  expect(preserving.signal.aborted).toBe(false);
  expect(() => f.connections.check(override)).toThrow();
  expect(() => f.connections.check(defaultImage)).not.toThrow();
});

it('uses the gateway route, size and PNG, and records actual quality, original asset and unavailable pricing', async () => {
  const f = await fixture();
  f.memberChoice({ connectionId: 'unode', modelId: 'gpt-image-2' });
  const spec = f.tools.specs().find(tool => tool.function.name === 'generate_image');
  expect(spec?.function.parameters.properties.size).toMatchObject({ enum: ['1024x1024'] });
  const invalid = await f.tools.run('generate_image', { prompt: 'image', size: '1536x1024' });
  expect(invalid.output).toContain('image-size-not-supported');
  expect(f.transport).not.toHaveBeenCalled();

  const records: ImageOperationRecord[] = [];
  const history = new ImageOperationHistory({ failed: vi.fn(), write: async (_key, record) => { records.push(record); } });
  const ledger = new FileSpendLedger({ root: join(f.h.storage, 'unode-image-spend'), pollMs: 0 });
  await ledger.open();
  const coordinator = new SpendCoordinator({ ledger, resolveRoute: () => undefined, routeCandidates: () => [],
    notifier: { threshold: vi.fn(), viewChanged: vi.fn(), referencePriceChoiceNeeded: vi.fn(), repairNeeded: vi.fn() },
    referenceMode: () => 'unselected', catalogs: () => ({}), userTargets: () => parseUserTargets({ schemaVersion: 1 }), repositoryBudget: () => undefined });
  cleanup.push(() => coordinator.dispose());
  f.setUsage(agentId => {
    const record = history.capture({ agentId });
    const spend = coordinator.imageGenerationUsage({ requestId: 'request-image', agentId })!;
    return {
      started: receipt => { record?.started(receipt); spend.started(receipt); },
      settled: (receipt, raw) => { record?.settled(receipt, raw); spend.settled(receipt); },
    };
  });
  const gatewayPng = solidScreenshotPng(1024, 1024);
  const usage = { input_tokens: 23, output_tokens: 196, total_tokens: 219 };
  for (const quality of ['low', undefined]) {
    f.transport.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ b64_json: gatewayPng.toString('base64') }], quality, usage,
    })));
    const result = await generate(f);
    expect(result).toMatchObject({ model: 'gpt-image-2', endpoint_base: 'https://www.unodetech.xyz/v1', quality: quality ?? 'unknown',
      requested_quality: 'medium', connection_id: 'unode', width: 1024, height: 1024, usage, pricing: { source: 'Unode', status: 'unavailable' } });
    expect(f.host.generatedAsset(result.asset_id)).toMatchObject({ assetId: result.asset_id,
      sha256: createHash('sha256').update(gatewayPng).digest('hex') });
  }
  const [url, init] = f.transport.mock.calls[0];
  expect(url).toBe('https://www.unodetech.xyz/v1/images/generations');
  expect(JSON.parse(init!.body as string)).toMatchObject({ model: 'gpt-image-2', n: 1, size: '1024x1024', quality: 'medium', output_format: 'png' });
  expect(f.egress).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'unode', endpointBase: 'https://www.unodetech.xyz/v1' }), expect.any(AbortSignal));
  expect(f.secret).toHaveBeenCalledWith('UNODE_API_KEY');
  await history.flush();
  expect(records).toHaveLength(4);
  expect(records.every(record => record.endpointBase === 'https://www.unodetech.xyz/v1' && record.receipt.model === 'gpt-image-2')).toBe(true);
  await coordinator.drained();
  const receipts = ledger.snapshot().events.flatMap(({ event }) => event.kind === 'usage-receipt' ? [event.receipt] : []);
  expect(receipts).toHaveLength(2);
  expect(receipts[0]).toMatchObject({ connectionId: 'unode', modelId: 'gpt-image-2',
    tokens: { input: 23, output: 196 }, displayCost: { basis: 'unavailable' } });
});
it('hides image generation for a member Off or user None and denies an old call while retaining saved-asset tools', async () => {
  const f = await fixture();
  const names = () => f.tools.specs().map(tool => tool.function.name);
  expect(names()).toContain('generate_image');
  f.memberChoice('off');
  expect(names()).not.toContain('generate_image');
  expect(names()).toContain('save_generated_asset');
  expect((await f.tools.run('generate_image', { prompt: 'must stay private' })).output).toContain('image-connection-not-selected');
  expect(f.connections.capture('another-member').modelId).toBe('gpt-image-2.6-flare');
  f.memberChoice('inherit');
  expect(names()).toContain('generate_image');
  f.off();
  expect(names()).not.toContain('generate_image');
  f.tools.setImageGeneration(f.host, true);
  expect(names()).toContain('generate_image');
  expect((await f.tools.run('generate_image', { prompt: 'must stay private' })).output).toContain('image-connection-not-selected');
  expect(f.transport).not.toHaveBeenCalled();
});
it('records actual generated-image usage on its service connection, survives ledger reload, and keeps unknown/partial cost honest', async () => {
  const f = await fixture(); const root = join(f.h.storage, 'image-spend');
  const ledger = new FileSpendLedger({ root, pollMs: 0 }); await ledger.open();
  const routeCandidates = vi.fn(() => []); const resolveRoute = vi.fn(() => undefined);
  const coordinator = new SpendCoordinator({ ledger, resolveRoute, routeCandidates,
    notifier: { threshold: vi.fn(), viewChanged: vi.fn(), referencePriceChoiceNeeded: vi.fn(), repairNeeded: vi.fn() },
    referenceMode: () => 'unselected', catalogs: () => ({}), userTargets: () => parseUserTargets({ schemaVersion: 1 }), repositoryBudget: () => undefined });
  cleanup.push(() => coordinator.dispose());
  let requestId = 'original-request';
  f.setUsage(agentId => coordinator.imageGenerationUsage({ requestId, agentId }));
  const original = f.transport.getMockImplementation()!;
  f.transport.mockImplementationOnce(async (...args) => {
    requestId = 'newer-request'; const response = await original(...args); const body = await response.json();
    body.usage.input_tokens_details = { text_tokens: 4, image_tokens: 6, cached_tokens: 0 };
    return new Response(JSON.stringify(body), { headers: response.headers });
  });
  const receipt = await generate(f);
  const result = await f.tools.run('generate_image', { prompt: 'another private prompt', variant_of: receipt.operation_id });
  expect(result.status).toBe('success');
  f.transport.mockImplementationOnce(async () => { throw Error('response lost after request'); });
  expect((await f.tools.run('generate_image', { prompt: 'unknown paid result' })).output).toContain('outcome-unknown');
  f.transport.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }],
    usage: { input_tokens: 10, output_tokens: 20, input_tokens_details: { text_tokens: 10, image_tokens: 0, cached_tokens: 3 } } })));
  await generate(f);
  await coordinator.drained();
  const events = ledger.snapshot().events;
  const receipts = events.filter(entry => entry.event.kind === 'usage-receipt').map(entry => (entry.event as any).receipt);
  expect(receipts).toHaveLength(3);
  expect(receipts[0]).toMatchObject({ requestId: 'original-request', agentId: 'dev', connectionId: 'custom:image-test', modelId: 'gpt-image-2.6-flare',
    displayCost: { nanoUsd: '668000', basis: 'gateway-published' }, reminderValue: { basis: 'reported-tokens', tokens: 30 } });
  expect(receipts[1].requestId).toBe('newer-request'); expect(receipts[1].usageUnitId).not.toBe(receipts[0].usageUnitId);
  expect(receipts[2].displayCost).toEqual({ basis: 'unavailable' });
  expect(events.filter(entry => entry.event.kind === 'coverage-gap')).toHaveLength(1);
  expect(coordinator.viewModel().coverageGaps).toBe(1);
  expect(resolveRoute).not.toHaveBeenCalled(); expect(routeCandidates).not.toHaveBeenCalled();
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain('private prompt'); expect(serialized).not.toContain('fixture-secret'); expect(serialized).not.toContain('b64_json');
  const reopened = new FileSpendLedger({ root, pollMs: 0 }); await reopened.open();
  try { expect(reopened.snapshot().events.map(entry => entry.event)).toEqual(events.map(entry => entry.event)); } finally { await reopened.dispose(); }
  const count = events.length; f.off(); await f.tools.run('generate_image', { prompt: 'not submitted' }); await coordinator.drained();
  expect(ledger.snapshot().events).toHaveLength(count);
});
async function generate(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.tools.run('generate_image', { prompt: 'Private exact image prompt' });
  expect(result.status, result.output).toBe('success'); return JSON.parse(result.output);
}
it('persists original private image usage and both lifecycle phases without prompts or pixels, and retries a failed storage write', async () => {
  const f = await fixture(); const root = join(f.h.storage, 'image-history'); await fs.mkdir(root);
  const failed = vi.fn(); let failOnce = true;
  const history = new ImageOperationHistory({ failed, write: async (key, record) => {
    if (failOnce) { failOnce = false; throw Error('private-storage-error-not-for-logs'); }
    await fs.writeFile(join(root, key + '.json'), JSON.stringify(record), { flag: 'wx' });
  } });
  f.setUsage((agentId, attemptId) => history.capture({ agentId, requestId: 'history-request', ...(attemptId ? { attemptId } : {}) }));
  const original = f.transport.getMockImplementation()!;
  f.transport.mockImplementationOnce(async (...args) => {
    const response = await original(...args); const body = await response.json();
    body.usage.provider_extension = { original_field: 'provider-specific-usage-kept-private' };
    return new Response(JSON.stringify(body), { headers: response.headers });
  });
  const generated = await generate(f); await history.flush();
  expect(history.pendingWrites).toBe(0); expect(failed).toHaveBeenCalledExactlyOnceWith();
  const records: ImageOperationRecord[] = await Promise.all((await fs.readdir(root)).map(async name => JSON.parse(await fs.readFile(join(root, name), 'utf8'))));
  expect(records).toHaveLength(2);
  expect(records.find(record => record.phase === 'started')).toMatchObject({ operationId: generated.operation_id, agentId: 'dev', requestId: 'history-request',
    endpointBase: 'https://api.openai.com/v1', receipt: { may_have_cost: true, connection_id: 'custom:image-test', connection_revision: 1 } });
  expect(records.find(record => record.phase === 'settled')).toMatchObject({ operationId: generated.operation_id,
    receipt: { state: 'succeeded', sha256: generated.sha256, asset_id: generated.asset_id },
    rawUsage: { provider_extension: { original_field: 'provider-specific-usage-kept-private' } } });
  const serialized = JSON.stringify(records); expect(serialized).not.toContain('Private exact image prompt');
  expect(serialized).not.toContain('fixture-secret'); expect(serialized).not.toContain(png.toString('base64'));
  f.off(); await f.tools.run('generate_image', { prompt: 'declined before provider' }); await history.flush();
  const after = await Promise.all((await fs.readdir(root)).map(async name => JSON.parse(await fs.readFile(join(root, name), 'utf8'))));
  expect(after).toHaveLength(3);
  expect(after.find(record => record.operationId !== generated.operation_id)).toMatchObject({ phase: 'settled', receipt: { state: 'failed', may_have_cost: false } });
  expect(f.transport).toHaveBeenCalledTimes(1);
});
it('views a genuinely generated asset through the real preview worker after generation is disabled, without confusing image-service and reviewer model facts', async () => {
  const f = await fixture(); const generated = await generate(f); f.off();
  f.tools.useOfficeVisualDelivery(new OfficeVisualDelivery(f.h.assets, new OfficeRenderPureHost(previewWorker)));
  const view = await f.tools.run('view_office_images', { asset_ids: [generated.asset_id] }); expect(view.status, view.output).toBe('success');
  const packet = await f.tools.takeOfficeVisualPacket(view, 'http', 'selected-review-model', true); expect(packet).toBeDefined();
  expect(packet!.images[0].base64).toBe(png.toString('base64'));
  expect(JSON.parse(packet!.text()).deliveries[0]).toMatchObject({ state: 'prepared', model: 'selected-review-model', provider_result: 'unknown',
    origin: { kind: 'generated-image', model: 'gpt-image-2.6-flare', sha256: generated.sha256 }, preview: { sha256: generated.sha256, resized: false } });
  packet!.submitted(); packet!.providerResponse(false); packet!.providerResponse(true); // Duplicate response cannot promote a rejected request.
  const receipt = JSON.parse((await f.tools.run('view_office_images', { operation: 'inspect', delivery_ids: packet!.deliveryIds })).output).deliveries[0];
  expect(receipt).toMatchObject({ state: 'payload-submitted', provider_result: 'rejected', transport: { submitted: 1, accepted: 0, rejected: 1 }, viewed: 'unknown', visual_review: 'not-run' });
  expect(f.transport).toHaveBeenCalledTimes(1); expect(JSON.stringify(receipt)).not.toContain('Private exact image prompt');
});
it('real host tool generates decoded immutable PNG, saves exact original with restore/readback, and embeds it into editable PPT', async () => {
  const f = await fixture(); const receipt = await generate(f);
  expect(receipt).toMatchObject({ state: 'succeeded', width: 1536, height: 1024, model: 'gpt-image-2.6-flare', request_id: 'req-fixture', pricing: { status: 'estimated', estimate_usd: 0.00065 } });
  await vi.waitFor(() => expect(f.preview).toHaveBeenCalledWith(expect.objectContaining({ state: 'succeeded', asset_id: receipt.asset_id, sha256: receipt.sha256 })));
  expect(JSON.stringify(receipt)).not.toContain('Private exact'); expect(JSON.stringify(receipt)).not.toContain('fixture-secret');
  expect(f.transport).toHaveBeenCalledTimes(1);
  const [url, init] = f.transport.mock.calls[0]; expect(url).toBe('https://api.openai.com/v1/images/generations');
  expect(init).toMatchObject({ redirect: 'manual', headers: { authorization: 'Bearer fixture-secret-never-in-receipt' } });
  expect(JSON.parse(init!.body as string)).toEqual({ model: 'gpt-image-2.6-flare', prompt: 'Private exact image prompt', n: 1, size: '1536x1024', quality: 'medium', output_format: 'png' });
  const original = join(f.h.root, 'original.png'); await fs.writeFile(original, 'previous original');
  const saved = await f.tools.run('save_generated_asset', { asset_id: receipt.asset_id, path: 'original.png' });
  expect(saved.status, saved.output).toBe('success'); expect(await fs.readFile(original)).toEqual(png);
  expect(f.h.text.list('original.png')).toHaveLength(1);
  const deck = await f.tools.run('write_presentation', presentationWithImage(receipt.asset_id));
  expect(deck.status, deck.output).toBe('success'); const zip = await JSZip.loadAsync(await fs.readFile(join(f.h.root, 'out/result.pptx')));
  const media = Object.keys(zip.files).find(name => name.startsWith('ppt/media/') && !zip.files[name].dir)!;
  expect(await zip.file(media)!.async('nodebuffer')).toEqual(png);
  expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('<a:t>');
});
it('HTTP backend discovers image tools and delivers a real original and editable PPT through the actual model turn router', async () => {
  const f = await fixture(); const events: unknown[] = []; let requests = 0; let receipt: any;
  const params: ConstructorParameters<typeof OpenAICompatBackend> = [{ id: 'dev', name: 'HTTP image', role: 'developer', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'deepseek-chat', workingDirectory: f.h.root,
    systemPrompt: 'Work.', autoApprove: true, allowedTools: ['read', 'write'], toolProtocol: 'native' }, async (_url, init) => {
    const body = JSON.parse(init.body); expect(body.tools.map((tool: any) => tool.function.name)).toContain('generate_image');
    const results = body.messages.filter((message: any) => message.role === 'tool'); const count = results.length;
    const text = (m: any) => typeof m.content === 'string' ? m.content : m.content.map((block: any) => block.text ?? '').join('\n');
    requests++; if (requests > 4) throw Error('HTTP image flow did not converge');
    if (count === 1) receipt = JSON.parse(text(results[0]));
    const call = count === 0 ? { name: 'generate_image', args: { prompt: 'Private HTTP illustration' } }
      : count === 1 ? { name: 'save_generated_asset', args: { asset_id: receipt.asset_id, path: 'http-original.png' } }
        : count === 2 ? { name: 'write_presentation', args: presentationWithImage(receipt.asset_id) } : undefined;
    if (count === 3) expect(text(results[2])).toContain('out/result.pptx');
    const response = { choices: [{ message: call ? { role: 'assistant', content: null, tool_calls: [{ id: 'image-' + count, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      : { role: 'assistant', content: 'Original and presentation delivered.' } }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
  }];
  params[16] = { imageGeneration: f.host, delegationContentAssets: f.h.assets, fileWrites: f.h.fileWrites('dev'), presentationRenderer: renderer };
  const backend = new OpenAICompatBackend(...params); cleanup.push(() => backend.stop());
  const done = new Promise<boolean>(resolve => backend.onEvent(event => { events.push(event); if (event.kind === 'turn_complete') resolve(event.result.isError); }));
  await backend.start({ ROAM_API_KEY: 'fixture-chat-key' }); backend.sendUserTurn('Generate an illustration and a presentation.'); expect(await done).toBe(false);
  expect(await fs.readFile(join(f.h.root, 'http-original.png'))).toEqual(png);
  const zip = await JSZip.loadAsync(await fs.readFile(join(f.h.root, 'out/result.pptx')));
  const media = Object.keys(zip.files).find(name => name.startsWith('ppt/media/') && !zip.files[name].dir)!;
  expect(await zip.file(media)!.async('nodebuffer')).toEqual(png);
  expect(requests).toBe(4); expect(f.transport).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(events)).not.toContain('Private HTTP illustration');
});
it.each(['off', 'gateway'] as const)('does not obtain a key or send image requests for %s', async kind => {
  const f = await fixture(); if (kind === 'off') f.off(); else f.changeEndpoint('https://company.example/v1');
  const result = await f.tools.run('generate_image', { prompt: 'test' }); expect(result.status).not.toBe('success');
  expect(result.output).toContain(kind === 'off' ? 'image-connection-not-selected' : 'image-endpoint-not-implemented');
  expect(f.secret).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
});
it.each(['revoke', 'endpoint'] as const)('cancels live %s changes and records unknown transport without automatically retrying', async kind => {
  const f = await fixture(); let launched!: () => void; const started = new Promise<void>(resolve => { launched = resolve; });
  f.transport.mockImplementationOnce(async (_url, init) => { launched(); return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('fixture abort')), { once: true })); });
  const pending = f.tools.run('generate_image', { prompt: 'test' }); await started;
  if (kind === 'revoke') f.revoke(); else f.changeEndpoint('https://company.example/v1');
  const result = await pending; expect(result.status).not.toBe('success'); expect(result.output).toContain('outcome-unknown');
  expect(result.output).toContain('"may_have_cost":true'); expect(f.transport).toHaveBeenCalledTimes(1);
});
it('a credential invalidation while the key read waits prevents the first outbound request', async () => {
  const f = await fixture(); let release!: (key: string) => void; let read!: () => void;
  const started = new Promise<void>(resolve => { read = resolve; });
  f.secret.mockImplementationOnce(async () => { read(); return await new Promise<string>(resolve => { release = resolve; }); });
  const pending = f.tools.run('generate_image', { prompt: 'test' }); await started;
  f.connections.invalidate('custom:image-test'); release('new-key');
  const result = await pending; expect(result.status).not.toBe('success'); expect(f.transport).not.toHaveBeenCalled();
  expect(result.output).toContain('"may_have_cost":false');
});
it('an unchanged registry refresh or an unrelated credential change does not cancel a usable generation', async () => {
  const f = await fixture(); let release!: (response: Response) => void; let launch!: () => void;
  const started = new Promise<void>(resolve => { launch = resolve; });
  f.transport.mockImplementationOnce(async () => { launch(); return await new Promise<Response>(resolve => { release = resolve; }); });
  const pending = f.tools.run('generate_image', { prompt: 'test' }); await started;
  f.connections.refresh(); f.connections.invalidate('custom:unrelated');
  release(new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })));
  expect((await pending).status).toBe('success');
});
it('retiring the tool owner aborts the in-flight image operation', async () => {
  const f = await fixture(); let launch!: () => void; const started = new Promise<void>(resolve => { launch = resolve; });
  f.transport.mockImplementationOnce(async (_url, init) => { launch(); return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('owned stop')), { once: true })); });
  const pending = f.tools.run('generate_image', { prompt: 'test' }); await started; f.tools.retire();
  expect((await pending).output).toContain('outcome-unknown'); expect(f.transport).toHaveBeenCalledTimes(1);
});
it.each(['write-off', 'untrusted'] as const)('keeps %s from starting image generation', async scope => {
  const f = await fixture(scope === 'write-off' ? { capabilities: ['read'] } : { trusted: () => false });
  expect((await f.tools.run('generate_image', { prompt: 'test' })).status).not.toBe('success');
  expect(f.secret).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
});
it.each(['plan', 'coordinator-contract'] as const)('HTTP real turn keeps %s from issuing a paid image request', async scope => {
  const f = await fixture(); let result = ''; let calls = 0;
  const params: ConstructorParameters<typeof OpenAICompatBackend> = [{ id: 'dev', name: 'PM', role: 'developer', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' }, model: 'deepseek-chat', workingDirectory: f.h.root,
    autoApprove: true, allowedTools: ['read', 'write'], toolProtocol: 'native' }, async (_url, init) => {
    const body = JSON.parse(init.body); const output = body.messages.find((m: any) => m.role === 'tool');
    if (output) result = typeof output.content === 'string' ? output.content : JSON.stringify(output.content);
    if (++calls > 2) throw Error('Refusal did not converge');
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: output
      ? { role: 'assistant', content: 'Continue without generating.' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'restricted-image', type: 'function', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'Do not send' }) } }] } }] }) };
  }];
  if (scope === 'coordinator-contract') params[2] = { has: () => false, hasTeammates: () => true, specs: () => [], canCoordinatorExecute: () => false, interruptPending: () => {},
    currentCoordinatorTaskAttempt: () => ({ contractId: 'other-contract' }) } as any;
  params[16] = { imageGeneration: f.host, delegationContentAssets: f.h.assets, fileWrites: f.h.fileWrites('dev') };
  const backend = new OpenAICompatBackend(...params); cleanup.push(() => backend.stop());
  const done = new Promise<void>(resolve => backend.onEvent(e => { if (e.kind === 'turn_complete') resolve(); }));
  await backend.start({ ROAM_API_KEY: 'fixture-chat-key' }); backend.sendUserTurn('Plan.', scope === 'plan' ? { mode: 'plan' } : undefined); await done;
  expect(result).toContain(scope === 'plan' ? 'Plan mode' : 'outside the task contract'); expect(f.transport).not.toHaveBeenCalled();
});
it.each(['redirect', 'base64', 'png'] as const)('does not admit %s as a generated image', async kind => {
  const f = await fixture();
  f.transport.mockResolvedValueOnce(kind === 'redirect' ? new Response(null, { status: 302, headers: { location: 'https://other.example/image' } })
    : new Response(JSON.stringify({ data: [{ b64_json: kind === 'base64' ? 'not base64!' : Buffer.from('not PNG').toString('base64') }] })));
  const result = await f.tools.run('generate_image', { prompt: 'test' }); expect(result.status).not.toBe('success');
  expect(f.transport).toHaveBeenCalledTimes(1); expect(result.output).not.toContain('"asset_id"');
});
it('keeps generated originals after a save denial and creates a new linked variant without overwriting the first', async () => {
  const f = await fixture({ ask: true, approve: async () => 'deny' }); const first = await generate(f);
  const saved = await f.tools.run('save_generated_asset', { asset_id: first.asset_id, path: 'denied.png' });
  expect(saved.status).not.toBe('success'); expect(saved.output).toContain('Original asset retained');
  expect(saved.status).toBe('refused');
  if (saved.status !== 'refused') throw Error('Expected save refusal');
  expect(saved.detail).toContain('The user denied this save. Nothing was saved; do not retry it unchanged');
  expect(saved.detail).toContain('Original asset retained. A later approved save can reuse it without repeating paid generation.');
  expect(await f.h.assets.imageBytesForDocument(first.asset_id)).toMatchObject({ bytes: png, sha256: first.sha256 });
  const variant = await f.tools.run('generate_image', { prompt: 'Intentional new version', variant_of: first.operation_id });
  expect(variant.status, variant.output).toBe('success'); const next = JSON.parse(variant.output);
  expect(next.variant_of).toBe(first.operation_id); expect(next.asset_id).not.toBe(first.asset_id);
  expect(f.host.operation(first.operation_id)?.state).toBe('succeeded'); expect(f.transport).toHaveBeenCalledTimes(2);
});
it('never treats user attachments as host-generated provenance', async () => {
  const f = await fixture(); const image = await f.h.assets.storeImage(png, 'user-attachment', 'image/png', 'dev');
  if ('error' in image) throw Error(image.error);
  const result = await f.tools.run('save_generated_asset', { asset_id: image.assetId, path: 'forged.png' });
  expect(result.status).not.toBe('success'); expect(f.transport).not.toHaveBeenCalled();
  await expect(fs.stat(join(f.h.root, 'forged.png'))).rejects.toMatchObject({ code: 'ENOENT' });
});
// v0.9.108 S3(d): a saved original releases generation's hold; turn end and the record limit forget only saved, unheld images.
it('releases the generation hold after a real save and forgets that saved record at turn end, keeping unsaved and task-held images', async () => {
  const f = await fixture(); const saved = await generate(f); const unsaved = await generate(f); const held = await generate(f);
  expect(f.h.assets.isHeld(saved.asset_id)).toBe(true);
  for (const [image, path] of [[saved, 'saved.png'], [held, 'held.png']] as const) {
    const result = await f.tools.run('save_generated_asset', { asset_id: image.asset_id, path }); expect(result.status, result.output).toBe('success');
  }
  expect(f.h.assets.isHeld(saved.asset_id)).toBe(false); expect(f.h.assets.isHeld(unsaved.asset_id)).toBe(true);
  // Still usable in this turn for the store's idle period, for example in a presentation.
  expect(await f.h.assets.imageBytesForDocument(saved.asset_id)).toMatchObject({ sha256: saved.sha256 });
  expect(f.host.generatedAsset(saved.asset_id)).toBeDefined();
  f.h.assets.retain([held.asset_id], 'attempt:still-using');
  f.host.endTurn();
  expect(f.host.generatedAsset(saved.asset_id)).toBeUndefined(); expect(f.host.operation(saved.operation_id)).toBeUndefined();
  expect(f.host.generatedAsset(unsaved.asset_id)).toBeDefined(); expect(f.host.operation(unsaved.operation_id)?.state).toBe('succeeded');
  expect(f.host.generatedAsset(held.asset_id)).toBeDefined();
  const again = await f.tools.run('save_generated_asset', { asset_id: unsaved.asset_id, path: 'later.png' }); expect(again.status, again.output).toBe('success');
  f.h.assets.release('attempt:still-using'); f.host.endTurn();
  expect(f.host.generatedAsset(held.asset_id)).toBeUndefined(); expect(f.host.generatedAsset(unsaved.asset_id)).toBeUndefined();
});
it('keeps a denied or failed save\'s image held and recorded', async () => {
  const f = await fixture({ ask: true, approve: async () => 'deny' }); const image = await generate(f);
  const result = await f.tools.run('save_generated_asset', { asset_id: image.asset_id, path: 'denied.png' }); expect(result.status).toBe('refused');
  f.host.endTurn();
  expect(f.h.assets.isHeld(image.asset_id)).toBe(true); expect(f.host.generatedAsset(image.asset_id)).toBeDefined();
});
it('limits the operation records to 50 by evicting only the oldest saved images nothing holds', async () => {
  const f = await fixture(); const size = () => (f.host as any).operations.size as number;
  const first = await generate(f); const second = await generate(f);
  for (const [image, path] of [[first, 'first.png'], [second, 'second.png']] as const) expect((await f.tools.run('save_generated_asset', { asset_id: image.asset_id, path })).status).toBe('success');
  const unsaved: any[] = []; while (size() < GENERATED_IMAGE_RECORD_LIMIT) unsaved.push(await generate(f));
  expect(f.host.operation(first.operation_id)).toBeDefined();
  unsaved.push(await generate(f)); expect(size()).toBe(GENERATED_IMAGE_RECORD_LIMIT);
  expect(f.host.operation(first.operation_id)).toBeUndefined(); expect(f.host.operation(second.operation_id)).toBeDefined();
  unsaved.push(await generate(f)); expect(f.host.operation(second.operation_id)).toBeUndefined();
  unsaved.push(await generate(f)); expect(size()).toBe(GENERATED_IMAGE_RECORD_LIMIT + 1);
  for (const image of unsaved) expect(f.host.generatedAsset(image.asset_id)).toBeDefined();
}, 120_000);
// v0.9.108 S3 audit F1: a save waiting on approval keeps its image and generation record through record cleanup.
it('keeps a pending second save of a saved image working when another turn ends or the record limit runs while it waits', async () => {
  let release!: () => void; let waiting!: () => void;
  const asked = new Promise<void>(resolve => { waiting = resolve; }); let approvals = 0;
  const f = await fixture({ ask: true, approve: async () => {
    if (++approvals === 1) return 'once';
    waiting(); await new Promise<void>(resolve => { release = resolve; }); return 'once';
  } });
  const image = await generate(f);
  expect((await f.tools.run('save_generated_asset', { asset_id: image.asset_id, path: 'first.png' })).status).toBe('success');
  const second = f.tools.run('save_generated_asset', { asset_id: image.asset_id, path: 'second.png' });
  await asked;
  expect(f.h.assets.isHeld(image.asset_id)).toBe(true);
  f.host.endTurn(); (f.host as any).forgetSaved(0);
  expect(f.host.generatedAsset(image.asset_id)).toBeDefined();
  release();
  const result = await second; expect(result.status, result.output).toBe('success');
  expect(await fs.readFile(join(f.h.root, 'second.png'))).toEqual(png); expect(await fs.readFile(join(f.h.root, 'first.png'))).toEqual(png);
  // Settled: only this save's hold is gone, so the saved record is now eligible for cleanup.
  expect(f.h.assets.isHeld(image.asset_id)).toBe(false);
  f.host.endTurn(); expect(f.host.generatedAsset(image.asset_id)).toBeUndefined();
});
