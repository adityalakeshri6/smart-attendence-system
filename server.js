const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const QRCode = require('qrcode');
const path = require('path');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_MINUTES = 10; // QR code validity window

// ---------- COURSES ----------
app.post('/api/courses', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const stmt = db.prepare('INSERT INTO courses (name) VALUES (?)');
  const result = stmt.run(name);
  res.json({ course_id: result.lastInsertRowid, name });
});

app.get('/api/courses', (req, res) => {
  const courses = db.prepare('SELECT * FROM courses ORDER BY name').all();
  res.json(courses);
});

// ---------- STUDENTS ----------
app.post('/api/students', (req, res) => {
  const { name, roll_no, course_id } = req.body;
  if (!name || !roll_no || !course_id) {
    return res.status(400).json({ error: 'name, roll_no, course_id are required' });
  }
  const student_token = crypto.randomBytes(16).toString('hex');
  try {
    const stmt = db.prepare(
      'INSERT INTO students (name, roll_no, course_id, student_token) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(name, roll_no, course_id, student_token);
    res.json({ student_id: result.lastInsertRowid, name, roll_no, course_id, student_token });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'roll_no already exists in this course' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students', (req, res) => {
  const { course_id } = req.query;
  let students;
  if (course_id) {
    students = db.prepare('SELECT * FROM students WHERE course_id = ? ORDER BY roll_no').all(course_id);
  } else {
    students = db.prepare('SELECT * FROM students ORDER BY roll_no').all();
  }
  res.json(students);
});

// ---------- SESSIONS ----------
app.post('/api/sessions/start', (req, res) => {
  const { course_id } = req.body;
  if (!course_id) return res.status(400).json({ error: 'course_id is required' });

  const course = db.prepare('SELECT * FROM courses WHERE course_id = ?').get(course_id);
  if (!course) return res.status(404).json({ error: 'course not found' });

  const qr_token = crypto.randomBytes(12).toString('hex');
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const start_time = now.toTimeString().slice(0, 8);
  const expires_at = new Date(now.getTime() + SESSION_MINUTES * 60000).toISOString();

  const stmt = db.prepare(
    `INSERT INTO sessions (course_id, date, start_time, qr_token, expires_at, status)
     VALUES (?, ?, ?, ?, ?, 'active')`
  );
  const result = stmt.run(course_id, date, start_time, qr_token, expires_at);
  const session_id = result.lastInsertRowid;

  res.json({ session_id, course_id, qr_token, expires_at, date, start_time });
});

// Get a QR code image (PNG data URL) for a session
app.get('/api/sessions/:id/qrcode', async (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });

  const payload = JSON.stringify({ session_id: session.session_id, qr_token: session.qr_token });
  try {
    const dataUrl = await QRCode.toDataURL(payload, { width: 320, margin: 1 });
    res.json({ dataUrl, expires_at: session.expires_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/close', (req, res) => {
  db.prepare(`UPDATE sessions SET status = 'closed' WHERE session_id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json(session);
});

// ---------- ATTENDANCE ----------
app.post('/api/attendance/mark', (req, res) => {
  const { session_id, qr_token, student_token } = req.body;
  if (!session_id || !qr_token || !student_token) {
    return res.status(400).json({ error: 'session_id, qr_token, student_token are required' });
  }

  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(session_id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (session.qr_token !== qr_token) return res.status(403).json({ error: 'invalid QR code' });
  if (session.status !== 'active') return res.status(410).json({ error: 'session is closed' });
  if (new Date(session.expires_at) < new Date()) {
    return res.status(410).json({ error: 'QR code has expired' });
  }

  const student = db.prepare('SELECT * FROM students WHERE student_token = ?').get(student_token);
  if (!student) return res.status(404).json({ error: 'student not recognized' });
  if (student.course_id !== session.course_id) {
    return res.status(403).json({ error: 'student is not enrolled in this course' });
  }

  try {
    const stmt = db.prepare(
      'INSERT INTO attendance (session_id, student_id) VALUES (?, ?)'
    );
    stmt.run(session_id, student.student_id);
    res.json({ ok: true, message: `Attendance marked for ${student.name}` });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'attendance already marked for this session' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id/attendance', (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.scanned_at, s.student_id, s.name, s.roll_no
    FROM attendance a
    JOIN students s ON s.student_id = a.student_id
    WHERE a.session_id = ?
    ORDER BY a.scanned_at
  `).all(req.params.id);

  const total = db.prepare('SELECT COUNT(*) c FROM students WHERE course_id = (SELECT course_id FROM sessions WHERE session_id = ?)').get(req.params.id).c;

  res.json({ present: rows, present_count: rows.length, total_students: total });
});

// ---------- Serve frontend for QR scanner student token lookup helper ----------
app.get('/api/students/:id/qrcode', async (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE student_id = ?').get(req.params.id);
  if (!student) return res.status(404).json({ error: 'student not found' });
  const payload = JSON.stringify({ type: 'student_id_card', student_token: student.student_token });
  const dataUrl = await QRCode.toDataURL(payload, { width: 280, margin: 1 });
  res.json({ dataUrl, name: student.name, roll_no: student.roll_no });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`QR Attendance server running on port ${PORT}`));
