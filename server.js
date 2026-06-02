const path = require('path');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = 3000;

// 当前正在代理的目标源（http://host:port）。
// 通过 /__nav 设置；之后所有同源请求都按原始路径转发到这里。
let currentTargetOrigin = '';

// 不应原样转发给浏览器的响应头：
// - 压缩/长度类（axios 已解压，长度会变）
// - 安全策略类（会阻止 iframe 嵌入、阻止注入的内联脚本、限制跨源资源）
const HOP_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'public-key-pins',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'report-to',
  'nel'
]);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toScriptString(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function buildInjectedScript(targetUrl) {
  return `
    (function () {
      const initialPageUrl = ${toScriptString(targetUrl)};
      let currentPageUrl = initialPageUrl;

      let targetOrigin = '';
      try {
        targetOrigin = new URL(initialPageUrl).origin;
      } catch (error) {
        targetOrigin = '';
      }

      // 把指向目标源的绝对地址改写成根相对地址，
      // 让运行时的请求也走同源代理，避免 CORS。
      function toSameOriginPath(value) {
        try {
          const resolved = new URL(value, currentPageUrl);
          if (targetOrigin && resolved.origin === targetOrigin) {
            return resolved.pathname + resolved.search + resolved.hash;
          }
          return value;
        } catch (error) {
          return value;
        }
      }

      const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
      if (nativeFetch) {
        window.fetch = function (input, init) {
          try {
            if (typeof input === 'string') {
              input = toSameOriginPath(input);
            } else if (input && typeof input.url === 'string') {
              input = new Request(toSameOriginPath(input.url), input);
            }
          } catch (error) {
            // 改写失败时保持原始入参
          }
          return nativeFetch(input, init);
        };
      }

      const nativeXhrOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          arguments[1] = toSameOriginPath(url);
        } catch (error) {
          // 改写失败时保持原始地址
        }
        return nativeXhrOpen.apply(this, arguments);
      };

      const interactiveSelector = [
        'a[href]',
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[onclick]',
        '[tabindex]'
      ].join(',');

      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.zIndex = '2147483647';
      overlay.style.pointerEvents = 'none';
      overlay.style.border = '2px solid #ff4d6d';
      overlay.style.background = 'rgba(255, 77, 109, 0.14)';
      overlay.style.boxSizing = 'border-box';
      overlay.style.display = 'none';
      document.documentElement.appendChild(overlay);

      function postToParent(type, payload) {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type, payload }, '*');
        }
      }

      function getInteractiveTarget(target) {
        if (!(target instanceof Element)) {
          return null;
        }
        return target.matches(interactiveSelector) ? target : target.closest(interactiveSelector);
      }

      function updateOverlay(element) {
        if (!element) {
          overlay.style.display = 'none';
          return;
        }

        const rect = element.getBoundingClientRect();
        overlay.style.display = 'block';
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
      }

      function getElementType(element) {
        const tag = element.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'select';
        if (tag === 'textarea') return 'textarea';
        if (tag === 'input') return element.type ? 'input-' + element.type.toLowerCase() : 'input-text';
        return tag;
      }

      function normalizeText(value) {
        return String(value || '').replace(/\\s+/g, ' ').trim();
      }

      function quoteXPath(value) {
        const stringValue = String(value);
        if (!stringValue.includes("'")) {
          return "'" + stringValue + "'";
        }
        if (!stringValue.includes('"')) {
          return '"' + stringValue + '"';
        }
        return 'concat(' + stringValue.split("'").map((part) => "'" + part + "'").join(", \\"'\\", ") + ')';
      }

      function getXPathSnapshot(xpath) {
        try {
          return document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        } catch (error) {
          return null;
        }
      }

      function isUniqueXPathForElement(xpath, element) {
        const snapshot = getXPathSnapshot(xpath);
        return Boolean(snapshot && snapshot.snapshotLength === 1 && snapshot.snapshotItem(0) === element);
      }

      function getXPathMatchCount(xpath) {
        const snapshot = getXPathSnapshot(xpath);
        return snapshot ? snapshot.snapshotLength : 0;
      }

      function getIdInfo(element) {
        const value = element.id || '';
        if (!value) {
          return { value: '', isUnique: false, duplicateCount: 0, display: '' };
        }

        const duplicateCount = getXPathMatchCount('//*[@id=' + quoteXPath(value) + ']');
        const isUnique = duplicateCount === 1;
        return {
          value,
          isUnique,
          duplicateCount,
          display: isUnique ? value : value + '（重复 ' + duplicateCount + ' 个，导出不记录）'
        };
      }

      function getAttributeValue(element, attributeName) {
        const value = attributeName === 'id' ? element.id : element.getAttribute(attributeName);
        return typeof value === 'string' ? value.trim() : '';
      }

      function getUniqueAttributeXPath(element, includeId) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) {
          return '';
        }

        const tag = element.tagName.toLowerCase();
        const idInfo = getIdInfo(element);
        const attributeNames = [
          'data-testid',
          'data-test',
          'data-cy',
          'name',
          'aria-label',
          'placeholder',
          'title'
        ];

        if (includeId && idInfo.isUnique) {
          const idXPath = '//*[@id=' + quoteXPath(idInfo.value) + ']';
          if (isUniqueXPathForElement(idXPath, element)) {
            return idXPath;
          }
        }

        for (const attributeName of attributeNames) {
          const value = getAttributeValue(element, attributeName);
          if (!value) {
            continue;
          }

          const wildcardXPath = '//*[@' + attributeName + '=' + quoteXPath(value) + ']';
          if (isUniqueXPathForElement(wildcardXPath, element)) {
            return wildcardXPath;
          }

          const tagXPath = '//' + tag + '[@' + attributeName + '=' + quoteXPath(value) + ']';
          if (isUniqueXPathForElement(tagXPath, element)) {
            return tagXPath;
          }
        }

        return '';
      }

      function getTextXPath(element) {
        const text = normalizeText(element.innerText || element.textContent || '');
        if (!text || text.length > 60) {
          return '';
        }

        const tag = element.tagName.toLowerCase();
        const candidate = '//' + tag + '[normalize-space(.)=' + quoteXPath(text) + ']';
        return isUniqueXPathForElement(candidate, element) ? candidate : '';
      }

      function getElementStep(element) {
        const tag = element.tagName.toLowerCase();
        const parent = element.parentElement;
        if (!parent) {
          return tag;
        }

        const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
        if (siblings.length <= 1) {
          return tag;
        }

        return tag + '[' + (siblings.indexOf(element) + 1) + ']';
      }

      function buildPathFromAncestor(ancestor, element) {
        const segments = [];
        let current = element;
        while (current && current !== ancestor) {
          segments.unshift(getElementStep(current));
          current = current.parentElement;
        }

        return current === ancestor && segments.length > 0 ? '/' + segments.join('/') : '';
      }

      function getAncestorRelativeXPath(element) {
        let ancestor = element.parentElement;
        while (ancestor && ancestor !== document.documentElement) {
          const anchorXPath = getUniqueAttributeXPath(ancestor, true);
          if (anchorXPath) {
            const relativePath = buildPathFromAncestor(ancestor, element);
            const candidate = anchorXPath + relativePath;
            if (relativePath && isUniqueXPathForElement(candidate, element)) {
              return candidate;
            }
          }
          ancestor = ancestor.parentElement;
        }

        return '';
      }

      function getIndexedXPath(baseXPath, element) {
        const snapshot = getXPathSnapshot(baseXPath);
        if (!snapshot) {
          return '';
        }

        for (let index = 0; index < snapshot.snapshotLength; index += 1) {
          if (snapshot.snapshotItem(index) === element) {
            const candidate = '(' + baseXPath + ')[' + (index + 1) + ']';
            return isUniqueXPathForElement(candidate, element) ? candidate : '';
          }
        }

        return '';
      }

      function getCompactIndexedXPath(element) {
        const tag = element.tagName.toLowerCase();
        const attributeNames = [
          'data-testid',
          'data-test',
          'data-cy',
          'name',
          'aria-label',
          'placeholder',
          'title'
        ];

        for (const attributeName of attributeNames) {
          const value = getAttributeValue(element, attributeName);
          if (!value) {
            continue;
          }

          const indexed = getIndexedXPath('//' + tag + '[@' + attributeName + '=' + quoteXPath(value) + ']', element);
          if (indexed) {
            return indexed;
          }
        }

        const text = normalizeText(element.innerText || element.textContent || '');
        if (text && text.length <= 60) {
          const indexedByText = getIndexedXPath('//' + tag + '[normalize-space(.)=' + quoteXPath(text) + ']', element);
          if (indexedByText) {
            return indexedByText;
          }
        }

        return getIndexedXPath('//' + tag, element);
      }

      function getXPath(element) {
        return getUniqueAttributeXPath(element, true)
          || getTextXPath(element)
          || getAncestorRelativeXPath(element)
          || getCompactIndexedXPath(element)
          || '';
      }

      function getCssSelector(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) {
          return '';
        }

        if (getIdInfo(element).isUnique) {
          return '#' + CSS.escape(element.id);
        }

        const parts = [];
        let current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          let part = current.tagName.toLowerCase();
          if (current.classList.length > 0) {
            part += '.' + CSS.escape(current.classList[0]);
          }
          const parent = current.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
            if (siblings.length > 1) {
              part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
            }
          }
          parts.unshift(part);
          current = parent;
        }
        return parts.join(' > ');
      }

      function getElementInfo(element) {
        const idInfo = getIdInfo(element);
        return {
          elementName: '',
          elementType: getElementType(element),
          tag: element.tagName.toLowerCase(),
          id: idInfo.isUnique ? idInfo.value : '',
          idPreview: idInfo.display,
          idDuplicate: Boolean(idInfo.value && !idInfo.isUnique),
          idDuplicateCount: idInfo.duplicateCount,
          class: typeof element.className === 'string' ? element.className.trim() : '',
          name: element.getAttribute('name') || '',
          xpath: getXPath(element),
          css: getCssSelector(element),
          text: (element.innerText || element.value || element.textContent || '').trim().slice(0, 80)
        };
      }

      function resolveUrl(url, baseUrl) {
        try {
          return new URL(url, baseUrl || currentPageUrl).href;
        } catch (error) {
          return '';
        }
      }

      function interceptNavigation(url) {
        const rawUrl = String(url || '').trim();
        if (!rawUrl || rawUrl.startsWith('javascript:') || rawUrl.startsWith('#')) {
          return;
        }

        const absoluteUrl = resolveUrl(rawUrl, currentPageUrl);
        if (!absoluteUrl) {
          return;
        }

        currentPageUrl = absoluteUrl;
        postToParent('NAVIGATE_TO_URL', { url: absoluteUrl });
      }

      function publishHover(target) {
        updateOverlay(target);
        if (target) {
          postToParent('ELEMENT_HOVER', getElementInfo(target));
        } else {
          postToParent('ELEMENT_LEAVE', {});
        }
      }

      document.addEventListener('mousemove', (event) => {
        publishHover(getInteractiveTarget(event.target));
      }, true);

      document.addEventListener('mouseover', (event) => {
        publishHover(getInteractiveTarget(event.target));
      }, true);

      document.addEventListener('mouseout', (event) => {
        if (!event.relatedTarget || !(event.relatedTarget instanceof Element)) {
          publishHover(null);
        }
      }, true);

      document.addEventListener('scroll', () => {
        const hovered = document.querySelector(':hover');
        publishHover(getInteractiveTarget(hovered));
      }, true);

      document.addEventListener('contextmenu', (event) => {
        const target = getInteractiveTarget(event.target);
        if (!target) {
          return;
        }

        event.preventDefault();
        publishHover(target);
        postToParent('ELEMENT_RIGHT_CLICK', getElementInfo(target));
      }, true);

      document.addEventListener('click', (event) => {
        const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (!anchor) {
          return;
        }

        event.preventDefault();
        interceptNavigation(anchor.getAttribute('href'));
      }, true);

      document.addEventListener('submit', (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) {
          return;
        }

        event.preventDefault();
        const formData = new FormData(form);
        const method = (form.getAttribute('method') || 'GET').toUpperCase();
        const action = form.getAttribute('action') || currentPageUrl;
        const targetUrl = new URL(action, currentPageUrl);

        if (method === 'GET') {
          const params = new URLSearchParams(formData);
          params.forEach((value, key) => targetUrl.searchParams.set(key, value));
          interceptNavigation(targetUrl.href);
          return;
        }

        interceptNavigation(targetUrl.href);
      }, true);

      const originalWindowOpen = window.open;
      window.open = function (url) {
        if (url) {
          interceptNavigation(url);
        }
        return null;
      };

      document.querySelectorAll('a[target]').forEach((anchor) => {
        anchor.setAttribute('target', '_self');
      });

      const nativeAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        this.setAttribute('target', '_self');
        if (this.href) {
          interceptNavigation(this.href);
          return;
        }
        return nativeAnchorClick.apply(this, arguments);
      };

      const originalPushState = history.pushState;
      history.pushState = function () {
        const nextUrl = arguments.length > 2 && arguments[2] ? resolveUrl(arguments[2], currentPageUrl) : currentPageUrl;
        try {
          originalPushState.apply(history, arguments);
        } catch (error) {
          // 代理文档可能拒绝目标源 URL；父级会同步地址栏，不强制重载
        }
        if (nextUrl) {
          currentPageUrl = nextUrl;
          postToParent('PAGE_URL_SYNC', { url: currentPageUrl });
        }
      };

      const originalReplaceState = history.replaceState;
      history.replaceState = function () {
        const nextUrl = arguments.length > 2 && arguments[2] ? resolveUrl(arguments[2], currentPageUrl) : currentPageUrl;
        try {
          originalReplaceState.apply(history, arguments);
        } catch (error) {
          // 代理文档可能拒绝目标源 URL；父级会同步地址栏，不强制重载
        }
        if (nextUrl) {
          currentPageUrl = nextUrl;
          postToParent('PAGE_URL_SYNC', { url: currentPageUrl });
        }
      };

      window.addEventListener('popstate', () => {
        postToParent('PAGE_URL_SYNC', { url: currentPageUrl });
      });
    })();
  `;
}

// 转发给目标的请求头：去掉会干扰代理的头，并把来源伪装成目标自身，
// 以兼容后端对 Origin/Referer 的同源校验。
function buildForwardHeaders(req) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers['accept-encoding'];

  headers.origin = currentTargetOrigin;
  if (headers.referer) {
    try {
      const parsed = new URL(headers.referer);
      headers.referer = currentTargetOrigin + parsed.pathname + parsed.search;
    } catch (error) {
      headers.referer = currentTargetOrigin + '/';
    }
  }

  return headers;
}

