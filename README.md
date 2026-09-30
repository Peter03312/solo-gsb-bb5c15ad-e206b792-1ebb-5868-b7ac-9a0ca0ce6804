# 🧵 服装裁片排版编辑器（Marker Editor）

本机完成版图编辑的 Web 应用：输入**布幅尺寸、缺陷多边形、各款裁片（多边形 / 所需数量 / 允许旋转角度 / 安全间距）**，在画布上拖放排料；保存时服务端按**旋转平移后的实际轮廓**全量复核数量、布边、缺陷与片间间距，任一不合格整张版图不变并标出冲突对象与原因。支持**乐观修订号**防多人覆盖、**锁定**后禁改，并输出含每片位置/角度与未排数量的**可下载裁切清单（CSV）**。

本轮新增**命名试排方案**：排版人员可从**未锁定的正式版图**创建多份命名方案，分别调整布面、缺陷、款式和裁片摆放；每份方案独立记录**来源正式版图修订号**与**方案自身修订号**。方案保存沿用同一套几何/数量/间距校验与乐观锁；将方案**切换为正式版图**时，服务端在单个事务内确认「方案修订号未过期 + 正式版图仍停留在来源修订号且未锁定」，通过后正式版图修订号 +1（其他方案保持原样），任一条件不满足则返回当前版本与原因，**不产生部分切换**。

- 后端：Node.js + Express + better-sqlite3（SQLite 单文件，同步事务）
- 前端：原生 HTML/CSS + Canvas 2D，无构建步骤
- 几何：`shared/geom.js` 前后端同一份代码（旋转、自交检测、多边形距离、防翻面模板比对）

## 规则（与需求逐条对应）

| 规则 | 实现 |
|---|---|
| 裁片不能翻面 | 提交的实际轮廓必须等于模板按允许角度旋转+平移的结果；并校验有向面积符号（镜像必拒） |
| 距布边/缺陷 | 每片净距 **≥ 自身安全间距**，恰等允许（`gap >= margin`） |
| 两片之间 | 净距 **≥ max(甲间距, 乙间距)**，恰等允许 |
| 数量 | 每款已排数不得超过所需数量；清单输出未排数量（未排满允许锁定，清单明示） |
| 非法输入 | 自交多边形、布幅/数量非正、角度非数值、负间距等一律 422 拒绝并说明原因 |
| 原子保存 | 校验在写库前进行；失败不触碰数据库，**整张版图保持原样**；写库用 SQLite 事务 |
| 多人并发 | 每次保存/锁定必须携带所见 `revision`；过期返回 409，不覆盖新稿 |
| 锁定 | `locked=1` 后任何对正式版图的写操作返回 423；仅可查看与下载清单（仍可创建/编辑方案，但不能创建于或切换到已锁定版图） |
| 输出 | 锁定后页面显示每片 `编号/位置(X,Y)/角度` 与所需/已排/未排数量，提供 CSV 下载 |
| 试排方案 | 仅可从**未锁定**正式版图创建；方案保存复用同一套校验与 422/409 语义，失败**整份方案不变** |
| 方案转正式版 | 事务内同时校验「方案修订号未过期 + 正式版图仍处于来源修订号且未锁定」；成功正式版图 `revision+1`、其他方案原样；失败返回当前版本与原因，无部分切换 |

## 一键启动（Docker，含依赖安装与初始化）

```bash
docker compose up --build
```

容器启动时自动完成：安装依赖 → 首次运行自动建表并写入一份示例版图（布幅 150×100cm、1 个缺陷、3 款裁片）。

- 网页地址：**http://localhost:3000**
- 端口：容器内 `3000`，宿主机默认映射 `3000`；可用环境变量改宿主机端口：
  ```bash
  HOST_PORT=8080 docker compose up --build   # -> http://localhost:8080
  ```
- 数据持久化在 compose 命名卷 `marker-data`（容器内 `/data/marker.db`）。
- 停止：`docker compose down`（加 `-v` 会连数据卷一并删除）。

## 本机直接运行（不用 Docker）

要求 Node.js ≥ 18（开发环境为 Node 20）。

```bash
npm install          # 安装依赖（better-sqlite3 需 python3/make/g++，一般有预编译包）
npm run init-db      # 初始化 SQLite（写入 data/marker.db 与示例数据；重复执行不覆盖）
npm start            # 启动服务
```

打开 **http://localhost:3000**。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 监听端口 |
| `DB_PATH` | `./data/marker.db` | SQLite 数据库文件路径（Docker 内为 `/data/marker.db`） |

复位为初始示例：删除数据库后重启即可（Docker：`docker compose down -v && docker compose up`；本机：`rm -rf data && npm run init-db`）。

## 使用说明

