'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/tracker.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'admin',
    company_id INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    plan_type TEXT DEFAULT 'basic',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    imei TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    brand TEXT DEFAULT 'SINOTRACK',
    model TEXT DEFAULT 'ST-906L',
    simcard_number TEXT,
    company_id INTEGER DEFAULT 1,
    icon TEXT DEFAULT 'truck',
    color TEXT DEFAULT '#3b82f6',
    speed_limit INTEGER,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (company_id) REFERENCES companies(id)
  );

  CREATE TABLE IF NOT EXISTS gps_positions (
    id TEXT PRIMARY KEY,
    device_imei TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    speed REAL DEFAULT 0,
    heading REAL DEFAULT 0,
    ignition INTEGER DEFAULT 0,
    satellites INTEGER DEFAULT 0,
    battery_level REAL,
    voltage REAL,
    signal_gsm_quality REAL,
    odometer REAL DEFAULT 0,
    altitude REAL DEFAULT 0,
    is_valid_gps INTEGER DEFAULT 1,
    raw_data TEXT,
    geo_coding TEXT,
    gps_timestamp TEXT,
    server_timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (device_imei) REFERENCES devices(imei)
  );

  CREATE TABLE IF NOT EXISTS gps_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_imei TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    speed REAL DEFAULT 0,
    heading REAL DEFAULT 0,
    ignition INTEGER DEFAULT 0,
    satellites INTEGER DEFAULT 0,
    battery_level REAL,
    voltage REAL,
    odometer REAL DEFAULT 0,
    raw_data TEXT,
    gps_timestamp TEXT,
    server_timestamp TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_history_imei ON gps_history(device_imei);
  CREATE INDEX IF NOT EXISTS idx_history_time ON gps_history(gps_timestamp);

  CREATE TABLE IF NOT EXISTS geofences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    company_id INTEGER DEFAULT 1,
    shape TEXT NOT NULL,
    center_lat REAL,
    center_lng REAL,
    radius REAL,
    coordinates TEXT,
    color TEXT DEFAULT '#3b82f6',
    category TEXT,
    priority TEXT DEFAULT 'low',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (company_id) REFERENCES companies(id)
  );

  CREATE TABLE IF NOT EXISTS references_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    company_id INTEGER DEFAULT 1,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    icon TEXT DEFAULT 'pin',
    color TEXT DEFAULT '#3b82f6',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    device_imei TEXT NOT NULL,
    device_name TEXT,
    company_id INTEGER DEFAULT 1,
    latitude REAL,
    longitude REAL,
    message TEXT,
    is_acknowledged INTEGER DEFAULT 0,
    acknowledged_at TEXT,
    acknowledged_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS share_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    name TEXT,
    imeis TEXT NOT NULL,
    display_names TEXT,
    company_id INTEGER DEFAULT 1,
    password_hash TEXT,
    expires_at TEXT,
    status TEXT DEFAULT 'active',
    access_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_imei TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT,
    start_lat REAL,
    start_lng REAL,
    end_lat REAL,
    end_lng REAL,
    start_address TEXT,
    end_address TEXT,
    distance_km REAL DEFAULT 0,
    max_speed REAL DEFAULT 0,
    avg_speed REAL DEFAULT 0,
    duration_minutes REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Insert default company and user if not exist
const companyExists = db.prepare('SELECT id FROM companies WHERE id = 1').get();
if (!companyExists) {
  db.prepare('INSERT OR IGNORE INTO companies (id, name) VALUES (1, ?)')
    .run(process.env.COMPANY_NAME || 'Mi Empresa GPS');
}

const userExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!userExists) {
  const bcrypt = require('crypto');
  const hash = bcrypt.createHash('sha256').update(process.env.ADMIN_PASSWORD || 'admin123').digest('hex');
  db.prepare('INSERT OR IGNORE INTO users (username, password_hash, email, company_id) VALUES (?, ?, ?, 1)')
    .run('admin', hash, process.env.ADMIN_EMAIL || 'admin@gps.local');
  console.log('Default admin user created: admin / admin123');
}

module.exports = db;
