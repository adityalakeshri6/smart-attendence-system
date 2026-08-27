const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'attendance.db'));
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS institutes (
  institute_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  course_id INTEGER PRIMARY KEY AUTOINCREMENT,
  institute_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (institute_id) REFERENCES institutes(institute_id)
);

CREATE TABLE IF NOT EXISTS students (
  student_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  roll_no TEXT NOT NULL,
  course_id INTEGER NOT NULL,
  student_token TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (course_id) REFERENCES courses(course_id),
  UNIQUE(course_id, roll_no)
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  qr_token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  teacher_lat REAL,
  teacher_lng REAL,
  geofence_meters INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (course_id) REFERENCES courses(course_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  scanned_at TEXT DEFAULT (datetime('now')),
  student_lat REAL,
  student_lng REAL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id),
  FOREIGN KEY (student_id) REFERENCES students(student_id),
  UNIQUE(session_id, student_id)
);
`);

module.exports = db;
