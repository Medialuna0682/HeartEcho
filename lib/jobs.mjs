/**
 * 长任务登记处（归档 / 日记 / 反思 / 以后可能加的别的东西）。
 *
 * 解决三个具体毛病：
 *   ① 重复触发：以前点两下就真的跑两遍——连点五次「反思」就出五批反思。
 *      这里按 kind 做单飞（single-flight）：同一类任务在跑，再点只会拿到同一个任务，
 *      不会启动第二个。
 *   ② 没有进度：以前是一次同步 HTTP 请求，几十秒里界面什么都不说。
 *      这里把任务放到后台跑，进度按步骤写进 job.steps，前端轮询着看。
 *   ③ 不知道成没成：结果和错误都留在 job 上，刷新页面也还看得到（内存里保留最近 30 条）。
 *
 * 只存在内存里：重启后历史清空没关系，跑着的任务本来也随进程没了。
 */
import { createLogger } from "./log.mjs";

const log = createLogger("Jobs");

/** id → job */
const jobs = new Map();
/** kind → 正在跑的 job id（单飞锁） */
const runningByKind = new Map();
const HISTORY_MAX = 30;

function snapshot(job) {
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    key: job.key,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    elapsedMs: (job.endedAt || Date.now()) - job.startedAt,
    steps: job.steps.map((step) => ({ at: step.at, message: step.message })),
    result: job.result ?? null,
    error: job.error || "",
    /** 有没有在跑 */
    running: job.status === "running",
  };
}

function trim() {
  if (jobs.size <= HISTORY_MAX) return;
  const finished = [...jobs.values()].filter((job) => job.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
  for (const job of finished) {
    if (jobs.size <= HISTORY_MAX) break;
    jobs.delete(job.id);
  }
}

export function getJob(id) {
  const job = jobs.get(String(id ?? ""));
  return job ? snapshot(job) : null;
}

export function listJobs({ limit = 20, kind = "" } = {}) {
  return [...jobs.values()]
    .filter((job) => !kind || job.kind === kind)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, Math.max(1, Number(limit) || 20))
    .map(snapshot);
}

/** 正在跑的那个（没有就 null）。前端用它决定按钮要不要置灰。 */
export function runningJob(kind) {
  const id = runningByKind.get(String(kind ?? ""));
  if (!id) return null;
  const job = jobs.get(id);
  return job && job.status === "running" ? snapshot(job) : null;
}

export function runningKinds() {
  const out = {};
  for (const [kind, id] of runningByKind) {
    const job = jobs.get(id);
    if (job && job.status === "running") out[kind] = snapshot(job);
  }
  return out;
}

/**
 * 启动一个长任务。
 *
 * 返回 { started, job }：
 *   started=false 表示同类任务已经在跑，job 是那一个（前端据此直接显示进度，不要重复发请求）。
 *
 * worker 收到一个 progress(message) 函数，用来写进度步骤。
 */
export function runJob(kind, title, worker, { key = "" } = {}) {
  const existing = runningJob(kind);
  if (existing) {
    log.info(`${title}已经在跑了，这次点击不再重复触发（${existing.id}）`);
    return { started: false, job: existing };
  }

  const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    id,
    kind: String(kind),
    title: String(title),
    key: String(key ?? ""),
    status: "running",
    startedAt: Date.now(),
    endedAt: 0,
    steps: [],
    result: null,
    error: "",
  };
  jobs.set(id, job);
  runningByKind.set(job.kind, id);

  const progress = (message) => {
    const text = String(message ?? "").trim();
    if (!text) return;
    job.steps.push({ at: Date.now(), message: text });
    log.info(`${job.title}：${text}`);
  };

  progress("开始");

  Promise.resolve()
    .then(() => worker(progress))
    .then((result) => {
      job.result = result ?? null;
      /*
       * 跑完了不等于做成了。
       * 「今天已经写过日记了」「模型这次没写出正文」这类结果是 skipped，
       * 以前一律标成 done：顶着一枚「完成」的绿标、底下却什么都没有，
       * 用户会以为是界面出了问题。现在单独标出来。
       */
      job.status = result?.skipped === true ? "skipped" : "done";
      job.endedAt = Date.now();
      const summary = typeof result?.summary === "string" ? result.summary : "";
      // 结果摘要和最后一条进度常常是同一句话，重复写一遍看起来像出了两次错
      const last = job.steps[job.steps.length - 1]?.message ?? "";
      if (summary && summary !== last) progress(summary);
    })
    .catch((error) => {
      job.status = "failed";
      job.error = String(error?.message ?? error).slice(0, 500);
      job.endedAt = Date.now();
      progress(`失败了：${job.error}`);
      log.warn(`${job.title}失败：${job.error}`);
    })
    .finally(() => {
      if (runningByKind.get(job.kind) === id) runningByKind.delete(job.kind);
      trim();
    });

  return { started: true, job: snapshot(job) };
}

/** 自检用：把登记表清空。 */
export function resetJobs() {
  jobs.clear();
  runningByKind.clear();
}
