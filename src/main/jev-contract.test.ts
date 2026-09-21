import { describe, expect, it } from "vitest";
import { validateChoice } from "./jev-action-space.js";
import { detectSensitivePage } from "./jev-client.js";
import { normalizeJev } from "./settings.js";

/**
 * TypeSafe（Jev）**契约**回归网：拿官方文档的响应形状去撞我们自己的校验器。
 *
 * 为什么值得单独一个文件：真实端到端（连 api.typesafe.ai 跑一次）需要付费密钥、
 * 且内网环境本就不可达（那正是这个开关默认关闭的原因）。所以能离线守住的只有
 * 「我们对协议的理解」这一层——契约一旦漂移，本地测试若只喂理想样本会全绿，
 * 而真机上表现为「每步都报无效响应、什么都不做」。
 *
 * 样本形态取自官方 API 文档（POST /v1/systemone）：
 *   { model, answers: { <问名>: {type, choice, confidence, probabilities} }, usage }
 */

const DOC_CHOICE_RESPONSE = {
  type: "choice",
  choice: "billing",
  confidence: 1,
  probabilities: { billing: 1, bug: 0, account: 0 }
};

describe("TypeSafe 响应契约", () => {
  it("接受官方文档里的 choice 响应", () => {
    expect(validateChoice(DOC_CHOICE_RESPONSE, ["billing", "bug", "account"]).choice).toBe("billing");
  });

  it("拒绝 noul / score 形状（本通路只问 choice）", () => {
    // 上游若回 noul（{noul: 0.98}）或 score（{score: 1.6, legend: {...}}），
    // 校验必须拒绝——宁可不执行，也不能把「概率」当成「操作」用。
    expect(() => validateChoice({ type: "noul", noul: 0.98 }, ["billing", "bug"])).toThrow(/无效的选择/);
    expect(() => validateChoice({ type: "score", score: 1.6, confidence: 1, legend: { 0: "低", 1: "高" }, probabilities: { 0: 0.2, 1: 0.8 } }, ["0", "1"])).toThrow(/无效的选择/);
  });

  it("拒绝上游把编号换成自造值的情况（模型不能发明目标）", () => {
    expect(() => validateChoice({ ...DOC_CHOICE_RESPONSE, choice: "e99" }, ["billing", "bug", "account"])).toThrow(/无效的选择/);
  });
});

describe("敏感页启发式的取向（宁可早停，不可越权代劳）", () => {
  it("登录/验证码/支付页面一律停下", () => {
    for (const text of ["请先登录后继续", "请输入短信验证码", "收银台 · 确认支付", "Sign in with Google", "Verify your identity"]) {
      expect(detectSensitivePage({ pageText: text }), text).toBeTruthy();
    }
  });

  it("普通页面上的「登录」入口不该让循环停下", () => {
    // 反向误判比漏判更糟：几乎每个站点导航栏都有「登录」链接，裸匹配会让 Jev
    // 在正常页面上直接罢工。所以只匹配带语境的写法（请/先/后/账号）与强信号词。
    for (const text of ["首页 商品 价格 登录 注册", "Sign in", "Zurich to London flights", "登录 | 我的账户"]) {
      expect(detectSensitivePage({ pageText: text }), text).toBeUndefined();
    }
  });
});

describe("Jev 配置的缺省语义（内网零成本）", () => {
  it("未显式开启时不落盘任何配置", () => {
    expect(normalizeJev({ enabled: false })).toBeUndefined();
    expect(normalizeJev({})).toBeUndefined();
  });

  it("开启后用官方默认端点与模型补齐缺失字段", () => {
    expect(normalizeJev({ enabled: true })).toMatchObject({
      enabled: true,
      baseUrl: "https://api.typesafe.ai/v1",
      model: "jev-latest",
      maxSteps: 30,
      autoPilot: true
    });
  });
});
