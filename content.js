/**
 * GCR Fetch — content.js
 *
 * Injected into every classroom.google.com page.
 * Responsibilities:
 *  1. Detect which tab is active (Stream vs Classwork).
 *  2. Inject the "⬇ GCR Fetch" floating button into the page.
 *  3. Create the sidebar iframe and handle open/close toggling.
 *  4. Relay messages between the sidebar iframe and background.js.
 *
 * Security:
 *  - No innerHTML / outerHTML used. All DOM manipulation uses
 *    createElement, setAttribute, textContent, appendChild.
 *  - The sidebar is loaded from chrome-extension:// URL (same extension),
 *    so it is trusted. Communication uses postMessage with strict origin checks.
 *  - File/attachment data only flows from Google APIs (enforced in background.js)
 *    to the sidebar. Nothing user-supplied is eval'd or inserted as HTML.
 */

'use strict';

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------
let sidebarIframe = null;
let toggleBtn = null;
let sidebarOpen = false;

// Prevent double-injection if the script somehow runs twice.
if (window.__gcrFetchInjected) {
  // Already running — do nothing.
} else {
  window.__gcrFetchInjected = true;
  init();
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------
function init() {
  injectStyles();
  injectToggleButton();
  injectSidebar();

  // Listen for messages from the sidebar iframe.
  window.addEventListener('message', handleSidebarMessage);

  // Re-inject button when Google Classroom navigates (it's a SPA).
  observeNavigation();
}

// ------------------------------------------------------------------
// Inject global styles (button only — sidebar has its own HTML)
// ------------------------------------------------------------------
function injectStyles() {
  const style = document.createElement('style');
  style.id = 'gcr-fetch-btn-style';
  // Use textContent — safe, no HTML interpretation.
  style.textContent = `
    #gcr-fetch-toggle-btn {
      position: fixed;
      bottom: 28px;
      right: 28px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 18px;
      background: linear-gradient(135deg, #1a73e8 0%, #0d47a1 100%);
      color: #ffffff;
      border: none;
      border-radius: 50px;
      font-family: 'Google Sans', 'Roboto', sans-serif;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.3px;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(26,115,232,0.45), 0 2px 6px rgba(0,0,0,0.2);
      transition: transform 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease;
      user-select: none;
    }
    #gcr-fetch-toggle-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 22px rgba(26,115,232,0.55), 0 3px 10px rgba(0,0,0,0.25);
    }
    #gcr-fetch-toggle-btn:active {
      transform: translateY(0px);
    }
    #gcr-fetch-toggle-btn .gcr-btn-icon {
      font-size: 18px;
      line-height: 1;
    }
    #gcr-fetch-sidebar-frame {
      position: fixed;
      top: 0;
      right: 0;
      width: 400px;
      max-width: 100vw;
      height: 100vh;
      z-index: 2147483646;
      border: none;
      box-shadow: -6px 0 32px rgba(0,0,0,0.18);
      transform: translateX(100%);
      transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
      border-radius: 12px 0 0 12px;
      background: transparent;
    }
    #gcr-fetch-sidebar-frame.open {
      transform: translateX(0);
    }
  `;
  document.head.appendChild(style);
}

// ------------------------------------------------------------------
// Toggle Button
// ------------------------------------------------------------------
function injectToggleButton() {
  if (document.getElementById('gcr-fetch-toggle-btn')) return;

  toggleBtn = document.createElement('button');
  toggleBtn.id = 'gcr-fetch-toggle-btn';
  toggleBtn.setAttribute('aria-label', 'Open GCR Fetch resource downloader');
  toggleBtn.setAttribute('title', 'GCR Fetch — Download all resources');

  const icon = document.createElement('span');
  icon.className = 'gcr-btn-icon';
  icon.textContent = '⬇';
  icon.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.textContent = 'GCR Fetch';

  toggleBtn.appendChild(icon);
  toggleBtn.appendChild(label);
  toggleBtn.addEventListener('click', toggleSidebar);

  document.body.appendChild(toggleBtn);
}

// ------------------------------------------------------------------
// Sidebar iframe
// ------------------------------------------------------------------
function injectSidebar() {
  if (document.getElementById('gcr-fetch-sidebar-frame')) return;

  sidebarIframe = document.createElement('iframe');
  sidebarIframe.id = 'gcr-fetch-sidebar-frame';
  sidebarIframe.src = chrome.runtime.getURL('sidebar/sidebar.html');
  sidebarIframe.setAttribute('title', 'GCR Fetch Sidebar');
  sidebarIframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads');

  document.body.appendChild(sidebarIframe);
}

// ------------------------------------------------------------------
// Sidebar toggle
// ------------------------------------------------------------------
function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  if (sidebarIframe) {
    if (sidebarOpen) {
      sidebarIframe.classList.add('open');
      // Tell sidebar to start scanning the current page.
      postToSidebar({ type: 'SCAN_PAGE', url: window.location.href });
    } else {
      sidebarIframe.classList.remove('open');
    }
  }
}

