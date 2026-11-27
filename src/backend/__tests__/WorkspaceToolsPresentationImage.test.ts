import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTENT_ASSET_TTL_MS } from '../../content/ContentAssetStore';
import { admitUserTurn, attachment, attachmentIds, saveHost, sha } from './attachmentSaveFixtures';
import { removeTemporaryFolders } from './pathSafetyFixtures';
import { presentationRouteRenderer } from './presentationRouteFixtures';
import { assertOriginalPngEmbedded, PRESENTATION_PNG, presentationWithImage, solidScreenshotPng } from './presentationImageFixtures';
import JSZip from 'jszip';
import { cmykJpegFixture, jpegGrayPixels, readJpegRendition, withExifOrientation, withRgbIccProfile } from './jpegImageFixtures';
import { inflateSync } from 'node:zlib';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); await removeTemporaryFolders(); });
async function host(bytes = PRESENTATION_PNG, now?: () => number, kind: 'png' | 'jpeg' = 'png') {
  const h = await saveHost({ now });
  const sources = await admitUserTurn(h.assets, [attachment(`pixels.${kind}`, `image/${kind}`, 'image', bytes)]);
  const renderer = await presentationRouteRenderer(); const tools = h.tools('dev', sources); tools.setPresentationRenderer(renderer); tools.beginTurn();
  cleanup.push(async () => { tools.retire(); await h.assets.dispose(); });
  return { ...h, sources, tools, makeTools: h.tools, renderer, id: attachmentIds(sources)[0] };
}

