const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.static('.'));

function buildInjectedScript() {
  return `
    (function () {
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

      function getXPath(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) {
          return '';
        }

        if (element.id) {
          return '//*[@id="' + element.id + '"]';
        }

        const segments = [];
        let current = element;

        while (current && current.nodeType === Node.ELEMENT_NODE) {
          const tagName = current.tagName.toLowerCase();
          let index = 1;
          let previous = current.previousElementSibling;
          while (previous) {
            if (previous.tagName === current.tagName) {
              index += 1;
            }
            previous = previous.previousElementSibling;
          }
          segments.unshift(tagName + '[' + index + ']');
          current = current.parentElement;
        }

        return '/' + segments.join('/');
      }

      function getCssSelector(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) {
          return '';
        }

        if (element.id) {
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
            const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
            if (sameTagSiblings.length > 1) {
              part += ':nth-of-type(' + (sameTagSiblings.indexOf(current) + 1) + ')';
            }
          }

          parts.unshift(part);
          current = parent;
        }

        return parts.join(' > ');
      }

      function getElementInfo(element) {
        return {
          elementName: '',
          elementType: getElementType(element),
          tag: element.tagName.toLowerCase(),
          id: element.id || '',
          class: typeof element.className === 'string' ? element.className.trim() : '',
          name: element.getAttribute('name') || '',
          xpath: getXPath(element),
          css: getCssSelector(element),
          text: (element.innerText || element.value || element.textContent || '').trim().slice(0, 80)
        };
      }

      function interceptNavigation(url) {
        if (!url || url.startsWith('javascript:') || url.startsWith('#')) {
          return;
        }

        let absoluteUrl;
        try {
          absoluteUrl = new URL(url, window.location.href).href;
        } catch (error) {
          return;
        }

        postToParent('NAVIGATE_TO_URL', { url: absoluteUrl });
      }

      function blockDefaultNavigation(event, target) {
        if (!target) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
          event.stopImmediatePropagation();
        }

        const form = target.closest('form');
        if (form) {
          form.setAttribute('target', '_self');
        }

        const anchor = target.closest('a[href]');
        if (anchor) {
          anchor.setAttribute('target', '_self');
        }
      }

      function stopEvent(event) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
          event.stopImmediatePropagation();
        }
        return false;
      }

      document.addEventListener('mouseover', (event) => {
        const target = getInteractiveTarget(event.target);
        updateOverlay(target);
      }, true);

      document.addEventListener('scroll', () => {
        const hovered = document.querySelector(':hover');
        updateOverlay(getInteractiveTarget(hovered));
      }, true);

      document.addEventListener('pointerdown', (event) => {
        const target = getInteractiveTarget(event.target);
        if (!target) {
          return;
        }

        blockDefaultNavigation(event, target);
      }, true);

      document.addEventListener('mouseup', (event) => {
        const target = getInteractiveTarget(event.target);
        if (!target) {
          return;
        }

        blockDefaultNavigation(event, target);
      }, true);

      document.addEventListener('click', (event) => {
        const target = getInteractiveTarget(event.target);
        if (!target) {
          return;
        }

        blockDefaultNavigation(event, target);
        updateOverlay(target);
        postToParent('ELEMENT_SELECT', getElementInfo(target));

        const anchor = target.closest('a[href]');
        if (anchor) {
          interceptNavigation(anchor.getAttribute('href'));
        }
        return false;
      }, true);

      document.addEventListener('dblclick', (event) => {
        const target = getInteractiveTarget(event.target);
        if (!target) {
          return;
        }

        blockDefaultNavigation(event, target);
      }, true);

      document.addEventListener('auxclick', (event) => {
        const target = getInteractiveTarget(event.target);
        if (!target) {
          return;
        }

        blockDefaultNavigation(event, target);
      }, true);

      document.addEventListener('mousedown', (event) => {
        const target = getInteractiveTarget(event.target);
        if (!target) {
          return;
        }

        if (event.button === 0 || event.button === 1) {
          blockDefaultNavigation(event, target);
        }
      }, true);

      document.addEventListener('keydown', (event) => {
        const active = getInteractiveTarget(document.activeElement);
        if (!active) {
          return;
        }

        if (event.key === 'Enter' || event.key === ' ') {
          blockDefaultNavigation(event, active);
        }
      }, true);

      document.addEventListener('contextmenu', (event) => {
        const target = getInteractiveTarget(event.target);
        if (!target) {
          return;
        }

        event.preventDefault();
        updateOverlay(target);
        postToParent('ELEMENT_RIGHT_CLICK', getElementInfo(target));
      }, true);

      document.addEventListener('submit', (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) {
          return;
        }

        blockDefaultNavigation(event, form);
        const formData = new FormData(form);
        const method = (form.getAttribute('method') || 'GET').toUpperCase();
        const action = form.getAttribute('action') || window.location.href;
        const targetUrl = new URL(action, window.location.href);

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

      if (window.EventTarget && window.EventTarget.prototype && window.EventTarget.prototype.dispatchEvent) {
        const nativeDispatchEvent = window.EventTarget.prototype.dispatchEvent;
        window.EventTarget.prototype.dispatchEvent = function (event) {
          if (
            event &&
            (event.type === 'click' || event.type === 'dblclick' || event.type === 'auxclick') &&
            this instanceof HTMLAnchorElement
          ) {
            if (this.href) {
              interceptNavigation(this.href);
            }
            return true;
          }
          return nativeDispatchEvent.call(this, event);
        };
      }


      const originalPushState = history.pushState;
      history.pushState = function () {
        originalPushState.apply(history, arguments);
        postToParent('NAVIGATE_TO_URL', { url: window.location.href });
      };

      const originalReplaceState = history.replaceState;
      history.replaceState = function () {
        originalReplaceState.apply(history, arguments);
        postToParent('NAVIGATE_TO_URL', { url: window.location.href });
      };

      window.addEventListener('popstate', () => {
        postToParent('NAVIGATE_TO_URL', { url: window.location.href });
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

    $('head').prepend('<base href="' + targetUrl.replace(/"/g, '&quot;') + '">');
    $('body').append('<script>' + buildInjectedScript() + '</script>');

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
        <p style="margin-bottom:8px;">目标地址：${targetUrl}</p>
        <p style="margin-bottom:0;">错误信息：${error.message}</p>
      </body>
      </html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`代理服务运行中: http://localhost:${PORT}`);
});
