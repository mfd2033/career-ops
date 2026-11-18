---
version: alpha
name: career-ops web
description: career-ops 的本地优先求职工作台：暖中性底色、单一焦橙强调色、衬线体编辑风格标题，明暗双主题。

colors:
  brand: hsl(26 73% 51%)
  brand-200: hsl(33 100% 60%)
  brand-foreground: hsl(24 30% 12%)
  brand-soft: hsl(26 73% 51% / 0.12)
  brand-text: hsl(26 80% 36%)
  background: "#f7f6f3"
  surface: "#ffffff"
  surface-hover: "#efeeea"
  border: hsl(40 9% 86%)
  foreground: hsl(30 10% 11%)
  muted: hsl(35 9% 34%)
  faint: hsl(35 7% 42%)
  landing: "#59592a"
  pre-bg: "#f2f1ed"

typography:
  sans:
    fontFamily: Inter
  serif:
    fontFamily: Instrument Serif
  display:
    fontFamily: Instrument Serif
  mono:
    fontFamily: ui-monospace

rounded:
  xs: 0.125rem
  sm: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  "2xl": 1rem

spacing:
  base: 0.25rem

components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.brand-foreground}"
    rounded: "{rounded.md}"
  button-primary-hover:
    backgroundColor: "{colors.brand-200}"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
  button-outline-hover:
    backgroundColor: "{colors.surface-hover}"
  button-ghost-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.foreground}"
  badge:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
  nav-active:
    backgroundColor: "{colors.brand-soft}"
    textColor: "{colors.brand-text}"
    rounded: "{rounded.md}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
  wordmark:
    textColor: "{colors.landing}"
    typography: "{typography.display}"
  caption:
    textColor: "{colors.faint}"
  prose-code:
    backgroundColor: "{colors.pre-bg}"
    typography: "{typography.mono}"
  prose-quote:
    textColor: "{colors.muted}"
    typography: "{typography.serif}"
  sidebar-expanded:
    width: 15rem
  sidebar-collapsed:
    width: 4rem
---

## Overview

career-ops web 是本地优先求职流水线的浏览器端。它和 CLI 读写同一批文件，每个页面都是真实数据的视图，没有演示用假数据。

视觉方向走编辑型工作台，与常见 SaaS 控制台区分开：底色用带暖调的纸白替代冷灰，焦橙只承担选中与进行中的状态，Instrument Serif 负责标题与主视觉，Inter 保证密集表格可读。明暗两套主题都是完整实现，暗色取中性近黑，不带蓝调。

## Colors

焦橙在明暗两套主题下取值相同，只出现在一个主操作、导航当前项、聚焦环和强调底色上。

同一个橙在浅色底上做小字号文字达不到对比度要求，所以小字与徽章改用 `brand-text`：浅色下加深，暗色下回到原色。`brand` 本身留给强调、图标、底色蒙层和 24px 以上的标题。

评分与等级不使用焦橙，走 good / warn / bad 三档语义色，避免与强调色抢注意力。

## Themes

主题切换靠文档根节点上的 `dark` 类实现，且在首帧绘制前写入。`brand`、`brand-200`、`brand-foreground`、`brand-soft` 两套主题取值相同，只在上方列出一次；下表是同一批语义令牌在另一主题下的取值。

| Token | Light | Dark |
| --- | --- | --- |
| background | #f7f6f3 | #0a0a0a |
| surface | #ffffff | #161616 |
| surface-hover | #efeeea | #232323 |
| border | hsl(40 9% 86%) | #262626 |
| foreground | hsl(30 10% 11%) | #fafafa |
| muted | hsl(35 9% 34%) | #a1a1aa |
| faint | hsl(35 7% 42%) | #8b8b95 |
| landing | #59592a | #e4e2d0 |
| brand-text | hsl(26 80% 36%) | hsl(26 73% 51%) |
| pre-bg | #f2f1ed | #111111 |