describe('O3 authorized, decoded static PNG insertion', () => {
  it('saves a valid CMYK JPEG through a fresh worker and discloses unverified color without rejecting the image', async () => {
    const bytes = cmykJpegFixture(); const h = await host(bytes, undefined, 'jpeg');
    const result = await h.tools.run('write_presentation', presentationWithImage(h.id));
    expect(result.status, result.output).toBe('success');
    expect(result.presentationWrite?.receipt?.images?.[0]).toMatchObject({ sha256: sha(bytes), width: 2, height: 1, colorProfile: 'unverified' });
    const actual = await readJpegRendition(await fs.readFile(path.join(h.root, 'out/result.pptx')));
    expect(actual.image).toMatchObject({ width: 2, height: 1 });
    expect(actual.image.pixels).toHaveLength(8); expect(actual.image.pixels[3]).toBe(255);
    expect(result.output).toContain('JPEG color rendering unverified'); expect(h.state.approvals).toEqual([]);
  });
  it('inserts a full-resolution, orientation-correct JPEG rendition and identifies input and embedded bytes separately', async () => {
    const profile = Buffer.alloc(132); profile.writeUInt32BE(profile.length); profile.write('RGB ', 16); profile.write('acsp', 36);
    const original = withRgbIccProfile(withExifOrientation(6), profile); const h = await host(original, undefined, 'jpeg');
    const result = await h.tools.run('write_presentation', presentationWithImage(h.id)); expect(result.status, result.output).toBe('success');
    const rendition = await readJpegRendition(await fs.readFile(path.join(h.root, 'out/result.pptx')));
    expect(rendition.image).toMatchObject({ width: 2, height: 3 }); expect(rendition.image.pixels).toEqual(jpegGrayPixels([3, 0, 4, 1, 5, 2]));
    expect(result.presentationWrite?.receipt?.images).toEqual([{ assetRef: h.id, sha256: sha(original), embeddedSha256: sha(rendition.bytes),
      sourceMimeType: 'image/jpeg', orientation: 6, colorProfile: 'preserved-rgb', width: 2, height: 3, placements: 1 }]);
    let embeddedProfile: Buffer | undefined;
    for (let at = 8; at < rendition.bytes.length;) {
      const length = rendition.bytes.readUInt32BE(at);
      if (rendition.bytes.toString('ascii', at + 4, at + 8) === 'iCCP') { const data = rendition.bytes.subarray(at + 8, at + 8 + length); embeddedProfile = inflateSync(data.subarray(data.indexOf(0) + 2)); }
      at += length + 12;
    }
    expect(embeddedProfile).toEqual(profile);
    expect(rendition.xml).toContain('<a:off x="1524000" y="914400"/>'); expect(rendition.xml).toContain('<a:ext cx="2438400" cy="3657600"/>');
    const raw = await h.assets.imageBytesForDocument(h.id); expect('error' in raw ? raw.error : raw.bytes).toEqual(original);
    expect(result.output).toContain(sha(original)); expect(result.output).toContain(sha(rendition.bytes));
  });
  it('rejects a truncated JPEG before changing the user’s existing destination', async () => {
    const h = await host(withExifOrientation(6).subarray(0, -2), undefined, 'jpeg'); const target = path.join(h.root, 'out/result.pptx');
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'USER FILE');
    const result = await h.tools.run('write_presentation', presentationWithImage(h.id));
    expect(result.presentationWrite?.code).toBe('invalid-image'); expect(await fs.readFile(target, 'utf8')).toBe('USER FILE');
  });
  it('writes a highly compressible 5K screenshot using its decoded size for the worker budget', async () => {
    const png = solidScreenshotPng(5120, 2880); expect(png.length).toBeLessThan(200000);
    const h = await host(png); const result = await h.tools.run('write_presentation', presentationWithImage(h.id));
    expect(result.status, result.output).toBe('success');
    expect(result.presentationWrite?.receipt?.images).toEqual([{ assetRef: h.id, sha256: sha(png), width: 5120, height: 2880, placements: 1 }]);
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'out/result.pptx')));
    const media = Object.keys(zip.files).find(name => name.startsWith('ppt/media/') && !zip.files[name].dir)!;
    expect(await zip.file(media)!.async('nodebuffer')).toEqual(png);
  });
  it('does not give another agent access by guessing a valid asset reference', async () => {
    const h = await host(); const other = h.makeTools('other'); other.setPresentationRenderer(h.renderer); other.beginTurn();
    expect((await other.run('write_presentation', presentationWithImage(h.id))).presentationWrite?.code).toBe('image-unavailable');
    expect(await fs.readdir(h.root)).toEqual([]); other.retire();
  });
  it('keeps original image bytes, verifies actual pixels in the worker and returns byte-identified image provenance', async () => {
    const h = await host(); const result = await h.tools.run('write_presentation', presentationWithImage(h.id));
    expect(result.status, result.output).toBe('success');
    await assertOriginalPngEmbedded(await fs.readFile(path.join(h.root, 'out/result.pptx')));
    expect(result.presentationWrite?.receipt?.images).toEqual([{ assetRef: h.id, sha256: sha(PRESENTATION_PNG), width: 2, height: 1, placements: 1 }]);
    expect(result.output).toContain(sha(PRESENTATION_PNG)); expect(result.output).toContain('Visual review not performed');
    expect(result.output).not.toContain(PRESENTATION_PNG.toString('base64')); expect(h.state.approvals).toEqual([]);
  });

  it('rejects a magic-correct damaged PNG without changing an existing destination', async () => {
    const damaged = Buffer.from(PRESENTATION_PNG); damaged[damaged.length - 1] ^= 1;
    const h = await host(damaged); const target = path.join(h.root, 'out/result.pptx');
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'USER FILE');
    const result = await h.tools.run('write_presentation', presentationWithImage(h.id));
    expect(result.presentationWrite?.code).toBe('invalid-image'); expect(await fs.readFile(target, 'utf8')).toBe('USER FILE');
    expect(h.text.list()).toEqual([]);
  });

  it('commits no late image result after the agent’s asset grant is revoked during generation', async () => {
    const h = await host();
    h.tools.setPresentationRenderer({ render: async (...args) => {
      const result = await h.renderer.render(...args); h.tools.setDelegationContentSources([]); return result;
    } }); h.tools.beginTurn();
    expect((await h.tools.run('write_presentation', presentationWithImage(h.id))).presentationWrite?.code).toBe('cancelled');
    await expect(fs.stat(path.join(h.root, 'out/result.pptx'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('holds image assets for disk-backed drafts beyond idle TTL, releases them after saving and honors revoked asset grants', async () => {
    let now = 0; const h = await host(PRESENTATION_PNG, () => now); const input = presentationWithImage(h.id);
    expect((await h.tools.run('write_presentation', { ...input, draft: 'images' })).status).toBe('success');
    now += CONTENT_ASSET_TTL_MS + 1; await h.assets.cleanupExpired(); expect(h.assets.getReceipt(h.id)).toBeDefined();
    h.tools.setDelegationContentSources([]);
    const final = { ...input, draft: 'images', final: true, deck: { ...input.deck, slides: [] } };
    expect((await h.tools.run('write_presentation', final)).presentationWrite?.code).toBe('image-unavailable');
    h.tools.setDelegationContentSources(h.sources);
    expect((await h.tools.run('write_presentation', final)).status).toBe('success');
    await assertOriginalPngEmbedded(await fs.readFile(path.join(h.root, 'out/result.pptx')));
    now += CONTENT_ASSET_TTL_MS + 1; await h.assets.cleanupExpired(); expect(h.assets.getReceipt(h.id)).toBeUndefined();
  });
});
