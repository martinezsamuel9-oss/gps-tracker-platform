'use strict';
/**
 * GPS TCP Server - Handles Sinotrack/HQ Protocol
 * Protocol format: *HQ,IMEI,CMD,TIME,STATUS,LAT,N/S,LNG,E/W,SPEED,HEADING,DATE,MILEAGE,CELL,...#
 * Example: *HQ,7026246723,V8,032823,A,1403.0266,N,08712.1964,W,000.00,341,310526,FFFFFBFF,708,01,17701,6180098,17,31,128,100#
 */
const net = require('net');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');

// Prepared statements
const upsertPosition = db.prepare(`
  INSERT OR REPLACE INTO gps_positions 
  (id, device_imei, latitude, longitude, speed, heading, ignition, satellites, 
   battery_level, voltage, signal_gsm_quality, odometer, raw_data, gps_timestamp, server_timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

const insertHistory = db.prepare(`
  INSERT INTO gps_history 
  (device_imei, latitude, longitude, speed, heading, ignition, satellites, 
   battery_level, voltage, odometer, raw_data, gps_timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getDevice = db.prepare('SELECT * FROM devices WHERE imei = ?');
const getPosition = db.prepare('SELECT * FROM gps_positions WHERE device_imei = ?');

/**
 * Parse HQ Protocol packet
 * *HQ,IMEI,CMD,HHMMSS,STATUS,DDMM.MMMM,N/S,DDDMM.MMMM,E/W,SPEED,HEADING,DDMMYY,...#
 */
function parseHQPacket(raw) {
  try {
    // Remove * prefix and # suffix
    const cleaned = raw.replace(/^\*/, '').replace(/#$/, '').trim();
    const parts = cleaned.split(',');
    
    if (parts.length < 11 || parts[0] !== 'HQ') return null;
    
    const imei = parts[1];
    const cmd = parts[2];
    const timeStr = parts[3]; // HHMMSS
    const status = parts[4];  // A=valid, V=invalid
    
    if (!imei || imei.length < 10) return null;
    
    // Parse latitude: DDMM.MMMM N/S
    const rawLat = parseFloat(parts[5]);
    const latDir = parts[6];
    const latDeg = Math.floor(rawLat / 100);
    const latMin = rawLat - (latDeg * 100);
    let latitude = latDeg + (latMin / 60);
    if (latDir === 'S') latitude = -latitude;
    
    // Parse longitude: DDDMM.MMMM E/W
    const rawLng = parseFloat(parts[7]);
    const lngDir = parts[8];
    const lngDeg = Math.floor(rawLng / 100);
    const lngMin = rawLng - (lngDeg * 100);
    let longitude = lngDeg + (lngMin / 60);
    if (lngDir === 'W') longitude = -longitude;
    
    const speed = parseFloat(parts[9]) || 0;  // km/h
    const heading = parseFloat(parts[10]) || 0;
    
    // Date: DDMMYY
    const dateStr = parts[11] || '';
    let gpsTimestamp = new Date().toISOString();
    try {
      if (dateStr.length === 6 && timeStr.length === 6) {
        const day = dateStr.substring(0, 2);
        const month = dateStr.substring(2, 4);
        const year = '20' + dateStr.substring(4, 6);
        const hh = timeStr.substring(0, 2);
        const mm = timeStr.substring(2, 4);
        const ss = timeStr.substring(4, 6);
        gpsTimestamp = new Date(`${year}-${month}-${day}T${hh}:${mm}:${ss}Z`).toISOString();
      }
    } catch(e) {}
    
    // Parse flags byte (FFFFFBFF or similar)
    const flagsHex = parts[12] || 'FFFFFFFF';
    const flags = parseInt(flagsHex, 16);
    const ignition = !!(flags & 0x40);  // bit 6
    const panicAlert = !!(flags & 0x10); // bit 4
    
    // Cell info
    const mcc = parseInt(parts[13]) || 0;
    const mnc = parseInt(parts[14]) || 0;
    const lac = parseInt(parts[15]) || 0;
    const cellId = parseInt(parts[16]) || 0;
    
    // GPS info
    const satellites = parseInt(parts[17]) || 0;
    const gsm = parseInt(parts[18]) || 0;
    const voltage_raw = parseInt(parts[19]) || 0;
    const battery = parseInt(parts[20]) || 100;
    
    // Convert voltage: value / 10 gives actual voltage
    const voltage = voltage_raw / 10;
    const signal_gsm = Math.min(100, (gsm / 31) * 100);
    
    const isValid = status === 'A' && latitude !== 0 && longitude !== 0;
    
    return {
      imei, cmd, status, latitude, longitude, speed, heading,
      ignition, satellites, voltage, battery_level: battery,
      signal_gsm_quality: Math.round(signal_gsm),
      mcc, mnc, lac, cell_id: cellId,
      gps_timestamp: gpsTimestamp,
      is_valid_gps: isValid,
      panic_alert: panicAlert,
      raw_data: raw
    };
  } catch (err) {
    console.error('Parse error:', err.message, 'for:', raw);
    return null;
  }
}

/**
 * Calculate odometer from history
 */
function updateOdometer(imei, newLat, newLng) {
  try {
    const prev = getPosition.get(imei);
    if (!prev) return 0;
    
    // Haversine formula
    const R = 6371; // km
    const dLat = (newLat - prev.latitude) * Math.PI / 180;
    const dLng = (newLng - prev.longitude) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(prev.latitude * Math.PI / 180) * Math.cos(newLat * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const dist = R * c;
    
    return (prev.odometer || 0) + (dist > 0.001 ? dist : 0);
  } catch(e) {
    return 0;
  }
}

/**
 * Process parsed GPS data
 */
function processGpsData(parsed) {
  const device = getDevice.get(parsed.imei);
  if (!device) {
    console.log(`Unknown device IMEI: ${parsed.imei} - ignoring`);
    return;
  }
  
  const odometer = updateOdometer(parsed.imei, parsed.latitude, parsed.longitude);
  const posId = uuidv4();
  
  // Update current position
  upsertPosition.run(
    posId, parsed.imei, parsed.latitude, parsed.longitude,
    parsed.speed, parsed.heading, parsed.ignition ? 1 : 0,
    parsed.satellites, parsed.battery_level, parsed.voltage,
    parsed.signal_gsm_quality, odometer, parsed.raw_data,
    parsed.gps_timestamp
  );
  
  // Insert into history (every position)
  insertHistory.run(
    parsed.imei, parsed.latitude, parsed.longitude,
    parsed.speed, parsed.heading, parsed.ignition ? 1 : 0,
    parsed.satellites, parsed.battery_level, parsed.voltage,
    odometer, parsed.raw_data, parsed.gps_timestamp
  );
  
  // Broadcast to WebSocket clients
  const positionData = {
    device_imei: parsed.imei,
    asset_name: device.name,
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    speed: parsed.speed,
    heading: parsed.heading,
    ignition: parsed.ignition,
    satellites: parsed.satellites,
    battery_level: parsed.battery_level,
    voltage: parsed.voltage,
    signal_gsm_quality: parsed.signal_gsm_quality,
    odometer,
    gps_timestamp: parsed.gps_timestamp,
    is_valid_gps: parsed.is_valid_gps
  };
  
  if (global.broadcastGpsUpdate) {
    global.broadcastGpsUpdate(String(device.company_id), positionData);
  }
  
  // Handle panic alert
  if (parsed.panic_alert) {
    const alert = {
      id: uuidv4(),
      type: 'panic',
      device_imei: parsed.imei,
      device_name: device.name,
      company_id: device.company_id,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      message: 'Alerta de pánico',
      created_at: new Date().toISOString()
    };
    
    db.prepare(`
      INSERT OR IGNORE INTO alerts (id, type, device_imei, device_name, company_id, latitude, longitude, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(alert.id, alert.type, alert.device_imei, alert.device_name, 
            alert.company_id, alert.latitude, alert.longitude, alert.message);
    
    if (global.broadcastAlert) {
      global.broadcastAlert(String(device.company_id), alert);
    }
    console.log(`PANIC ALERT from ${device.name} (${parsed.imei})`);
  }
  
  console.log(`GPS: ${device.name} | ${parsed.latitude.toFixed(5)}, ${parsed.longitude.toFixed(5)} | ${parsed.speed}km/h | ${parsed.ignition?'ON':'OFF'}`);
}

// TCP Server instance
let server;

function start(port) {
  server = net.createServer((socket) => {
    const clientAddr = socket.remoteAddress + ':' + socket.remotePort;
    console.log(`GPS device connected: ${clientAddr}`);
    
    let buffer = '';
    
    socket.on('data', (data) => {
      buffer += data.toString();
      
      // Process complete packets (end with #)
      const packets = buffer.split('#');
      buffer = packets.pop(); // Keep incomplete packet in buffer
      
      packets.forEach(packet => {
        const raw = (packet + '#').trim();
        if (!raw.startsWith('*')) return;
        
        const parsed = parseHQPacket(raw);
        if (parsed && parsed.is_valid_gps) {
          try {
            processGpsData(parsed);
          } catch(e) {
            console.error('Error processing GPS data:', e.message);
          }
        }
      });
    });
    
    socket.on('error', (err) => {
      console.error(`GPS socket error (${clientAddr}):`, err.message);
    });
    
    socket.on('close', () => {
      console.log(`GPS device disconnected: ${clientAddr}`);
    });
    
    socket.setTimeout(300000); // 5 min timeout
    socket.on('timeout', () => socket.destroy());
  });
  
  server.listen(port, '0.0.0.0', () => {
    console.log(`GPS TCP Server listening on port ${port} (Sinotrack/HQ Protocol)`);
  });
  
  server.on('error', (err) => {
    console.error('GPS Server error:', err);
  });
  
  return server;
}

module.exports = { start, parseHQPacket };
