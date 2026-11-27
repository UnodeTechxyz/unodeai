import { describe, expect, it } from 'vitest';
import { MCPHub, type McpClientFactory, type McpServerGrant } from '../MCPHub';
import { normalizeMcpToolResult } from '../RealMcpClient';
import { MCP_IMAGE_MAX_BYTES, mcpImagesForModel } from '../mcpImages';

import { PNG_BASE64 } from '../../__tests__/fixtures/tinyPng';
const png = () => new Uint8Array(Buffer.from(PNG_BASE64, 'base64'));
/** Bytes that start like a PNG, of a chosen size. */
const pngOfSize = (bytes: number) => { const data = new Uint8Array(bytes); data.set(png().slice(0, 8)); return data; };

/** A real MCPHub whose one server returns what `result` says, as the real client normalises it. */
async function hubReturning(result: unknown) {
  const factory: McpClientFactory = async () => ({
    async listTools() { return [{ name: 'screenshot' }]; },
    async callTool() { return normalizeMcpToolResult(result); },
    async close() {},
  });
  const hub = new MCPHub(factory);
  await hub.register({ id: 'shots', name: 'Shots', transport: 'stdio', command: 'node' });
  const grants: McpServerGrant[] = [{ serverId: 'shots', toolFilter: 'all' }];
  return { hub, grants };
}

describe('v0.9.105 D5-2: MCP images', () => {
  it('the client keeps the text naming each image and the image bytes beside it', () => {
    const normalized = normalizeMcpToolResult({ content: [
      { type: 'text', text: 'The window:' },
      { type: 'image', mimeType: 'image/png', data: PNG_BASE64 },
    ] });
    expect(normalized.output).toBe(`The window:\n[image: image/png, ${png().byteLength} bytes]`);
    expect(normalized.images).toEqual([{ mimeType: 'image/png', data: png() }]);
    expect(normalizeMcpToolResult({ content: [{ type: 'text', text: 'no picture' }] }).images).toBeUndefined();
  });

  it('the hub holds a result\'s images beside its outcome, never on it, and hands them out once', async () => {
    const { hub, grants } = await hubReturning({ content: [{ type: 'text', text: 'shot' }, { type: 'image', mimeType: 'image/png', data: PNG_BASE64 }] });
    const outcome = await hub.executeTool('shots__screenshot', {}, grants);
    expect(outcome).toMatchObject({ status: 'success', output: `shot\n[image: image/png, ${png().byteLength} bytes]` });
    // Nothing that keeps or serialises the outcome can keep the picture.
    expect(JSON.stringify(outcome)).not.toContain(PNG_BASE64);
    expect(Object.keys(outcome)).not.toContain('images');
    expect(hub.takeMcpImages(outcome)).toEqual([{ mimeType: 'image/png', data: png() }]);
    expect(hub.takeMcpImages(outcome)).toEqual([]);
  });

  it('an application error with an image stays a failure', async () => {
    const { hub, grants } = await hubReturning({ isError: true, content: [{ type: 'text', text: 'crashed' }, { type: 'image', mimeType: 'image/png', data: PNG_BASE64 }] });
    const outcome = await hub.executeTool('shots__screenshot', {}, grants);
    expect(outcome).toMatchObject({ status: 'failed', failureKind: 'integration_error' });
    expect(hub.takeMcpImages(outcome)).toHaveLength(1);
  });

  it('attaches PNG, JPEG, GIF and WebP read from the bytes, and says why any image was left out', () => {
    expect(mcpImagesForModel([])).toEqual({ accepted: [] });
    const one = mcpImagesForModel([{ mimeType: 'image/jpeg', data: png() }]);
    // The bytes decide the format, not the declared type.
    expect(one.accepted).toEqual([{ mimeType: 'image/png', base64: PNG_BASE64, byteLength: png().byteLength }]);
    expect(one.note).toBe('[UnodeAi: 1 image from this tool attached for you to see.]');

    const notImage = mcpImagesForModel([{ mimeType: 'image/png', data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) }]);
    expect(notImage).toEqual({ accepted: [], note: '[UnodeAi: 1 image not attached: not a PNG, JPEG, GIF or WebP image.]',
      omittedNote: '[UnodeAi: 1 image not attached: not a PNG, JPEG, GIF or WebP image.]' });
    // v0.9.105 D5-3: the omissions alone, for the route that keeps images as assets instead of attaching them.
    expect(one.omittedNote).toBeUndefined();

    const large = mcpImagesForModel([{ mimeType: 'image/png', data: pngOfSize(MCP_IMAGE_MAX_BYTES + 1) }, { mimeType: 'image/png', data: png() }]);
    expect(large.accepted).toHaveLength(1);
    expect(large.note).toBe('[UnodeAi: 1 image from this tool attached for you to see; 1 image not attached: larger than 5 MB.]');
    expect(large.omittedNote).toBe('[UnodeAi: 1 image not attached: larger than 5 MB.]');

    const many = mcpImagesForModel(Array.from({ length: 6 }, () => ({ mimeType: 'image/png', data: png() })));
    expect(many.accepted).toHaveLength(4);
    expect(many.note).toBe('[UnodeAi: 4 images from this tool attached for you to see; 2 images not attached: at most 4 images per result.]');

    const heavy = mcpImagesForModel(Array.from({ length: 3 }, () => ({ mimeType: 'image/png', data: pngOfSize(4 * 1024 * 1024) })));
    expect(heavy.accepted).toHaveLength(2);
    expect(heavy.note).toBe('[UnodeAi: 2 images from this tool attached for you to see; 1 image not attached: more than 10 MB of images in one result.]');
  });
});
