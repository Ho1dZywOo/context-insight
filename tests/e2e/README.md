# Insight 浏览器 E2E（Playwright）

真构建 + 真服务 + 真库（`prisma/e2e.db`）+ 真浏览器的全栈端到端测试。设计上承袭
opsbot web E2E 的成熟机制（webServer 引导 / browserConsole 验收门 / POM / teardown
不变量），但**不做 opsbot 式双层**：insight 是自含 Next.js + SQLite 应用，数据库即
受控夹具——全栈直跑就是最高价值层，API mock 只用于失败注入（`page.route` 定点，
见 resilience.spec.ts）。

## 运行

```bash
npm run test           # 一条命令全覆盖：vitest（ut + pipeline）→ 本套件（推荐入口）
npm run e2e           # 只跑本套件（首跑含 next build ~2min；复用 BUILD_ID 缓存秒过）
npm run e2e:headed    # 有头模式（可观赏）
npm run e2e:debug      # Playwright Inspector 步进调试
npm run e2e:report     # 打开 html 报告（trace/截图/录像/browser-console.log）
```

浏览器二进制：首次使用需 `npx playwright install chromium`（仓内无 lockfile，各机
自装；`scripts/run-tests.sh` 入口已带自愈补装）。

## 架构

```
playwright.config.ts          单 webServer：bash tests/e2e/boot/boot-server.sh
tests/e2e/
├── constants.ts              单一事实源：端口 / 夹具路径 / 关键 id / 工具常量
├── fixtures.ts               browserConsole 验收门（auto fixture）
├── global-setup.ts           播种 = 真实 HTTP 导入管线（即导入冒烟）
├── global-teardown.ts        端口回收不变量（防泄漏实例 fail-fast）
├── boot/boot-server.sh       e2e.db 重建 → 构建复用 → 隔离环境 → next start
├── fixtures/tool-bundle/     E2E 自有工具语料（e2e-tools01，见下）
├── support/
│   ├── env.ts                UI 等待预算（E2E_UI_TIMEOUT_MS 覆盖）
│   └── pom/                  页面对象：WorkbenchHome / RunWorkbench / ImportWizard
├── home.spec.ts              工作台首页：语料就位/类型分段/搜索/行下钻/设置页
├── import-journey.spec.ts    导入旅程：JSONL 首导（新行出现）+ bundle 重导（幂等）
├── run-workbench.spec.ts     Run 工作台：tab 矩阵/深链/?a 门/历史栈返回
├── turns-deep-link.spec.ts   搜索语法深链：tool:X / tool:X member:Y / 命中浮层
├── session-view.spec.ts      Solo 会话视图：同壳工作台 + Markdown 导出 + Perf
├── resilience.spec.ts        韧性：真 404 错误卡 + 500 注入不白屏
├── overview-tab.spec.ts      Overview：身份卡/指标瓦片/Tool Calls 分组列表
├── graph-tab.spec.ts         Graph：DAG SVG 节点标签 + 缩放工具条四钮
├── turns-player.spec.ts      Turns：角色筛选条计数真值/轮次播放器/走查推进
├── search-grammar.spec.ts    搜索语法：#N 直跳/role: 算子/零命中文案
├── context-tab.spec.ts       Context：增长曲线 + 图表模式切换 + 胶囊下钻档案弹窗
├── audit-tab.spec.ts         Audit：四域导航/默认 skill 域/workflow·run 目标行
├── skills-files-tab.spec.ts  Skills 斜杠调用行/Files 文件行全路径 + 搜索过滤
├── wire-replay-tab.spec.ts   Wire 结构面（无捕获不崩）+ Replay 播放推进
├── score-tab.spec.ts         Score：六维雷达/维度卡/成员切换/评分导出钮
├── recycle-bin.spec.ts       回收站全旅程：删除→回收站→恢复回流（自包一次性夹具）
├── upload-dialog.spec.ts     上传对话框：字段在场/取消可关
└── offline-export.spec.ts    离线 HTML 导出：下载 + file:// 往返离线内核起播
```

### 环境隔离（五件套）

| 隔离面 | 手段 |
| --- | --- |
| 数据库 | `prisma/e2e.db`，boot 期 migrations 重建（与 dev.db/test.db 物理隔离；run-to-run 确定性） |
| 端口 | 默认 21100（`INSIGHT_E2E_PORT` 可覆盖），避开 dev 21025 |
| HOME | `CONTEXT_INSIGHT_HOME=仓内 tmp/insight-e2e-home`（run-store/回收站/数据仓配置与真实家目录断开） |
| 日志 | `CONTEXT_LOG=0`（不写用户日志目录） |
| 启动器 | **不用 `./start.sh`**——它会杀本仓所有自家 next 实例（含用户在用的 21025）、写端口登记、装代理、开浏览器 |