// 把目标下发的 Set-Cookie 调整到当前（localhost）域可用：
// 去掉 Domain / Secure / SameSite，避免在 http://localhost 下被浏览器丢弃。
function rewriteSetCookie(cookies) {
  return [].concat(cookies).map((cookie) => String(cookie)
    .replace(/;\s*Domain=[^;]*/ig, '')
    .replace(/;\s*Secure/ig, '')
    .replace(/;\s*SameSite=[^;]*/ig, ''));
}

// 重写重定向地址：
// - 指向目标源 → 改成根相对，让浏览器在同源内继续走代理
// - 指向其它源 → 转交 /__nav，由代理切换目标源后再继续
function rewriteLocation(location) {
  try {
    const parsed = new URL(location, currentTargetOrigin);
    if (parsed.origin === currentTargetOrigin) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
    return '/__nav?url=' + encodeURIComponent(parsed.href);
  } catch (error) {
    return location;
  }
}

function applyResponseHeaders(res, headers) {
  Object.keys(headers).forEach((key) => {
    const lowerKey = key.toLowerCase();
    if (HOP_HEADERS.has(lowerKey) || lowerKey === 'set-cookie' || lowerKey === 'content-type') {
      return;
    }
    if (lowerKey === 'location') {
      res.set('location', rewriteLocation(headers[key]));
      return;
    }
    res.set(key, headers[key]);
  });

  if (headers['set-cookie']) {
    res.set('set-cookie', rewriteSetCookie(headers['set-cookie']));
  }

  const contentType = headers['content-type'];
  if (contentType && !String(contentType).includes('html')) {
    res.set('content-type', contentType);
  }
}

