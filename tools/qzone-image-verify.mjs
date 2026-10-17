/**
 * 验证「发布带图说说」这项能力：把一张本地图片上传到空间并读回确认。
 *
 *   node tools/qzone-image-verify.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sampleTestPng } from "./png.mjs";

const PANEL = process.env.HEARTECHO_PANEL || "http://127.0.0.1:5311";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, body) {
  const res = await fetch(PANEL + pathname, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

const results = [];
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${id} ${name}${detail ? `  · ${detail}` : ""}`);
};

async function main() {
  console.log("=== 空间带图说说验证 ===");
  const status = await api("/api/status");
  check("QG-01", "机器人 QQ 在线", Boolean(status.onebot?.online), status.onebot?.nickname || "");

  // 生成一张测试图，放到数据目录里
  const file = path.join(os.tmpdir(), `heartecho-qzone-${Date.now().toString(36)}.png`);
  fs.writeFileSync(file, sampleTestPng(120));
  check("QG-02", "生成测试图片", fs.existsSync(file), `${(fs.statSync(file).size / 1024).toFixed(1)} KB · ${file}`);

  const marker = `带图${Date.now().toString(36)}`;
  let result;
  try {
    result = await api("/api/qzone/post-with-image", { content: `带图测试 ${marker}`, file });
  } catch (error) {
    result = { ok: false, message: String(error?.message ?? error) };
  }

  if (!result.ok && /没有这个接口|404/.test(String(result.message))) {
    check("QG-03", "带图发布接口", false, "接口还没实现（需要先加 /api/qzone/post-with-image）");
    fs.rmSync(file, { force: true });
    return summary();
  }

  check("QG-03", "带图发布调用", Boolean(result.ok), result.ok ? `图片 ${result.images} 张` : `${result.message}｜${result.hint ?? ""}`);
  if (!result.ok) {
    fs.rmSync(file, { force: true });
    return summary();
  }

  check("QG-04", "发布结果已核验可见", result.verified === true, result.verified ? "读到页面确认" : "接口成功但未能确认");

  const list = await api("/api/qzone/my-list", { num: 10 });
  const hit = (list.items ?? []).find((item) => String(item.content ?? "").includes(marker));
  check("QG-05", "读回确认说说在页面上", Boolean(hit?.tid), hit?.tid ? `tid=${String(hit.tid).slice(0, 20)}…` : "没读到");

  const caps = await api("/api/qzone");
  const cap = (caps.capabilities ?? []).find((c) => c.id === "post_image");
  check("QG-06", "带图能力状态已更新", cap?.status && cap.status !== "unknown", `post_image = ${cap?.status}`);

  if (hit?.tid) {
    const del = await api("/api/qzone/delete", { tid: hit.tid });
    check("QG-07", "测试说说已清理", Boolean(del.ok), del.ok ? "已删除" : del.message);
  } else {
    check("QG-07", "测试说说已清理", false, "没读到 tid，请手动删掉那条测试说说");
  }

  fs.rmSync(file, { force: true });
  summary();
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "═".repeat(58));
  console.log(`带图说说验证：${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    console.log("未通过：");
    for (const item of failed) console.log(`  ${item.id} ${item.name} —— ${item.detail}`);
  }
  console.log("═".repeat(58));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error("验证崩了：", error?.stack ?? error);
  process.exitCode = 2;
});
