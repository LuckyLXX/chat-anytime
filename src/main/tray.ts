/**
 * 托盘图标（main 进程，懒创建）。
 *
 * 关闭主窗口不再退出应用（用户 2026-09-26 明确：关闭 = 退到后台，让正在跑的
 * 会话与面板继续活着），因此必须有一个「回来」和「真退出」的入口，否则用户
 * 会以为应用死了、或者找不到退出的地方。托盘就是那个常驻入口。
 *
 * 懒创建的理由：绝大多数用户从不用托盘，启动即挂一个图标是多余的打扰；而只要
 * 用户真的隐藏过一次主窗口，这时建图标就正好是他需要它的时候。
 *
 * 图标创建失败不抛错——托盘是便利设施，不能因为它挡住「隐藏窗口」这件事
 * （那时面板窗口仍可唤回主界面）。
 */

import { Menu, Tray } from "electron";

export interface TrayController {
  /** 懒创建（幂等）；失败静默——调用方不必关心。 */
  ensure(): void;
  /**
   * 托盘是不是真的建起来了。
   *
   * 调用方必须问这一句：隐藏主窗口后任务栏也没有按钮了，托盘是唯一的回路；
   * 托盘建不起来时隐藏就等于把用户关在外面（应用还在跑，但他回不去了）。
   */
  isActive(): boolean;
  dispose(): void;
}

export interface TrayControllerDeps {
  iconPath: string;
  tip: string;
  onOpen: () => void;
  onQuit: () => void;
}

export function createTrayController(deps: TrayControllerDeps): TrayController {
  let tray: Tray | undefined;

  return {
    ensure(): void {
      if (tray) return;
      try {
        const created = new Tray(deps.iconPath);
        created.setToolTip(deps.tip);
        created.setContextMenu(
          Menu.buildFromTemplate([
            { label: "打开主界面", click: () => deps.onOpen() },
            { type: "separator" },
            { label: "退出 ChatAnyTime", click: () => deps.onQuit() }
          ])
        );
        // 左键单击 = 回到主界面（与菜单第一项同义，用户不必先右键）。
        created.on("click", () => deps.onOpen());
        tray = created;
      } catch {
        tray = undefined;
      }
    },
    dispose(): void {
      if (!tray) return;
      try {
        tray.destroy();
      } catch {
        /* 退出路径上不必计较 */
      }
      tray = undefined;
    },
    isActive(): boolean {
      return tray !== undefined;
    }
  };
}
