const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SERIAL_PORT_NAME = process.env.SERIAL_PORT || 'COM3';
const BAUD_RATE = Number(process.env.BAUD_RATE || 115200);
const DB_PATH = path.join(__dirname, 'cushion_data.db');

app.use(cors());
app.use(express.json({ limit: '32kb' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('Database Error:', err.message);
  else console.log(`✅ SQLite connected: ${DB_PATH}`);
});

let serialPort = null;
let serialConnected = false;
let lastWifiAt = 0;
let lastSensorData = null;
let lastSensorAt = null;
let parser = null;
let serialRetryTimer = null;

// สถานะรอบการเก็บข้อมูล (Session & Fixed Countdown Timer)
let activeParticipant = '';
let activeNote = '';
let targetMinutes = 10;
let isRecording = false;
let sessionStartedAt = null;
let sessionEndTime = null;

const isWifiConnected = () => (Date.now() - lastWifiAt) < 3000;
const isAnyEspConnected = () => isWifiConnected() || serialConnected;
const getActiveSourceName = () => (isWifiConnected() ? 'Wi-Fi (192.168.137.1)' : SERIAL_PORT_NAME);

function broadcast(payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

function getSessionPayload() {
  const now = Date.now();
  const remainingMs = (isRecording && sessionEndTime) ? Math.max(0, sessionEndTime - now) : 0;
  return {
    type: 'session_state',
    isRecording,
    participantName: activeParticipant,
    note: activeNote,
    targetMinutes,
    sessionStartedAt,
    sessionEndTime,
    remainingSeconds: Math.ceil(remainingMs / 1000)
  };
}

function broadcastServerStatus() {
  broadcast({
    type: 'server_status',
    serialConnected: isAnyEspConnected(),
    serialPort: getActiveSourceName(),
    lastSensorAt
  });
  broadcast(getSessionPayload());
}

// ตรวจสอบการหมดเวลาทุก 500ms เพื่อหยุดบันทึกอัตโนมัติ
setInterval(() => {
  if (isRecording && sessionEndTime && Date.now() >= sessionEndTime) {
    isRecording = false;
    console.log(`⏰ ครบกำหนดเวลา ${targetMinutes} นาที สำหรับ: ${activeParticipant} -> หยุดบันทึกอัตโนมัติ`);
    broadcast({
      type: 'session_completed',
      participantName: activeParticipant,
      targetMinutes
    });
    broadcastServerStatus();
  }
}, 500);

setInterval(broadcastServerStatus, 2000);

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'server_status',
    serialConnected: isAnyEspConnected(),
    serialPort: getActiveSourceName(),
    lastSensorAt
  }));
  ws.send(JSON.stringify(getSessionPayload()));
  if (lastSensorData) ws.send(JSON.stringify({ type: 'sensor', ...lastSensorData }));
});

function ensureColumn(table, column, definition) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
      if (err) return reject(err);
      if (rows.some((row) => row.name === column)) return resolve();
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (alterErr) => {
        if (alterErr) reject(alterErr);
        else resolve();
      });
    });
  });
}

