const jwt = require('jsonwebtoken');

// JWT_SECRET must be set as an environment variable (Railway → Variables tab).
// No fallback: if this is missing, the app refuses to start rather than
// silently running with a guessable secret.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET environment variable is not set. ' +
    'Set it in Railway → your service → Variables before starting the app.'
  );
}

function signToken(institute) {
  return jwt.sign(
    { institute_id: institute.institute_id, email: institute.email, name: institute.name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing or invalid Authorization header' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.institute_id = payload.institute_id;
    req.institute_email = payload.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { signToken, requireAuth, JWT_SECRET };