注意 `.next/` 与用户日常实例共享（Turbopack 禁止 distDir 外置）：E2E 与 `./start.sh`
**串行使用**；并行跑会因重建抽掉运行中实例的产物。

### 播种即冒烟

`global-setup.ts` 在 webServer 健康后经**真实 HTTP 导入端点**播种语料（与 UI 向导同
一代码路径）：

1. `mini-bundle` → run `minidemo01`——结构语料（图/代际/验收/子图），与 vitest IT
   同一夹具；其会话为极简骨架（零工具调用），工具维度断言走下一条
2. `tool-bundle`（`tests/e2e/fixtures/`，E2E 自有）→ run `e2e-tools01`——Read×3 / bash×2
   / Grep×1 + 时间戳撑起的真实工具时长；工具名是**夹具常量**，断言逐字锁定
3. `claude-sample.jsonl` → solo 会话（伞形 `jsonl` 列出 → 逐条 import-file）

claude-skill-dispatch.jsonl **刻意不播种**——留给 import-journey.spec 走 UI 向导首导，
保住「导入前后差一行」的旅程断言。

recycle-bin.spec 的**一次性夹具** `claude-autorefresh-base.jsonl`（`tests/ut/data/e2e/`）
同样不进播种——spec 内经 HTTP 自行导入（global-setup 同款管线），结束时恢复回流
为普通行，与播种态等价，幂等重跑安全。

### browserConsole 验收门

断言全绿的用例若期间抛过未捕获 `pageerror` → 判负（绿着的白屏回归躲不掉）；已知无
害片段须带来源注释加入豁免清单（当前为空）。失败用例的 console 全程采集落盘到
test-results（与 trace/截图/录像并排）。

### teardown 不变量

被测服务必须死透（端口释放）——否则下次 run 撞 EADDRINUSE，直接 fail-fast。刻意
不做「pgrep next-server + cwd 在仓内」的全局断言：用户自己的 dev 实例（同仓 cwd）
是合法并行进程，端口级断言才是本套件的精确边界。

## 已知陷阱（写新用例前必读）

- **taskId = 文件名主干**：claude-jsonl 适配器 `deriveSessionIdFromName` 契约——
  `claude-sample.jsonl` → taskId `claude-sample`（非 JSONL 内 sessionId 字段）。
- **tab 面板惰性挂载**：`data-run-tab=<key>` 的面板**访问过才存在**于 DOM
  （visitedTabs 契约）；断言前先经 `switchTab` 走真实导航。
- **`/hidden/` 正则陷阱**：活跃面板的合法类名含 `overflow-hidden` 等子串——判面板
  选中只看 `toBeVisible()`（tailwind `hidden` → display:none）。
- **bundle schema 哈希钉死**：`workflow.schema.json` 必须与
  `schema-validate.ts` 的 TRUSTED_SCHEMA_SHA256 逐字节一致——新 bundle 一律
  `cp` 官方 schema，手写必挂。
- **运行时 ID 形态**：资产行 key = `run:<runId>` / `session:<db自增id>`——会话行按
  taskId 定位走行内 `title` 元素，不用 db id。
- **run 数据不在 DB**：run = 文件系统清单（CONTEXT_INSIGHT_HOME 下的 run 目录）+
  DB 会话行；e2e.db 重建即全新，无残留。

## 与 vitest 的分工

- vitest（`tests/ut`，happy-dom IT）：组件级契约，改契约即红——**密度**在这里。
- vitest（`tests/pipeline`，真 DB/真文件系统）：数据管线端到端——导入→落库→数据仓
  →导出→发包哨兵；无浏览器无服务（历史沿革：曾名 tests/e2e，「e2e」之名已让渡
  给本浏览器套件）。
- Playwright（本目录）：用户旅程全链路，真服务真库真浏览器——**置信**在这里。
- 选择器锚点尽量复用 vitest IT 已锁定的 `data-*` 契约（`data-run-tab` /
  `data-asset-row` / `data-tool-row` / `data-turns-search-input`…）——改锚点两套
  测试一起红，漂移无处藏身。
