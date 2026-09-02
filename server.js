const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { signToken, requireAuth } = require('./auth');
const { distanceMeters } = require('./geo');
const { isValidEmail, isNonEmptyString, isValidCoordinate, isPositiveInt } = require('./validate');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_MINUTES = 10; // QR code validity window

// Rate limit login/register only — generous enough that a real user mistyping
// their password a few times never gets blocked, but stops automated guessing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});

// ================= AUTH =================
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { institute_name, email, password } = req.body;
  if (!isNonEmptyString(institute_name, 200)) {
    return res.status(400).json({ error: 'institute_name is required' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'a valid email is required' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    return res.status(400).json({ error: 'password must be between 6 and 128 characters' });
  }
  const normalizedEmail = email.trim().toLowerCase();

  const existing = db.prepare('SELECT institute_id FROM institutes WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'an account with this email already exists' });

  const password_hash = await bcrypt.hash(password, 10);
  const stmt = db.prepare(
    'INSERT INTO institutes (name, email, password_hash) VALUES (?, ?, ?)'
  );
  const result = stmt.run(institute_name.trim(), normalizedEmail, password_hash);
  const institute = { institute_id: result.lastInsertRowid, email: normalizedEmail, name: institute_name.trim() };
  const token = signToken(institute);
  res.json({ token, institute: { institute_id: institute.institute_id, name: institute.name, email: normalizedEmail } });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!isValidEmail(email) || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const normalizedEmail = email.trim().toLowerCase();

  const institute = db.prepare('SELECT * FROM institutes WHERE email = ?').get(normalizedEmail);
  if (!institute) return res.status(401).json({ error: 'invalid email or password' });

  const valid = await bcrypt.compare(password, institute.password_hash);
  if (!valid) return res.status(401).json({ error: 'invalid email or password' });

  const token = signToken(institute);
  res.json({ token, institute: { institute_id: institute.institute_id, name: institute.name, email: institute.email } });
});

// ================= COURSES (protected, scoped to institute) =================
app.post('/api/courses', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!isNonEmptyString(name, 200)) return res.status(400).json({ error: 'a valid course name is required' });
  const stmt = db.prepare('INSERT INTO courses (institute_id, name) VALUES (?, ?)');
  const result = stmt.run(req.institute_id, name.trim());
  res.json({ course_id: result.lastInsertRowid, name: name.trim() });
});

app.get('/api/courses', requireAuth, (req, res) => {
  const courses = db.prepare('SELECT * FROM courses WHERE institute_id = ? ORDER BY name').all(req.institute_id);
  res.json(courses);
});

// Helper: verify a course belongs to the requesting institute
function courseBelongsToInstitute(course_id, institute_id) {
  const row = db.prepare('SELECT course_id FROM courses WHERE course_id = ? AND institute_id = ?').get(course_id, institute_id);
  return !!row;
}