1. **① 布面设置**
   - 顶部输入布幅宽/高（cm，必须为正）。
   - 「✎ 绘制缺陷」：在画布上单击逐点画缺陷多边形，双击/回车闭合；右侧可删除。
   - 款式库：填名称、所需数量、安全间距、允许角度（如 `0,90,180,270`），「新增」快速建矩形片，或「✎ 绘制裁片轮廓」画任意不自交多边形。
2. **② 排版编辑**
   - 款式卡片点「＋ 放置」加入布面（达到所需数量自动置灰）。
   - 鼠标拖曳移动；选中后用角度按钮 / R（右转）/ Q（左转）旋转——**只能在允许角度之间切换**；Delete 删除。
   - 滚轮缩放、空格/中键拖动画布；可勾选「显示间距圈」辅助排料。
   - 顶部「保存版图」：服务端全量校验。失败时右侧弹出冲突清单，画布上红色虚线标出冲突裁片与最近点连线（净距/要求值），点冲突项自动定位；**已保存的版图不变**。
   - 修订号过期时会提示并可选择载入他人新稿，旧稿不会覆盖新稿。
3. **③ 裁切清单**
   - 确认无误后点顶部「锁定版图」（同样携带修订号，过期需先刷新）。
   - 锁定后禁止一切改动；该页列出每片位置与角度、各款未排数量，并可「⬇ 下载 CSV 裁切清单」。
4. **⇑ 命名试排方案（本轮新增）**
   - 在「⇑ 方案」页点「＋ 从当前正式版图（rN）新建试排方案」并命名（正式版图未锁定时才允许）。新方案是当时正式版图的独立副本，记录**来源修订号 rN**，自身修订号从 `0` 开始。
   - 打开方案后即进入方案编辑模式（顶栏显示「📝 方案：名称」与 `方案 rX（来源正式版图 rN）`）：布面、缺陷、款式、裁片摆放都可独立调整；「保存方案」走与正式版图**完全相同**的服务端校验——422 时冲突入坞、整份方案不变；方案修订号过期返回 409，不覆盖他人修改。
   - 方案列表卡片显示**名称、来源修订号、自身修订号、各款未排数量**；正式版图已离开来源修订号的方案会有黄色提示，不能再直接转正式版。
   - 点「⇪ 转正式版」：成功后画布载入新正式版图（修订号 +1，未锁定，可继续编辑或再锁定），**其他方案保持原样**；条件不满足（方案过期 / 来源已变化 / 正式版图已锁定）时弹窗给出当前版本与原因，数据无任何改动。
   - 「返回正式版图」随时放弃方案视图（有未保存改动会先确认）；方案可重命名、删除，均不影响正式版图。

## HTTP API

### 正式版图（原有接口，保持兼容）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/board` | 当前版图 `{revision, locked, doc, updatedAt}` |
| PUT | `/api/board` | 提交 `{revision, doc}`；422=校验失败（含 `conflicts[]`，整稿不变），409=修订号过期，423=已锁定 |
| POST | `/api/board/lock` | `{revision}` 锁定；409=过期，423=已锁定 |
| GET | `/api/cutlist` / `?format=csv` | 仅锁定后可用，JSON 或下载 CSV |

### 命名试排方案（本轮新增）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plans` | 方案列表：`{board:{revision,locked}, plans:[{id,name,sourceRevision,revision,createdAt,updatedAt,placedCount,remaining[]}]}`（列表项不含完整 doc） |
| POST | `/api/plans` | 创建方案：`{name, boardRevision}` → 201 `{plan, board}`；409=`boardRevision` 过期，423=正式版图已锁定 |
| GET | `/api/plans/:id` | 方案详情（含完整 `doc` 与当时正式版图状态 `board`）；404=不存在 |
| PUT | `/api/plans/:id` | 保存方案：`{revision, doc}`；**复用正式版图同一套全量校验**——422=校验失败（含 `conflicts[]`，整份方案不变），409=`PLAN_REVISION_STALE`（响应 `current` 为最新方案），404=方案已删除 |
| PATCH | `/api/plans/:id` | 重命名 `{name}` |
| DELETE | `/api/plans/:id` | 删除方案（不影响正式版图与其他方案） |
| POST | `/api/plans/:id/promote` | 转正式版：`{revision}`（**方案**自身修订号）→ 200 `{ok,revision,row}`，正式版图修订号 +1；失败均无部分改动：409 `PLAN_REVISION_STALE`（方案被他人改过，`current` 为最新方案）、409 `SOURCE_REVISION_MOVED`（正式版图已离开来源修订号，响应含 `sourceRevision` 与当前 `current`）、423 正式版图已锁定、404 方案不存在 |

