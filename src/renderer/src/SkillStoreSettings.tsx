import { RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { SkillStoreSort } from "../../shared/protocol";
import { SkillStoreBrowser } from "./components/SkillStoreBrowser";
import { useDesktopStore } from "./store";

/**
 * 设置页「Skill 商店」tab（公开 SkillHub，2026-11-04）。
 *
 * 本文件只保留**公开商店专属**的头部（标题 / 安装作用域 / 刷新）；浏览、详情、
 * 安装确认、卸载全部在共用的 `SkillStoreBrowser` 里，与「内网 Skill 商店」共用一套。
 * 主题钩子：`data-pane="skill-store"`；控件 `skill-store-refresh` / `-scope` +
 * browser 内的 `skill-store-search|-category|-sort|-top|-page|-open|-install|
 * -confirm-install|-uninstall|-close-detail`。
 */

const SORT_OPTIONS: { value: SkillStoreSort; label: string }[] = [
  { value: "score", label: "综合评分" },
  { value: "downloads", label: "下载量" },
  { value: "stars", label: "收藏数" },
  { value: "updated_at", label: "最近更新" }
];

export function SkillStoreSettings(): ReactNode {
  const skillStore = useDesktopStore((state) => state.skillStore);
  const workspace = useDesktopStore((state) => state.snapshot.workspace);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [refreshTick, setRefreshTick] = useState(0);

  return (
    <div className="resource-page skill-store-page" data-pane="skill-store">
      <header className="resource-page-head">
        <span className="resource-page-title">
          <strong>Skill 商店</strong>
          <small>来自 SkillHub（api.skillhub.cn）的公开技能；安装后在「技能与工具」里管理启用</small>
        </span>
        <span className="resource-page-actions">
          <label className="skill-store-scope">
            <span>安装到</span>
            <select
              aria-label="安装作用域"
              data-control="skill-store-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value === "project" ? "project" : "global")}
            >
              <option value="global">用户全局 pidesktop-skills/</option>
              <option value="project" disabled={!workspace}>{workspace ? "仅当前项目 .pidesktop-skills/" : "仅当前项目（未打开工作区）"}</option>
            </select>
          </label>
          <button
            className="secondary-button compact-button"
            type="button"
            data-control="skill-store-refresh"
            disabled={skillStore.listLoading}
            onClick={() => setRefreshTick((tick) => tick + 1)}
          ><RefreshCw size={13} className={skillStore.listLoading ? "spinning" : undefined} />刷新</button>
        </span>
      </header>
      <div className="resource-page-body">
        <SkillStoreBrowser
          source="public"
          state={skillStore}
          scope={scope}
          showTop
          sortOptions={SORT_OPTIONS}
          defaultSort="score"
          emptyHint="没有匹配的技能。换个关键词，或点「热门 Top 50」看看大家都在用什么。"
          refreshTick={refreshTick}
          onPatch={(next) => useDesktopStore.setState((state) => ({ skillStore: { ...state.skillStore, ...next } }))}
        />
      </div>
    </div>
  );
}
