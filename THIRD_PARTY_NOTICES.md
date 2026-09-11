# 第三方声明（Third-Party Notices）

本软件包含以下第三方作品的衍生内容。按各自许可证要求在此声明。

---

## OpenPencil 设计风格语料

本软件的设计模式（Design Studio）内置 63 套「风格指南」设计知识语料，源自 OpenPencil：
- 上游项目：https://github.com/ZSeven-W/openpencil
- 语料路径：`crates/op-ai-skills/skills/style-guides/*.md`（63 套，共 704 KB）
- 许可证：MIT License
- 版权：Copyright (c) 2026 ZSeven—W

### 提取与转换方式

原始 `.md` **未随本软件分发**。仅通过构建脚本 `scripts/build-style-guides.mjs`
把它们转换成结构化摘要（digest），生成物为 `src/shared/design-guides.json`，
已入库供审阅。每套 digest 只保留：名称、平台、标签、一段风格摘要、≤5 条美学要点、
命名调色板 token、字体配对、字号档位，以及间距/圆角/字距/行高标尺
（单套 ≤1.4 KB，全部 63 套约 87 KB）。

相对于上游语料，转换过程中丢掉了绝大部分散文式指令、组件/图标/页面几何说明——
digest 是「参数摘录」，不是原文替代品。这属于对原作品的改编（adaptation），
因此同样适用上游的 MIT 许可证，并且：

- 保留版权声明与许可证全文（见下）；
- 不得移除本文件中的来源标注。

若需要完整的设计指导，请直接使用上游 OpenPencil 项目。

### MIT License（上游许可证全文）

```
MIT License

Copyright (c) 2026 ZSeven—W

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
