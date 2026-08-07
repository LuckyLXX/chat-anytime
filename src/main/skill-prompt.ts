const displayMarkerPattern = /^<!-- pidesktop-skill-display:([A-Za-z0-9_-]+) -->\r?\n/u;
const legacySkillPromptPattern = /^使用 Skill「([^」\r\n]+)」完成任务。\r?\n\r?\n首先调用 read 工具读取 Skill 文件：[^\r\n]+\r?\n\r?\n完整阅读后遵循其中的说明；其中的相对路径均以该 Skill 文件所在目录为基准。(?:\r?\n\r?\n用户要求：\r?\n([\s\S]*))?$/u;

export interface SkillPromptDisplay {
  name: string;
  instructions: string;
}

export function buildSkillPrompt(name: string, instructions: string, executionPrompt: string): string {
  const metadata = Buffer.from(JSON.stringify({ name, instructions }), "utf8").toString("base64url");
  return `<!-- pidesktop-skill-display:${metadata} -->\n${executionPrompt}`;
}

export function parseSkillPrompt(text: string): SkillPromptDisplay | undefined {
  const marker = displayMarkerPattern.exec(text);
  if (marker?.[1]) {
    try {
      const value = JSON.parse(Buffer.from(marker[1], "base64url").toString("utf8")) as Partial<SkillPromptDisplay>;
      if (typeof value.name === "string" && value.name.trim() && typeof value.instructions === "string") {
        return { name: value.name, instructions: value.instructions };
      }
    } catch {
      return undefined;
    }
  }

  const legacy = legacySkillPromptPattern.exec(text);
  if (!legacy?.[1]) return undefined;
  return { name: legacy[1], instructions: legacy[2] ?? "" };
}
