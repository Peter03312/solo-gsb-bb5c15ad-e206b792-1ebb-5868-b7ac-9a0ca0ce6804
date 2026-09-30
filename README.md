# 🧵 服装裁片排版编辑器（Marker Editor）

本机完成版图编辑的 Web 应用：输入**布幅尺寸、缺陷多边形、各款裁片（多边形 / 所需数量 / 允许旋转角度 / 安全间距）**，在画布上拖放排料；保存时服务端按**旋转平移后的实际轮廓**全量复核数量、布边、缺陷与片间间距，任一不合格整张版图不变并标出冲突对象与原因。支持**乐观修订号**防多人覆盖、**锁定**后禁改，并输出含每片位置/角度与未排数量的**可下载裁切清单（CSV）**。

排版人员还可从**未锁定的正式版图**创建多份**命名试排方案**，分别调整布面、缺陷、款式与裁片摆放；每份方案固定记录**来源正式版图修订号**与**方案自身修订号**，保存沿用同一套校验与乐观锁；满足三重前提时可将方案**切换为正式版图**（原子操作，成功后正式版图修订号递增、其他方案保持原样）。

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
| 锁定 | `locked=1` 后任何写操作返回 423；仅可查看与下载清单 |
| 输出 | 锁定后页面显示每片 `编号/位置(X,Y)/角度` 与所需/已排/未排数量，提供 CSV 下载 |
| 试排方案 | 仅能从**未锁定正式版图**克隆；方案独立保存并带自身修订号；切换成功只改正式版图一稿，其他方案原样 |
| 切换前提 | ① 方案修订号未过期 ② 正式版图仍处于方案**来源修订号** ③ 正式版图未锁定；任一不满足返回当前版本与原因，**无部分切换** |

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

## 试排方案（多方案比选）

在正式版图**未锁定**时，点顶部「🧪 方案管理」：

1. **创建**：输入方案名称（如 `试排A-省料`），从当前正式版图整稿克隆一份；方案记录
   - `sourceRevision` = 创建时正式版图修订号（固定不变）
   - 自身 `revision` 从 **1** 开始。
2. **列表**：显示每个方案的名称、来源修订号、方案修订号，以及**各款未排数量**（已排/所需）；
   正式版图已离开某方案来源修订号时该行红色提示，正式版图锁定时显示锁定标记。
3. **编辑**：「打开编辑」进入方案画布（顶栏显示 🧪 方案名与方案修订号），布面、缺陷、款式、摆放都可独立调整；
   「保存方案」走与正式版图**完全相同**的服务端全量几何/数量/间距校验：
   - 校验失败返回 `422` 与 `conflicts[]`，**整份方案不变**，画布标红冲突对象；
   - 方案修订号过期（他人已保存新版）返回 `409`，过期修订号不得覆盖。
   - 「⬅ 返回正式版图」放弃当前方案视图回到正式版图。
4. **切换为正式版图（promote）**：必须同时满足
   - 携带的方案修订号 == 方案当前修订号（方案没过期）；
   - 正式版图修订号 == 方案 `sourceRevision`（自克隆后正式版图没被别人保存/切换过）；
   - 正式版图 `locked=false`。

   三者满足时在**单个 SQLite 事务**内把方案稿写入正式版图，正式版图 `revision + 1`；
   原方案与其他方案**全部保持原样**（原方案仍可继续编辑、再次切换；但其来源修订号此刻已落后，
   需基于新正式版图另建方案才能再次切换）。任一条件不满足返回 `409/423`，响应带**当前正式版图版本、
   方案当前版本（及来源修订号）与原因**，不产生部分切换。
