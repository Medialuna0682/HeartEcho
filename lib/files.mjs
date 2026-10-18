/**
 * 读用户发来的文件（把字节变成文字）。
 *
 * 只做一件事：给定「字节 + 文件名」，尽量把里面的文字取出来。
 * 落盘、写库、进提示词都不在这里——那是 chat.mjs 的事。
 *
 * 三条原则：
 *   ① 认得出就是认得出，认不出就说认不出。宁可什么都不给，也不能给半截乱码让角色照着编。
 *   ② 编码要靠猜，而且必须猜对：QQ 上发来的 txt 一半是 UTF-8，一半是 Windows 记事本的 GBK。
 *   ③ 只用 Node 自带的东西（zlib 解 docx），不引入任何依赖。
 */
import { inflateRawSync } from "node:zlib";

/** 认得出的纯文本后缀（只是给提示词描述用，真正的判断看内容）。 */
export const TEXT_EXTENSIONS = [
  ".txt", ".md", ".markdown", ".log", ".csv", ".tsv", ".json", ".jsonl", ".yml", ".yaml",
  ".ini", ".cfg", ".conf", ".toml", ".xml", ".html", ".htm", ".css", ".js", ".mjs", ".cjs",
  ".ts", ".py", ".java", ".c", ".h", ".cpp", ".cs", ".go", ".rs", ".php", ".rb", ".sql",
  ".sh", ".bat", ".ps1", ".vue", ".srt", ".lrc",
];

/** 明确读不了的（说清楚比猜强）。 */
const BINARY_HINTS = {
  ".pdf": "PDF",
  ".doc": "旧版 Word（.doc）",
  ".xls": "旧版 Excel（.xls）",
  ".ppt": "旧版 PowerPoint（.ppt）",
  ".xlsx": "Excel 表格",
  ".pptx": "PowerPoint",
  ".zip": "压缩包",
  ".rar": "压缩包",
  ".7z": "压缩包",
  ".png": "图片",
  ".jpg": "图片",
  ".jpeg": "图片",
  ".gif": "图片",
  ".webp": "图片",
  ".mp3": "音频",
  ".mp4": "视频",
  ".wav": "音频",
  ".exe": "程序",
  ".dll": "程序",
  ".safetensors": "模型权重文件",
  ".ckpt": "模型权重文件",
  ".bin": "二进制文件",
};

export function extensionOf(name) {
  const match = /\.([^.\\/]+)$/.exec(String(name ?? "").trim());
  return match ? `.${match[1].toLowerCase()}` : "";
}

/** 文件名只留安全字符，避免 ../ 之类的东西把文件写到别处去。 */
export function sanitizeFileName(name, fallback = "file") {
  const base = String(name ?? "")
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return (base || fallback).slice(0, 120);
}

/**
 * 是不是二进制。
 * 常见文本里不会有 NUL；有 NUL 基本可以断定不是给人读的文件（UTF-16 除外，它满屏都是 NUL，
 * 所以要先看 BOM：带 BOM 的 UTF-16 直接按 UTF-16 解，不走这个判断）。
 */
export function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (!sample.length) return false;
  let nul = 0;
  for (const byte of sample) if (byte === 0) nul += 1;
  return nul / sample.length > 0.02;
}

function decodeWith(buffer, encoding) {
  return new TextDecoder(encoding, { fatal: false }).decode(buffer);
}

/**
 * 猜编码并解码。
 *
 * 顺序很重要：
 *   ① BOM 说是什么就是什么（UTF-8 / UTF-16LE / UTF-16BE）；
 *   ② 没有 BOM 就先严格按 UTF-8 试一次——能解通就是 UTF-8（中文 UTF-8 很少能碰巧通过严格校验）；
 *   ③ 解不通再用 GB18030（Windows 记事本的中文默认，兼容 GBK/GB2312）。
 */
