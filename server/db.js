/*
 * db.js —— SQLite 持久化（better-sqlite3，同步 API）
 *
 * 正式版图表 board：id / revision（乐观修订号）/ locked / doc(JSON) / updated_at
 * 命名试排方案表 plans：
 *   id / name / source_revision（创建时所依据的正式版图修订号）
 *   / revision（方案自身的乐观修订号）/ doc(JSON) / created_at / updated_at
 *
 * 方案与正式版图是两份独立的数据：
 *   - 保存方案只推进 plans.revision，不触碰 board；
 *   - 方案转正式版（promote）在单个事务内同时校验“方案修订号未过期 +
 *     正式版图仍停留在来源修订号且未锁定”，通过后 board.revision +1，
 *     方案行本身保持原样（作为历史留痕，不被删除）。
 */
'use strict';
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var Database = require('better-sqlite3');

var DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'marker.db');
var BOARD_ID = 1;

var db;
function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS board (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      revision   INTEGER NOT NULL DEFAULT 0,
      locked     INTEGER NOT NULL DEFAULT 0,
      doc        TEXT    NOT NULL,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS plans (
      id              TEXT PRIMARY KEY,
      name            TEXT    NOT NULL,
      source_revision INTEGER NOT NULL,
      revision        INTEGER NOT NULL DEFAULT 0,
      doc             TEXT    NOT NULL,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seedDoc() {
  return {
    fabric: { width: 150, height: 100, unit: 'cm' },
    defects: [
      {
        id: 'defect-1',
        name: '破洞 A',
        points: [
          { x: 95, y: 20 }, { x: 112, y: 16 }, { x: 118, y: 30 },
          { x: 108, y: 42 }, { x: 94, y: 36 }
        ]
      }
    ],
    pieces: [
      {
        id: 'front', name: '前身片', qty: 2, margin: 1.5,
        allowedAngles: [0, 180],
        points: [
          { x: 0, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 40 },
          { x: 17, y: 40 }, { x: 16, y: 35 }, { x: 15, y: 40 }, { x: 0, y: 40 }
        ]
      },
      {
        id: 'back', name: '后身片', qty: 2, margin: 1.5,
        allowedAngles: [0, 90, 180, 270],
        points: [
          { x: 0, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 42 }, { x: 0, y: 42 }
        ]
      },
      {
        id: 'sleeve', name: '袖子', qty: 4, margin: 1.0,
        allowedAngles: [0, 90, 180, 270],
        points: [
          { x: 0, y: 6 }, { x: 14, y: 0 }, { x: 18, y: 0 },
          { x: 32, y: 6 }, { x: 24, y: 22 }, { x: 8, y: 22 }
        ]
      }
    ],
    placements: []
  };
}

function init() {
  open();
  var row = db.prepare('SELECT COUNT(*) AS n FROM board WHERE id = ?').get(BOARD_ID);
  if (row.n === 0) {
    db.prepare('INSERT INTO board (id, revision, locked, doc) VALUES (?, 0, 0, ?)')
      .run(BOARD_ID, JSON.stringify(seedDoc(), null, 2));
    console.log('[db] 已初始化版图样例数据 ->', DB_PATH);
  }
  return get();
}

function get() {
  open();
  var row = db.prepare('SELECT revision, locked, doc, updated_at FROM board WHERE id = ?').get(BOARD_ID);
  if (!row) return null;
  return { revision: row.revision, locked: !!row.locked, updatedAt: row.updated_at, doc: JSON.parse(row.doc) };
}

/*
 * 原子保存：expectedRevision 必须等于当前 revision；锁定后拒绝写入。
 * 校验在调用方（事务外）完成，本函数仍包一层事务保证“失败整稿不变”。
 * 返回 {status:'ok', revision, row} | {status:'locked'} | {status:'stale', current}
 */
function save(doc, expectedRevision) {
  open();
  var tx = db.transaction(function () {
    var row = db.prepare('SELECT revision, locked, doc FROM board WHERE id = ?').get(BOARD_ID);
    if (row.locked) return { status: 'locked' };
    if (row.revision !== expectedRevision) {
      return { status: 'stale', current: { revision: row.revision, locked: false, doc: JSON.parse(row.doc) } };
    }
    var next = row.revision + 1;
    db.prepare("UPDATE board SET doc = ?, revision = ?, locked = 0, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(doc), next, BOARD_ID);
    return { status: 'ok', revision: next };
  });
  var res = tx();
  if (res.status === 'ok') return { status: 'ok', revision: res.revision, row: get() };
  if (res.status === 'stale') {
    var c = get();
    return { status: 'stale', current: c };
  }
  return res;
}

/*
 * 锁定：同样携带修订号；锁定不改变几何数据，revision +1。
 * 已锁定返回 {status:'already-locked', revision}。
 */
function lock(expectedRevision) {
  open();
  var tx = db.transaction(function () {
    var row = db.prepare('SELECT revision, locked FROM board WHERE id = ?').get(BOARD_ID);
    if (row.locked) return { status: 'already-locked', revision: row.revision };
    if (row.revision !== expectedRevision) return { status: 'stale' };
    var next = row.revision + 1;
    db.prepare("UPDATE board SET locked = 1, revision = ?, updated_at = datetime('now') WHERE id = ?")
      .run(next, BOARD_ID);
    return { status: 'ok', revision: next };
  });
  var res = tx();
  res.row = get();
  return res;
}

/* ================= 命名试排方案 ================= */

// 各款“未排数量”汇总（qty - 已放置数），用于方案列表
function remainingByPiece(doc) {
  var out = {};
  (doc.pieces || []).forEach(function (p) {
    out[p.id] = { pieceId: p.id, name: p.name || p.id, required: p.qty, placed: 0, remaining: p.qty };
  });
  (doc.placements || []).forEach(function (pl) {
    if (out[pl.pieceId]) {
      out[pl.pieceId].placed++;
      out[pl.pieceId].remaining = out[pl.pieceId].required - out[pl.pieceId].placed;
    }
  });
  return Object.keys(out).map(function (id) { return out[id]; });
}

function rowToPlan(row) {
  if (!row) return null;
  var doc = JSON.parse(row.doc);
  return {
    id: row.id,
    name: row.name,
    sourceRevision: row.source_revision,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doc: doc,
    remaining: remainingByPiece(doc)
  };
}
// 列表项不含完整 doc（可能很大），只给名称/来源修订号/自身修订号/各款未排数量
function rowToPlanSummary(row) {
  var doc = JSON.parse(row.doc);
  return {
    id: row.id,
    name: row.name,
    sourceRevision: row.source_revision,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    placedCount: (doc.placements || []).length,
    remaining: remainingByPiece(doc)
  };
}

function listPlans() {
  open();
  var rows = db.prepare('SELECT id, name, source_revision, revision, doc, created_at, updated_at FROM plans ORDER BY created_at DESC, rowid DESC').all();
  return rows.map(rowToPlanSummary);
}

function getPlan(id) {
  open();
  var row = db.prepare('SELECT id, name, source_revision, revision, doc, created_at, updated_at FROM plans WHERE id = ?').get(id);
  return rowToPlan(row);
}

/*
 * 从“未锁定且修订号匹配”的正式版图创建方案（深拷贝其 doc 作为方案首稿）。
 * 返回：
 *   {status:'ok', plan, board:{revision,locked}}
 *   {status:'board-locked', current:{revision,locked}}
 *   {status:'board-stale',  current:{revision,locked}}
 *   {status:'not-initialized'}
 */
function createPlan(name, expectedBoardRevision) {
  open();
  var tx = db.transaction(function () {
    var board = db.prepare('SELECT revision, locked, doc FROM board WHERE id = ?').get(BOARD_ID);
    if (!board) return { status: 'not-initialized' };
    if (board.locked) return { status: 'board-locked', current: { revision: board.revision, locked: true } };
    if (board.revision !== expectedBoardRevision) {
      return { status: 'board-stale', current: { revision: board.revision, locked: false } };
    }
    var id = 'plan-' + crypto.randomUUID();
    var docText = board.doc; // 直接沿用库里的 JSON 文本，天然深拷贝
    db.prepare('INSERT INTO plans (id, name, source_revision, revision, doc) VALUES (?, ?, ?, 0, ?)')
      .run(id, name, board.revision, docText);
    var row = db.prepare('SELECT id, name, source_revision, revision, doc, created_at, updated_at FROM plans WHERE id = ?').get(id);
    return { status: 'ok', plan: rowToPlan(row), board: { revision: board.revision, locked: false } };
  });
  return tx();
}

/*
 * 保存方案：沿用与正式版图完全相同的全量几何/数量/间距校验（调用方在事务外完成）。
 * 只比较方案自身的 revision；正式版图是否已变化不影响方案保存。
 * 返回：
 *   {status:'ok', revision, plan}
 *   {status:'not-found'}
 *   {status:'stale', current: plan（含最新 doc）}
 */
function savePlan(id, doc, expectedPlanRevision) {
  open();
  var tx = db.transaction(function () {
    var row = db.prepare('SELECT id, name, source_revision, revision, doc, created_at, updated_at FROM plans WHERE id = ?').get(id);
    if (!row) return { status: 'not-found' };
    if (row.revision !== expectedPlanRevision) return { status: 'stale', current: rowToPlan(row) };
    var next = row.revision + 1;
    db.prepare("UPDATE plans SET doc = ?, revision = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(doc), next, id);
    var updated = db.prepare('SELECT id, name, source_revision, revision, doc, created_at, updated_at FROM plans WHERE id = ?').get(id);
    return { status: 'ok', revision: next, plan: rowToPlan(updated) };
  });
  return tx();
}

function renamePlan(id, name) {
  open();
  var info = db.prepare("UPDATE plans SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
  if (info.changes === 0) return { status: 'not-found' };
  return { status: 'ok', plan: getPlan(id) };
}

function deletePlan(id) {
  open();
  var info = db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  return { status: info.changes === 0 ? 'not-found' : 'ok' };
}

/*
 * 方案转正式版：单个事务内完成全部前置条件检查与替换，条件不满足时不产生部分切换。
 * 条件（按顺序）：
 *   1) 正式版图存在且未锁定                              -> board-locked
 *   2) 方案存在                                          -> plan-not-found
 *   3) 携带的方案修订号 == plans.revision（方案未过期）   -> plan-stale
 *   4) board.revision == plans.source_revision（正式版图
 *      仍停留在方案来源修订号）                          -> source-moved
 * 通过后：board.doc = plan.doc，board.locked = 0，board.revision +1；
 *         方案行保持原样（来源/自身修订号均不改）。
 */
function promotePlan(id, expectedPlanRevision) {
  open();
  var tx = db.transaction(function () {
    var board = db.prepare('SELECT revision, locked FROM board WHERE id = ?').get(BOARD_ID);
    if (!board) return { status: 'not-initialized' };
    if (board.locked) return { status: 'board-locked', current: { revision: board.revision, locked: true } };

    var plan = db.prepare('SELECT id, revision, source_revision FROM plans WHERE id = ?').get(id);
    if (!plan) return { status: 'plan-not-found' };
    if (plan.revision !== expectedPlanRevision) {
      var curRow = db.prepare('SELECT id, name, source_revision, revision, doc, created_at, updated_at FROM plans WHERE id = ?').get(id);
      return { status: 'plan-stale', current: rowToPlan(curRow), board: { revision: board.revision, locked: false } };
    }
    if (board.revision !== plan.source_revision) {
      return { status: 'source-moved', sourceRevision: plan.source_revision,
        current: { revision: board.revision, locked: false } };
    }

    var docText = db.prepare('SELECT doc FROM plans WHERE id = ?').get(id).doc;
    var nextBoardRev = board.revision + 1;
    db.prepare("UPDATE board SET doc = ?, revision = ?, locked = 0, updated_at = datetime('now') WHERE id = ?")
      .run(docText, nextBoardRev, BOARD_ID);
    return { status: 'ok', revision: nextBoardRev };
  });
  var res = tx();
  if (res.status === 'ok') res.row = get();
  return res;
}

module.exports = {
  init: init,
  get: get,
  save: save,
  lock: lock,
  // 方案
  listPlans: listPlans,
  getPlan: getPlan,
  createPlan: createPlan,
  savePlan: savePlan,
  renamePlan: renamePlan,
  deletePlan: deletePlan,
  promotePlan: promotePlan,
  DB_PATH: DB_PATH
};