// 把 HTML 里指向目标源的绝对地址改写成根相对，剥离会导致校验失败的属性，
// 并注入定位脚本。注意：不再写入 <base>，相对路径会自然落到同源代理。
function processHtml(html, pageUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  if ($('head').length === 0) {
    $('html').prepend('<head></head>');
  }

  let pageOrigin = '';
  try {
    pageOrigin = new URL(pageUrl).origin;
  } catch (error) {
    pageOrigin = '';
  }

  const toRel = (value) => {
    if (value === undefined || value === null) {
      return value;
    }
    const raw = String(value).trim();
    if (!raw || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(raw)) {
      return value;
    }
    try {
      const resolved = new URL(raw, pageUrl);
      if (pageOrigin && resolved.origin === pageOrigin) {
        return resolved.pathname + resolved.search + resolved.hash;
      }
      return value;
    } catch (error) {
      return value;
    }
  };

  const urlAttrs = ['src', 'href', 'action', 'data', 'poster', 'formaction'];
  $('[src],[href],[action],[data],[poster],[formaction]').each((index, element) => {
    const $el = $(element);
    urlAttrs.forEach((attr) => {
      const value = $el.attr(attr);
      if (value !== undefined) {
        $el.attr(attr, toRel(value));
      }
    });
  });

  $('[srcset]').each((index, element) => {
    const $el = $(element);
    const value = $el.attr('srcset');
    if (!value) {
      return;
    }
    const rewritten = value.split(',').map((part) => {
      const segment = part.trim();
      if (!segment) {
        return segment;
      }
      const pieces = segment.split(/\s+/);
      pieces[0] = toRel(pieces[0]);
      return pieces.join(' ');
    }).join(', ');
    $el.attr('srcset', rewritten);
  });

  // 同源后这些属性已无意义，且 integrity 会因 CSS 改写而校验失败
  $('[integrity]').removeAttr('integrity');
  $('[crossorigin]').removeAttr('crossorigin');

  $('body').append('<script>' + buildInjectedScript(pageUrl) + '</script>');

  return $.html();
}