function initDatabase() {
  return new Promise((resolve, reject) => {
    db.run('PRAGMA journal_mode=WAL;');
    db.run(`
      CREATE TABLE IF NOT EXISTS sensor_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER,
        fsr_seat_l INTEGER,
        fsr_seat_r INTEGER,
        fsr_back_l INTEGER,
        fsr_back_r INTEGER,
        emg INTEGER,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, async (err) => {
      if (err) return reject(err);
      try {
        await ensureColumn('sensor_logs', 'ad8232_raw', 'REAL');
        await ensureColumn('sensor_logs', 'participant_name', 'TEXT');
        await ensureColumn('sensor_logs', 'session_note', 'TEXT');
        await ensureColumn('sensor_logs', 'target_minutes', 'INTEGER');
        await new Promise((backfillResolve, backfillReject) => {
          db.run('UPDATE sensor_logs SET ad8232_raw = emg WHERE ad8232_raw IS NULL AND emg IS NOT NULL', (backfillErr) => {
            if (backfillErr) backfillReject(backfillErr);
            else backfillResolve();
          });
        });
        resolve();
      } catch (migrationError) {
        reject(migrationError);
      }
    });
  });
}

function toSafeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(4095, Math.round(n * 100) / 100)) : fallback;
}

function parseSensorLine(line) {
  const clean = String(line || '').trim().replace(/^\uFEFF/, '');
  if (!clean || clean.startsWith('#') || clean.startsWith('[') || /^timestamp/i.test(clean)) return null;

  const parts = clean.split(',').map((part) => part.trim());
  if (parts.length < 6) return null;

  const timestampMs = Number.parseInt(parts[0], 10);
  const status = parts[6] || 'NORMAL';
  return {
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
    fsrSeatL: toSafeNumber(parts[1]),
    fsrSeatR: toSafeNumber(parts[2]),
    fsrBackL: toSafeNumber(parts[3]),
    fsrBackR: toSafeNumber(parts[4]),
    ad8232Raw: toSafeNumber(parts[5]),
    status: status.slice(0, 64)
  };
}

const DB_SAVE_INTERVAL_MS = 10000; // บันทึกลงฐานข้อมูลทุกๆ 10 วินาที (10,000 ms)
  let lastDbSaveAt = 0; 

function handleIncomingSensor(data) {
  lastSensorData = {
    ...data,
    participantName: activeParticipant || 'Unspecified',
    isRecording
  };
  lastSensorAt = new Date().toISOString();

  // ส่งขึ้นกราฟหน้าเว็บตลอดเวลาเพื่อดูค่าสด
  broadcast({ type: 'sensor', ...lastSensorData, receivedAt: lastSensorAt });

  // บันทึกลง SQLite เฉพาะตอนที่อยู่ในช่วงเวลาเก็บข้อมูล (isRecording = true)
  if (!isRecording) return;

  // หน่วงเวลา: ถ้ายังไม่ครบ 10 วินาทีจากรอบก่อน ให้ข้ามการบันทึกลง DB (แต่กราฟหน้าเว็บยังวิ่งปกติ)
  const now = Date.now();
  if (now - lastDbSaveAt < DB_SAVE_INTERVAL_MS) return;
  lastDbSaveAt = now;

  const sql = `
    INSERT INTO sensor_logs
      (participant_name, session_note, target_minutes, timestamp_ms, fsr_seat_l, fsr_seat_r, fsr_back_l, fsr_back_r, emg, ad8232_raw, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(sql, [
    activeParticipant || 'Unspecified',
    activeNote,
    targetMinutes,
    data.timestampMs,
    data.fsrSeatL,
    data.fsrSeatR,
    data.fsrBackL,
    data.fsrBackR,
    null,
    data.ad8232Raw,
    data.status
  ]);
}

function scheduleSerialRetry() {
  if (serialRetryTimer) clearTimeout(serialRetryTimer);
  serialRetryTimer = setTimeout(() => {
    if (!serialConnected && !isWifiConnected()) openSerialConnection();
  }, 5000);
}

function openSerialConnection() {
  if (serialConnected) return;
  serialPort = new SerialPort({ path: SERIAL_PORT_NAME, baudRate: BAUD_RATE, autoOpen: false });
  serialPort.on('error', () => {
    serialConnected = false;
    broadcastServerStatus();
    scheduleSerialRetry();
  });
  serialPort.on('close', () => {
    serialConnected = false;
    broadcastServerStatus();
    scheduleSerialRetry();
  });

  serialPort.open((err) => {
    if (err) {
      serialConnected = false;
      broadcastServerStatus();
      scheduleSerialRetry();
      return;
    }

    if (serialRetryTimer) clearTimeout(serialRetryTimer);
    serialConnected = true;
    console.log(`🔌 ESP32 connected on USB ${SERIAL_PORT_NAME} @ ${BAUD_RATE}`);
    broadcastServerStatus();
    parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (line) => {
      const data = parseSensorLine(line);
      if (!data) return;
      handleIncomingSensor(data);
    });
  });
}

// ---- API ENDPOINTS ----

// เริ่มรอบเก็บข้อมูลใหม่พร้อมตั้งเวลาถอยหลัง (5 / 10 / 15 นาที)
app.post('/api/session', (req, res) => {
  const { participantName = 'Unspecified', note = '', durationMinutes = 10 } = req.body || {};
  activeParticipant = String(participantName).trim() || 'Unspecified';
  activeNote = String(note).trim();
  targetMinutes = Math.max(0.5, Math.min(120, Number(durationMinutes) || 10));

  isRecording = true;
  lastDbSaveAt = 0;
  sessionStartedAt = Date.now();
  sessionEndTime = sessionStartedAt + (targetMinutes * 60 * 1000);

  console.log(`▶️ เริ่มเก็บข้อมูล: ${activeParticipant} | กำหนดเวลา ${targetMinutes} นาที`);
  broadcastServerStatus();
  res.json({ ok: true, ...getSessionPayload() });
});

// หยุดบันทึกชั่วคราว / จบรอบก่อนกำหนด
app.post('/api/session/stop', (req, res) => {
  isRecording = false;
  console.log(`⏹️ หยุดเก็บข้อมูลของ: ${activeParticipant}`);
  broadcastServerStatus();
  res.json({ ok: true, ...getSessionPayload() });
});

// รับข้อมูลไร้สายจาก ESP32 (Core 0)
app.post('/api/sensor', (req, res) => {
  const body = req.body || {};
  lastWifiAt = Date.now();
  const data = {
    timestampMs: Number.isFinite(Number(body.timestampMs)) ? Number(body.timestampMs) : Date.now(),
    fsrSeatL: toSafeNumber(body.fsrSeatL),
    fsrSeatR: toSafeNumber(body.fsrSeatR),
    fsrBackL: toSafeNumber(body.fsrBackL),
    fsrBackR: toSafeNumber(body.fsrBackR),
    ad8232Raw: toSafeNumber(body.ad8232Raw),
    status: String(body.status || 'NORMAL').slice(0, 64)
  };
  handleIncomingSensor(data);
  res.status(200).json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({
    serialConnected: isAnyEspConnected(),
    serialPort: getActiveSourceName(),
    ...getSessionPayload(),
    lastSensorAt,
    lastSensorData
  });
});

// API สรุปผลการนั่งแยกตามรายชื่อผู้ทดสอบ (Individual Participant Clinical Summary)
app.get('/api/summary/participants', (req, res) => {
  const strainThreshold = Math.max(50, Number(req.query.threshold) || 350);

  db.all(`
    SELECT
      COALESCE(NULLIF(TRIM(participant_name), ''), 'Unspecified') AS participant_name,
      MAX(COALESCE(session_note, '')) AS session_note,
      MAX(COALESCE(target_minutes, 10)) AS target_minutes,
      MIN(datetime(created_at, '+7 hours')) AS started_at,
      MAX(datetime(created_at, '+7 hours')) AS ended_at,
      COUNT(*) AS total_samples,
      AVG(fsr_seat_l) AS avg_fsr1,
      AVG(fsr_seat_r) AS avg_fsr2,
      AVG(fsr_back_l) AS avg_fsr3,
      AVG(fsr_back_r) AS avg_fsr4,
      SUM(CASE WHEN (COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0)) >= 300 THEN 1 ELSE 0 END) AS seated_samples,
      AVG(CASE WHEN (COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0)) >= 300
          THEN 100.0 * (1.0 - (ABS(COALESCE(fsr_seat_l,0) - COALESCE(fsr_seat_r,0)) * 1.0) / MAX(1.0, COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0)))
          END) AS avg_seat_balance,
      SUM(CASE WHEN (COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0)) >= 300
          AND (100.0 * ABS(COALESCE(fsr_seat_l,0) - COALESCE(fsr_seat_r,0)) / MAX(1.0, COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0))) <= 25
          THEN 1 ELSE 0 END) AS balanced_samples,
      SUM(CASE WHEN (COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0)) >= 300
          AND (100.0 * ABS(COALESCE(fsr_seat_l,0) - COALESCE(fsr_seat_r,0)) / MAX(1.0, COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0))) > 25
          AND COALESCE(fsr_seat_l,0) > COALESCE(fsr_seat_r,0)
          THEN 1 ELSE 0 END) AS lean_left_samples,
      SUM(CASE WHEN (COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0)) >= 300
          AND (100.0 * ABS(COALESCE(fsr_seat_l,0) - COALESCE(fsr_seat_r,0)) / MAX(1.0, COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0))) > 25
          AND COALESCE(fsr_seat_r,0) > COALESCE(fsr_seat_l,0)
          THEN 1 ELSE 0 END) AS lean_right_samples,
      AVG(COALESCE(ad8232_raw, emg, 0)) AS avg_emg,
      MAX(COALESCE(ad8232_raw, emg, 0)) AS peak_emg,
      SUM(CASE WHEN COALESCE(ad8232_raw, emg, 0) >= ? THEN 1 ELSE 0 END) AS strain_samples
    FROM sensor_logs
    GROUP BY COALESCE(NULLIF(TRIM(participant_name), ''), 'Unspecified')
    ORDER BY MAX(id) DESC
  `, [strainThreshold], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const formatted = rows.map((r) => {
      const total = Math.max(1, Number(r.total_samples || 0));
      const seated = Math.max(1, Number(r.seated_samples || 0));
      const actualMinutes = +(Number(r.total_samples || 0) * (DB_SAVE_INTERVAL_MS / 1000) / 60).toFixed(2);

      return {
        participant_name: r.participant_name,
        session_note: r.session_note,
        target_minutes: r.target_minutes,
        started_at: r.started_at,
        ended_at: r.ended_at,
        total_samples: r.total_samples,
        actual_minutes: actualMinutes,
        avg_fsr1: Math.round(r.avg_fsr1 || 0),
        avg_fsr2: Math.round(r.avg_fsr2 || 0),
        avg_fsr3: Math.round(r.avg_fsr3 || 0),
        avg_fsr4: Math.round(r.avg_fsr4 || 0),
        avg_seat_balance: r.avg_seat_balance != null ? +Number(r.avg_seat_balance).toFixed(1) : 0,
        balanced_pct: r.seated_samples > 0 ? +((r.balanced_samples * 100) / seated).toFixed(1) : 0,
        lean_left_pct: r.seated_samples > 0 ? +((r.lean_left_samples * 100) / seated).toFixed(1) : 0,
        lean_right_pct: r.seated_samples > 0 ? +((r.lean_right_samples * 100) / seated).toFixed(1) : 0,
        avg_emg: +Number(r.avg_emg || 0).toFixed(1),
        peak_emg: Math.round(r.peak_emg || 0),
        strain_pct: +((r.strain_samples * 100) / total).toFixed(1)
      };
    });

    res.json(formatted);
  });
});

// API ค้นหาข้อมูลสรุปและประวัติการตรวจรายบุคคล (ค้นหาตามชื่อคนไข้)
app.get('/api/patient/search', (req, res) => {
  const queryName = String(req.query.name || '').trim();
  const strainThreshold = Math.max(50, Number(req.query.threshold) || 350);

  if (!queryName) {
    return res.json({ summaries: [], logs: [] });
  }

  const likePattern = `%${queryName}%`;

  const summarySql = `
    SELECT
      COALESCE(NULLIF(TRIM(participant_name), ''), 'Unspecified') AS participant_name,
      MAX(COALESCE(session_note, '')) AS session_note,
      MAX(COALESCE(target_minutes, 10)) AS target_minutes,
      MIN(datetime(created_at, '+7 hours')) AS started_at,
      MAX(datetime(created_at, '+7 hours')) AS ended_at,
      COUNT(*) AS total_samples,
      AVG(fsr_seat_l) AS avg_fsr1,
      AVG(fsr_seat_r) AS avg_fsr2,
      AVG(fsr_back_l) AS avg_fsr3,
      AVG(fsr_back_r) AS avg_fsr4,
      SUM(CASE WHEN (COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0)) >= 300 THEN 1 ELSE 0 END) AS seated_samples,
      AVG(CASE WHEN (COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0)) >= 300
          THEN 100.0 * (1.0 - (ABS(COALESCE(fsr_seat_l,0) - COALESCE(fsr_seat_r,0)) * 1.0) / MAX(1.0, COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0)))
          END) AS avg_seat_balance,
      SUM(CASE WHEN (COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0)) >= 300
          AND (100.0 * ABS(COALESCE(fsr_seat_l,0) - COALESCE(fsr_seat_r,0)) / MAX(1.0, COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0))) <= 25
          THEN 1 ELSE 0 END) AS balanced_samples,
      SUM(CASE WHEN (COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0)) >= 300
          AND (100.0 * ABS(COALESCE(fsr_seat_l,0) - COALESCE(fsr_seat_r,0)) / MAX(1.0, COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0))) > 25
          AND COALESCE(fsr_seat_l,0) > COALESCE(fsr_seat_r,0)
          THEN 1 ELSE 0 END) AS lean_left_samples,
      SUM(CASE WHEN (COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0)) >= 300
          AND (100.0 * ABS(COALESCE(fsr_seat_l,0) - COALESCE(fsr_seat_r,0)) / MAX(1.0, COALESCE(fsr_seat_l,0) + COALESCE(fsr_seat_r,0))) > 25
          AND COALESCE(fsr_seat_r,0) > COALESCE(fsr_seat_l,0)
          THEN 1 ELSE 0 END) AS lean_right_samples,
      AVG(COALESCE(ad8232_raw, emg, 0)) AS avg_emg,
      MAX(COALESCE(ad8232_raw, emg, 0)) AS peak_emg,
      SUM(CASE WHEN COALESCE(ad8232_raw, emg, 0) >= ? THEN 1 ELSE 0 END) AS strain_samples
    FROM sensor_logs
    WHERE TRIM(participant_name) LIKE ?
    GROUP BY COALESCE(NULLIF(TRIM(participant_name), ''), 'Unspecified')
    ORDER BY MAX(id) DESC
  `;

  const logsSql = `
    SELECT id, datetime(created_at, '+7 hours') AS created_at,
           COALESCE(participant_name, 'Unspecified') AS participant_name,
           session_note,
           fsr_seat_l, fsr_seat_r, fsr_back_l, fsr_back_r,
           COALESCE(ad8232_raw, emg, 0) AS ad8232_raw,
           status
    FROM sensor_logs
    WHERE TRIM(participant_name) LIKE ?
    ORDER BY id DESC
    LIMIT 500
  `;

  db.all(summarySql, [strainThreshold, likePattern], (err, summaryRows) => {
    if (err) return res.status(500).json({ error: err.message });

    const summaries = summaryRows.map((r) => {
      const total = Math.max(1, Number(r.total_samples || 0));
      const seated = Math.max(1, Number(r.seated_samples || 0));
      const actualMinutes = +(Number(r.total_samples || 0) * (DB_SAVE_INTERVAL_MS / 1000) / 60).toFixed(2);

      return {
        participant_name: r.participant_name,
        session_note: r.session_note,
        target_minutes: r.target_minutes,
        started_at: r.started_at,
        ended_at: r.ended_at,
        total_samples: r.total_samples,
        actual_minutes: actualMinutes,
        avg_fsr1: Math.round(r.avg_fsr1 || 0),
        avg_fsr2: Math.round(r.avg_fsr2 || 0),
        avg_fsr3: Math.round(r.avg_fsr3 || 0),
        avg_fsr4: Math.round(r.avg_fsr4 || 0),
        avg_seat_balance: r.avg_seat_balance != null ? +Number(r.avg_seat_balance).toFixed(1) : 0,
        balanced_pct: r.seated_samples > 0 ? +((r.balanced_samples * 100) / seated).toFixed(1) : 0,
        lean_left_pct: r.seated_samples > 0 ? +((r.lean_left_samples * 100) / seated).toFixed(1) : 0,
        lean_right_pct: r.seated_samples > 0 ? +((r.lean_right_samples * 100) / seated).toFixed(1) : 0,
        avg_emg: +Number(r.avg_emg || 0).toFixed(1),
        peak_emg: Math.round(r.peak_emg || 0),
        strain_pct: +((r.strain_samples * 100) / total).toFixed(1)
      };
    });

    db.all(logsSql, [likePattern], (err2, logRows) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ summaries, logs: logRows });
    });
  });
});

