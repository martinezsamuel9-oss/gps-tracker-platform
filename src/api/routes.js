'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'gps-tracker-secret-2024';

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;
  if (!token) return res.status(401).json({ message: 'No autorizado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ message: 'Token inválido' });
  }
}

// ============================================================
// AUTH ROUTES
// ============================================================
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Credenciales requeridas' });
  
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND password_hash = ?').get(username, hash);
  
  if (!user) return res.status(401).json({ message: 'Credenciales incorrectas' });
  
  const token = jwt.sign(
    { id: user.id, username: user.username, company_id: user.company_id, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  
  res.json({ 
    token, 
    user: { id: user.id, username: user.username, email: user.email, company_id: user.company_id, role: user.role }
  });
});

router.post('/auth/refresh', authMiddleware, (req, res) => {
  const token = jwt.sign(
    { id: req.user.id, username: req.user.username, company_id: req.user.company_id, role: req.user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.status(201).json({ token });
});

// ============================================================
// DEVICES ROUTES
// ============================================================
router.get('/devices', authMiddleware, (req, res) => {
  const devices = db.prepare('SELECT * FROM devices WHERE company_id = ? ORDER BY name').all(req.user.company_id);
  res.json({ data: devices, meta: { total: devices.length } });
});

router.post('/devices', authMiddleware, (req, res) => {
  const { imei, name, brand, model, simcard_number, icon, color, speed_limit } = req.body;
  if (!imei || !name) return res.status(400).json({ message: 'IMEI y nombre son requeridos' });
  
  try {
    const result = db.prepare(
      'INSERT INTO devices (imei, name, brand, model, simcard_number, company_id, icon, color, speed_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(imei, name, brand || 'SINOTRACK', model || 'ST-906L', simcard_number, req.user.company_id, icon || 'truck', color || '#3b82f6', speed_limit);
    
    res.status(201).json({ id: result.lastInsertRowid, message: 'Dispositivo creado' });
  } catch(e) {
    res.status(400).json({ message: 'IMEI ya existe o error: ' + e.message });
  }
});

router.put('/devices/:imei', authMiddleware, (req, res) => {
  const { name, brand, model, simcard_number, icon, color, speed_limit, active } = req.body;
  db.prepare(
    'UPDATE devices SET name=?, brand=?, model=?, simcard_number=?, icon=?, color=?, speed_limit=?, active=?, updated_at=datetime("now") WHERE imei=? AND company_id=?'
  ).run(name, brand, model, simcard_number, icon, color, speed_limit, active !== undefined ? (active ? 1 : 0) : 1, req.params.imei, req.user.company_id);
  res.json({ message: 'Dispositivo actualizado' });
});

router.delete('/devices/:imei', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM devices WHERE imei=? AND company_id=?').run(req.params.imei, req.user.company_id);
  res.json({ message: 'Dispositivo eliminado' });
});

// ============================================================
// GPS POSITIONS
// ============================================================
router.post('/gps/positions/by-imeis', authMiddleware, (req, res) => {
  const { imeis } = req.body;
  if (!imeis || !Array.isArray(imeis)) return res.status(400).json({ message: 'imeis array required' });
  
  const positions = imeis.map(imei => {
    const pos = db.prepare('SELECT * FROM gps_positions WHERE device_imei = ?').get(imei);
    const device = db.prepare('SELECT * FROM devices WHERE imei = ?').get(imei);
    if (!pos) return null;
    return {
      ...pos,
      asset_name: device?.name || imei,
      device_brand: device?.brand || 'UNKNOWN',
      device_model: device?.model || 'UNKNOWN',
      ignition: !!pos.ignition,
      is_valid_gps: !!pos.is_valid_gps
    };
  }).filter(Boolean);
  
  res.status(201).json(positions);
});

router.get('/gps/positions/:imei', authMiddleware, (req, res) => {
  const pos = db.prepare('SELECT * FROM gps_positions WHERE device_imei = ?').get(req.params.imei);
  if (!pos) return res.status(404).json({ message: 'Sin posición' });
  res.json(pos);
});

// History / trips
router.get('/gps/history', authMiddleware, (req, res) => {
  const { imei, startDate, endDate, limit = 1000 } = req.query;
  if (!imei) return res.status(400).json({ message: 'imei required' });
  
  const history = db.prepare(
    'SELECT * FROM gps_history WHERE device_imei = ? AND gps_timestamp BETWEEN ? AND ? ORDER BY gps_timestamp ASC LIMIT ?'
  ).all(imei, startDate || '2020-01-01', endDate || '2099-12-31', parseInt(limit));
  
  res.json(history);
});

router.get('/gps/trips', authMiddleware, (req, res) => {
  const { imei, startDate, endDate } = req.query;
  if (!imei) return res.status(400).json({ message: 'imei required' });
  
  const trips = db.prepare(
    'SELECT * FROM trips WHERE device_imei = ? AND start_time BETWEEN ? AND ? ORDER BY start_time DESC'
  ).all(imei, startDate || '2020-01-01', endDate + 'T23:59:59' || '2099-12-31');
  
  res.json(trips);
});

// ============================================================
// STARTUP FLEET (compatible with NearGPS format)
// ============================================================
router.get('/startup-fleet/company/:companyId', authMiddleware, (req, res) => {
  const { page = 1, limit = 100 } = req.query;
  const companyId = parseInt(req.params.companyId) || req.user.company_id;
  
  const devices = db.prepare('SELECT * FROM devices WHERE company_id = ? AND active = 1 ORDER BY name').all(companyId);
  
  const data = devices.map((device, i) => {
    const pos = db.prepare('SELECT * FROM gps_positions WHERE device_imei = ?').get(device.imei);
    return {
      id: device.id,
      asset_id: device.id,
      device_id: device.id,
      company_id: device.company_id,
      created_at: device.created_at,
      updated_at: device.updated_at,
      device: {
        id: device.id,
        imei: device.imei,
        brand: device.brand,
        model: device.model,
        simcard_number: device.simcard_number,
        active: !!device.active,
        speed_limit: device.speed_limit,
        stop_threshold_minutes: 5,
        company_id: device.company_id,
        asset_type: { id: device.id, name: device.name, icon: device.icon || 'truck', color: device.color }
      },
      gpsPosition: pos ? {
        id: pos.id,
        device_imei: pos.device_imei,
        device_brand: device.brand,
        device_model: device.model,
        latitude: pos.latitude,
        longitude: pos.longitude,
        device_id: String(device.id),
        asset_name: device.name,
        asset_id: String(device.id),
        speed: pos.speed,
        heading: pos.heading,
        ignition: !!pos.ignition,
        fuel_level: null,
        odometer: pos.odometer,
        satellites: pos.satellites,
        is_valid_gps: !!pos.is_valid_gps,
        device_model: device.model,
        battery_level: pos.battery_level,
        voltage: pos.voltage,
        signal_gsm_quality: pos.signal_gsm_quality,
        gps_timestamp: pos.gps_timestamp,
        server_timestamp: pos.server_timestamp,
        geo_coding: pos.geo_coding,
        raw_data: pos.raw_data
      } : null
    };
  });
  
  res.json({
    data,
    meta: { page: parseInt(page), limit: parseInt(limit), total: devices.length, totalPages: 1 }
  });
});

// ============================================================
// ALERTS / PANIC EVENTS
// ============================================================
router.post('/gps/panic-events/unacknowledged', authMiddleware, (req, res) => {
  const alerts = db.prepare(
    'SELECT * FROM alerts WHERE company_id = ? AND is_acknowledged = 0 ORDER BY created_at DESC'
  ).all(req.user.company_id);
  res.status(201).json(alerts);
});

router.get('/alerts', authMiddleware, (req, res) => {
  const { page = 1, limit = 20, acknowledged } = req.query;
  const offset = (page - 1) * limit;
  
  let query = 'WHERE company_id = ?';
  if (acknowledged === 'false') query += ' AND is_acknowledged = 0';
  if (acknowledged === 'true') query += ' AND is_acknowledged = 1';
  
  const alerts = db.prepare(`SELECT * FROM alerts ${query} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(req.user.company_id, parseInt(limit), offset);
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM alerts ${query}`).get(req.user.company_id).cnt;
  
  res.json({ data: alerts, meta: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total/limit) } });
});

