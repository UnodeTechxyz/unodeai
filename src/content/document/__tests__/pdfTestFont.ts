/** Original test-only SFNT: one rectangular outline per printable ASCII character.
 * Not a system-font substitute or visual-language qualification. No third-party font data. */
export function pdfTestFont(bold = false, extra = ''): Buffer {
  const additional = [...new Set([...extra].map(char => char.codePointAt(0)!))].filter(cp => cp > 126).sort((a, b) => a - b);
  const count = 96 + additional.length; const tables = new Map<string, Buffer>();
  const head = Buffer.alloc(54); head.writeUInt32BE(0x10000); head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(1000, 18); head.writeInt16BE(500, 40); head.writeInt16BE(700, 42); tables.set('head', head);
  const hhea = Buffer.alloc(36); hhea.writeUInt32BE(0x10000); hhea.writeInt16BE(800, 4); hhea.writeInt16BE(-200, 6);
  hhea.writeUInt16BE(500, 10); hhea.writeUInt16BE(count, 34); tables.set('hhea', hhea);
  const maxp = Buffer.alloc(32); maxp.writeUInt32BE(0x10000); maxp.writeUInt16BE(count, 4);
  maxp.writeUInt16BE(4, 6); maxp.writeUInt16BE(1, 8); maxp.writeUInt16BE(2, 14); tables.set('maxp', maxp);
  const os2 = Buffer.alloc(96); os2.writeUInt16BE(4); os2.writeInt16BE(500, 2); os2.writeUInt16BE(bold ? 700 : 400, 4);
  os2.writeUInt16BE(5, 6); os2.writeUInt16BE(bold ? 32 : 64, 62); os2.writeUInt16BE(32, 64); os2.writeUInt16BE(126, 66);
  os2.writeInt16BE(800, 68); os2.writeInt16BE(-200, 70); os2.writeUInt16BE(800, 74); os2.writeUInt16BE(200, 76);
  os2.writeInt16BE(500, 86); os2.writeInt16BE(700, 88); tables.set('OS/2', os2);
  const hmtx = Buffer.alloc(count * 4); for (let i = 0; i < count; i++) hmtx.writeUInt16BE(500, i * 4); tables.set('hmtx', hmtx);
  // Simple outline: (100,0) -> (500,0) -> (500,700) -> (100,700).
  const shape = Buffer.alloc(26); shape.writeInt16BE(1); shape.writeInt16BE(100, 2); shape.writeInt16BE(500, 6); shape.writeInt16BE(700, 8);
  shape.writeUInt16BE(3, 10); shape.writeUInt16BE(0, 12); shape.set([0x33, 0x21, 0x11, 0x21], 14);
  shape.writeUInt8(100, 18); shape.writeInt16BE(400, 19); shape.writeInt16BE(-400, 21); shape.writeInt16BE(700, 23);
  const glyf = Buffer.concat(Array.from({ length: count }, (_, i) => i === 1 ? Buffer.alloc(26) : shape)); tables.set('glyf', glyf);
  const loca = Buffer.alloc((count + 1) * 2); for (let i = 0; i <= count; i++) loca.writeUInt16BE(i * 13, i * 2); tables.set('loca', loca);
  const cmap = Buffer.alloc(44); cmap.writeUInt16BE(1, 2); cmap.writeUInt16BE(3, 4); cmap.writeUInt16BE(1, 6); cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(4, 12); cmap.writeUInt16BE(32, 14); cmap.writeUInt16BE(4, 18); cmap.writeUInt16BE(4, 20); cmap.writeUInt16BE(1, 22);
  cmap.writeUInt16BE(126, 26); cmap.writeUInt16BE(65535, 28); cmap.writeUInt16BE(32, 32); cmap.writeUInt16BE(65535, 34);
  cmap.writeInt16BE(-31, 36); cmap.writeUInt16BE(1, 38); tables.set('cmap', cmap);
  if (additional.length) {
    const groups = [[32, 126, 1], ...additional.map((cp, index) => [cp, cp, 96 + index])];
    const extended = Buffer.alloc(28 + groups.length * 12);
    extended.writeUInt16BE(1, 2); extended.writeUInt16BE(3, 4); extended.writeUInt16BE(10, 6); extended.writeUInt32BE(12, 8);
    extended.writeUInt16BE(12, 12); extended.writeUInt32BE(16 + groups.length * 12, 16); extended.writeUInt32BE(groups.length, 24);
    groups.forEach((values, index) => values.forEach((value, offset) => extended.writeUInt32BE(value, 28 + index * 12 + offset * 4)));
    tables.set('cmap', extended);
  }
  const strings = ['UnodeTest', bold ? 'Bold' : 'Regular', bold ? 'UnodeTest-Bold' : 'UnodeTest-Regular'];
  const values = [1, 2, 6].map((id, index) => ({ id, bytes: Buffer.from(strings[index].split('').flatMap(char => [0, char.charCodeAt(0)])) }));
  const name = Buffer.alloc(6 + values.length * 12 + values.reduce((n, value) => n + value.bytes.length, 0));
  name.writeUInt16BE(values.length, 2); name.writeUInt16BE(42, 4); let textOffset = 0;
  values.forEach((value, index) => { const at = 6 + index * 12; name.writeUInt16BE(3, at); name.writeUInt16BE(1, at + 2);
    name.writeUInt16BE(0x409, at + 4); name.writeUInt16BE(value.id, at + 6); name.writeUInt16BE(value.bytes.length, at + 8);
    name.writeUInt16BE(textOffset, at + 10); value.bytes.copy(name, 42 + textOffset); textOffset += value.bytes.length; }); tables.set('name', name);
  const post = Buffer.alloc(32); post.writeUInt32BE(0x30000); tables.set('post', post);
  const entries = [...tables].sort(([a], [b]) => a < b ? -1 : 1);
  let offset = 12 + entries.length * 16; const output = Buffer.alloc(offset + entries.reduce((n, [, bytes]) => n + Math.ceil(bytes.length / 4) * 4, 0));
  output.writeUInt32BE(0x10000); output.writeUInt16BE(entries.length, 4); output.writeUInt16BE(128, 6); output.writeUInt16BE(3, 8); output.writeUInt16BE(32, 10);
  const checksum = (bytes: Buffer) => { let sum = 0; for (let i = 0; i < bytes.length; i += 4) sum = (sum + bytes.readUInt32BE(i)) >>> 0; return sum; };
  let headAt = 0;
  entries.forEach(([tag, bytes], i) => { const at = 12 + i * 16; output.write(tag, at, 'ascii'); output.writeUInt32BE(offset, at + 8);
    output.writeUInt32BE(bytes.length, at + 12); bytes.copy(output, offset); output.writeUInt32BE(checksum(output.subarray(offset, offset + Math.ceil(bytes.length / 4) * 4)), at + 4);
    if (tag === 'head') headAt = offset; offset += Math.ceil(bytes.length / 4) * 4; });
  output.writeUInt32BE((0xb1b0afba - checksum(output)) >>> 0, headAt + 8);
  return output;
}
