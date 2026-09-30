/*
 * server.js —— Express 服务：静态页面 + 版图 REST API
 *
 * 接口：
 *   GET    /api/board              读取当前版图（含 revision / locked）
 *   PUT    /api/board              提交整稿 {revision, doc}：先全量校验，通过后按修订号原子落库
 *   POST   /api/board/lock         锁定版图 {revision}
 *   GET    /api/cutlist?format=csv 已锁定版图的裁切清单（CSV 下载）
 *
 * 试排方案：
 *   GET    /api/schemes            方案列表（名称 / 来源修订号 / 各款未排数量）
 *   POST   /api/schemes            从当前未锁定正式版图克隆新方案 {name}
 *   GET    /api/schemes/:id        读取单个方案整稿
 *   PUT    /api/schemes/:id        保存方案 {revision, doc}（沿用全量几何/数量/间距校验）
 *   POST   /api/schemes/:id/promote 将方案切换为正式版图 {revision}
 *   DELETE /api/schemes/:id        删除方案
 */
'use strict';
var path = require('path');
var express = require('express');
var store = require('./db.js');
var validator = require('./validator.js');

var app = express();
app.use(express.json({ limit: '5mb' }));
// JSON 解析失败统一返回 JSON（而不是 Express 默认 HTML 错误页）
app.use(function (err, req, res, next) {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'BAD_JSON', message: '请求体不是合法 JSON：' + err.message });
  }
  if (err) return res.status(400).json({ error: 'BAD_REQUEST', message: err.message });
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));

app.get('/api/board', function (req, res) {
  var row = store.get();
  if (!row) return res.status(404).json({ error: 'NOT_INITIALIZED', message: '版图尚未初始化，请先运行 npm run init-db' });
  res.json(row);
});

app.put('/api/board', function (req, res) {
  var body = req.body || {};
  var expected = body.revision;
  var doc = body.doc;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '必须携带所见版图修订号 revision（非负整数）' });
  }
  if (!doc || typeof doc !== 'object') {
    return res.status(400).json({ error: 'BAD_DOC', message: '缺少版图数据 doc' });
  }

  // 1) 几何/业务全量校验（任何一项不合格：不触碰数据库，整稿不变）
  var result = validator.validateBoard(doc);
  if (!result.ok) {
    return res.status(422).json({
      error: 'VALIDATION_FAILED',
      message: '校验未通过，整张版图保持原样（共 ' + result.conflicts.length + ' 处冲突）',
      conflicts: result.conflicts
    });
  }

  // 2) 乐观锁原子写入
  var saved = store.save(result.doc, expected);
  if (saved.status === 'locked') {
    return res.status(423).json({ error: 'BOARD_LOCKED', message: '版图已锁定，禁止任何改动' });
  }
  if (saved.status === 'stale') {
    return res.status(409).json({
      error: 'REVISION_STALE',
      message: '修订号 ' + expected + ' 已过期，服务器当前为 ' + saved.current.revision + '，请刷新获取新稿后再提交（不会覆盖他人修改）',
      current: saved.current
    });
  }
  res.json({ ok: true, revision: saved.revision, locked: false, row: saved.row });
});

app.post('/api/board/lock', function (req, res) {
  var expected = (req.body || {}).revision;
  if (typeof expected !== 'number' || !Number.isInteger(expected)) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '锁定必须携带修订号' });
  }
  var r = store.lock(expected);
  if (r.status === 'already-locked') {
    return res.status(423).json({ error: 'BOARD_LOCKED', message: '版图已处于锁定状态', revision: r.revision, row: r.row });
  }
  if (r.status === 'stale') {
    var cur = store.get();
    return res.status(409).json({
      error: 'REVISION_STALE',
      message: '修订号已过期，请刷新后再锁定',
      current: cur
    });
  }
  res.json({ ok: true, revision: r.revision, locked: true, row: r.row });
});

/* =====================================================================
 * 试排方案 API
 * ===================================================================== */