router.post('/alerts/:id/acknowledge', authMiddleware, (req, res) => {
  db.prepare('UPDATE alerts SET is_acknowledged=1, acknowledged_at=datetime("now"), acknowledged_by=? WHERE id=? AND company_id=?')
    .run(req.user.username, req.params.id, req.user.company_id);
  res.json({ message: 'Alerta atendida' });
});

router.delete('/alerts/all', authMiddleware, (req, res) => {
  db.prepare('UPDATE alerts SET is_acknowledged=1, acknowledged_at=datetime("now") WHERE company_id=?').run(req.user.company_id);
  res.json({ message: 'Todas las alertas atendidas' });
});

// ============================================================
// GEOFENCES
// ============================================================
router.get('/geofences/company/:companyId', authMiddleware, (req, res) => {
  const { page = 1, limit = 1000 } = req.query;
  const geofences = db.prepare('SELECT * FROM geofences WHERE company_id = ? ORDER BY created_at DESC').all(req.user.company_id);
  res.json({ data: geofences, meta: { total: geofences.length, page: parseInt(page), limit: parseInt(limit), totalPages: 1 } });
});

router.post('/geofences', authMiddleware, (req, res) => {
  const { name, description, shape, center_lat, center_lng, radius, coordinates, color, category, priority } = req.body;
  if (!name || !shape) return res.status(400).json({ message: 'Nombre y forma son requeridos' });
  
  const result = db.prepare(
    'INSERT INTO geofences (name, description, company_id, shape, center_lat, center_lng, radius, coordinates, color, category, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, description, req.user.company_id, shape, center_lat, center_lng, radius, JSON.stringify(coordinates), color || '#3b82f6', category, priority || 'low');
  
  res.status(201).json({ id: result.lastInsertRowid, message: 'Geocerca creada' });
});

router.put('/geofences/:id', authMiddleware, (req, res) => {
  const { name, description, color, category, priority, is_active } = req.body;
  db.prepare('UPDATE geofences SET name=?, description=?, color=?, category=?, priority=?, is_active=? WHERE id=? AND company_id=?')
    .run(name, description, color, category, priority, is_active ? 1 : 0, req.params.id, req.user.company_id);
  res.json({ message: 'Geocerca actualizada' });
});

router.delete('/geofences/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM geofences WHERE id=? AND company_id=?').run(req.params.id, req.user.company_id);
  res.json({ message: 'Geocerca eliminada' });
});

