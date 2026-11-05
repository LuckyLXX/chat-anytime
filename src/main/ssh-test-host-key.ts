// 测试辅助：为真实 ssh2 e2e 服务端生成 host key（仅测试与测试工具使用）。
//
// 为什么需要它：ssh2 的 `utils.generateKeyPairSync("ed25519")` 偶发产出无法解析的
// OpenSSH 私钥——本机实测 3000 次里 11 次抛 "Cannot parse privateKey: Malformed
// OpenSSH private key"（约 0.37%，与并发无关，重试一次必定恢复）。三个 ssh e2e 文件
// （host-test / sftp / window-change）每次运行共生成 5 个 host key，直接调用意味着
// 全量 `npm test` 每轮约有 2% 概率随机转红（2026-11-04 发版前实测踩到一次：单跑该文件
// 5 次全绿、全量跑第 1 例转红）。这里生成后立刻用 `utils.parseKey` 自检，坏的重试；
// 顺带把公钥 blob 一起返回，免得每个用例各自 parseKey。
import { utils } from "ssh2";

const MAX_ATTEMPTS = 5;

export interface TestHostKey {
  /** OpenSSH 格式私钥，直接塞给 `new Server({ hostKeys: [private] })`。 */
  private: string;
  /** RFC 4253 公钥 blob（ssh2 的 known_hosts 指纹就是按它算的）。 */
  public: Buffer;
}

export function makeTestHostKey(): TestHostKey {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const privateKey = utils.generateKeyPairSync("ed25519").private;
    const parsed = utils.parseKey(privateKey);
    if (!(parsed instanceof Error)) {
      return { private: privateKey, public: parsed.getPublicSSH() };
    }
  }
  throw new Error(`ssh2 连续 ${MAX_ATTEMPTS} 次生成不出可解析的 ed25519 host key`);
}
