/**
 * 自定义通道的示例桥接脚本（2026-11-12，IM 通道 P2）。
 *
 * 它演示对接一个内网工作软件需要的全部三件事：
 *   1. POST /v1/messages      推一条消息进 PiDesktop（脚本侧「收到别人消息」）
 *   2. POST <replyUrl>        在回调里收答案（脚本侧「把答案发回工作软件」）
 *   3. GET  /v1/replies       轮询兜底（回调丢了也能取回）
 *
 * 用法：
 *   PIBASE=http://127.0.0.1:8787/v1 PITOKEN=<面板里的 Token> \
 *     node docs/im-channel-bridge-example.mjs "帮我看下今天发了什么版"
 *
 *   # 不走回调、纯轮询：
 *   PIBASE=... PITOKEN=... node docs/im-channel-bridge-example.mjs --poll
 *
 * 真实场景里把 `readIncomingFromWorkSoftware()` 换成你的监听逻辑
 * （WebSocket / 长轮询 / SDK 回调都行），把 `pushAnswerBack()` 换成你的发送 API。
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const base = (process.env.PIBASE ?? "").replace(/\/+$/u, "");
const token = process.env.PITOKEN ?? "";
const args = process.argv.slice(2);
const usePollingOnly = args.includes("--poll");
const text = args.filter((item) => !item.startsWith("--")).join(" ").trim() || "你好，报一下现在的时间和工作区。";
const peerId = process.env.PIPEER ?? "demo-user";
const callbackPort = Number(process.env.PICALLBACK_PORT ?? "8799");

if (!base || !token) {
  console.error("缺少环境变量：PIBASE（形如 http://127.0.0.1:8787/v1）与 PITOKEN。");
  process.exit(1);
}

/** ① 脚本侧「收到一条工作软件的消息」——这里用命令行参数模拟。 */
function readIncomingFromWorkSoftware() {
  return { peerId, text, messageId: `demo-${randomUUID()}` };
}

/** ③ 脚本侧「把答案发回工作软件」——真实场景换成你的发送 API。 */
function pushAnswerBack(answer) {
  console.log(`\n[答案 → 工作软件] ${answer}\n`);
}

async function postMessage(message) {
  const response = await fetch(`${base}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(message)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`推送失败：${response.status} ${body.error ?? ""}`);
    process.exit(1);
  }
  console.log(`已收下：messageId=${body.messageId} peerId=${body.peerId}`);
  return body;
}

async function pollReplies(cursor, deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs;
  let since = cursor;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/replies?since=${since}&peerId=${encodeURIComponent(peerId)}&token=${encodeURIComponent(token)}`);
    if (!response.ok) {
      console.error(`轮询失败：${response.status}（检查 Token 与端口）`);
      return;
    }
    const body = await response.json();
    for (const item of body.items ?? []) pushAnswerBack(item.text);
    since = body.next ?? since;
    await new Promise((resolve) => { setTimeout(resolve, 1_500); });
  }
}

if (usePollingOnly) {
  // 只看轮询这条腿：先推再拉。
  const sent = await postMessage(readIncomingFromWorkSoftware());
  console.log("轮询答案中（Ctrl+C 结束）…");
  await pollReplies(0);
} else {
  // 回调这条腿：起一个本地回调服务器，把 replyUrl 一起推过去。
  const replyUrl = `http://127.0.0.1:${callbackPort}/reply`;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/reply") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      try {
        const payload = JSON.parse(raw);
        pushAnswerBack(payload.text);
      } catch {
        console.error("回调体不是 JSON：", raw.slice(0, 200));
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{\"ok\":true}");
    });
  });
  await new Promise((resolve) => server.listen(callbackPort, "127.0.0.1", resolve));
  console.log(`回调服务器就绪：${replyUrl}`);
  await postMessage({ ...readIncomingFromWorkSoftware(), replyUrl });
  console.log("等答案（Ctrl+C 结束）…");
}