function parseId(v) {
  var n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 列表：名称、来源修订号、方案修订号、各款未排数量
app.get('/api/schemes', function (req, res) {
  var board = store.get();
  res.json({ board: board ? { revision: board.revision, locked: board.locked, updatedAt: board.updatedAt } : null,
             schemes: store.listSchemes() });
});

// 创建：仅允许从未锁定的正式版图克隆；方案 revision 从 1 开始，sourceRevision=当前版图修订号
app.post('/api/schemes', function (req, res) {
  var name = (req.body && req.body.name != null) ? String(req.body.name).trim() : '';
  if (!name) return res.status(400).json({ error: 'BAD_NAME', message: '方案名称不能为空' });
  if (name.length > 80) return res.status(400).json({ error: 'BAD_NAME', message: '方案名称最长 80 个字符' });
  var r = store.createScheme(name);
  if (r.status === 'no-board') {
    return res.status(404).json({ error: 'NOT_INITIALIZED', message: '版图尚未初始化，请先运行 npm run init-db' });
  }
  if (r.status === 'name-exists') {
    return res.status(409).json({ error: 'SCHEME_NAME_EXISTS', message: '已存在同名方案：' + name });
  }
  if (r.status === 'board-locked') {
    return res.status(423).json({
      error: 'BOARD_LOCKED', message: '正式版图已锁定（修订号 ' + r.board.revision + '），不能从锁定版图创建试排方案',
      current: { revision: r.board.revision, locked: true }
    });
  }
  res.status(201).json({ ok: true, scheme: schemeFull(r.scheme) });
});

// 读取单个方案
app.get('/api/schemes/:id', function (req, res) {
  var id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'BAD_ID', message: '方案 id 必须为正整数' });
  var sch = store.getScheme(id);
  if (!sch) return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '方案不存在：' + id });
  res.json(schemeFull(sch));
});

// 保存方案：沿用现有几何/数量/间距全量校验；失败 422 且整份方案不变；修订号过期 409
app.put('/api/schemes/:id', function (req, res) {
  var id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'BAD_ID', message: '方案 id 必须为正整数' });
  var body = req.body || {};
  var expected = body.revision;
  var doc = body.doc;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected <= 0) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '必须携带所见方案修订号 revision（正整数）' });
  }
  if (!doc || typeof doc !== 'object') {
    return res.status(400).json({ error: 'BAD_DOC', message: '缺少方案数据 doc' });
  }

  // 1) 与正式版图保存完全相同的全量校验（任一不合格：整份方案不变）
  var result = validator.validateBoard(doc);
  if (!result.ok) {
    return res.status(422).json({
      error: 'VALIDATION_FAILED',
      message: '校验未通过，整份方案保持原样（共 ' + result.conflicts.length + ' 处冲突）',
      conflicts: result.conflicts
    });
  }

  // 2) 方案乐观锁原子写入（过期修订号不得覆盖他人修改）
  var saved = store.saveScheme(id, result.doc, expected);
  if (saved.status === 'missing') {
    return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '方案不存在（可能已被删除）：' + id });
  }
  if (saved.status === 'stale') {
    return res.status(409).json({
      error: 'REVISION_STALE',
      message: '方案修订号 ' + expected + ' 已过期，服务器当前为 ' + saved.current.revision +
        '，请刷新获取新稿后再提交（不会覆盖他人修改）',
      current: schemeFull(saved.current)
    });
  }
  res.json({ ok: true, revision: saved.revision, scheme: schemeFull(saved.scheme) });
});

// 删除方案（不影响正式版图与其他方案）
app.delete('/api/schemes/:id', function (req, res) {
  var id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'BAD_ID', message: '方案 id 必须为正整数' });
  var r = store.deleteScheme(id);
  if (!r.removed) return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '方案不存在：' + id });
  res.json({ ok: true, removed: id });
});

