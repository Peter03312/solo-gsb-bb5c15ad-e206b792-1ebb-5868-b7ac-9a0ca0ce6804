/*
 * db.js —— SQLite 持久化（better-sqlite3，同步 API）
 * 单版图表 board：id / revision（乐观修订号）/ locked / doc(JSON) / updated_at
 * 试排方案表 schemes：id / name / source_rev（来源正式版图修订号）/
 *                     revision（方案自身修订号）/ doc(JSON) / 时间戳
 */
'use strict';
var path = require('path');
var fs = require('fs');
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
    CREATE TABLE IF NOT EXISTS schemes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      source_rev INTEGER NOT NULL,
      revision   INTEGER NOT NULL DEFAULT 1,
      doc        TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
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

/* =====================================================================
 * 试排方案（schemes）
 * 每个方案从某个修订号的“正式版图”克隆而来：source_rev 固定记录来源修订号；
 * 方案自身也有 revision 乐观修订号，保存整稿 doc（布面/缺陷/款式/摆放）。
 * 切换为正式版图（promote）在单事务内校验三重前提，成功后 board.revision+1，
 * 方案本身保持原样（仍可查看/编辑/再次切换）。
 * ===================================================================== */

function rowToScheme(r) {
  return {
    id: r.id, name: r.name, sourceRevision: r.source_rev,
    revision: r.revision, updatedAt: r.updated_at, createdAt: r.created_at,
    doc: JSON.parse(r.doc)
  };
}

// 列表摘要：名称、来源修订号、方案修订号、各款所需/已排/未排数量
function summarize(r) {
  var doc = JSON.parse(r.doc);
  var used = Object.create(null);
  (doc.placements || []).forEach(function (pl) { used[pl.pieceId] = (used[pl.pieceId] || 0) + 1; });
  var pieces = (doc.pieces || []).map(function (p) {
    var placed = used[p.id] || 0;
    return { pieceId: p.id, name: p.name, required: p.qty, placed: placed, remaining: p.qty - placed };
  });
  return {
    id: r.id, name: r.name, sourceRevision: r.source_rev, revision: r.revision,
    createdAt: r.created_at, updatedAt: r.updated_at, pieces: pieces
  };
}

function listSchemes() {
  open();
  var rows = db.prepare('SELECT * FROM schemes ORDER BY id DESC').all();
  return rows.map(summarize);
}

function getScheme(id) {
  open();
  var r = db.prepare('SELECT * FROM schemes WHERE id = ?').get(id);
  return r ? rowToScheme(r) : null;
}

/*
 * 从当前正式版图克隆一份命名方案（前置条件由调用方把关：正式版图未锁定）。
 * 返回 {status:'ok', scheme} | {status:'board-locked', board} |
 *      {status:'name-exists'} | {status:'no-board'}
 */
function createScheme(name) {
  open();
  var tx = db.transaction(function () {
    var board = db.prepare('SELECT revision, locked, doc FROM board WHERE id = ?').get(BOARD_ID);
    if (!board) return { status: 'no-board' };
    if (board.locked) {
      return {
        status: 'board-locked',
        board: { revision: board.revision, locked: true, doc: JSON.parse(board.doc) }
      };
    }
    var dup = db.prepare('SELECT id FROM schemes WHERE name = ?').get(name);
    if (dup) return { status: 'name-exists' };
    var info = db.prepare(
      "INSERT INTO schemes (name, source_rev, revision, doc) VALUES (?, ?, 1, ?)"
    ).run(name, board.revision, board.doc);
    return { status: 'ok', id: info.lastInsertRowid };
  });
  var res = tx();
  if (res.status === 'ok') return { status: 'ok', scheme: getScheme(res.id) };
  return res;
}

/*
 * 保存方案整稿：方案修订号乐观锁；几何/数量/间距校验由调用方在事务外完成。
 * 方案不随正式版图锁定而禁改（仅创建/切换要求正式版图未锁定）。
 * 返回 {status:'ok', revision, scheme} | {status:'stale', current} | {status:'missing'}
 */
function saveScheme(id, doc, expectedRevision) {
  open();
  var tx = db.transaction(function () {
    var row = db.prepare('SELECT revision FROM schemes WHERE id = ?').get(id);
    if (!row) return { status: 'missing' };
    if (row.revision !== expectedRevision) return { status: 'stale' };
    var next = row.revision + 1;
    db.prepare("UPDATE schemes SET doc = ?, revision = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(doc), next, id);
    return { status: 'ok', revision: next };
  });
  var res = tx();
  if (res.status === 'ok') return { status: 'ok', revision: res.revision, scheme: getScheme(id) };
  if (res.status === 'stale') return { status: 'stale', current: getScheme(id) };
  return res;
}

/*
 * 将方案切换为正式版图（单事务，无部分切换）：
 *   1) 方案存在；2) expectedRevision === 方案当前 revision（方案未过期）
 *   3) 正式版图未锁定；4) 正式版图仍处于方案的来源修订号 source_rev
 * 成功：board.doc = 方案 doc，board.revision += 1（且解锁状态）；方案原样保留。
 * 失败返回当前版本信息与原因，不产生任何写入。
 */
function promoteScheme(id, expectedRevision) {
  open();
  var tx = db.transaction(function () {
    var sch = db.prepare('SELECT source_rev, revision, doc FROM schemes WHERE id = ?').get(id);
    if (!sch) return { status: 'missing' };
    var board = db.prepare('SELECT revision, locked, doc FROM board WHERE id = ?').get(BOARD_ID);
    if (!board) return { status: 'no-board' };

    if (sch.revision !== expectedRevision) {
      return {
        status: 'scheme-stale', reason: 'SCHEME_REVISION_STALE',
        schemeRevision: sch.revision, expectedSchemeRevision: expectedRevision,
        board: { revision: board.revision, locked: !!board.locked, sourceRevision: sch.source_rev }
      };
    }
    if (board.locked) {
      return {
        status: 'board-locked', reason: 'BOARD_LOCKED',
        schemeRevision: sch.revision,
        board: { revision: board.revision, locked: true, sourceRevision: sch.source_rev }
      };
    }
    if (board.revision !== sch.source_rev) {
      return {
        status: 'board-moved', reason: 'BOARD_REVISION_MOVED',
        schemeRevision: sch.revision, sourceRevision: sch.source_rev,
        board: { revision: board.revision, locked: false, sourceRevision: sch.source_rev }
      };
    }
    var next = board.revision + 1;
    db.prepare("UPDATE board SET doc = ?, revision = ?, locked = 0, updated_at = datetime('now') WHERE id = ?")
      .run(sch.doc, next, BOARD_ID);
    return { status: 'ok', revision: next };
  });
  var res = tx();
  if (res.status === 'ok') return { status: 'ok', revision: res.revision, row: get(), scheme: getScheme(id) };
  res.currentBoard = get();
  return res;
}

function deleteScheme(id) {
  open();
  var info = db.prepare('DELETE FROM schemes WHERE id = ?').run(id);
  return { status: 'ok', removed: info.changes };
}

module.exports = {
  init: init, get: get, save: save, lock: lock, DB_PATH: DB_PATH,
  listSchemes: listSchemes, getScheme: getScheme, createScheme: createScheme,
  saveScheme: saveScheme, promoteScheme: promoteScheme, deleteScheme: deleteScheme
};
