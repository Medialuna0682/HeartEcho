import { getConfig, saveConfig, loadCharacter, saveCharacter } from "./config.mjs";
import { all, run } from "./db.mjs";
import {
  memoryDisclosure,
  memoryConsentValid,
  memoryHealth,
  listExtendedMemories,
  editExtendedMemory,
  archiveExtendedDaily,
} from "./extended-memory.mjs";
import { runtimeStatus, startManagedHindsight } from "./hindsight-runtime.mjs";
import { rateSnapshot, resetReplyQuota } from "./policy.mjs";
import { searchFingerprint } from "./tb.mjs";
import { serviceUrl } from "./service-http.mjs";
import { randomBytes } from "node:crypto";

const numericId = (value) => /^[1-9]\d*$/.test(String(value || ""));
const bounded = (value, min, max) => Math.max(min, Math.min(max, Math.round(Number(value) || min)));

export async function nextApi({ route, url, body, ctx }) {
  if (route === "GET /api/next")
    return {
      ok: true,
      disclosure: memoryDisclosure(),
      consentValid: memoryConsentValid(),
      memoryHealth: getConfig().nextMemory.enabled ? memoryHealth : { state: "disabled", changedAt: 0 },
      runtimeStatus,
      memories: listExtendedMemories(),
      typing: ctx.chat.typingStatus || { observed: false },
      erasureNote: "修改或删除立即阻止旧版本召回；外部服务中的物理副本需在服务可用时删除。",
    };
  if (route === "POST /api/next/consent") {
    if (body.fingerprint !== memoryDisclosure().fingerprint || body.agreed !== true)
      throw new Error("设置已变化，请重新阅读传输说明并同意");
    saveConfig({ nextMemory: { consentDigest: body.fingerprint } });
    return { ok: true };
  }
  if (route === "POST /api/next/memory/start") {
    if (!getConfig().nextMemory.enabled || !memoryConsentValid())
      throw new Error("请先启用记忆、保存设置并同意当前数据传输说明");
    if (!getConfig().nextMemory.llm.baseUrl || !getConfig().nextMemory.llm.model)
      throw new Error("请先配置 Hindsight 使用的归档模型");
    // Provisioning may download a large image. Return promptly; status is polled by the panel.
    startManagedHindsight().catch((error) => {
      runtimeStatus.state = "unavailable";
      runtimeStatus.message = error.message;
    });
    return { ok: true, runtimeStatus };
  }
  if (route === "POST /api/next/memory/archive") return archiveExtendedDaily(ctx.llm);
  if (route === "POST /api/next/memory/edit") return editExtendedMemory(body.id, body.content);
  if (route === "POST /api/next/memory/settings") {
    const patch = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    if (body.baseUrl !== undefined) {
      patch.baseUrl = serviceUrl(body.baseUrl);
      if (patch.baseUrl !== getConfig().nextMemory.baseUrl && !body.apiKey) patch.apiKey = "";
    }
    if (body.apiKey !== undefined) patch.apiKey = String(body.apiKey).slice(0, 4096);
    for (const kind of ["llm", "embedding", "reranker"])
      if (body[kind]) {
        const input = body[kind];
        const current = getConfig().nextMemory[kind];
        patch[kind] = {
          provider: input.provider === "local" ? "local" : "external",
          baseUrl: input.baseUrl ? serviceUrl(input.baseUrl) : "",
          model: String(input.model || "").slice(0, 200),
        };
        if (input.apiKey) patch[kind].apiKey = String(input.apiKey).slice(0, 4096);
        else if (patch[kind].baseUrl !== current.baseUrl) patch[kind].apiKey = "";
      }
    for (const key of ["characterLinks", "groupLinks"])
      if (body[key] !== undefined) {
        if (
          !Array.isArray(body[key]) ||
          body[key].length > 40 ||
          body[key].some(
            (pair) =>
              !Array.isArray(pair) ||
              pair.length !== 2 ||
              pair.some((item) => typeof item !== "string" || item.length > 40),
          )
        )
          throw new Error("共享配置需为成对的角色 ID 或群号");
        patch[key] = body[key];
      }
    const endpoint = patch.baseUrl || getConfig().nextMemory.baseUrl;
    const nextKey = "apiKey" in patch ? patch.apiKey : getConfig().nextMemory.apiKey;
    if (endpoint === "http://127.0.0.1:8888" && !nextKey) patch.apiKey = randomBytes(24).toString("hex");
    saveConfig({ nextMemory: patch });
    return { ok: true, disclosure: memoryDisclosure(), consentValid: memoryConsentValid() };
  }
  if (route === "POST /api/next/poke") {
    const character = loadCharacter(String(body.characterId || getConfig().activeCharacter));
    const patch = {
      privateEnabled: body.privateEnabled === true,
      groupEnabled: body.groupEnabled === true,
      mode: body.mode === "persona" ? "persona" : "fixed",
      text: String(body.text || "我在。").slice(0, 500),
      cooldownSec: bounded(body.cooldownSec, 3, 3600),
    };
    const poke = { ...(character.poke || {}) };
    if (body.groupId) {
      if (!numericId(body.groupId)) throw new Error("群号无效");
      poke.groups = { ...(poke.groups || {}), [String(body.groupId)]: patch };
      if (body.inherit === true) delete poke.groups[String(body.groupId)];
    } else Object.assign(poke, patch);
    saveCharacter(character.id, { poke });
    return { ok: true };
  }
  if (route === "GET /api/next/quota") {
    const groupId = url.searchParams.get("groupId"),
      peerId = url.searchParams.get("peerId") || "0";
    if (!numericId(groupId) || !/^\d+$/.test(peerId)) throw new Error("请选择有效群号和成员 QQ");
    return {
      ok: true,
      checks: rateSnapshot({ kind: "group", groupId, peerId }),
      exempt: Boolean(
        all("select * from quota_exemptions where character_id = ? and group_id = ? and peer_id = ?", [
          getConfig().activeCharacter,
          groupId,
          peerId,
        ]).length,
      ),
    };
  }
  if (route === "POST /api/next/quota") {
    const groupId = String(body.groupId || ""),
      peerId = String(body.peerId || "");
    if (!numericId(groupId) || (peerId && !numericId(peerId))) throw new Error("群号或成员 QQ 无效");
    if (body.action === "reset") resetReplyQuota(groupId, peerId);
    else if (body.action === "exempt" || body.action === "unexempt") {
      if (!peerId) throw new Error("请选择成员");
      if (body.action === "exempt")
        run("insert or ignore into quota_exemptions values(?, ?, ?)", [getConfig().activeCharacter, groupId, peerId]);
      else
        run("delete from quota_exemptions where character_id = ? and group_id = ? and peer_id = ?", [
          getConfig().activeCharacter,
          groupId,
          peerId,
        ]);
    } else {
      const prefix = peerId ? "perUser" : "perGroup";
      const rate = {};
      for (const period of ["Minute", "Hour", "Day"])
        rate[prefix + "Per" + period] = bounded(body[period.toLowerCase()], 0, 100000);
      if (peerId) {
        const { upsertMemberPolicy } = await import("./storage.mjs");
        upsertMemberPolicy({ characterId: getConfig().activeCharacter, groupId, peerId, settings: { rate } });
      } else saveConfig({ group: { groupOverrides: { [groupId]: { rate } } } });
    }
    return { ok: true };
  }
  if (route === "POST /api/next/admin") {
    saveConfig({ interaction: { adminReset: body.adminReset === true, adminExempt: body.adminExempt === true } });
    return { ok: true };
  }
  if (route === "POST /api/next/tb/search") {
    const patch = {
      enabled: body.enabled === true,
      mode: body.mode === "api" ? "api" : "wiki",
      baseUrl: body.baseUrl ? serviceUrl(body.baseUrl) : "",
    };
    if (body.apiKey) patch.apiKey = String(body.apiKey).slice(0, 4096);
    else if (patch.baseUrl !== getConfig().tb.search.baseUrl) patch.apiKey = "";
    saveConfig({ tb: { search: patch } });
    return {
      ok: true,
      fingerprint: searchFingerprint(),
      disclosure: "搜索 API 将接收本次问题的查询文本。保存后须另行同意，默认 Wiki 不需要 API Key。",
    };
  }
  if (route === "POST /api/next/tb/search/consent") {
    if (body.fingerprint !== searchFingerprint() || body.agreed !== true) throw new Error("搜索设置已变化，请重新确认");
    saveConfig({ tb: { search: { consentDigest: body.fingerprint } } });
    return { ok: true };
  }
  if (route === "POST /api/next/tb/rules") {
    if (!numericId(body.groupId)) throw new Error("群号无效");
    const gid = String(body.groupId);
    if (body.action === "fetch") return ctx.tb.refreshRules(gid);
    if (body.action === "confirm") return ctx.tb.confirmRules(gid, body.fingerprint);
    const patch = {
      enabled: body.enabled === true,
      source: body.source === "custom" ? "custom" : "notice",
      noticeId: String(body.noticeId || "").slice(0, 100),
    };
    if (patch.source === "custom") patch.rules = String(body.rules || "").slice(0, 1800);
    saveConfig({ tb: { groups: { [gid]: patch } } });
    return { ok: true };
  }
  return null;
}