冲突对象在 422 响应中带定位信息（`target` / `targets` / `defectId` / `side`、实测 `gap` 与要求 `required`、最近点 `points`），前端据此高亮（方案保存返回的冲突结构与正式版图一致）。

### 调用示例（curl）

```bash
# 1) 读正式版图（假设 revision=0）
curl -s http://localhost:3000/api/board

# 2) 基于未锁定正式版图 r0 创建命名方案
curl -s -X POST http://localhost:3000/api/plans \
  -H 'content-type: application/json' \
  -d '{"name":"密排方案 A","boardRevision":0}'
# -> {"ok":true,"plan":{"id":"plan-xxxx","name":"密排方案 A","sourceRevision":0,"revision":0,"doc":{...},
#                       "remaining":[{"pieceId":"front","name":"前身片","required":2,"placed":0,"remaining":2}, ...]}, ...}

# 3) 方案列表（名称 / 来源修订号 / 自身修订号 / 各款未排数量）
curl -s http://localhost:3000/api/plans

# 4) 读取方案、编辑后携带“方案自身修订号”保存（doc 结构与 /api/board 完全相同）
curl -s http://localhost:3000/api/plans/plan-xxxx        # 取 plan.doc
curl -s -X PUT http://localhost:3000/api/plans/plan-xxxx \
  -H 'content-type: application/json' \
  -d '{"revision":0,"doc":{ ...修改后的整稿... }}'
# -> {"ok":true,"revision":1,"plan":{...}}
# 几何/数量/间距不合法 -> 422 {"error":"VALIDATION_FAILED","conflicts":[...]}，方案库中仍是旧稿
# 他人已先保存       -> 409 {"error":"PLAN_REVISION_STALE","current":{最新方案...}}

# 5) 转正式版：携带方案修订号；成功正式版图 revision+1，其他方案不动
curl -s -X POST http://localhost:3000/api/plans/plan-xxxx/promote \
  -H 'content-type: application/json' -d '{"revision":1}'
# -> {"ok":true,"revision":1,"locked":false,"row":{正式版图...}}
# 正式版图已被他人推进 -> 409 {"error":"SOURCE_REVISION_MOVED","sourceRevision":0,
#                              "current":{"revision":2,"locked":false},"message":"..."}
# 方案修订号过期       -> 409 {"error":"PLAN_REVISION_STALE","current":{最新方案...},"board":{...}}
# 正式版图已锁定       -> 423 {"error":"BOARD_LOCKED","current":{"revision":N,"locked":true}}
```

更多语言示例（Node.js fetch）：

```js
const base = 'http://localhost:3000';
// 创建
const created = await (await fetch(base + '/api/plans', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: '宽间距方案', boardRevision: 0 })
})).json();

// 编辑 placements 后保存（务必带回最新方案 revision）
const doc = created.plan.doc;
doc.placements.push(/* ... */);
const saved = await fetch(base + '/api/plans/' + created.plan.id, {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ revision: created.plan.revision, doc })
}).then(async r => ({ status: r.status, body: await r.json() }));
if (saved.status === 422) console.error('冲突，方案未变：', saved.body.conflicts);
if (saved.status === 409) console.error('方案过期，先读 body.current 再合并：', saved.body.current);

// 转正式版
const promoted = await fetch(base + '/api/plans/' + created.plan.id + '/promote', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ revision: saved.body.revision })
}).then(async r => ({ status: r.status, body: await r.json() }));
if (promoted.status !== 200) console.error('未切换：', promoted.status, promoted.body.message, promoted.body.current);
```

## 目录结构

```
shared/geom.js       前后端共用几何引擎（自交/距离/旋转/防翻面）
server/
  server.js          Express 入口与 REST API：版图、锁定、CSV 清单、命名试排方案
  validator.js       保存时全量校验（结构 + 布边/缺陷/片间/数量/角度/翻面）——版图与方案共用
  db.js              SQLite：单行版图表 + plans 方案表；revision 乐观锁、创建/保存/转正式版事务
  init-db.js         初始化脚本
public/              前端（index.html / styles.css / app.js 画布编辑 + 方案管理页）
Dockerfile           镜像（含依赖安装）
docker-compose.yml   一键启动 + 数据卷 + 健康检查
```

> 升级说明：`plans` 表由服务启动时 `CREATE TABLE IF NOT EXISTS` 自动建立，旧数据库文件可直接继续使用，无需迁移；原 `board` 表结构与全部旧接口未变。

## 坐标与单位

布面坐标单位为 **cm**，原点在布面**左下角**，x 向右、y 向上（画布按屏幕方向向下渲染）。每片放置的 `x,y` 为其旋转后包围盒左下角；`angle` 为屏幕顺时针角度（°），取自该款允许角度白名单。