// 切换为正式版图：方案修订号未过期 + 正式版图仍处来源修订号 + 正式版图未锁定
app.post('/api/schemes/:id/promote', function (req, res) {
  var id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'BAD_ID', message: '方案 id 必须为正整数' });
  var expected = (req.body || {}).revision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected <= 0) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '切换必须携带所见方案修订号 revision（正整数）' });
  }
  var r = store.promoteScheme(id, expected);

  if (r.status === 'missing') {
    return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '方案不存在：' + id });
  }
  if (r.status === 'no-board') {
    return res.status(404).json({ error: 'NOT_INITIALIZED', message: '版图尚未初始化' });
  }
  if (r.status === 'scheme-stale') {
    return res.status(409).json({
      error: 'SCHEME_REVISION_STALE',
      message: '方案修订号 ' + expected + ' 已过期，该方案当前修订号为 ' + r.schemeRevision + '，请刷新方案后再切换（未产生部分切换）',
      reason: r.reason,
      schemeRevision: r.schemeRevision,
      current: { board: r.currentBoard }
    });
  }
  if (r.status === 'board-locked') {
    return res.status(423).json({
      error: 'BOARD_LOCKED',
      message: '正式版图已锁定（当前修订号 ' + r.currentBoard.revision +
        '，方案来源修订号 ' + r.board.sourceRevision + '），不能切换（未产生部分切换）',
      reason: r.reason,
      schemeRevision: r.schemeRevision,
      current: { board: r.currentBoard }
    });
  }
  if (r.status === 'board-moved') {
    return res.status(409).json({
      error: 'BOARD_REVISION_MOVED',
      message: '正式版图已离开方案来源修订号：来源为 ' + r.sourceRevision + '，当前为 ' + r.currentBoard.revision +
        '（且未锁定）。请基于当前正式版图新建方案后再切换（未产生部分切换）',
      reason: r.reason,
      schemeRevision: r.schemeRevision,
      sourceRevision: r.sourceRevision,
      current: { board: r.currentBoard }
    });
  }
  res.json({ ok: true, revision: r.revision, row: r.row, scheme: schemeFull(r.scheme) });
});

// 方案完整对外形态
function schemeFull(sch) {
  return {
    id: sch.id, name: sch.name, sourceRevision: sch.sourceRevision,
    revision: sch.revision, doc: sch.doc, createdAt: sch.createdAt, updatedAt: sch.updatedAt
  };
}

/* ---------- 裁切清单 ---------- */
function buildCutList(row) {
  var doc = row.doc;
  var map = {};
  doc.pieces.forEach(function (p) {
    map[p.id] = { pieceId: p.id, name: p.name, required: p.qty, placed: 0, margin: p.margin, items: [] };
  });
  doc.placements.forEach(function (pl) {
    if (!map[pl.pieceId]) return;
    map[pl.pieceId].placed++;
    var xs = pl.points.map(function (p) { return p.x; });
    var ys = pl.points.map(function (p) { return p.y; });
    map[pl.pieceId].items.push({
      placementId: pl.id,
      x: Math.round(Math.min.apply(null, xs) * 1000) / 1000,
      y: Math.round(Math.min.apply(null, ys) * 1000) / 1000,
      angle: Math.round(pl.angle * 1000) / 1000
    });
  });
  var groups = Object.keys(map).map(function (id) {
    var g = map[id];
    g.remaining = g.required - g.placed;
    return g;
  });
  return {
    fabric: doc.fabric,
    revision: row.revision,
    lockedAt: row.updatedAt,
    groups: groups,
    placements: doc.placements
  };
}

function csvCell(v) {
  var s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(list) {
  var lines = [];
  lines.push(['# 服装裁片裁切清单']);
  lines.push(['# 布幅(cm)', list.fabric.width + ' x ' + list.fabric.height]);
  lines.push(['# 修订号', list.revision, '锁定时间', list.lockedAt]);
  lines.push([]);
  lines.push(['裁片', '放置编号', '位置X(cm)', '位置Y(cm)', '角度(°)', '自身间距(cm)']);
  list.groups.forEach(function (g) {
    g.items.forEach(function (it) {
      lines.push([g.name, it.placementId, it.x, it.y, it.angle, g.margin]);
    });
  });
  lines.push([]);
  lines.push(['裁片', '所需数量', '已排数量', '未排数量']);
  list.groups.forEach(function (g) {
    lines.push([g.name, g.required, g.placed, g.remaining]);
  });
  return '﻿' + lines.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
}

app.get('/api/cutlist', function (req, res) {
  var row = store.get();
  if (!row) return res.status(404).json({ error: 'NOT_INITIALIZED' });
  if (!row.locked) return res.status(409).json({ error: 'NOT_LOCKED', message: '版图尚未锁定，锁定后才能输出正式裁切清单' });
  var list = buildCutList(row);
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="cutlist-rev' + row.revision + '.csv"');
    return res.send(toCsv(list));
  }
  res.json(list);
});

var PORT = parseInt(process.env.PORT || '3000', 10);
store.init();
app.listen(PORT, function () {
  console.log('[marker] 服装裁片排版服务已启动: http://localhost:' + PORT);
  console.log('[marker] 数据库: ' + store.DB_PATH);
});