// ================= STUDENTS (protected) =================
app.post('/api/students', requireAuth, (req, res) => {
  const { name, roll_no, course_id } = req.body;
  if (!isNonEmptyString(name, 200) || !isNonEmptyString(String(roll_no ?? ''), 50) || !isPositiveInt(Number(course_id))) {
    return res.status(400).json({ error: 'a valid name, roll_no, and course_id are required' });
  }
  if (!courseBelongsToInstitute(course_id, req.institute_id)) {
    return res.status(403).json({ error: 'course not found for this institute' });
  }
  const student_token = crypto.randomBytes(16).toString('hex');
  try {
    const stmt = db.prepare(
      'INSERT INTO students (name, roll_no, course_id, student_token) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(name.trim(), String(roll_no).trim(), course_id, student_token);
    res.json({ student_id: result.lastInsertRowid, name: name.trim(), roll_no: String(roll_no).trim(), course_id, student_token });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'roll_no already exists in this course' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students', requireAuth, (req, res) => {
  const { course_id } = req.query;
  if (!course_id) return res.status(400).json({ error: 'course_id is required' });
  if (!courseBelongsToInstitute(course_id, req.institute_id)) {
    return res.status(403).json({ error: 'course not found for this institute' });
  }
  const students = db.prepare('SELECT * FROM students WHERE course_id = ? ORDER BY roll_no').all(course_id);
  res.json(students);
});

// ================= SESSIONS (protected to start/manage) =================
app.post('/api/sessions/start', requireAuth, (req, res) => {
  const { course_id, teacher_lat, teacher_lng, geofence_meters } = req.body;
  if (!isPositiveInt(Number(course_id))) return res.status(400).json({ error: 'a valid course_id is required' });
  if (!courseBelongsToInstitute(course_id, req.institute_id)) {
    return res.status(403).json({ error: 'course not found for this institute' });
  }
  if (geofence_meters != null && !isValidCoordinate(teacher_lat, teacher_lng)) {
    return res.status(400).json({ error: 'valid teacher_lat/teacher_lng are required when setting a geofence' });
  }

  const qr_token = crypto.randomBytes(12).toString('hex');
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const start_time = now.toTimeString().slice(0, 8);
  const expires_at = new Date(now.getTime() + SESSION_MINUTES * 60000).toISOString();

  const stmt = db.prepare(
    `INSERT INTO sessions (course_id, date, start_time, qr_token, expires_at, status, teacher_lat, teacher_lng, geofence_meters)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  );
  const result = stmt.run(
    course_id, date, start_time, qr_token, expires_at,
    teacher_lat ?? null, teacher_lng ?? null, geofence_meters ?? null
  );
  const session_id = result.lastInsertRowid;

  res.json({ session_id, course_id, qr_token, expires_at, date, start_time, geofence_meters: geofence_meters ?? null });
});

app.get('/api/sessions/:id/qrcode', requireAuth, async (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!courseBelongsToInstitute(session.course_id, req.institute_id)) {
    return res.status(403).json({ error: 'not your session' });
  }

  const payload = JSON.stringify({ session_id: session.session_id, qr_token: session.qr_token });
  try {
    const dataUrl = await QRCode.toDataURL(payload, { width: 320, margin: 1 });
    res.json({ dataUrl, expires_at: session.expires_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/close', requireAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!courseBelongsToInstitute(session.course_id, req.institute_id)) {
    return res.status(403).json({ error: 'not your session' });
  }
  db.prepare(`UPDATE sessions SET status = 'closed' WHERE session_id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/sessions/:id/attendance', requireAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (!courseBelongsToInstitute(session.course_id, req.institute_id)) {
    return res.status(403).json({ error: 'not your session' });
  }

  const rows = db.prepare(`
    SELECT a.id, a.scanned_at, s.student_id, s.name, s.roll_no
    FROM attendance a
    JOIN students s ON s.student_id = a.student_id
    WHERE a.session_id = ?
    ORDER BY a.scanned_at
  `).all(req.params.id);

  const total = db.prepare('SELECT COUNT(*) c FROM students WHERE course_id = ?').get(session.course_id).c;

  res.json({ present: rows, present_count: rows.length, total_students: total });
});

// ================= ATTENDANCE MARKING (public — this is the student-facing scan) =================
// No auth token required here since students don't log in — the qr_token + student_token
// pair together act as the credential, and both are single-use/private.
app.post('/api/attendance/mark', (req, res) => {
  const { session_id, qr_token, student_token, student_lat, student_lng } = req.body;
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

  // Anti-proxy: geofence check, only enforced if the teacher set a radius when starting the session
  if (session.geofence_meters && session.teacher_lat != null && session.teacher_lng != null) {
    if (!isValidCoordinate(student_lat, student_lng)) {
      return res.status(400).json({ error: 'Location permission is required for this session.' });
    }
    const dist = distanceMeters(session.teacher_lat, session.teacher_lng, student_lat, student_lng);
    if (dist > session.geofence_meters) {
      return res.status(403).json({ error: 'You are outside the classroom attendance area.' });
    }
  }

  try {
    const stmt = db.prepare(
      'INSERT INTO attendance (session_id, student_id, student_lat, student_lng) VALUES (?, ?, ?, ?)'
    );
    stmt.run(session_id, student.student_id, student_lat ?? null, student_lng ?? null);
    res.json({ ok: true, message: `Attendance marked for ${student.name}` });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'attendance already marked for this session' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ================= STUDENT ID QR (protected — admin generates/prints these) =================
app.get('/api/students/:id/qrcode', requireAuth, async (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE student_id = ?').get(req.params.id);
  if (!student) return res.status(404).json({ error: 'student not found' });
  if (!courseBelongsToInstitute(student.course_id, req.institute_id)) {
    return res.status(403).json({ error: 'not your student' });
  }
  const payload = JSON.stringify({ type: 'student_id_card', student_token: student.student_token });
  const dataUrl = await QRCode.toDataURL(payload, { width: 280, margin: 1 });
  res.json({ dataUrl, name: student.name, roll_no: student.roll_no });
});

// ================= REPORTS (protected) =================
// CSV export: attendance % per student across all sessions ever held for a course
app.get('/api/courses/:id/report.csv', requireAuth, (req, res) => {
  const course_id = req.params.id;
  if (!courseBelongsToInstitute(course_id, req.institute_id)) {
    return res.status(403).json({ error: 'course not found for this institute' });
  }

  const totalSessions = db.prepare(
    `SELECT COUNT(*) c FROM sessions WHERE course_id = ?`
  ).get(course_id).c;

  const students = db.prepare(
    `SELECT student_id, name, roll_no FROM students WHERE course_id = ? ORDER BY roll_no`
  ).all(course_id);

  const rows = students.map(s => {
    const attended = db.prepare(`
      SELECT COUNT(*) c FROM attendance a
      JOIN sessions se ON se.session_id = a.session_id
      WHERE a.student_id = ? AND se.course_id = ?
    `).get(s.student_id, course_id).c;
    const pct = totalSessions > 0 ? ((attended / totalSessions) * 100).toFixed(1) : '0.0';
    return { roll_no: s.roll_no, name: s.name, attended, total_sessions: totalSessions, percentage: pct };
  });

  let csv = 'Roll No,Name,Sessions Attended,Total Sessions,Attendance %\n';
  rows.forEach(r => {
    csv += `${r.roll_no},"${r.name}",${r.attended},${r.total_sessions},${r.percentage}\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-report-course-${course_id}.csv"`);
  res.send(csv);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`QR Attendance server running on port ${PORT}`));
