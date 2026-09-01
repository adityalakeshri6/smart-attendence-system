// Lightweight input validation — no external framework, just guards
// against obviously bad data before it reaches the database.

function isValidEmail(email) {
  return typeof email === 'string' &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isNonEmptyString(value, maxLength = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isValidCoordinate(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

module.exports = { isValidEmail, isNonEmptyString, isValidCoordinate, isPositiveInt };
