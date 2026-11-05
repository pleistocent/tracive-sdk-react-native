/**
 * A transfer receipt as a PNG and as a PDF, made in code so the report button has real files to
 * attach without asking for photo-library access. Both are valid files, small enough to stay well
 * under the SDK's limits.
 */

const encoder = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      crc = (CRC_TABLE[(crc ^ (part[i] as number)) & 0xff] as number) ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const name = encoder(type);
  return concat([uint32(data.length), name, data, uint32(crc32([name, data]))]);
}

/** zlib with stored (uncompressed) deflate blocks: valid, and no compressor needed. */
function zlibStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  for (let i = 0; i < blocks; i++) {
    const block = data.subarray(i * 65535, (i + 1) * 65535);
    const length = block.length;
    const last = i === blocks - 1 ? 1 : 0;
    parts.push(
      Uint8Array.of(last, length & 0xff, length >>> 8, ~length & 0xff, (~length >>> 8) & 0xff),
    );
    parts.push(block);
  }
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + (data[i] as number)) % 65521;
    b = (b + a) % 65521;
  }
  parts.push(uint32(((b << 16) | a) >>> 0));
  return concat(parts);
}

/** A 240×120 receipt card: a blue header band and grey text lines on white. */
export function receiptPng(): Uint8Array {
  const width = 240;
  const height = 120;
  const rows = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    rows[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const header = y < 28;
      const textLine =
        !header && y % 16 >= 6 && y % 16 < 10 && x > 16 && x < 16 + ((y * 37) % 160) + 40;
      const [r, g, b] = header ? [31, 111, 235] : textLine ? [152, 162, 179] : [255, 255, 255];
      rows.set([r as number, g as number, b as number], row + 1 + x * 3);
    }
  }
  const header = concat([uint32(width), uint32(height), Uint8Array.of(8, 2, 0, 0, 0)]);
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlibStored(rows)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

/** A one-page A4 PDF listing `lines` in Helvetica. ASCII only, so offsets are byte offsets. */
export function receiptPdf(lines: readonly string[]): Uint8Array {
  const escape = (text: string) => text.replace(/[\\()]/g, (character) => `\\${character}`);
  const content = `BT /F1 14 Tf 56 780 Td ${lines
    .map((line, i) => `${i === 0 ? '' : '0 -22 Td '}(${escape(line)}) Tj`)
    .join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder(out);
}
