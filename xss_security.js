/**
 * xss_security.js
 * HR Attendance LIFF — XSS 防護統一模組
 *
 * 功能：
 * 1. escapeHTML()    — HTML 實體跳脫
 * 2. escAttr()       — HTML 屬性值跳脫
 * 3. escURL()        — URL 安全驗證
 * 4. sanitizeHTML()  — 允許白名單標籤的 HTML 淨化
 * 5. cleanInput()    — 字串清理（去除前後空白 + 長度限制）
 * 6. cleanNumber()   — 安全數字解析
 * 7. cleanDate()     — 日期格式驗證
 * 8. safeJSONParse() — 安全 JSON 解析
 * 9. injectCSP()     — 注入 Content-Security-Policy meta 標籤
 * 10. sanitizeURLParams() — URL 參數安全過濾
 */

// ========================================
// 1. HTML 實體跳脫（防止標籤注入）
// ========================================
const HTML_ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
    '`': '&#96;'
};

const HTML_ESCAPE_RE = /[&<>"'`/]/g;

function escapeHTML(str) {
    if (str == null) return '';
    return String(str).replace(HTML_ESCAPE_RE, ch => HTML_ESCAPE_MAP[ch]);
}

// ========================================
// 2. HTML 屬性值跳脫
// ========================================
function escAttr(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ========================================
// 3. URL 安全驗證（阻擋 javascript: / data:）
// ========================================
const ALLOWED_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];

function escURL(url) {
    if (!url) return '';
    const str = String(url).trim();

    // 阻擋 javascript:, data:, vbscript: 等危險協議
    const lower = str.toLowerCase().replace(/[\s\x00-\x1f]/g, '');
    if (/^(javascript|data|vbscript|blob)\s*:/i.test(lower)) {
        return '';
    }

    // 相對路徑直接通過
    if (str.startsWith('/') || str.startsWith('./') || str.startsWith('#')) {
        return str;
    }

    // 檢查協議白名單
    try {
        const parsed = new URL(str);
        if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
            return '';
        }
        return str;
    } catch {
        // 無法解析為 URL 時，視為相對路徑
        return str;
    }
}

// ========================================
// 4. HTML 淨化（白名單標籤 + 屬性）
// ========================================
const SAFE_TAGS = new Set([
    'b', 'i', 'u', 'em', 'strong', 'br', 'p', 'span',
    'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'small', 'sub', 'sup', 'hr', 'blockquote',
    'code', 'pre'
]);

const SAFE_ATTRS = new Set([
    'class', 'id', 'style', 'href', 'target', 'title',
    'colspan', 'rowspan', 'align', 'valign'
]);

function sanitizeHTML(html) {
    if (!html) return '';

    const str = String(html);
    // 移除 script, style, iframe, object, embed, form 等危險標籤
    let clean = str
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
        .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
        .replace(/<embed\b[^>]*\/?>/gi, '')
        .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '')
        .replace(/<link\b[^>]*\/?>/gi, '')
        .replace(/<meta\b[^>]*\/?>/gi, '');

    // 移除事件處理器屬性（on*）
    clean = clean.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');

    // 移除 javascript: 協議
    clean = clean.replace(/\bhref\s*=\s*(?:"|')?\s*javascript\s*:/gi, 'href="');

    // 過濾非白名單標籤（保留內容，只移除標籤本身）
    clean = clean.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*\/?>/gi, (match, tag) => {
        if (SAFE_TAGS.has(tag.toLowerCase())) {
            // 白名單標籤：移除非白名單屬性
            return match.replace(/\s+([a-z-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, (attrMatch, attrName) => {
                if (SAFE_ATTRS.has(attrName.toLowerCase())) {
                    // href 屬性需額外檢查 URL 安全
                    if (attrName.toLowerCase() === 'href') {
                        const hrefVal = attrMatch.match(/=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/);
                        if (hrefVal) {
                            const val = hrefVal[1] || hrefVal[2] || hrefVal[3] || '';
                            const safe = escURL(val);
                            return safe ? ` href="${escAttr(safe)}"` : '';
                        }
                    }
                    return attrMatch;
                }
                return '';
            });
        }
        return '';
    });

    return clean;
}

// ========================================
// 5. 字串清理
// ========================================
function cleanInput(str, maxLength) {
    if (str == null) return '';
    maxLength = maxLength || 1000;
    let result = String(str).trim();
    // 移除零寬字元
    result = result.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');
    // 限制長度
    if (result.length > maxLength) {
        result = result.substring(0, maxLength);
    }
    return result;
}

// ========================================
// 6. 安全數字解析
// ========================================
function cleanNumber(val, fallback) {
    fallback = fallback !== undefined ? fallback : 0;
    if (val == null || val === '') return fallback;
    const n = Number(val);
    if (isNaN(n) || !isFinite(n)) return fallback;
    return n;
}

// ========================================
// 7. 日期格式驗證（YYYY-MM-DD）
// ========================================
function cleanDate(str) {
    if (!str) return null;
    const s = String(str).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(s + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    return s;
}

// ========================================
// 8. 安全 JSON 解析
// ========================================
function safeJSONParse(str, fallback) {
    fallback = fallback !== undefined ? fallback : null;
    if (!str) return fallback;
    try {
        return JSON.parse(str);
    } catch {
        return fallback;
    }
}

// ========================================
// 9. 注入 CSP Meta 標籤
// ========================================
function injectCSP(options) {
    options = options || {};
    // 預設 CSP 指令
    const directives = {
        'default-src': "'self'",
        'script-src':  "'self' 'unsafe-inline' https://static.line-scdn.net https://cdn.jsdelivr.net",
        'style-src':   "'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
        'font-src':    "'self' https://fonts.gstatic.com https://cdn.jsdelivr.net",
        'img-src':     "'self' data: https: blob:",
        'connect-src': "'self' https://*.supabase.co https://api.line.me",
        'frame-src':   "'none'",
        'object-src':  "'none'",
        'base-uri':    "'self'"
    };

    // 允許自訂覆蓋
    if (options.directives) {
        Object.assign(directives, options.directives);
    }

    const policy = Object.entries(directives)
        .map(function(entry) { return entry[0] + ' ' + entry[1]; })
        .join('; ');

    // 避免重複注入
    if (document.querySelector('meta[http-equiv="Content-Security-Policy"]')) {
        return;
    }

    const meta = document.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy';
    meta.content = policy;
    document.head.prepend(meta);
}

// ========================================
// 10. URL 參數安全過濾
// ========================================
function sanitizeURLParams(allowedKeys) {
    const params = new URLSearchParams(window.location.search);
    const safe = {};
    params.forEach(function(value, key) {
        if (!allowedKeys || allowedKeys.includes(key)) {
            safe[key] = cleanInput(value, 500);
        }
    });
    return safe;
}

// ========================================
// 全域掛載 + 匯出
// ========================================
const XSS = {
    escapeHTML:         escapeHTML,
    escAttr:            escAttr,
    escURL:             escURL,
    sanitizeHTML:       sanitizeHTML,
    cleanInput:         cleanInput,
    cleanNumber:        cleanNumber,
    cleanDate:          cleanDate,
    safeJSONParse:      safeJSONParse,
    injectCSP:          injectCSP,
    sanitizeURLParams:  sanitizeURLParams
};

// 掛載到 window（供非模組頁面使用）
if (typeof window !== 'undefined') {
    window.XSS = XSS;
    // 向下相容：覆蓋舊版 escapeHTML
    window.escapeHTML = escapeHTML;
}

// ES Module 匯出
if (typeof module !== 'undefined' && module.exports) {
    module.exports = XSS;
}
