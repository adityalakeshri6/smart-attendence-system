# Smart Attendance — QR Based

A working QR-code attendance system: admin panel, live session QR (rotates per session, expires after 10 min), and a student scanner page — all in one app.

## How it works
1. **Admin** adds a Course, then adds Students to it. Each student gets a private `student_token` (their permanent digital ID).
2. **Teacher** opens **Start Session**, picks the course, and a fresh QR appears on screen. It's valid for 10 minutes and tied to that exact session.
3. **Students** open **Scan**, save their token once (stored in browser), then scan the teacher's screen with their phone camera. Attendance is marked instantly, duplicates are blocked automatically.
4. Teacher's screen shows a **live-updating list** of who has checked in.

## Run it
```bash
npm install
node server.js
```
Then open `http://localhost:3000` in a browser.

- On a phone (for scanning), it must reach the same server — either run this on a laptop and connect phone to the same WiFi and use the laptop's local IP (e.g. `http://192.168.1.5:3000/scan.html`), or deploy it (see below) so it has a real HTTPS URL (camera access requires HTTPS on most phones unless it's `localhost`).

## Deploying so students can actually use it
Camera access in browsers requires **HTTPS** (except on localhost). Easiest free options:
- **Railway** / **Render** — deploy this Node app directly, free tier works for a class-sized pilot
- **Replit** — good for quick demos

The SQLite database (`attendance.db`) is a single file — fine for a pilot with one class/institute. For multiple institutes (i.e. once you're selling this), you'll want to move to PostgreSQL and add per-institute accounts/login — see "Next steps" below.

## Project structure
```
qr-attendance/
├── server.js          # Express API — courses, students, sessions, attendance
├── db.js              # SQLite schema + connection
├── public/
│   ├── index.html      # Admin — add courses/students
│   ├── session.html     # Teacher — start session, show QR, live attendance
│   ├── scan.html         # Student — save token, scan QR
│   └── style.css
└── package.json
```

## What's already handled
- QR token rotates per session and expires (default 10 min) — can't be reused later
- Duplicate scans blocked at the database level (`UNIQUE(session_id, student_id)`)
- Student can only mark attendance for a session in their own enrolled course

## Next steps to make this sellable
1. **Auth** — right now anyone can hit the admin API. Add login (JWT) for teachers/admins, one account per institute.
2. **Multi-tenant** — add an `institutes` table, scope courses/students/sessions to an `institute_id`.
3. **Anti-proxy safeguard** — right now a student could screenshot the QR and send it to a friend within the 10-minute window. Options: shrink the expiry window further, or add geofencing (compare student's GPS to classroom location) for a stronger version.
4. **Deploy on Postgres** — swap `better-sqlite3` for `pg` when you have real concurrent users.
5. **Reports** — add CSV/Excel export of attendance % per student per month (this is what institutes will actually pay for).
6. **Native app or PWA** — wrap `scan.html` as a PWA so it feels like a real app on students' phones.
