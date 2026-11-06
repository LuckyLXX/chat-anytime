/**
 * 安装版单实例守卫（2026-11-07）。
 *
 * 用户报障：双击安装后的 exe 图标会**再起一个** ChatAnyTime，而不是回到已经开着的
 * 窗口。两个实例共享同一个 userData —— settings / credentials / 会话索引 / 内置浏览器
 * 分区都是同一批文件，所以这不是「多一个窗口」的观感问题，而是后写覆盖先写的真实
 * 数据损坏面（踩坑记录 T7 里记的就是这个风险）。
 *
 * **为什么只在 app.isPackaged 时启用**：单实例锁按 userData 目录互斥，而 dev 版与
 * 安装版共用同一个数据目录（`%APPDATA%\ChatAnyTime` 与 `%APPDATA%\chat-anytime` 在
 * Windows 上是同一个目录，productName 与 package name 大小写不同而已）。全版本启用
 * 会挡住「`npm run dev` 与安装版并行」的日常开发流程，因此用户 2026-11-07 明确选择
 * 「仅安装版启用」。dev 自己开两个实例仍不会被拦——那是开发者的手动行为，不是
 * 「双击安装图标」这条路径；真的要并行两个安装版，用 `--user-data-dir` 分开即可
 * （锁也跟着 userData 走，打包冒烟测试正是靠这一点与日常实例隔离）。
 *
 * **实测事实（electron 43.2.0，2026-11-07 独立探针，勿凭记忆改回去）**：
 *  1. 次实例 `requestSingleInstanceLock()` 返回 false 之后调用 `app.quit()`，
 *     **whenReady 仍然会 resolve**（探针记录 `ready windows=0`）。也就是说 quit 不足
 *     以保证「不初始化」；`app.exit(0)` 才是立即终止（不触发 before-quit / will-quit，
 *     其后的代码也不再执行）。次实例用 exit，主实例侧仍保留 whenReady 守卫做纵深防御。
 *  2. 主实例主线程被阻塞时，次实例的 `requestSingleInstanceLock()` 会同步等待到主线程
 *     空出来（探针：主实例阻塞 4s，次实例 3.1s 才拿到 false），随后 `second-instance`
 *     在主实例的 ready 回调执行完之后才分发。事件在 ready 之前到达仍属可能（不同平台/
 *     时序），而 ready 之前调 `createWindow()` 会抛错，所以启动期到达的激活请求必须
 *     排队，等启动完成后补发。
 */

export interface SingleInstanceHost {
  /** `app.isPackaged`：只有安装版启用（dev 与安装版并行是日常流程）。 */
  isPackaged: boolean;
  /** `app.requestSingleInstanceLock()`，同步返回是否抢到锁。 */
  requestLock: () => boolean;
  /** `app.exit(code)`：次实例立即结束，不跑初始化，也不触发退出钩子。 */
  exit: (code: number) => void;
  /** `app.isReady()`：ready 之前不能创建/显示窗口。 */
  isReady: () => boolean;
  /** `app.on("second-instance", …)` 的注入点。 */
  onSecondInstance: (listener: () => void) => void;
  /** 唤回主界面（index.ts 的 `showMainWindow`：有窗口就前置，没有就重建）。 */
  activate: () => void;
}

export interface SingleInstanceGuard {
  /** false = 本进程是第二个实例，已请求退出；调用方不得再做任何初始化。 */
  primary: boolean;
  /** 启动完成后调用一次：补发启动期间排队的激活请求（幂等）。 */
  flushPendingActivation: () => void;
}

const noop = (): void => {};

export function installSingleInstanceGuard(host: SingleInstanceHost): SingleInstanceGuard {
  // dev：完全不碰锁，保持「npm run dev 与安装版并行」的日常流程。
  if (!host.isPackaged) return { primary: true, flushPendingActivation: noop };

  if (!host.requestLock()) {
    // 第二个实例：立刻结束。不注册 second-instance（本进程不该被唤起），也不做任何
    // 初始化——settings / runtime / 窗口 / 托盘都不许碰。
    host.exit(0);
    return { primary: false, flushPendingActivation: noop };
  }

  // 启动期（ready 之前）到达的激活请求：只记一个标记，等窗口建好再补发。
  let pending = false;
  host.onSecondInstance(() => {
    if (!host.isReady()) {
      pending = true;
      return;
    }
    host.activate();
  });

  return {
    primary: true,
    flushPendingActivation: () => {
      // ready 之前不补发：启动完成前 `showMainWindow()` 里的 createWindow 会抛错。
      if (!pending || !host.isReady()) return;
      pending = false;
      host.activate();
    }
  };
}