## Typography

四个字族各管一件事：Inter 管界面与正文；Instrument Serif 含常规与斜体两档，只用于页面标题、首页主文案、产品字标和引文；等宽位使用系统等宽栈，用于命令、日志与代码。

衬线体只出现在展示型位置。正文、标签、表格单元格和数字留在 Inter，可比较列里的数字用等宽数字，保证跨行对齐。

报告与简历的 Markdown 在统一的 prose 作用域内渲染，标题层级、代码样式和表格线都由它给出，页面不改写 prose 子元素。

## Layout

桌面端是固定左栏加单一滚动内容列。左栏吸附视口、可收成图标条，小屏断点下换成抽屉式导航。导航项来自同一份列表，侧栏与抽屉不会各写一套。

横向裁剪由内容列负责，宽表在表内滚动，整页宽度不受影响。内容列内各分区自定义纵向节奏，页面外层只管外边距。

层级顺序固定：左栏压在页面内装饰层之上，从栏边探出的 tooltip 不会被盖住；对话框、助手控制台等固定浮层再压在左栏之上。tooltip 是最高一层的可交互元素。

## Elevation & Depth

深度由 1px 边框与表面透明度给出。卡片是页面底色上叠加半透明 surface，次级面板再降一档；hover 只抬升表面色，阴影不动。

阴影只给真正的浮层：tooltip 与浮动对话框，取标准的小、中两档。任何表面都不同时使用重阴影和半透明填充。

## Shapes

圆角取 Tailwind 的档位，按角色分配：控件用中档，输入框与小面板用大档，内容面板与统计块用 2xl 档，骨架块与行内芯片用大档。

全圆胶囊只留给首页主行动按钮和快速评估输入条。普通控制按钮保持带圆角的矩形，胶囊因此只出现在这两个强调位。

## Components

**Button**：四个变体（primary、outline、secondary、ghost）与三个尺寸（default、sm、icon）出自同一份 `cva` 定义。primary 是焦橙实底配 `brand-foreground` 文字；outline 与 secondary 是描边表面；ghost 只在 hover 时出现底色。所有变体共用同一个聚焦环，小视口下最小高度抬到 44px。

**Badge**：评分与状态胶囊，五档 tone（good、warn、bad、info、muted）。变化的只有 tone，内距、字号和等宽数字由组件固定。

**列表四态**：加载、骨架、空态、错误横幅一律取自共用组件。页面不自行拼一套 spinner、虚线空框或红条。

**输入框**：焦点入口只有两个。直接输入框与文本域用 field 类；带图标的容器型搜索框把焦点样式挂在外层容器。两条路径最终都落在焦橙聚焦环上，没有第二种焦点色。

**Sidebar**：展开与收起两个宽度见组件令牌。收起态只留图标，标签通过 tooltip 浮现，宽度与内距的过渡共用一条缓动曲线。

## Do's and Don'ts

- 新增列表页一律先接共用的加载、骨架、空态、错误组件。
- 小字号文字与徽章用 `brand-text`；`brand` 用于强调、图标、底色蒙层和 24px 以上标题。
- 输入框焦点只走 field-styles 的两条入口。
- 可比较的数量、金额、时长、天数列右对齐并启用等宽数字；行号与日期当标识符处理，保持左对齐。
- 不用焦橙表示评分、等级或状态。
- 不给 Button 增加胶囊变体，也不给普通控件套全圆角。
- 不引入新的焦点色（例如 sky 系），不写只绑定 `focus:` 而不带 `focus-visible:` 的聚焦环。
- 页面入场动效的填充模式不得写成 `both` 或 `forwards`：残留的 transform 会让包装层成为所有 `position: fixed` 子元素的包含块，长页面上的页内弹窗会被拉到视口外。
- 不为单个页面手写降级动效，全局的 reduced-motion 规则已经覆盖动画与过渡时长。