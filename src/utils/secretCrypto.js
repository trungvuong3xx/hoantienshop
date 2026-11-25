const crypto = require('crypto');
const logger = require('./logger');

const SENSITIVE_SETTING_KEYS = [
  'shopeeAppSecret',
  'tiktokAppSecret',
  'tiktokAccessToken',
  'tiktokCookie',
  'accesstradeApiKey',
  'addlivetagApiKey',
  'postbackToken',
  'turnstileSecretKey',
  'resendApiKey'
];

const CIPHER_PREFIX = 'enc:v1:';

function settingsCryptoError() {
  const error = new Error('Không thể giải mã cấu hình. Kiểm tra khóa mã hóa gốc; dữ liệu chưa được ghi đè.');
  error.code = 'SETTINGS_DECRYPT_FAILED';
  error.status = 503;
  return error;
}

function deriveSettingsAesKey(secretMaterial) {
  const raw = String(secretMaterial || '').trim();
  if (!raw) return null;
  return crypto.createHmac('sha256', 'lila-settings-aes256gcm-v1').update(raw).digest();
}

function encryptSecretValue(plainText, keyBuffer) {
  if (!plainText || typeof plainText !== 'string') return plainText;
  if (plainText.startsWith(CIPHER_PREFIX)) return plainText;
  if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length !== 32) return plainText;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${CIPHER_PREFIX}${iv.toString('base64url')}:${authTag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decryptSecretValue(storedValue, keyBuffer) {
  if (!storedValue || typeof storedValue !== 'string') return storedValue;
  if (!storedValue.startsWith(CIPHER_PREFIX)) {
    // Seamless backward compatibility with pre-encryption plaintext settings
    return storedValue;
  }
  if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length !== 32) {
    logger.warning('secretCrypto', 'Missing encryption key while reading encrypted setting');
    throw settingsCryptoError();
  }

  const parts = storedValue.slice(CIPHER_PREFIX.length).split(':');
  if (parts.length !== 3) {
    logger.warning('secretCrypto', 'Malformed encrypted setting payload');
    throw settingsCryptoError();
  }

  try {
    const iv = Buffer.from(parts[0], 'base64url');
    const authTag = Buffer.from(parts[1], 'base64url');
    const ciphertext = Buffer.from(parts[2], 'base64url');
    if (iv.length !== 12 || authTag.length !== 16) {
      throw new Error('Invalid IV or authTag length');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    logger.warning('secretCrypto', 'Failed to decrypt setting value (key rotated or tampered)', {
      error: err.message
    });
    throw settingsCryptoError();
  }
}

function encryptSettingsObject(settings, secretMaterial) {
  if (!settings || typeof settings !== 'object') return settings;
  const key = deriveSettingsAesKey(secretMaterial);
  if (!key) return { ...settings };

  const out = { ...settings };
  for (const field of SENSITIVE_SETTING_KEYS) {
    if (typeof out[field] === 'string' && out[field].trim() !== '' && out[field] !== '***') {
      out[field] = encryptSecretValue(out[field], key);
    }
  }
  return out;
}

function decryptSettingsObject(settings, secretMaterial) {
  if (!settings || typeof settings !== 'object') return settings;
  const key = deriveSettingsAesKey(secretMaterial);
  const out = { ...settings };
  for (const field of SENSITIVE_SETTING_KEYS) {
    if (typeof out[field] === 'string' && out[field].startsWith(CIPHER_PREFIX)) {
      out[field] = decryptSecretValue(out[field], key);
    }
  }
  return out;
}

module.exports = {
  SENSITIVE_SETTING_KEYS,
  CIPHER_PREFIX,
  deriveSettingsAesKey,
  encryptSecretValue,
  decryptSecretValue,
  encryptSettingsObject,
  decryptSettingsObject
};