app.use(cors());

// 工具自身的界面（注意只占用 /index.html，让站点根路径留给被代理页面）
app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 设置目标源并跳转到镜像路径；iframe 的 src 指向这里
app.get('/__nav', (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) {
    res.status(400).send('Missing url');
    return;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    res.status(400).send('Invalid url');
    return;
  }

  currentTargetOrigin = parsed.origin;
  const dest = (parsed.pathname || '/') + parsed.search;
  res.redirect(302, dest);
});

// 代理路径需要拿到原始请求体（转发 POST/PUT 等接口调用）
app.use(express.raw({ type: () => true, limit: '50mb' }));

// 兜底：除上面的工具路由外，所有请求都按原始路径转发到当前目标源
app.use(async (req, res) => {
  if (!currentTargetOrigin) {
    if (req.path === '/') {
      res.redirect(302, '/index.html');
      return;
    }
    res.status(502).send('尚未设置目标页面，请在工具中输入 URL 后点击“加载页面”。');
    return;
  }

  const targetUrl = currentTargetOrigin + req.originalUrl;
  let upstream;
  try {
    upstream = await axios.request({
      method: req.method,
      url: targetUrl,
      headers: buildForwardHeaders(req),
      data: (req.method === 'GET' || req.method === 'HEAD') ? undefined : req.body,
      responseType: 'arraybuffer',
      timeout: 20000,
      maxRedirects: 0,
      decompress: true,
      validateStatus: () => true
    });
  } catch (error) {
    res.status(502).send('代理请求失败：' + escapeHtml(error.message));
    return;
  }

  applyResponseHeaders(res, upstream.headers);

  const contentType = String(upstream.headers['content-type'] || '');
  if (contentType.includes('html')) {
    const html = Buffer.from(upstream.data).toString('utf8');
    res.status(upstream.status);
    res.set('content-type', 'text/html; charset=utf-8');
    res.send(processHtml(html, targetUrl));
    return;
  }

  res.status(upstream.status);
  res.send(Buffer.from(upstream.data));
});

app.listen(PORT, () => {
  console.log(`代理服务运行中: http://localhost:${PORT}/index.html`);
});
