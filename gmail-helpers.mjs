// @ts-check

/**
 * Extracts all URLs starting with http/https from a string (plain text or HTML).
 * Normalizes HTML entities like &amp;.
 * @param {string} body
 * @returns {string[]}
 */
export function extractUrls(body) {
  if (!body) return [];
  const urls = [];
  const regex = /https?:\/\/[^\s"'<>\(\)]+/gi;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const url = match[0].replace(/[.,;:!?]+$/, '').replace(/&amp;/g, '&');
    urls.push(url);
  }
  return [...new Set(urls)];
}

/**
 * Checks if a URL is clean and relevant (not a click tracker, unsubscribe link, or open pixel).
 * @param {string} url
 * @returns {boolean}
 */
export function isCleanUrl(url) {
  try {
    const u = new URL(url);
    const lowerUrl = url.toLowerCase();

    // Deny tracking, unsubscribe, and boilerplate elements
    const badKeywords = [
      'click', 'track', 'openpixel', 'sendgrid', 'unsubscribe', 'optout',
      'newsletter', 'subscribe', 'w3.org', 'doubleclick', 'googlesyndication',
      'googleadservices', 'mailgun', 'mandrill', 'mjml', 'github.com/login',
      'linkedin.com/legal', 'linkedin.com/help', 'linkedin.com/settings'
    ];

    if (badKeywords.some(kw => lowerUrl.includes(kw))) {
      return false;
    }

    // Must use HTTPS
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Checks Gmail header for DMARC alignment (anti-spoof gate).
 * @param {Array<{ name: string, value: string }>} headers
 * @returns {boolean}
 */
export function isAuthenticEmail(headers) {
  if (!Array.isArray(headers)) return false;
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === 'authentication-results') {
      if (h.value && /dmarc=pass/i.test(h.value)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Parses "{Role} at {Company}" from the subject line.
 * @param {string} subject
 * @returns {{ role: string, company: string } | null}
 */
export function parseRoleAtCompany(subject) {
  if (!subject) return null;
  
  // Clean prefixes
  let clean = subject.replace(/^(re|fwd|new match|job alert|alert|match|notification|alert for|daily alert for):\s*/i, '').trim();
  
  // Strip trailing info (e.g. after dashes or pipes)
  clean = clean.split(/\s+[-|]\s+/)[0].trim();
  
  const match = clean.match(/^(.+?)\s+at\s+(.+)$/i);
  if (match) {
    const role = match[1].trim();
    const company = match[2].trim();
    if (role && company && role.length < 100 && company.length < 100) {
      return { role, company };
    }
  }
  return null;
}
