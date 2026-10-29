# Paper Mode · 论文写作模式

[![CI](https://github.com/torfqy/dsh-paper-mode/actions/workflows/ci.yml/badge.svg)](https://github.com/torfqy/dsh-paper-mode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 把 Overleaf 搬进 DeepSeek Harness：左边写 LaTeX，中间看英文排版，右边看**同一篇论文的中文排版**，最右和写作助手对话。四栏并列，双击互相定位。

<img src="docs/media/zh-page1.png" width="46%" alt="中文排版第 1 页"> <img src="docs/media/en-page1.png" width="46%" alt="英文排版第 1 页">

> 左边是英文版，右边是同一份源码翻译后**重新排版**出的中文版：公式、图表编号、参考文献编号完全一致。

## 它解决什么

用 LaTeX 写论文时，中文母语作者最常卡在两件事上：读自己写出来的英文要反复切换注意力，改一句话要等排版才知道效果；以及"这段到底在哪一行"的来回找。

Paper Mode 把这两件事压进同一屏：

- **中文版是排出来的，不是机翻的文本框**。翻译发生在源码层，然后重新跑一遍 XeLaTeX，所以得到的是真正的第二份 PDF；
- **排版和源码双向可达**。双击 PDF 任意位置跳到源码那一行，光标在源码里移动时 PDF 跟着高亮。

## 功能

### 四栏并列工作台

源码编辑器 ｜ 英文排版 ｜ 中文对照排版 ｜ 写作助手。三条分隔条可拖动，任何一栏可收起，布局记在本地。

### 双语同构排版（核心）

不是把 PDF 文本抽出来机翻，而是：

1. 扫描 `.tex`，切出「自然语言」片段，把公式、`\cite`、`\ref`、`\label`、图片、换行替换成不可翻译的占位符；
2. 只把散文交给模型，逐段翻译，**校验占位符与命令的数量**，不符就重试、降级、最后保留原文；
3. 把译文拼回源码，注入中文导言区，再跑一遍 XeLaTeX。

于是中文版和英文版共用同一套版式、同一套编号、同一批浮动体位置。

### 双向定位（SyncTeX）

- **PDF → 源码**：双击页面任意位置，编辑器跳到对应行并选中（跨文件也能跳）；
- **源码 → PDF**：光标移动，英文页滚到对应位置并闪一个高亮框，标出这句话的范围。

用的是真正的 SyncTeX（`-synctex=1`），编译开销约 0.05 秒。点击参考文献会自动落到 `\bibliography{...}` 那一行；中文版的行号偏移也做了扣除，点中文版标题和点英文版标题回到同一行。

### PDF 可以直接选中

每页位图之上盖了一层透明文字层（来自 `pdftotext -bbox-layout` 的行框，按页面等比缩放并用 `scaleX` 对齐），拖选、双击选词、`Ctrl+C` 都和真 PDF 阅读器一致。选中的内容可以一键发给助手。

### 编译设置

像 Overleaf 的 Compile settings：编译器（XeLaTeX / pdfLaTeX / LuaLaTeX）、主文件、页面清晰度、快速模式、出错即停、参考文献策略、中文宏包、自动编译延迟。

### 三层缓存

内容没改再点编译是 **0 毫秒**：构建签名命中就直接复用上次的页图；翻译记忆存在 Harness home，跨项目、跨重启复用同一段落；页图按 PDF 内容哈希缓存。

### 写作助手

助手能看到当前文件、你选中的源码、以及你从 PDF 里选中的文字。润色 / 压缩 / 审稿 / 译成中文四个快捷动作直接作用于选区，回复里的 LaTeX 代码块可以一键替换选中或追加到末尾。

## 安装

### 前置条件

- **DSH** ≥ `0.2.1-rc.2`
- **Node.js** ≥ 22
- **TeX**：需要 `xelatex`、`bibtex`、`pdftoppm`、`pdfinfo`、`pdftotext`、`synctex`
  - Windows：MiKTeX 或 TeX Live
  - macOS：MacTeX
  - Linux：`texlive-xetex` + `texlive-lang-chinese` + `poppler-utils`
- **中文字体**：Windows/macOS 用系统自带字体；Linux 建议装 `fonts-noto-cjk`。都没有也能用——会自动回退到 TeX 自带的 Fandol 字体（字形朴素，但不会失败）

### 安装为 DSH 插件

```bash
git clone https://github.com/torfqy/dsh-paper-mode.git
```

然后在 DSH Web GUI 的插件管理里，选择从**本地目录**安装这个 bundle，目录指向：

```
dsh-paper-mode/paper-mode
```

命令行等价形式：

```bash
dsh plugin --profile web add link:~/dsh-paper-mode/paper-mode
```

安装后刷新页面，左侧栏会出现「论文写作」图标。

### 验证

打开工作台 → 点「打开文件夹」选 `examples/demo-paper`（或任何含 `main.tex` 的目录）→ 英文栏几秒内出图，中文栏随后补上。第一次编译中文会逐段翻译，需要十几秒。

## 使用

| 操作 | 说明 |
|---|---|
| 停笔 | 1.4 秒后自动保存并重编（可在设置里关） |
| `Ctrl+Enter` | 立即编译 |
| `Ctrl+S` | 保存 |
| 双击 PDF | 跳到对应源码行 |
| 移动光标 | 英文页跟随高亮（设置里可关） |
| 选中 PDF 文字 | 内容会随下一条消息发给助手 |

## 配置

| 环境变量 | 作用 |
|---|---|
| `PAPER_MODE_MODEL` | 覆盖翻译与对话用的模型，格式 `provider/model`，例如 `deepseek-official/deepseek-flash`。默认跟随 DSH 的会话默认模型 |

其余选项都在工作台的 ⚙ 面板里，存在浏览器本地，改「编译器 / 宏包 / dpi / 快速模式 / 主文件」会立刻重编一次。

## 它是怎么工作的

```
浏览器半 (client.js)                     宿主半 (index.js)
├ 四栏 UI，纯 React.createElement        ├ /api/dsh-paper/* 路由
├ 编辑器 / 页图 / 文字层 / 对话流         ├ 增量同步构建树 + 条件编译
└ 通过文档相对路径调宿主                  ├ 分段翻译 + 校验 + 共享翻译记忆
                                          ├ pdftoppm 栅格化、pdftotext 文字层
                                          └ synctex 双向定位
```

完整设计（取舍、数据流、缓存键、已知边界）见 [docs/design.md](docs/design.md)。

## 已知限制

| 限制 | 说明 |
|---|---|
| 表格内容不翻译 | `tabular` / `longtable` 整段保留原文，数字为主、翻译收益低 |
| 中文版页数与英文版不同 | 中文更紧凑，逐页对照是「第 N 页对第 N 页」，不是逐行对齐 |
| 图内文字不翻译 | 图是位图，需要 OCR |
| 中文版行号是推算的 | 靠注入的导言区行数反推，若模型在译文里插入了空行，后面的行号会偏 |
| 路由未接宿主鉴权 | 仅监听本机 + 同源校验；多用户部署前应接上 Harness 的浏览器鉴权 |
| 编辑器是 textarea | 行号、Tab、快捷键有，语法高亮和补全没有 |

## 开发

```bash
# 单元测试（零依赖）
node --test paper-mode/test/tex.test.mjs

# 浏览器半的挂载测试（jsdom + React）
cd paper-mode/test && npm install && node mount.test.mjs
```

`paper-mode/` 是插件包本体，没有任何运行时依赖——Harness 直接以纯 JavaScript 提供这些文件。

## 许可证

[MIT](LICENSE)
