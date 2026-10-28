/** 生成传统 BMP 编码 ICO，兼容 Windows 自带 .NET Framework csc。 */
export function installerIcon() {
  const size = 32;
  const bitmapHeader = 40;
  const xorBytes = size * size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const maskBytes = maskStride * size;
  const imageSize = bitmapHeader + xorBytes + maskBytes;
  const ico = Buffer.alloc(6 + 16 + imageSize);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico[6] = size; ico[7] = size;
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(imageSize, 14);
  ico.writeUInt32LE(22, 18);
  const header = 22;
  ico.writeUInt32LE(bitmapHeader, header);
  ico.writeInt32LE(size, header + 4);
  ico.writeInt32LE(size * 2, header + 8);
  ico.writeUInt16LE(1, header + 12);
  ico.writeUInt16LE(32, header + 14);
  ico.writeUInt32LE(xorBytes + maskBytes, header + 20);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5 - size / 2) / (size / 2);
    const dy = (y + 0.5 - size / 2) / (size / 2);
    const inside = dx * dx + dy * dy < 0.9;
    const hx = dx * 1.5, hy = -dy * 1.5 - 0.05;
    const heart = (hx * hx + hy * hy - 0.36) ** 3 - hx * hx * hy ** 3 <= 0;
    const pixel = header + bitmapHeader + ((size - 1 - y) * size + x) * 4;
    if (inside) {
      ico[pixel] = heart ? 255 : 225;
      ico[pixel + 1] = heart ? 255 : Math.round(112 + 20 * (dy + 1));
      ico[pixel + 2] = heart ? 255 : Math.round(150 + 35 * (dy + 1));
      ico[pixel + 3] = 255;
    } else {
      const mask = header + bitmapHeader + xorBytes + (size - 1 - y) * maskStride + Math.floor(x / 8);
      ico[mask] |= 0x80 >> (x % 8);
    }
  }
  return ico;
}
