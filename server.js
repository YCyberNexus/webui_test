const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.static('.'));

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
          // The proxied document may reject target-origin URLs; the parent will reload through the proxy.
        }
        if (nextUrl) {
          currentPageUrl = nextUrl;
          postToParent('NAVIGATE_TO_URL', { url: currentPageUrl });
        }
      };

      const originalReplaceState = history.replaceState;
      history.replaceState = function () {
        const nextUrl = arguments.length > 2 && arguments[2] ? resolveUrl(arguments[2], currentPageUrl) : currentPageUrl;
        try {
          originalReplaceState.apply(history, arguments);
        } catch (error) {
          // The proxied document may reject target-origin URLs; the parent will reload through the proxy.
        }
        if (nextUrl) {
          currentPageUrl = nextUrl;
          postToParent('NAVIGATE_TO_URL', { url: currentPageUrl });
        }
      };

      window.addEventListener('popstate', () => {
        postToParent('NAVIGATE_TO_URL', { url: currentPageUrl });
      });
    })();
  `;
}

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    res.status(400).send('Missing url');
    return;
  }

  try {
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      timeout: 15000,
      responseType: 'text'
    });

    const html = response.data;
    const $ = cheerio.load(html, { decodeEntities: false });

    if ($('head').length === 0) {
      $('html').prepend('<head></head>');
    }

    $('head').prepend('<base href="' + escapeHtml(targetUrl) + '">');
    $('body').append('<script>' + buildInjectedScript(targetUrl) + '</script>');

    res.send($.html());
  } catch (error) {
    res.status(500).send(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <title>加载失败</title>
      </head>
      <body style="margin:0;padding:24px;font-family:PingFang SC,Microsoft YaHei,sans-serif;background:#f8fafc;color:#334155;">
        <h2 style="margin-bottom:12px;">页面加载失败</h2>
        <p style="margin-bottom:8px;">目标地址：${escapeHtml(targetUrl)}</p>
        <p style="margin-bottom:0;">错误信息：${escapeHtml(error.message)}</p>
      </body>
      </html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`代理服务运行中: http://localhost:${PORT}`);
});
