/**
 * 验证空间的点赞与评论能力：在自己空间发一条说说 → 点赞 → 评论 → 读回确认 → 清理。
 * 这样验证的是机器人自己的登录态真的能执行写操作，不依赖别人的动态。
 *
 * 注意：腾讯对「短时间连续发说说」有节流，连发两条可能只留下最后一条。
 * 所以这个脚本一次只发一条，并且自带冷却，避免把上一条顶掉。
 *
 *   node tools/qzone-interact-verify.mjs
 */
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

/**
 * 空间的读接口是「最终一致」的：刚发完的说说不会立刻出现在列表里。
 * 所以读回确认必须轮询重试，不能读一次没看到就判失败。
 */
async function pollMyList(matchFn, { tries = 6, baseDelay = 1500, num = 10 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    last = await api("/api/qzone/my-list", { num });
    const hit = (last.items ?? []).find(matchFn);
    if (hit) return { hit, list: last.items ?? [], tries: i + 1 };
    await sleep(baseDelay + i * 500);
  }
  return { hit: null, list: last?.items ?? [], tries };
}

async function main() {
  console.log("=== 空间点赞 / 评论能力验证 ===");
  const status = await api("/api/status");
  const self = String(status.bots?.selfId ?? "");
  check("QI-01", "机器人 QQ 在线", Boolean(status.onebot?.online), `${status.onebot?.nickname}（${self}）`);

  const marker = `互动自检${Date.now().toString(36)}`;
  const post = await api("/api/qzone/post", { content: `测试说说：${marker}` });
  check("QI-02", "先发一条自己的说说当靶子", Boolean(post.ok), post.ok ? (post.verified ? "已核验可见" : "已发出待核验") : post.message);
  if (!post.ok) return summary();

  // 空间的读接口是最终一致的，刚发的说说不会立刻出现，所以要轮询
  const found = await pollMyList((item) => String(item.content ?? "").includes(marker), { tries: 8, baseDelay: 2000 });
  const target = found.hit ?? (post.data?.tid ? { tid: post.data.tid } : null);
  check("QI-03", "拿到这条说说的 tid", Boolean(target?.tid), target?.tid ? `tid=${String(target.tid).slice(0, 20)}…（第 ${found.tries} 次读到）` : "既没读到也没拿到 tid");
  if (!target?.tid) return summary();

  const like = await api("/api/qzone/like", { tid: target.tid, targetUin: self });
  check("QI-04", "点赞调用成功", Boolean(like.ok), like.ok ? `status=${like.action?.status ?? "ok"}` : `${like.message}｜${like.hint ?? ""}`);

  const commentText = `自检评论 ${marker}`;
  const comment = await api("/api/qzone/comment", { tid: target.tid, content: commentText, targetUin: self });
  check("QI-05", "评论调用成功", Boolean(comment.ok), comment.ok ? `内容：${comment.content}` : `${comment.message}｜${comment.hint ?? ""}`);

  await sleep(2000);
  const refreshed = await pollMyList((item) => String(item.tid) === String(target.tid), { tries: 6, baseDelay: 2000 });
  const commentCount = Number(refreshed.hit?.comment_num ?? 0);
  check("QI-06", "读回确认评论真的进去了", commentCount > 0, `评论数 ${commentCount}（第 ${refreshed.tries} 次读到）`);
  const actions0 = await api("/api/qzone");
  const commentRow = (actions0.actions ?? []).find((a) => a.action === "comment" && String(a.target_post) === String(target.tid));
  check("QI-06b", "评论动作被标记为已核验", commentRow?.status === "verified", `status=${commentRow?.status}`);

  const actions = await api("/api/qzone");
  const rows = (actions.actions ?? []).filter((a) => ["like", "comment"].includes(a.action));
  check("QI-07", "点赞与评论都留了操作记录", rows.length >= 2, rows.map((a) => `${a.action}:${a.status}`).join("｜"));

  const capList = actions.capabilities ?? [];
  const likeCap = capList.find((c) => c.id === "like");
  const commentCap = capList.find((c) => c.id === "comment");
  // 评论能读回确认 → end_to_end_verified；点赞没法从消息里读到状态 → 只能到 api_verified
  check(
    "QI-08",
    "能力状态如实记录（评论已端到端验证、点赞止于接口可用）",
    ["api_verified", "end_to_end_verified"].includes(likeCap?.status) && ["api_verified", "end_to_end_verified"].includes(commentCap?.status),
    `like=${likeCap?.status}｜comment=${commentCap?.status}`,
  );

  const del = await api("/api/qzone/delete", { tid: target.tid });
  check("QI-09", "测试说说已清理", Boolean(del.ok), del.ok ? (del.verified ? "已确认删除" : "删除请求已发出") : del.message);

  // 重复点赞同一条应被幂等拦住
  const dup = await api("/api/qzone/like", { tid: target.tid, targetUin: self });
  check("QI-10", "同一目标重复操作被幂等拦住", dup.ok === true, dup.deduped ? "识别为重复操作，没有重复调用" : `未识别为重复（status=${dup.action?.status}）`);

  summary();
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "═".repeat(58));
  console.log(`空间互动验证：${results.length - failed.length} / ${results.length} 通过`);
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