function closeSidebar() {
  sidebarOpen = false;
  sidebarIframe && sidebarIframe.classList.remove('open');
}

// ------------------------------------------------------------------
// Cross-frame messaging
// ------------------------------------------------------------------
const SIDEBAR_ORIGIN = chrome.runtime.getURL('').slice(0, -1); // strip trailing slash

function postToSidebar(message) {
  if (sidebarIframe && sidebarIframe.contentWindow) {
    sidebarIframe.contentWindow.postMessage(message, SIDEBAR_ORIGIN);
  }
}

function handleSidebarMessage(event) {
  // Strict origin check — only accept messages from our own sidebar.
  if (event.origin !== SIDEBAR_ORIGIN) return;

  const { type } = event.data || {};

  switch (type) {
    case 'CLOSE_SIDEBAR':
      closeSidebar();
      break;

    case 'SIDEBAR_READY':
      postToSidebar({ type: 'SCAN_PAGE', url: window.location.href });
      break;

    case 'REQUEST_AUTH_TOKEN':
      // Relay to background.js and forward response back to sidebar.
      chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' }, (response) => {
        postToSidebar({ type: 'AUTH_TOKEN_RESPONSE', ...response });
      });
      break;

    case 'REQUEST_FETCH':
      // Sidebar asks us to proxy-fetch a URL through background.js.
      chrome.runtime.sendMessage(
        {
          type: 'FETCH_WITH_AUTH',
          url: event.data.url,
          responseType: event.data.responseType || 'json',
        },
        (response) => {
          postToSidebar({
            type: 'FETCH_RESPONSE',
            requestId: event.data.requestId,
            ...response,
          });
        }
      );
      break;

    case 'REQUEST_DOM_SCRAPE':
      // Sidebar asks the content script to scrape the live DOM
      // (the content script has access; the iframe does not).
      const scraped = scrapeDom();
      postToSidebar({ type: 'DOM_SCRAPE_RESULT', files: scraped });
      break;

    default:
      break;
  }
}

