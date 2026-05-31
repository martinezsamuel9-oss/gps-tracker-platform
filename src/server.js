'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const db = require('./db/database');
const gpsServer = require('./gps/tcpServer');
const apiRoutes = require('./api/routes');

const app = express();
const PORT = process.env.PORT || 3000;
const GPS_PORT = process.env.GPS_PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', apiRoutes);
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

global.wsClients = new Map();

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  const companyId = params.get('companyId') || 'default';
  if (!global.wsClients.has(companyId)) global.wsClients.set(companyId, new Set());
  global.wsClients.get(companyId).add(ws);
  console.log('WS client connected, company:', companyId);
  ws.on('close', () => { const c = global.wsClients.get(companyId); if (c) c.delete(ws); });
  ws.on('error', console.error);
});

global.broadcastGpsUpdate = (companyId, data) => {
  const clients = global.wsClients.get(companyId);
  if (!clients) return;
  const msg = JSON.stringify({ type: 'gps_update', data });
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
};

global.broadcastAlert = (companyId, alert) => {
  const clients = global.wsClients.get(companyId);
  if (!clients) return;
  const msg = JSON.stringify({ type: 'alert', data: alert });
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
};

gpsServer.start(GPS_PORT);

httpServer.listen(PORT, () => {
  console.log('\n================================');
  console.log('  GPS Tracker Platform');
  console.log('================================');
  console.log('  Web UI:   http://localhost:' + PORT);
  console.log('  GPS TCP:  port ' + GPS_PORT);
  console.log('  WS:       ws://localhost:' + PORT + '/ws');
  console.log('  Login:    admin / ' + (process.env.ADMIN_PASSWORD || 'admin123'));
  console.log('================================\n');
});

module.exports = { app, httpServer };
