/**
 * 临时脚本（不进仓库）：把 .txt 设定文档转成 .docx（手写 OOXML + 自己拼 zip）。
 *
 * 为什么自己拼：项目零第三方依赖，不想为了一个文档引入 docx 库。
 * 用 store/deflate 都行，这里用 deflate（zlib.deflateRawSync），Word / WPS / LibreOffice 都能开。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/* --------------------------------- zip --------------------------------- */

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = Buffer.from(file.data, "utf8");
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ------------------------------- docx ---------------------------------- */

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 行内 **加粗** → 多个 run */
function runs(text, { bold = false, mono = false, size = 22, color = "" } = {}) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts
    .map((part) => {
      const isBold = bold || /^\*\*[^*]+\*\*$/.test(part);
      const clean = part.replace(/^\*\*|\*\*$/g, "");
      const props = [
        isBold ? "<w:b/>" : "",
        `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
        mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/>' : "",
        color ? `<w:color w:val="${color}"/>` : "",
      ].filter(Boolean).join("");
      return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(clean)}</w:t></w:r>`;
    })
    .join("");
}

function para(text, opts = {}) {
  const { style = "", bold = false, mono = false, size = 22, align = "", spacing = 240, after = 120, indent = 0, color = "" } = opts;
  const ppr = [
    style ? `<w:pStyle w:val="${style}"/>` : "",
    align ? `<w:jc w:val="${align}"/>` : "",
    `<w:spacing w:line="${spacing}" w:lineRule="auto" w:before="0" w:after="${after}"/>`,
    indent ? `<w:ind w:left="${indent}"/>` : "",
  ].filter(Boolean).join("");
  return `<w:p><w:pPr>${ppr}</w:pPr>${runs(text, { bold, mono, size, color })}</w:p>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>
    <w:sz w:val="22"/><w:szCs w:val="22"/>
  </w:rPr></w:rPrDefault>
  <w:pPrDefault><w:pPr><w:spacing w:line="240" w:lineRule="auto" w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:sz w:val="48"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:after="360"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:sz w:val="24"/><w:color w:val="555555"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="360" w:after="180"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:sz w:val="34"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:sz w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="180" w:after="90"/><w:outlineLvl w:val="2"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:sz w:val="23"/></w:rPr></w:style>
</w:styles>`;

function buildDocument(text) {
  const lines = text.split(/\r?\n/);
  const body = [];
  let inJson = false;
  let inCode = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");

    // 装饰性的 ==== / ---- 分隔线跳过
    if (/^={10,}$/.test(line) || /^-{10,}$/.test(line)) continue;
    if (!line.trim()) {
      body.push('<w:p><w:pPr><w:spacing w:line="120" w:lineRule="auto"/></w:pPr></w:p>');
      continue;
    }

    // 附录 A 的 JSON：整段等宽
    if (/^\{$/.test(line.trim()) && !inJson) {
      inJson = true;
      body.push(para(line, { mono: true, size: 17, spacing: 200, after: 0 }));
      continue;
    }
    if (inJson) {
      body.push(para(line, { mono: true, size: 17, spacing: 200, after: 0 }));
      if (/^\}$/.test(line.trim())) inJson = false;
      continue;
    }

    // 一级标题
    if (/^[一二三四五六七八九十]+、/.test(line) || /^附录 [AB]/.test(line)) {
      body.push(para(line, { style: "Heading1", spacing: 300, after: 160 }));
      continue;
    }
    // 二级标题 1.1 / 2.3
    if (/^\d+\.\d+\s/.test(line)) {
      body.push(para(line, { style: "Heading2", spacing: 260, after: 120 }));
      continue;
    }
    // 三级标题（全是短句且以「」或「·」开头的加粗小标题，这里只处理 5.1 / 5.2 这类）
    if (/^\d+\.\d\s/.test(line)) {
      body.push(para(line, { style: "Heading3" }));
      continue;
    }

    // 顶部标题
    if (line.startsWith("灵语 · HeartEcho 角色设定文档")) {
      body.push(para(line, { style: "Title" }));
      continue;
    }
    if (line.startsWith("初月 · 世界观与完整角色设定")) {
      body.push(para(line, { style: "Subtitle", spacing: 240 }));
      continue;
    }
    if (/^（含「打破第四面墙」/.test(line) || /^版本 1\.0/.test(line)) {
      body.push(para(line, { style: "Subtitle", spacing: 240, after: 60 }));
      continue;
    }

    // 列表
    if (line.startsWith("· ")) {
      body.push(para("· " + line.slice(2), { spacing: 260, after: 60, indent: 240 }));
      continue;
    }
    // 场景小标题（**（一）...**）
    if (/^\*\*（[一二三四五六]）/.test(line)) {
      body.push(para(line, { style: "Heading3" }));
      continue;
    }

    body.push(para(line, { spacing: 260 }));
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body.join("\n")}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1418" w:bottom="1440" w:left="1418" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const src = process.argv[2];
const dst = process.argv[3];
const text = fs.readFileSync(src, "utf8");
const doc = buildDocument(text);
const out = zip([
  { name: "[Content_Types].xml", data: CONTENT_TYPES },
  { name: "_rels/.rels", data: RELS },
  { name: "word/document.xml", data: doc },
  { name: "word/_rels/document.xml.rels", data: DOC_RELS },
  { name: "word/styles.xml", data: STYLES },
]);
fs.writeFileSync(dst, out);
console.log(`${path.basename(dst)} → ${(out.length / 1024).toFixed(1)} KB（document.xml ${(doc.length / 1024).toFixed(1)} KB）`);
