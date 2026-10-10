import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PANEL_MEASURE_HTML, PanelProtocolRoute, type PanelProtocolEndpoint } from "./panel-protocol.js";
import { panelWorkHost, panelWorkUrl } from "../shared/protocol.js";
import { PANEL_MEASURE_PAGE, PANEL_STATE_ENDPOINT, type PanelRequest } from "../shared/panel.js";

/**
 * 面板协议路由（2026-10-10 根因修复）。
 *
 * 这是面板「数据不再随重启丢」的落地点：页面、资产、状态端点、数据量测页全部由它
 * 在**固定 origin** 上服务。测试直接打 `handle(Request)`（Electron 的 protocol.handle
 * 收到的就是 Request），不需要起 HTTP 服务，所以跑得快且能断言真实响应。
 */

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pidesktop-panel-"));
  await mkdir(join(root, "canvas", "sub"), { recursive: true });
  await writeFile(join(root, "canvas", "index.html"), "<h1>panel</h1>");
  await writeFile(join(root, "canvas", "style.css"), "body{color:red}");
  await writeFile(join(root, "canvas", "sub", "deep.json"), '{"ok":true}');
  await writeFile(join(root, "secret.txt"), "outside");
  return root;
}

function routeWith(actions: PanelRequest[] = []): PanelProtocolRoute {
  const endpoint: PanelProtocolEndpoint = {
    state: () => ({ sessions: 1 }),
    action: (request) => {
      actions.push(request);
      return true;
    }
  };
  return new PanelProtocolRoute(endpoint);
}

function get(url: string): Promise<Response> {
  return routeWith().handle(new Request(url));
}

describe("PanelProtocolRoute 文件服务", () => {
  it("按固定 origin 提供入口与相对资产，MIME 与缓存头正确", async () => {
    const root = await workspace();
    const route = routeWith();
    const host = route.mount({ appId: "g-0b5c16e7f1e9", workspace: root });

    const page = await route.handle(new Request(panelWorkUrl(host, "canvas/index.html")));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toBe("<h1>panel</h1>");

    const css = await route.handle(new Request(panelWorkUrl(host, "canvas/style.css")));
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toBe("body{color:red}");

    const json = await route.handle(new Request(panelWorkUrl(host, "canvas/sub/deep.json")));
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(await json.json()).toEqual({ ok: true });
  });

  it("host 由作品 id 决定（跨启动稳定），不同作品互相隔离", async () => {
    const root = await workspace();
    const route = routeWith();
    const hostA = route.mount({ appId: "g-0b5c16e7f1e9", workspace: root });
    const hostB = route.mount({ appId: "g-ff05d72161ae", workspace: root });
    expect(hostA).toBe(panelWorkHost("g-0b5c16e7f1e9"));
    expect(hostB).not.toBe(hostA);
    // 未挂载的 host（= 别的作品/别的 app 生成过的地址）一律 404，不会串到 A 的工作区
    expect((await route.handle(new Request(panelWorkUrl("w-g-ffffffffffff", "canvas/index.html")))).status).toBe(404);
    route.unmount("g-0b5c16e7f1e9");
    expect(route.has("g-0b5c16e7f1e9")).toBe(false);
    expect((await route.handle(new Request(panelWorkUrl(hostA, "canvas/index.html")))).status).toBe(404);
  });

  it("拒绝越界路径（含 %2F 夹带与跨盘符段）", async () => {
    const root = await workspace();
    const route = routeWith();
    const host = route.mount({ appId: "g-abc", workspace: root });
    // 点段（`..` / `%2e%2e`）在 URL 解析阶段就被规范化掉，结果仍落在挂载根内：
    // 拿到的是工作区里的文件，而不是上级目录——这不是「漏了」，是没有可漏之处。
    const collapsed = await route.handle(new Request(`pidesktop-file://${host}/../secret.txt`));
    expect(collapsed.status).toBe(200);
    expect(await collapsed.text()).toBe("outside");
    // 编码过的分隔符：解析层就拒
    expect((await route.handle(new Request(`pidesktop-file://${host}/canvas%2F..%2F..%2Fsecret.txt`))).status).toBe(404);
    expect((await route.handle(new Request("pidesktop-file://preview/D%3A%2Fws/canvas/index.html"))).status).toBe(404);
    // 盘符段（Windows 特有）：实测 `resolve(root, "C:foo.txt")` 在**同盘**时只贡献相对名（
    // 仍落在挂载根内），换盘符才会跑到根外、由包含校验拦下（跨盘时 relative 返回绝对路径）。
    // 这里钉的是「不会因为盘符段就跑出根」这个结论。
    const driveRelative = await route.handle(new Request(panelWorkUrl(host, "C:foo.txt")));
    expect(driveRelative.status).toBe(404);
  });

  it("不跟随指向工作区外的符号链接", async (context) => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "pidesktop-panel-out-"));
    await writeFile(join(outside, "leak.txt"), "leak");
    try {
      await symlink(join(outside, "leak.txt"), join(root, "canvas", "link.txt"));
    } catch {
      context.skip();
      return;
    }
    const route = routeWith();
    const host = route.mount({ appId: "g-abc", workspace: root });
    expect((await route.handle(new Request(panelWorkUrl(host, "canvas/link.txt")))).status).toBe(403);
  });

  it("目录落到 index.html；未知扩展名 415", async () => {
    const root = await workspace();
    const route = routeWith();
    const host = route.mount({ appId: "g-abc", workspace: root });
    expect(await (await route.handle(new Request(panelWorkUrl(host, "canvas")))).text()).toBe("<h1>panel</h1>");
    await writeFile(join(root, "canvas", "data.bin"), "binary");
    expect((await route.handle(new Request(panelWorkUrl(host, "canvas/data.bin")))).status).toBe(415);
  });
});

