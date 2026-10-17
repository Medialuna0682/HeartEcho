/**
 * 极简 PNG 编码器：给自检用（生成一张确定的测试图，不依赖任何外部素材）。
 * 只支持 8bit RGB，无压缩优化，够用就行。
 */
import zlib from "node:zlib";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * 生成一张 png 图。
 * @param {number} width
 * @param {number} height
 * @param {(x:number,y:number)=>[number,number,number]} pixel
 */
export function encodePng(width, height, pixel) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset] = r & 0xff;
      raw[offset + 1] = g & 0xff;
      raw[offset + 2] = b & 0xff;
      offset += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 生成一张「蓝底白圆 + 右上角一颗小星」的测试图（和角色氛围一致，便于人工核对）。 */
export function sampleTestPng(size = 96) {
  const cx = size * 0.42;
  const cy = size * 0.5;
  const radius = size * 0.28;
  return encodePng(size, size, (x, y) => {
    const inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
    if (inside) return [250, 250, 255];
    // 右上角一颗小星
    const sx = size * 0.78;
    const sy = size * 0.22;
    if (Math.abs(x - sx) + Math.abs(y - sy) < size * 0.06) return [255, 246, 200];
    const t = y / size;
    return [Math.round(38 + 40 * t), Math.round(58 + 60 * t), Math.round(140 + 70 * t)];
  });
}

export function sampleTestDataUrl(size = 96) {
  return `data:image/png;base64,${sampleTestPng(size).toString("base64")}`;
}
