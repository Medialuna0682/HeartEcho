/**
 * 空间自动化任务（规划书 FR-601~604、9.1）。
 *
 * 三种模式（FR-506）：
 *   manual 完全手动：只在你点按钮时执行
 *   review 待审核：自动生成草稿/候选，但写操作必须人工批准
 *   limited_auto 有限自动：在审批之外允许按间隔自动执行，但只对 capability=end_to_end_verified 的能力
 *
 * 幂等：每条动态用 action_key（tid + 动作）去重，处理过的记进 qzone_actions，不会重复点赞刷屏。
 */
import { all, one, run } from "./db.mjs";
import { getConfig, activeCharacter } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { clamp } from "./util.mjs";
import { pauseState } from "./policy.mjs";
import { canAutomate, listActions } from "./qzone.mjs";

const log = createLogger("QZoneJob");

export class QZoneScheduler {
  constructor({ qzone, llm }) {
    this.qzone = qzone;
    this.llm = llm;
    this.timer = null;
    this.nextPostAt = 0;
    this.lastPostAt = 0;
    this.lastReactAt = 0;
    this.lastRun = null;
    this.lastError = "";
    this.drafts = [];
    this.tickCount = 0;
  }

  mode() {
    const cfg = getConfig();
    return cfg.qzone?.enabled === false ? "manual" : cfg.greet?.automationMode ?? "limited_auto";
  }

  character() {
    return activeCharacter();
  }

  /** 生成一条说说草稿（不发送）。 */
  async draftPost({ topic = "", hint = "" } = {}) {
    const cfg = getConfig();
    const character = this.character();
    const { text, requestId, cost } = await this.qzone.composePost({ character, topic: topic || cfg.qzone?.autoPost?.hint || "" });
    const draft = {
      id: `draft-${Date.now()}`,
      kind: "post",
      at: Date.now(),
      text,
      images: [],
      ugcRight: Number(cfg.qzone?.autoPost?.ugcRight) || 1,
      hint,
      requestId,
      cost,
      status: "pending",
    };
    this.drafts.unshift(draft);
    this.drafts = this.drafts.slice(0, 30);
    return draft;
  }

  async approveDraft(id) {
    const draft = this.drafts.find((item) => item.id === id);
    if (!draft) throw new Error("这个草稿不在了");
    if (draft.kind === "post") {
      const result = await this.qzone.publish(draft.text, { images: draft.images, ugcRight: draft.ugcRight, idempotencyKey: `approved:${draft.id}` });
      draft.status = result.verified ? "verified" : "sent_unverified";
      return { ...result, draft };
    }
    throw new Error(`不认识的草稿类型：${draft.kind}`);
  }

  rejectDraft(id, reason = "用户拒绝") {
    const draft = this.drafts.find((item) => item.id === id);
    if (draft) draft.status = "rejected";
    return draft;
  }

  /** 手动发一条（面板按钮）。 */
  async postOnce({ content = "", images = [], dryRun = false } = {}) {
    const cfg = getConfig();
    const character = this.character();
    const text = String(content ?? "").trim() || (await this.qzone.composePost({ character, topic: cfg.qzone?.autoPost?.hint || "" })).text;
    return this.qzone.publish(text, {
      images,
      ugcRight: Number(cfg.qzone?.autoPost?.ugcRight) || 1,
      dryRun,
      idempotencyKey: dryRun ? "" : `manual-post:${Math.floor(Date.now() / 60000)}`,
    });
  }

