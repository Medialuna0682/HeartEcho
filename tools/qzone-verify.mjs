/**
 * QQ 空间端到端验证：真的发一条说说，然后读回来确认页面可见，最后删掉。
 * 这是「接口返回成功」和「真实生效」之间那道坎的唯一有效检验。
 *
 *   node tools/qzone-verify.mjs           只读检查
 *   node tools/qzone-verify.mjs --write   真的发一条说说（验证后自动删除）
 */
const PANEL = process.env.HEARTECHO_PANEL || "http://127.0.0.1:5311";
const WRITE = process.argv.includes("--write");

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
  console.log("=== QQ 空间端到端验证 ===");
  const status = await api("/api/status");
  check("QZ-01", "机器人 QQ 在线", Boolean(status.onebot?.online), status.onebot?.nickname || "");

  const check1 = await api("/api/qzone/check", {});
  const steps = check1.report?.steps ?? [];
  for (const step of steps) {
    // 第 ④ 步是「绕过协议端的兜底通路」，它不通不影响使用（主通路是协议端），只做提示
    const isFallback = step.name.includes("直连腾讯");
    check(isFallback ? "QZ-info" : "QZ-step", step.name, isFallback ? true : step.ok, String(step.detail).slice(0, 120));
  }

  // 读自己的说说
  const mine = await api("/api/qzone/my-list", { num: 10 });
  check("QZ-02", "能读到自己空间的说说", Boolean(mine.ok), mine.ok ? `拿到 ${(mine.items ?? []).length} 条（来源 ${mine.source}）` : mine.message);
  const baseline = (mine.items ?? []).map((i) => String(i.content ?? ""));

  // 读好友动态
  const feeds = await api("/api/qzone/feeds", {});
  check("QZ-03", "能读到好友动态流", Boolean(feeds.ok), feeds.ok ? `${(feeds.items ?? []).length} 条` : `${feeds.message}｜${feeds.hint ?? ""}`);

  if (!WRITE) {
    console.log("\n（只读模式。要真实验证发布，加 --write）");
    return summary();
  }

  // ---------- 真实发布 → 读回确认 → 删除 ----------
  const marker = `自检${Date.now().toString(36)}`;
  const content = `今天月色很好。${marker}`;
  console.log(`\n准备发布说说：${content}`);
  const post = await api("/api/qzone/post", { content });
  check("QZ-04", "发说说接口调用", Boolean(post.ok), post.ok ? `verified=${post.verified}` : `${post.message}｜${post.hint ?? ""}`);
  if (!post.ok) return summary();

  check("QZ-05", "发布结果被标记为已核验", post.verified === true, post.verified ? "读到页面确认可见" : "接口成功但未能确认（状态 sent_unverified）");

  await sleep(3000);
  const after = await api("/api/qzone/my-list", { num: 10 });
  const found = (after.items ?? []).some((item) => String(item.content ?? "").includes(marker));
  check("QZ-06", "读回确认这条说说真的在页面上", found, found ? "在最新说说列表里找到了" : `没找到，列表：${(after.items ?? []).map((i) => String(i.content).slice(0, 20)).join("｜")}`);

  const caps = await api("/api/qzone");
  const cap = (caps.capabilities ?? []).find((c) => c.id === "post_text");
  check("QZ-07", "能力状态已升级为端到端已验证", cap?.status === "end_to_end_verified", `post_text = ${cap?.status}`);

  // 清理：把测试说说删掉
  const tid = (after.items ?? []).find((item) => String(item.content ?? "").includes(marker))?.tid;
  if (tid) {
    const del = await api("/api/qzone/delete", { tid });
    check("QZ-08", "测试说说已清理", Boolean(del.ok), del.ok ? "已删除" : del.message);
  } else {
    check("QZ-08", "测试说说已清理", false, "没找到 tid，请手动删掉那条测试说说");
  }

  summary();
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "═".repeat(58));
  console.log(`QQ 空间验证：${results.length - failed.length} / ${results.length} 通过`);
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
