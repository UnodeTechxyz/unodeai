import { expect, it } from 'vitest';
import { fitOfficePicture } from '../OfficePictureFit';
import { validateOfficeEditRequest } from '../OfficeEditContracts';
const frame = { x: -100n, y: 200n, w: 400n, h: 400n };
it('contains an explicit crop around the same center and preserves full integer coordinate precision', () => {
  const x = 9007199254740993000n;
  expect(fitOfficePicture({ ...frame, x }, 400, 100, { fit: 'contain', crop: { x: .25, y: 0, w: .5, h: 1 } }))
    .toEqual({ frame: { x, y: 300n, w: 400n, h: 200n }, crop: { l: 25000, t: 0, r: 25000, b: 0 } });
});
it('covers a portrait with a top focal rectangle and keeps every frame coordinate', () => {
  expect(fitOfficePicture(frame, 100, 400, { fit: 'cover', focal_rect: { x: 0, y: 0, w: 1, h: .2 } }))
    .toEqual({ frame, crop: { l: 0, t: 0, r: 0, b: 75000 } });
});
it('defaults to contain and rejects unrelated image arguments and invalid source rectangles', () => {
  const request = (extra: object) => ({ schema_version: 1, path: 'out.pptx', snapshot_ref: 'office-00000000-0000-0000-0000-000000000000',
    edits: [{ op: 'replace_image', target_ref: 'S1-O1', asset_ref: 'asset', ...extra }] });
  expect(validateOfficeEditRequest(request({})).edits[0]).toMatchObject({ fit: 'contain' });
  for (const extra of [{ url: 'https://example.invalid/a.png' }, { bytes: 'AAAA' }, { crop: { x: 0, y: 0, w: NaN, h: 1 } },
    { focal_rect: { x: .8, y: 0, w: .3, h: 1 } }, { crop: { x: 0, y: 0, w: 0, h: 1 } }]) expect(() => validateOfficeEditRequest(request(extra))).toThrow('invalid-office-edits');
});
it('keeps a valid tiny edge crop inside OOXML integer percentage precision', () => {
  expect(fitOfficePicture(frame, 100, 100, { fit: 'cover', crop: { x: .9999999, y: .9999999, w: .0000001, h: .0000001 } }).crop)
    .toEqual({ l: 99999, t: 99999, r: 0, b: 0 });
});