  /** 扫描一轮好友动态并执行允许的互动。 */
  async reactOnce({ dryRun = true } = {}) {
    const cfg = getConfig();
    const conf = cfg.qzone?.autoReact ?? {};
    const character = this.character();
    const masterId = String(cfg.bot.masterId ?? "");
    const result = { at: Date.now(), dryRun, scanned: 0, candidates: [], liked: 0, commented: 0, skipped: [] };

    let feeds = [];
    try {
      feeds = await this.qzone.feedItems({ count: 20 });
    } catch (error) {
      result.skipped.push({ reason: `读好友动态失败：${String(error?.message ?? error).slice(0, 120)}`, hint: error?.hint ?? "" });
      this.lastError = String(error?.message ?? error);
    }

    // 好友动态流里翻不到时，改为直接读指定 QQ 空间的最新说说（默认读自己/指挥官的空间）
    const targetUins = new Set([
      ...((conf.targets ?? []).map(String)),
      ...(conf.selfSpace !== false && masterId ? [masterId] : []),
    ]);
    for (const uin of targetUins) {
      try {
        const data = await this.qzone.msgList(uin, 0, 5);
        for (const item of data?.msglist ?? []) {
          feeds.push({
            uin: Number(uin),
            nickname: "",
            time: Number(item.created_time ?? 0) * 1000,
            text: String(item.content ?? ""),
            images: item.images ?? [],
            tid: String(item.tid ?? ""),
            fromSpace: true,
          });
        }
      } catch (error) {
        result.skipped.push({ uin, reason: `读空间说说失败：${String(error?.message ?? error).slice(0, 120)}` });
      }
    }

    const seen = new Set();
    result.scanned = feeds.length;
    const maxAge = Math.max(1, Number(conf.maxAgeHours) || 48) * 3600000;
    const now = Date.now();

    for (const feed of feeds) {
      if (!feed.tid) continue;
      if (seen.has(feed.tid)) continue;
      seen.add(feed.tid);
      const isTarget = targetUins.size === 0 ? true : targetUins.has(String(feed.uin));
      if (!isTarget) continue;
      if (feed.time && now - feed.time > maxAge) continue;
      if (result.candidates.length >= Math.max(1, Number(conf.maxPerRun) || 3)) break;
      result.candidates.push({
        tid: feed.tid,
        uin: feed.uin,
        nickname: feed.nickname,
        time: feed.time,
        text: String(feed.text ?? "").slice(0, 200),
        images: (feed.images ?? []).length,
        from: feed.fromSpace ? "空间" : "动态流",
      });
    }

    if (dryRun) {
      result.note = "只是演练：上面是会处理的动态，没有真的操作。";
      return result;
    }

    for (const candidate of result.candidates) {
      const likeKey = `like:${candidate.tid}`;
      if (conf.like) {
        const gate = canAutomate("like");
        const guarded = this.mode() === "limited_auto" ? { ok: true } : gate;
        if (!guarded.ok) {
          result.skipped.push({ tid: candidate.tid, reason: guarded.reason });
        } else if (one("select id from qzone_actions where idempotency_key = ?", [likeKey])) {
          result.skipped.push({ tid: candidate.tid, reason: "这条之前已经赞过了" });
        } else {
          try {
            await this.qzone.like(candidate.tid, candidate.uin, { idempotencyKey: likeKey });
            result.liked += 1;
          } catch (error) {
            result.skipped.push({ tid: candidate.tid, reason: String(error?.message ?? error).slice(0, 120) });
          }
        }
      }
      if (conf.comment && Math.random() < clamp(conf.commentChance ?? 0.7, 0, 1)) {
        const commentKey = `comment:${candidate.tid}`;
        if (one("select id from qzone_actions where idempotency_key = ?", [commentKey])) {
          result.skipped.push({ tid: candidate.tid, reason: "这条之前已经评论过了" });
        } else {
          try {
            const text = await this.qzone.composeComment({ character, post: candidate });
            if (text) {
              await this.qzone.comment(candidate.tid, text, candidate.uin, { idempotencyKey: commentKey });
              result.commented += 1;
              candidate.comment = text;
            }
          } catch (error) {
            result.skipped.push({ tid: candidate.tid, reason: String(error?.message ?? error).slice(0, 120) });
          }
        }
      }
    }
    this.lastRun = result;
    log.info(`空间互动完成：候选 ${result.candidates.length} 条，赞 ${result.liked}，评论 ${result.commented}`);
    return result;
  }

  /** 定时任务：自动发动态（按随机间隔）与自动互动。 */
  async tick(now = new Date()) {
    const cfg = getConfig();
    if (cfg.qzone?.enabled !== true) return;
    if (pauseState.paused) return;
    if (this.mode() !== "limited_auto") return;
    const post = cfg.qzone?.autoPost ?? {};
    const react = cfg.qzone?.autoReact ?? {};

    if (post.enabled) {
      const minMs = Math.max(10, Number(post.minIntervalMinutes) || 180) * 60000;
      const maxMs = Math.max(minMs, Number(post.maxIntervalMinutes) || 420) * 60000;
      if (!this.nextPostAt) {
        this.nextPostAt = Date.now() + minMs + Math.random() * (maxMs - minMs);
      } else if (Date.now() >= this.nextPostAt) {
        try {
          const draft = await this.draftPost();
          if (post.requireApproval !== false) {
            log.info(`自动发动态：已生成草稿等待审核（${draft.text.slice(0, 30)}…）`);
          } else {
            await this.approveDraft(draft.id);
            log.info(`自动发动态：已发布（${draft.text.slice(0, 30)}…）`);
          }
        } catch (error) {
          this.lastError = String(error?.message ?? error);
          log.warn(`自动发动态失败：${this.lastError}`);
        } finally {
          this.lastPostAt = Date.now();
          this.nextPostAt = Date.now() + minMs + Math.random() * (maxMs - minMs);
        }
      }
    }

    if (react.enabled) {
      const interval = Math.max(2, Number(react.scanIntervalMinutes) || 10) * 60000;
      if (!this.lastReactAt || Date.now() - this.lastReactAt >= interval) {
        this.lastReactAt = Date.now();
        try {
          await this.reactOnce({ dryRun: react.requireApproval === true });
        } catch (error) {
          this.lastError = String(error?.message ?? error);
          log.warn(`自动互动失败：${this.lastError}`);
        }
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tickCount += 1;
      this.tick().catch((error) => log.error(`空间任务异常：${error?.message ?? error}`));
    }, 60000);
    this.timer.unref?.();
    log.info("空间自动化已启动（每 60 秒检查一次，但默认不自动执行写操作）");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    const cfg = getConfig();
    return {
      enabled: cfg.qzone?.enabled === true,
      mode: this.mode(),
      nextPostAt: this.nextPostAt,
      lastPostAt: this.lastPostAt,
      lastReactAt: this.lastReactAt,
      lastRun: this.lastRun,
      drafts: this.drafts.slice(0, 20),
      actions: listActions({ limit: 30 }),
      lastError: this.lastError,
      tickCount: this.tickCount,
    };
  }
}