// ============================================================
// REFERENCE POINTS
// ============================================================
router.get('/references', authMiddleware, (req, res) => {
  const refs = db.prepare('SELECT * FROM references_points WHERE company_id = ? ORDER BY name').all(req.user.company_id);
  res.json({ data: refs, meta: { total: refs.length } });
});

router.post('/references', authMiddleware, (req, res) => {
  const { name, description, latitude, longitude, icon, color } = req.body;
  if (!name || !latitude || !longitude) return res.status(400).json({ message: 'Nombre y coordenadas requeridos' });
  
  const result = db.prepare(
    'INSERT INTO references_points (name, description, company_id, latitude, longitude, icon, color) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name, description, req.user.company_id, latitude, longitude, icon || 'pin', color || '#3b82f6');
  res.status(201).json({ id: result.lastInsertRowid });
});

router.delete('/references/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM references_points WHERE id=? AND company_id=?').run(req.params.id, req.user.company_id);
  res.json({ message: 'Referencia eliminada' });
});

// ============================================================
// SHARE LINKS
// ============================================================
router.get('/share-links', authMiddleware, (req, res) => {
  const { page = 1, limit = 10, statusNot } = req.query;
  const offset = (page - 1) * limit;
  
  let where = 'WHERE company_id = ?';
  const params = [req.user.company_id];
  if (statusNot) { where += ' AND status != ?'; params.push(statusNot); }
  
  // Update expired links
  db.prepare("UPDATE share_links SET status='expired' WHERE expires_at < datetime('now') AND status='active'").run();
  
  const links = db.prepare(`SELECT * FROM share_links ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), offset);
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM share_links ${where}`).get(...params).cnt;
  
  const data = links.map(l => ({
    ...l,
    imeis: JSON.parse(l.imeis || '[]'),
    display_names: JSON.parse(l.display_names || '[]'),
    devices: [],
    connected_devices: l.access_count
  }));
  
  res.json({ data, meta: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total/limit) } });
});