5. 正式版图锁定期间：不能新建方案、不能切换；已存在方案仍可打开查看与保存（方案数据独立）。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/board` | 当前版图 `{revision, locked, doc, updatedAt}` |
| PUT | `/api/board` | 提交 `{revision, doc}`；422=校验失败（含 `conflicts[]`，整稿不变），409=修订号过期，423=已锁定 |
| POST | `/api/board/lock` | `{revision}` 锁定；409=过期，423=已锁定 |
| GET | `/api/cutlist` / `?format=csv` | 仅锁定后可用，JSON 或下载 CSV |
| GET | `/api/schemes` | 方案列表：`{board:{revision,locked}, schemes:[{id,name,sourceRevision,revision,pieces:[{pieceId,name,required,placed,remaining}]}]}` |
| POST | `/api/schemes` | 从当前未锁定正式版图克隆新方案 `{name}` → 201 完整方案；400=名称非法，409=重名，423=正式版图已锁定 |
| GET | `/api/schemes/:id` | 单个方案完整稿 `{id,name,sourceRevision,revision,doc,...}`；404=不存在 |
| PUT | `/api/schemes/:id` | 保存方案 `{revision, doc}`；422=校验失败（整份方案不变，含 `conflicts[]`），409=方案修订号过期（`current` 为新稿），404=方案已删除 |
| POST | `/api/schemes/:id/promote` | 切换为正式版图 `{revision}`；成功 200 `{revision, row, scheme}`；409=`SCHEME_REVISION_STALE`/`BOARD_REVISION_MOVED`，423=`BOARD_LOCKED`，均带当前版本与原因 |
| DELETE | `/api/schemes/:id` | 删除方案（不影响正式版图与其他方案） |

切换失败响应示例（正式版图已前进）：

```json
{
  "error": "BOARD_REVISION_MOVED",
  "message": "正式版图已离开方案来源修订号：来源为 3，当前为 5（且未锁定）。请基于当前正式版图新建方案后再切换（未产生部分切换）",
  "reason": "BOARD_REVISION_MOVED",
  "schemeRevision": 4,
  "sourceRevision": 3,
  "current": { "board": { "revision": 5, "locked": false } }
}
```

### 调用示例（curl）

```bash
# 1) 查看方案列表（含正式版图当前版本与各款未排数量）
curl -s http://localhost:3000/api/schemes

# 2) 从当前未锁定正式版图创建命名方案（sourceRevision 自动取当前版图修订号，方案 rev=1）
curl -s -X POST http://localhost:3000/api/schemes \
  -H 'content-type: application/json' \
  -d '{"name":"试排A-省料"}'

# 3) 读取方案整稿到本地，修改 doc（布面/缺陷/款式/placements）后乐观保存
curl -s http://localhost:3000/api/schemes/1 -o scheme.json
# …用脚本编辑 JSON…
curl -s -X PUT http://localhost:3000/api/schemes/1 \
  -H 'content-type: application/json' \
  -d '{"revision":1,"doc":{ ... }}'
# 200 -> {"ok":true,"revision":2,"scheme":{...}}
# 422 -> {"error":"VALIDATION_FAILED","conflicts":[...]}   整份方案不变
# 409 -> {"error":"REVISION_STALE","current":{...方案新稿...}}

# 4) 切换为正式版图（携带所见方案修订号）
curl -s -X POST http://localhost:3000/api/schemes/1/promote \
  -H 'content-type: application/json' \
  -d '{"revision":2}'
# 200 -> {"ok":true,"revision":6,"row":{正式版图新稿},"scheme":{方案原样}}
# 409 SCHEME_REVISION_STALE / BOARD_REVISION_MOVED；423 BOARD_LOCKED —— 均无写入
```

冲突对象在响应中带定位信息（`target` / `targets` / `defectId` / `side`、实测 `gap` 与要求 `required`、最近点 `points`），前端据此高亮。

## 目录结构

```
shared/geom.js       前后端共用几何引擎（自交/距离/旋转/防翻面）
server/
  server.js          Express 入口与 REST API、CSV 清单、试排方案 API
  validator.js       保存时全量校验（结构 + 布边/缺陷/片间/数量/角度/翻面；正式版图与方案共用）
  db.js              SQLite：单行版图表 + schemes 方案表，revision 乐观锁与 promote 原子事务
  init-db.js         初始化脚本（旧库启动自动补建 schemes 表，正式版图数据保留）
public/              前端（index.html / styles.css / app.js 画布编辑 + 方案管理弹窗）
Dockerfile           镜像（含依赖安装）
docker-compose.yml   一键启动 + 数据卷 + 健康检查
```

## 坐标与单位

布面坐标单位为 **cm**，原点在布面**左下角**，x 向右、y 向上（画布按屏幕方向向下渲染）。每片放置的 `x,y` 为其旋转后包围盒左下角；`angle` 为屏幕顺时针角度（°），取自该款允许角度白名单。
