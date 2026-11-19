// Qianwen (千问 App, com.alibaba.tongyi) as a magpie / OpenCode provider.
// 读取桌面登录态，纯 HTTP 复现 Baxia 签名直接调网页端 API，
// 以 OpenAI Chat Completions 协议暴露给 agent（无浏览器、无 DOM 依赖）。
import { QianwenSession, SITE, browserBin } from "./session.mjs";

const PROVIDER = "qianwen";
const API = "https://chat2.qianwen.com";

const icon = ""; // 可选：provider 图标（留空则 magpie 用默认）

// 从 CC 注入了 system-reminder / command-message 的 user 消息里提取真实用户输入。
// 典型结构：<system-reminder>...</system-reminder>\n\n<真实输入>\n\n<command-message>...
function extractRealUserText(raw) {
  if (typeof raw !== "string" || !raw.trim()) return raw;
  let s = raw;
  // 1) 若以 <system-reminder> 包裹，取最后一个 </system-reminder> 之后的内容
  const lastReminder = s.lastIndexOf("</system-reminder>");
  if (lastReminder >= 0 && s.indexOf("<system-reminder>") === 0) {
    s = s.slice(lastReminder + "</system-reminder>".length);
  }
  // 2) 去掉紧随其后的 command-message / command-name / skill-format 等 CC 元数据块
  const cmdIdx = s.search(/<command-message\b|<command-name\b|<skill-format\b|<system-reminder\b/);
  if (cmdIdx > 0) s = s.slice(0, cmdIdx);
  s = s.trim();
  return s || raw.trim(); // 剥离后为空则回退原文，避免误伤
}

function readAuth(auth) {
  if (auth?.type !== "api") {
    const e = new Error("请先导入千问桌面登录账号（magpie plugin login qianwen）。");
    e.status = 401; e.signIn = "required"; throw e;
  }
  try { return JSON.parse(auth.key); } catch { return {}; }
}

export const QianwenPlugin = async ({ client } = {}) => {
  const sessions = new Map();
  const opts = (client?.options && typeof client.options === "object") ? client.options : {};
  const sessionFor = (auth) => {
    const binding = readAuth(auth);
    const key = `${binding.profile || "Default"}`;
    if (!sessions.has(key)) sessions.set(key, new QianwenSession(binding, { browserBin: opts.browserBin }));
    return sessions.get(key);
  };

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "千问", npm: "@ai-sdk/openai-compatible",
        api: `${API}/v1`, models: {},
      };
    },
    auth: {
      provider: PROVIDER, maxConcurrency: 1,
      ...(icon ? { icon } : {}),
      methods: [{
        type: "api", keyless: true, label: "导入千问桌面登录",
        prompts: [],
        async authorize() {
          const session = new QianwenSession({}, { browserBin: opts.browserBin });
          await session.ready();
          const binding = { version: 1, profile: "Default" };
          sessions.set(binding.profile, session);
          const uid = session.uid || "";
          return {
            type: "success", key: JSON.stringify(binding),
            metadata: { email: `千问桌面账号${uid ? " · " + uid.slice(0, 10) : ""}`, uid, profile: "Default" },
          };
        },
      }],
      async loader(getAuth) {
        return {
          baseURL: `${API}/v1`,
          apiKey: "qianwen-local-session",
          async fetch(input, init) {
            return handleFetch(await getAuth(), input, init);
          },
        };
      },
      async usage() {
        // 千问网页没有稳定的额度接口，返回空窗口避免报错。
        return { windows: [] };
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        const list = await sessionFor(auth).models();
        const out = {};
        for (const m of list) {
          out[m.id] = { id: m.id, name: m.name || m.id };
        }
        return out;
      },
    },
  };

  async function handleFetch(auth, input, init) {
    const req = new Request(input, init);
    const url = new URL(req.url);
    // 只处理对话端点
    if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
      return json({ error: { message: "qianwen: unsupported endpoint" } }, 400);
    }
    let body;
    try { body = await req.json(); } catch { return json({ error: { message: "invalid json" } }, 400); }
    const session = sessionFor(auth);
    try {
      // 传递完整 messages 数组，保留多轮上下文（session 内部复用 session_id/topic_id）。
      const msgs = (Array.isArray(body.messages) ? body.messages : []).map((m) => {
        const c = m?.content;
        const content = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text || "").join("\n") : "";
        return { role: m?.role || "user", content };
      });
      let text = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user" && msgs[i].content) { text = msgs[i].content; break; }
      }
      // CC 会把 CLAUDE.md/system-reminder/skill 文档拼进 user 消息。
      // 千问只需真实输入，剥掉这些包裹，避免被判成「工作流意图」而空回复。
      text = extractRealUserText(text);
      if (!text) return json({ error: { message: "no user message" } }, 400);
      const model = body.model || "Qwen";
      // 风控是按 cookie/IP 维度的，重试只会加重；只做一次短暂退避后重试，
      // 之后如实抛错，提示用户在网页完成验证或稍后再试。
      let reply;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          reply = await session.sendMessage(text, { messages: msgs, model });
          break;
        } catch (e) {
          if (e.rateLimited && attempt === 0) {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          throw e;
        }
      }
      const id = `chatcmpl-${randomId()}`;
      if (!body.stream) {
        return json({
          id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        });
      }
      // 流式：一次性吐出（网页是整段回复），再给 [DONE]
      const encoder = new TextEncoder();
      const chunks = [];
      const meta = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
      chunks.push(encoder.encode(`data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`));
      chunks.push(encoder.encode(`data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: { content: reply } }] })}\n\n`));
      chunks.push(encoder.encode(`data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
      chunks.push(encoder.encode("data: [DONE]\n\n"));
      return new Response(new ReadableStream({
        start(controller) { for (const c of chunks) controller.enqueue(c); controller.close(); },
      }), { headers: { "Content-Type": "text/event-stream" } });
    } catch (error) {
      const status = error.status || 502;
      return json({ error: { message: error.message || String(error) } }, status);
    }
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function randomId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export default QianwenPlugin;