app.get('/api/logs/latest', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number.parseInt(req.query.limit, 10) || 50));
  db.all(`
    SELECT id, datetime(created_at, '+7 hours') AS created_at,
           COALESCE(participant_name, 'Unspecified') AS participant_name,
           session_note, timestamp_ms,
           fsr_seat_l, fsr_seat_r, fsr_back_l, fsr_back_r,
           COALESCE(ad8232_raw, emg, 0) AS ad8232_raw,
           status
    FROM sensor_logs ORDER BY id DESC LIMIT ?
  `, [limit], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/logs/export.csv', (req, res) => {
  db.all(`
    SELECT id, datetime(created_at, '+7 hours') AS created_at,
           COALESCE(participant_name, '') AS participant_name,
           COALESCE(session_note, '') AS session_note,
           COALESCE(target_minutes, 10) AS target_minutes,
           timestamp_ms, fsr_seat_l, fsr_seat_r, fsr_back_l, fsr_back_r,
           COALESCE(ad8232_raw, emg, 0) AS ad8232_raw, status
    FROM sensor_logs ORDER BY id ASC
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const columns = [
      'id', 'created_at', 'participant_name', 'session_note', 'target_minutes',
      'timestamp_ms', 'fsr_seat_l', 'fsr_seat_r', 'fsr_back_l', 'fsr_back_r',
      'ad8232_raw', 'status'
    ];
    const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => {
      const value = row[key] == null ? '' : String(row[key]);
      return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    }).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lumbar_raw_logs.csv"');
    res.send('\uFEFF' + csv);
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

initDatabase()
  .then(() => {
    console.log('✅ sensor_logs ready (Dual-Core Wi-Fi/USB & Auto-Timer Ready)');
    openSerialConnection();
  })
  .catch((err) => {
    console.error('❌ Database initialization failed:', err.message);
    process.exitCode = 1;
  });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Dashboard: http://localhost:${PORT}`);
  console.log(`🗄️ SQLite: ${DB_PATH}`);
});

function shutdown() {
  if (serialPort && serialPort.isOpen) serialPort.close();
  db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);