describe("PanelProtocolRoute 虚拟端点", () => {
  it("GET 读状态（不缓存），HEAD 无 body", async () => {
    const root = await workspace();
    const route = routeWith();
    const host = route.mount({ appId: "g-abc", workspace: root });
    const url = panelWorkUrl(host, `canvas/${PANEL_STATE_ENDPOINT}`);
    const response = await route.handle(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ sessions: 1 });
    const head = await route.handle(new Request(url, { method: "HEAD" }));
    expect(await head.text()).toBe("");
  });

  it("POST 白名单动作带上作品 id（窗口定位靠它，不靠 Referer）", async () => {
    const root = await workspace();
    const actions: PanelRequest[] = [];
    const route = new PanelProtocolRoute({
      state: () => null,
      action: (request, context) => {
        expect(context.appId).toBe("g-abc");
        actions.push(request);
        return true;
      }
    });
    const host = route.mount({ appId: "g-abc", workspace: root });
    const response = await route.handle(
      new Request(panelWorkUrl(host, "canvas/__pidesktop_state.json"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resize", width: 300, height: 200 })
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, action: "resize" });
    expect(actions).toEqual([{ action: "resize", width: 300, height: 200 }]);
  });

  it("非法动作 / 白名单之外 / 拒绝的动作都是 403，超大请求体 413，其它方法 405", async () => {
    const root = await workspace();
    const route = new PanelProtocolRoute({ state: () => null, action: () => false });
    const host = route.mount({ appId: "g-abc", workspace: root });
    const url = panelWorkUrl(host, PANEL_STATE_ENDPOINT);
    const post = (body: string): Promise<Response> =>
      route.handle(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }));
    expect((await post("{}")).status).toBe(403);
    expect((await post(JSON.stringify({ action: "delete-everything" }))).status).toBe(403);
    expect((await post(JSON.stringify({ action: "close" }))).status).toBe(403);
    expect((await post(`{"action":"close","pad":"${"x".repeat(5000)}"}`)).status).toBe(413);
    expect((await route.handle(new Request(url, { method: "DELETE" }))).status).toBe(405);
  });

  it("量测页是平台自带页面（不读作品文件），且端点优先于同名真实文件", async () => {
    const root = await workspace();
    const route = routeWith();
    const host = route.mount({ appId: "g-abc", workspace: root });
    const measure = await route.handle(new Request(panelWorkUrl(host, `canvas/${PANEL_MEASURE_PAGE}`)));
    expect(measure.status).toBe(200);
    expect(measure.headers.get("content-type")).toContain("text/html");
    expect(await measure.text()).toBe(PANEL_MEASURE_HTML);
    // 作品里真有个同名文件时端点优先（与状态端点同一取舍，记为已知行为）
    await writeFile(join(root, "canvas", PANEL_MEASURE_PAGE), "<p>mine</p>");
    expect(await (await route.handle(new Request(panelWorkUrl(host, `canvas/${PANEL_MEASURE_PAGE}`)))).text()).toBe(PANEL_MEASURE_HTML);
  });
});

describe("PanelProtocolRoute 与 theme / preview 两条既有通路互不干扰", () => {
  it("theme 与 preview 的 URL 一律不被面板路由接管", async () => {
    expect((await get("pidesktop-file://theme/current/a.png")).status).toBe(404);
    expect((await get("pidesktop-file://preview/D%3A%2Fws/a.png")).status).toBe(404);
    // 404 而 500/200 才是关键：说明它既没误挂载也没抛错
  });
});