router.post('/share-links', authMiddleware, (req, res) => {
  const { imeis, display_names, expires_hours = 24, password } = req.body;
  if (!imeis || !imeis.length) return res.status(400).json({ message: 'imeis requeridos' });
  
  const token = 'ngps_' + crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + expires_hours * 3600000).toISOString();
  const passwordHash = password ? crypto.createHash('sha256').update(password).digest('hex') : null;
  
  const result = db.prepare(
    'INSERT INTO share_links (token, imeis, display_names, company_id, password_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(token, JSON.stringify(imeis), JSON.stringify(display_names || imeis), req.user.company_id, passwordHash, expiresAt);
  
  res.status(201).json({ id: result.lastInsertRowid, token, expires_at: expiresAt });
});

router.delete('/share-links/:id', authMiddleware, (req, res) => {
  db.prepare("UPDATE share_links SET status='revoked' WHERE id=? AND company_id=?").run(req.params.id, req.user.company_id);
  res.json({ message: 'Link revocado' });
});

// Public share tracking endpoint
router.get('/share/:token', (req, res) => {
  const link = db.prepare("SELECT * FROM share_links WHERE token=? AND status='active' AND expires_at > datetime('now')").get(req.params.token);
  if (!link) return res.status(404).json({ message: 'Link inválido o expirado' });
  
  const imeis = JSON.parse(link.imeis);
  const positions = imeis.map(imei => {
    const pos = db.prepare('SELECT * FROM gps_positions WHERE device_imei = ?').get(imei);
    const device = db.prepare('SELECT name FROM devices WHERE imei = ?').get(imei);
    return pos ? { ...pos, asset_name: device?.name || imei, ignition: !!pos.ignition } : null;
  }).filter(Boolean);
  
  // Update access count
  db.prepare('UPDATE share_links SET access_count = access_count + 1 WHERE token=?').run(req.params.token);
  
  res.json({ positions, display_names: JSON.parse(link.display_names || '[]') });
});

// ============================================================
// GEOCODING (reverse)
// ============================================================
router.get('/geocoding/reverse', authMiddleware, async (req, res) => {
  const { lat, lng } = req.query;
  try {
    // Use nominatim for free geocoding
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const response = await fetch(url, { headers: { 'User-Agent': 'GPS-Tracker/1.0' } });
    const data = await response.json();
    res.json({ address: data.display_name || `${lat}, ${lng}` });
  } catch(e) {
    res.json({ address: `${lat}, ${lng}` });
  }
});

// ============================================================
// COMMANDS (engine cut/restore via SMS simulation)
// ============================================================
router.post('/commands/send', authMiddleware, (req, res) => {
  const { imei, command } = req.body;
  // In production: integrate with SMS gateway or GPRS command channel
  // For now: log the command
  console.log(`Command sent to ${imei}: ${command}`);
  res.json({ message: `Comando "${command}" enviado a ${imei}`, note: 'Configure SMS gateway en .env para comandos reales' });
});

module.exports = router;