// ------------------------------------------------------------------
// DOM Scraper
// Extracts file attachment links visible in the current page DOM.
// Returns an array of { name, url, topic, source } objects.
// ------------------------------------------------------------------
function scrapeDom() {
  const files = [];
  const seen = new Set();

  // Helper: add a file entry if not already seen (deduplicate by URL).
  function addFile(entry) {
    if (!entry.url || seen.has(entry.url)) return;
    seen.add(entry.url);
    // Sanitize name: strip path traversal chars, keep alphanumeric + safe punctuation.
    entry.name = sanitizeFilename(entry.name || 'untitled');
    files.push(entry);
  }

  // ── Stream tab: posts with attachments ────────────────────────────
  const streamLinks = document.querySelectorAll('a[href]');
  streamLinks.forEach((anchor) => {
    const href = anchor.href;
    let name = deriveFilename(anchor, href);
    let url = href;
    const driveInfo = parseDriveUrl(href);

    if (driveInfo) {
      url = driveInfo.url;
      if (driveInfo.ext && !name.toLowerCase().endsWith(driveInfo.ext)) {
        name += driveInfo.ext;
      }
      const topic = deriveTopicFromAnchor(anchor);
      addFile({ name, url, topic, source: 'stream-dom' });
    } else if (isFileLink(href)) {
      const topic = deriveTopicFromAnchor(anchor);
      addFile({ name, url, topic, source: 'stream-dom' });
    } else if (isExternalDomLink(href)) {
      const topic = deriveTopicFromAnchor(anchor);
      const linkType = getExternalLinkType(href);
      addFile({
        name,
        url,
        topic,
        source: 'stream-dom',
        isExternalLink: true,
        linkType
      });
    }
  });

  // ── Classwork tab: topic sections with material cards ─────────────
  const topicHeadings = document.querySelectorAll(
    '[class*="topic-title"], [class*="Topic"], h2, h3'
  );
  topicHeadings.forEach((heading) => {
    const topicName = sanitizeText(heading.textContent);
    const parent = heading.closest('[class*="topic"], [class*="Topic"], section, li') ||
                   heading.parentElement;
    if (!parent) return;
    const links = parent.querySelectorAll('a[href]');
    links.forEach((a) => {
      const href = a.href;
      let name = deriveFilename(a, href);
      let url = href;
      const driveInfo = parseDriveUrl(href);

      if (driveInfo) {
        url = driveInfo.url;
        if (driveInfo.ext && !name.toLowerCase().endsWith(driveInfo.ext)) {
          name += driveInfo.ext;
        }
        addFile({ name, url, topic: topicName, source: 'classwork-dom' });
      } else if (isFileLink(href)) {
        addFile({ name, url, topic: topicName, source: 'classwork-dom' });
      } else if (isExternalDomLink(href)) {
        const linkType = getExternalLinkType(href);
        addFile({
          name,
          url,
          topic: topicName,
          source: 'classwork-dom',
          isExternalLink: true,
          linkType
        });
      }
    });
  });

  return files;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Checks whether a URL points to a downloadable file attachment
 * from a known Google-hosted location.
 */
function isFileLink(href) {
  if (!href) return false;
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:') return false;

    const allowed = [
      'drive.google.com',
      'docs.google.com',
      'classroom.google.com',
    ];
    const hostOk = allowed.some((d) => url.hostname === d || url.hostname.endsWith('.' + d));
    if (!hostOk) return false;

    const pathLower = url.pathname.toLowerCase();

    // Google Drive file view/open links
    if (url.hostname.includes('drive.google.com')) {
      if (pathLower.startsWith('/file/d/') || pathLower.includes('/open') || url.searchParams.has('id')) {
        return true;
      }
    }

    // Google Docs/Sheets/Slides editor links
    if (url.hostname.includes('docs.google.com')) {
      if (pathLower.startsWith('/document/d/') || 
          pathLower.startsWith('/spreadsheets/d/') || 
          pathLower.startsWith('/presentation/d/') ||
          pathLower.startsWith('/drawings/d/')) {
        return true;
      }
    }

    // File extensions
    const hasExt = /\.(pdf|pptx?|docx?|xlsx?|png|jpe?g|gif|zip|rar|txt|csv)$/.test(pathLower);
    if (hasExt) return true;

    // Download/export parameters
    if (url.searchParams.has('export') || url.searchParams.has('id')) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Derives a human-readable filename from an anchor and its href.
 * Falls back to the URL pathname basename.
 */
function deriveFilename(anchor, href) {
  // Try aria-label, title, innerText of the anchor.
  const candidates = [
    anchor.getAttribute('aria-label'),
    anchor.getAttribute('title'),
    anchor.textContent,
  ];
  for (const c of candidates) {
    const trimmed = (c || '').trim();
    if (trimmed && trimmed.length > 1 && trimmed.length < 200) {
      return sanitizeFilename(trimmed);
    }
  }
  // Fall back to URL path basename.
  try {
    const url = new URL(href);
    const parts = url.pathname.split('/');
    const last = parts[parts.length - 1];
    if (last) return sanitizeFilename(decodeURIComponent(last));
  } catch { /* ignore */ }
  return 'attachment';
}

/**
 * Walks up the DOM from an anchor to find the nearest section/topic heading.
 */
function deriveTopicFromAnchor(anchor) {
  let el = anchor.parentElement;
  let depth = 0;
  while (el && depth < 10) {
    const heading = el.querySelector('h2, h3, [class*="topic-title"]');
    if (heading) return sanitizeText(heading.textContent);
    // Also check if *this* element is a heading.
    if (['H2', 'H3'].includes(el.tagName)) return sanitizeText(el.textContent);
    el = el.parentElement;
    depth++;
  }
  return 'General';
}

/**
 * Sanitizes a filename to prevent path traversal and invalid characters.
 * Only allows alphanumeric, spaces, hyphens, underscores, dots, and parentheses.
 */
function sanitizeFilename(name) {
  // Strip traversal sequences first.
  let safe = name.replace(/\.\.[/\\]/g, '');
  // Replace path separators.
  safe = safe.replace(/[/\\]/g, '-');
  // Keep only safe characters.
  safe = safe.replace(/[^a-zA-Z0-9 \-_.()\[\]]/g, '_');
  // Trim and cap length.
  safe = safe.trim().slice(0, 120);
  return safe || 'attachment';
}

/**
 * Returns plain text from an element, stripping excess whitespace.
 */
function sanitizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

// ------------------------------------------------------------------
// SPA navigation observer
// Google Classroom navigates without full page reloads.
// We watch for URL changes and re-inject the button if needed.
// ------------------------------------------------------------------
function observeNavigation() {
  let lastUrl = window.location.href;
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      // Notify the sidebar of URL change.
      postToSidebar({ type: 'SCAN_PAGE', url: lastUrl });
      // Give GCR a moment to render the new page before injecting.
      setTimeout(() => {
        injectToggleButton();
      }, 800);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * Parses Google Docs/Drive URLs and constructs a direct download/export URL.
 * Also returns the target file extension.
 */
function parseDriveUrl(href) {
  try {
    const url = new URL(href);
    const pathLower = url.pathname.toLowerCase();

    // Google Docs, Sheets, Slides, Drawings editor URLs
    if (url.hostname.includes('docs.google.com')) {
      if (pathLower.startsWith('/document/d/')) {
        const match = url.pathname.match(/\/document\/d\/([^/]+)/);
        if (match) {
          const id = match[1];
          return {
            id,
            url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
            ext: '.docx'
          };
        }
      }
      if (pathLower.startsWith('/spreadsheets/d/')) {
        const match = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
        if (match) {
          const id = match[1];
          return {
            id,
            url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
            ext: '.xlsx'
          };
        }
      }
      if (pathLower.startsWith('/presentation/d/')) {
        const match = url.pathname.match(/\/presentation\/d\/([^/]+)/);
        if (match) {
          const id = match[1];
          return {
            id,
            url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=application/vnd.openxmlformats-officedocument.presentationml.presentation`,
            ext: '.pptx'
          };
        }
      }
      if (pathLower.startsWith('/drawings/d/')) {
        const match = url.pathname.match(/\/drawings\/d\/([^/]+)/);
        if (match) {
          const id = match[1];
          return {
            id,
            url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=image/png`,
            ext: '.png'
          };
        }
      }
    }

    // Google Drive links
    if (url.hostname.includes('drive.google.com')) {
      let id = null;
      if (pathLower.startsWith('/file/d/')) {
        const match = url.pathname.match(/\/file\/d\/([^/]+)/);
        if (match) id = match[1];
      } else if (url.searchParams.has('id')) {
        id = url.searchParams.get('id');
      }
      if (id) {
        return {
          id,
          url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`,
          ext: ''
        };
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Checks whether a DOM link is a valid external link (not internal GCR/Google accounts UI).
 */
function isExternalDomLink(href) {
  if (!href) return false;
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

    const host = url.hostname.toLowerCase();

    // Ignore all google.com and subdomains except Drive, Docs, Sites, and Colab
    if (host === 'google.com' || host.endsWith('.google.com')) {
      const allowedSubdomains = [
        'drive.google.com',
        'docs.google.com',
        'sites.google.com',
        'colab.research.google.com'
      ];
      if (!allowedSubdomains.includes(host)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Maps the URL hostname and path to a categorised linkType.
 */
function getExternalLinkType(href) {
  try {
    const url = new URL(href);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();

    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      return 'youtube';
    }
    if (host.includes('docs.google.com')) {
      if (path.startsWith('/forms/')) return 'form';
      if (path.startsWith('/drive/folders/')) return 'folder';
    }
    if (host.includes('forms.gle')) {
      return 'form';
    }
    if (host.includes('drive.google.com')) {
      if (path.startsWith('/drive/folders/')) return 'folder';
    }
    return 'link';
  } catch {
    return 'link';
  }
}

