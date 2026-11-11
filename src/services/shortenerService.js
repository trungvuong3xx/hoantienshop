const logger = require('../utils/logger');

/**
 * Shorten a long URL using free public shorteners (is.gd or tinyurl.com).
 */
async function shortenUrl(longUrl, provider = 'isgd') {
  logger.logEnter('shortenUrl', { provider, longUrl });
  if (!longUrl || provider === 'none') {
    logger.logLeave('shortenUrl', { shortUrl: longUrl, skipped: true });
    return longUrl;
  }

  try {
    if (provider === 'tinyurl') {
      const api = `https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`;
      const res = await fetch(api, { method: 'GET', signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const text = (await res.text()).trim();
        if (text.startsWith('http')) {
          logger.logLeave('shortenUrl', { shortUrl: text, provider: 'tinyurl' });
          return text;
        }
      }
    }

    // Default or fallback: is.gd
    const isgdApi = `https://is.gd/create.php?format=simple&url=${encodeURIComponent(longUrl)}`;
    const res = await fetch(isgdApi, { method: 'GET', signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text.startsWith('http')) {
        logger.logLeave('shortenUrl', { shortUrl: text, provider: 'isgd' });
        return text;
      }
    }
  } catch (err) {
    logger.warning('shortenUrl', 'Shortener API failed, returning original affiliate URL', {
      provider,
      error: err.message
    });
  }

  logger.logLeave('shortenUrl', { shortUrl: longUrl, fallback: true });
  return longUrl;
}

module.exports = {
  shortenUrl
};
