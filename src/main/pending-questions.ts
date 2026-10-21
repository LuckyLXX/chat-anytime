import type { QuestionRequest } from "../shared/protocol.js";

/**
 * 主进程侧的待决提问镜像，专供渲染端重载恢复。
 *
 * 为什么需要：`QuestionBroker` 活在 utility 进程里，提问请求只通过一次
 * `question` 推送交给渲染端；渲染端的 `questions` 数组是纯内存状态。
 * 开发态 Vite HMR、Ctrl+R、渲染进程崩溃恢复都会把它清空——面板消失后
 * 用户再也答不了，而工具仍在 broker 上永久等待（2026-10-21 实测：计划
 * 审查面板被 HMR 重载吞掉，`exit_plan_mode` 挂起 55 分钟且停止无效）。
 *
 * 镜像只管「渲染端还欠用户一个面板」的请求：收到 `question` 记入，
 * `question.dismiss` 移除；bootstrap 时整表回传，渲染端按 id 合并。
 * 真正的应答状态仍以 utility 的 QuestionBroker 为准，这里不参与裁决。
 */
export class PendingQuestionMirror {
  private requests: QuestionRequest[] = [];

  /** 记录/刷新一条待决提问；同 id 重复推送只保留最新一份。 */
  record(request: QuestionRequest): void {
    this.requests = [...this.requests.filter((item) => item.id !== request.id), request];
  }

  /** 提问已作答、被取消或会话销毁：从镜像移除。 */
  dismiss(id: string): void {
    this.requests = this.requests.filter((item) => item.id !== id);
  }

  /** 当前待决提问（副本，调用方不能改到镜像内部状态）。 */
  list(): QuestionRequest[] {
    return [...this.requests];
  }

  /** utility 进程退出：挂起请求已随进程消失，镜像必须同步清空。 */
  clear(): void {
    this.requests = [];
  }
}