export function decodeText(buffer) {
  if (!buffer.length) return { text: "", encoding: "empty" };

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: decodeWith(buffer.subarray(3), "utf-8"), encoding: "utf-8-bom" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: decodeWith(buffer.subarray(2), "utf-16le"), encoding: "utf-16le" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: decodeWith(buffer.subarray(2), "utf-16be"), encoding: "utf-16be" };
  }

  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "utf-8" };
  } catch {
    /* 不是合法 UTF-8，往下试 GB18030 */
  }

  try {
    const text = decodeWith(buffer, "gb18030");
    // GB18030 永远能解（它是全字节映射），所以要看解出来像不像中文里该有的样子：
    // 出现成片的私用区 / 替换字符就说明猜错了。
    if (/[\uFFFD]/.test(text.slice(0, 2000))) return { text, encoding: "gb18030（可能有乱码）" };
    return { text, encoding: "gb18030" };
  } catch (error) {
    return { text: decodeWith(buffer, "latin1"), encoding: `无法确定（按 latin1 解，${error?.message ?? error}）` };
  }
}

/* --------------------------------- docx --------------------------------- */

/**
 * 从 zip 里取出一个文件（只支持 deflate 与 stored 两种，docx 只用到这两种）。
 * 从中央目录找，而不是从本地头顺着走——有些生成器会把本地头写成占位值。
 */
function zipEntry(buffer, wanted) {
  // EOCD 签名 0x06054b50，在最末尾 64KB 内
  const minPos = Math.max(0, buffer.length - 65558);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= minPos; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip（找不到中央目录）");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    if (name === wanted) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("本地文件头损坏");
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const raw = buffer.subarray(start, start + compSize);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`不支持的压缩方式 ${method}`);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("zip 里没有 " + wanted);
}

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

/** docx → 纯文本（只取正文段落，忽略样式、批注、页眉页脚）。 */
export function readDocxText(buffer) {
  const xml = zipEntry(buffer, "word/document.xml").toString("utf8");
  const text = xml
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return unescapeXml(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------- 对外入口 ------------------------------- */

/**
 * 把一份文件读成文字。
 *
 * 返回：
 *   { ok: true, kind, text, encoding, chars, note }
 *   { ok: false, kind, note }        —— note 是给角色看的人话（她照着说实话就行）
 */
export function extractText(buffer, name, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const ext = extensionOf(name);
  const size = buffer.length;

  if (!size) return { ok: false, kind: "empty", note: "这个文件是空的，里面没有内容" };
  if (size > maxBytes) {
    return {
      ok: false,
      kind: "too-large",
      note: `文件太大（${formatSize(size)}），超过了我能读的上限 ${formatSize(maxBytes)}`,
    };
  }

  if (ext === ".docx") {
    try {
      const text = readDocxText(buffer);
      if (!text.trim()) return { ok: false, kind: "docx", note: "这是个 Word 文档，但里面没有文字（可能只有图片）" };
      return { ok: true, kind: "docx", text, encoding: "docx", chars: text.length, note: "" };
    } catch (error) {
      return { ok: false, kind: "docx", note: `这是个 Word 文档，但我打不开（${error?.message ?? error}）` };
    }
  }

  if (BINARY_HINTS[ext]) {
    return { ok: false, kind: "binary", note: `这是个${BINARY_HINTS[ext]}（${ext}），我读不出里面的文字` };
  }

  // 带 BOM 的 UTF-16 一定有大量 NUL，所以先解 BOM，再做二进制判断
  const hasBom =
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));
  if (!hasBom && looksBinary(buffer)) {
    return { ok: false, kind: "binary", note: "这个文件是二进制格式，不是文字" };
  }

  const { text, encoding } = decodeText(buffer);
  const cleaned = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (!cleaned) return { ok: false, kind: "empty", note: "这个文件里没有可读的文字" };

  return { ok: true, kind: "text", text: cleaned, encoding, chars: cleaned.length, note: "" };
}

/**
 * 太长就掐一段：留开头和结尾，中间标明省略了多少字。
 * 开头是标题和设定，结尾往往是结论，中间那段牺牲掉最不容易误导。
 */
export function windowText(text, maxChars) {
  const limit = Math.max(200, Number(maxChars) || 12000);
  if (text.length <= limit) return { text, truncated: false, omitted: 0 };
  const head = Math.floor(limit * 0.8);
  const tail = limit - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n……（中间省略了约 ${omitted} 字）……\n\n${text.slice(text.length - tail)}`,
    truncated: true,
    omitted,
  };
}

export function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
