/**
 * GCR Fetch — lib/zipper.js
 *
 * Creates and triggers download of a ZIP archive from a list of FileEntry objects.
 * Requires JSZip (window.JSZip) to be loaded before this script.
 *
 * Security:
 *  - All filenames are re-sanitized here as a second layer of defense,
 *    even if fetcher.js already sanitized them.
 *  - ZIP path components are validated to prevent directory traversal
 *    attacks within the archive (no ".." segments allowed).
 *  - File data is fetched via the background proxy which enforces
 *    origin allowlists and HTTPS-only policy.
 *  - No eval(), innerHTML, or dynamic code execution.
 */

'use strict';

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Downloads selected files as a ZIP archive.
 *
 * @param {FileEntry[]} files    - Selected files to include (already filtered/checked)
 * @param {'flat'|'categorized'} mode - ZIP structure mode
 * @param {function} onProgress  - Progress callback (current, total, filename)
 * @returns {Promise<void>}
 */
async function downloadAsZip(files, mode, convertToPdf, onProgress) {
  if (!window.JSZip) throw new Error('JSZip library not loaded');
  if (!files || files.length === 0) throw new Error('No files selected');

  const zip = new JSZip();
  const report = (curr, total, name) => { if (onProgress) onProgress(curr, total, name); };

  // Partition files into downloadable files and external links
  const downloadFiles = [];
  const linkFiles = [];
  files.forEach((f) => {
    if (f.isExternalLink) {
      linkFiles.push(f);
    } else {
      downloadFiles.push(f);
    }
  });

  const totalSteps = files.length;
  let currentStep = 0;

  // Track used ZIP paths to handle filename collisions.
  const usedPaths = new Set();

  // 1. Process external links (generate individual shortcuts and the HTML dashboard)
  if (linkFiles.length > 0) {
    try {
      const htmlBlob = generateHtmlBlob(linkFiles);
      if (htmlBlob) {
        zip.file('External Resources.html', htmlBlob);
      }
    } catch (err) {
      console.error('[GCR Fetch] Failed to generate HTML Dashboard:', err);
      if (window.showToast) {
        window.showToast(`Failed to generate HTML: ${err.message}`, 'error');
      }
    }

    for (let j = 0; j < linkFiles.length; j++) {
      const file = linkFiles[j];
      report(currentStep, totalSteps, `Shortcut: ${file.name}`);

      try {
        const shortcutContent = `[InternetShortcut]\r\nURL=${file.url}\r\n`;
        const zipPath = buildZipPath(file, mode, usedPaths, false);
        zip.file(zipPath, shortcutContent);
      } catch (err) {
        console.warn('[GCR Fetch] Failed to create shortcut file:', err);
      }
      currentStep++;
    }
  }

  // 2. Process downloadable files
  for (let i = 0; i < downloadFiles.length; i++) {
    const file = downloadFiles[i];
    report(currentStep, totalSteps, file.name);

    try {
      let blob = null;
      let isPdfConverted = false;

      if (convertToPdf && isConvertibleToPdf(file)) {
        blob = await convertAndFetchPdfBlob(file);
        if (blob) {
          isPdfConverted = true;
        } else {
          throw new Error("PDF conversion failed for " + file.name);
        }
      } else {
        blob = await fetchFileBlob(file.url);
      }

      if (blob) {
        const zipPath = buildZipPath(file, mode, usedPaths, isPdfConverted);
        zip.file(zipPath, blob);
      }
    } catch (err) {
      console.warn(`[GCR Fetch] Skipped file ${i + 1}/${downloadFiles.length} — fetch failed`);
    }
    currentStep++;
  }

  report(totalSteps, totalSteps, 'Generating ZIP…');

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  triggerDownload(zipBlob, `gcr-resources-${Date.now()}.zip`);
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

/**
 * Fetches a file as a Blob through the background service worker proxy.
 * Falls back to a direct fetch for non-Drive URLs that don't need auth.
 *
 * @param {string} url
 * @returns {Promise<Blob|null>}
 */
async function fetchFileBlob(url) {
  return new Promise((resolve) => {
    // Use the background proxy which injects the auth header.
    chrome.runtime.sendMessage(
      { type: 'FETCH_WITH_AUTH', url, responseType: 'blob' },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        if (!response || !response.success) {
          resolve(null);
          return;
        }
        // Background returns base64 data (Blob can't cross message channel).
        try {
          const binary = atob(response.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: response.mimeType || 'application/octet-stream' });
          resolve(blob);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * Builds the path for a file inside the ZIP archive.
 * Sanitizes each path segment to prevent directory traversal.
 * Appends a numeric suffix if the path already exists.
 *
 * @param {FileEntry} file
 * @param {'flat'|'categorized'} mode
 * @param {Set<string>} usedPaths - Mutable set of already-used paths
 * @param {boolean} isPdfConverted - Whether to enforce .pdf extension
 * @returns {string}
 */
function buildZipPath(file, mode, usedPaths, isPdfConverted) {
  let safeName = sanitizeZipSegment(file.name);
  if (isPdfConverted) {
    const lastDot = safeName.lastIndexOf('.');
    if (lastDot > 0) safeName = safeName.slice(0, lastDot);
    safeName += '.pdf';
  } else if (file.isExternalLink) {
    // Force .url extension for link shortcuts
    const lastDot = safeName.lastIndexOf('.');
    if (lastDot > 0) {
      const ext = safeName.slice(lastDot).toLowerCase();
      if (ext !== '.url') {
        safeName = safeName.slice(0, lastDot) + '.url';
      }
    } else {
      safeName += '.url';
    }
  }

  let basePath;
  if (mode === 'categorized') {
    const safeTopic = sanitizeZipSegment(file.topic || 'General');
    basePath = `${safeTopic}/${safeName}`;
  } else {
    if (file.isSubmission) {
      basePath = `[My Work] ${safeName}`;
    } else if (file.isExternalLink) {
      basePath = `[Link] ${safeName}`;
    } else {
      basePath = safeName;
    }
  }

  // Resolve collisions by appending (1), (2), etc.
  if (!usedPaths.has(basePath)) {
    usedPaths.add(basePath);
    return basePath;
  }

  // Separate name and extension for clean suffix insertion.
  const lastDot = safeName.lastIndexOf('.');
  const nameBase = lastDot > 0 ? safeName.slice(0, lastDot) : safeName;
  const ext      = lastDot > 0 ? safeName.slice(lastDot) : '';

  for (let n = 1; n < 999; n++) {
    let candidate;
    if (mode === 'categorized') {
      const safeTopic = sanitizeZipSegment(file.topic || 'General');
      candidate = `${safeTopic}/${nameBase} (${n})${ext}`;
    } else {
      candidate = `${nameBase} (${n})${ext}`;
    }
    if (!usedPaths.has(candidate)) {
      usedPaths.add(candidate);
      return candidate;
    }
  }

  // Extremely unlikely fallback.
  const fallback = `${Date.now()}-${safeName}`;
  usedPaths.add(fallback);
  return fallback;
}

/**
 * Sanitizes a single ZIP path segment (filename or folder name).
 * Prevents directory traversal within the archive by:
 *  1. Rejecting ".." components.
 *  2. Stripping path separators.
 *  3. Allowlisting safe characters only.
 *
 * @param {string} segment
 * @returns {string}
 */
function sanitizeZipSegment(segment) {
  if (!segment) return 'untitled';

  // Reject traversal patterns.
  if (segment === '..' || segment === '.') return 'untitled';
  let safe = segment.replace(/\.\.[/\\]/g, '');

  // Strip path separators — no slashes allowed inside a single segment.
  safe = safe.replace(/[/\\]/g, '-');

  // Allowlist: alphanumeric, space, hyphen, underscore, dot, parens, brackets.
  safe = safe.replace(/[^a-zA-Z0-9 \-_.()\[\]]/g, '_');

  // Trim and cap length.
  safe = safe.trim().slice(0, 120);

  return safe || 'untitled';
}

/**
 * Triggers a browser file download for a Blob.
 * Uses an object URL that is revoked immediately after the click.
 *
 * @param {Blob} blob
 * @param {string} filename - Already-sanitized filename
 */
function triggerDownload(blob, filename) {
  // Extra sanitization on the download filename itself.
  const safeFilename = sanitizeZipSegment(filename);
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.setAttribute('download', safeFilename);
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();

  // Revoke the object URL after a short delay to allow the download to start.
  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }, 1000);
}

// ------------------------------------------------------------------
// PDF Conversion Helpers
// ------------------------------------------------------------------

function isConvertibleToPdf(file) {
  if (!file.url) return false;
  if (file.url.includes('/export?mimeType=')) return true;
  
  const id = file.driveFileId || getDriveIdFromUrl(file.url);
  if (id) {
    const ext = file.name.split('.').pop().toLowerCase();
    const convertibleExts = ['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'md', 'txt', 'rtf', 'csv'];
    if (convertibleExts.includes(ext)) return true;

    // Check MIME type if extension is missing
    const m = file.mimeType || '';
    if (m.includes('wordprocessingml') || m.includes('msword') ||
        m.includes('presentationml') || m.includes('ms-powerpoint') ||
        m.includes('spreadsheetml') || m.includes('ms-excel')) {
      return true;
    }
  }
  return false;
}

function getDriveIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.pathname.startsWith('/drive/v3/files/')) {
      const match = u.pathname.match(/\/drive\/v3\/files\/([^/]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
  } catch (e) {}
  return null;
}

async function convertAndFetchPdfBlob(file) {
  if (file.url.includes('/export?mimeType=')) {
    const pdfUrl = file.url.replace(/mimeType=[^&]+/, 'mimeType=application/pdf');
    return await fetchFileBlob(pdfUrl);
  }

  const id = file.driveFileId || getDriveIdFromUrl(file.url);
  if (!id) return null;

  const ext = file.name.split('.').pop().toLowerCase();
  const m = file.mimeType || '';
  let targetMimeType = 'application/vnd.google-apps.document';
  
  if (['ppt', 'pptx'].includes(ext) || m.includes('presentationml') || m.includes('ms-powerpoint')) {
    targetMimeType = 'application/vnd.google-apps.presentation';
  } else if (['xls', 'xlsx', 'csv'].includes(ext) || m.includes('spreadsheetml') || m.includes('ms-excel')) {
    targetMimeType = 'application/vnd.google-apps.spreadsheet';
  }

  // 1. Copy to convert
  const copyRes = await apiFetchJSON(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/copy?supportsAllDrives=true`,
    'POST',
    JSON.stringify({ mimeType: targetMimeType })
  );

  if (!copyRes || !copyRes.id) return null;
  const newId = copyRes.id;
  // 2. Export PDF
  const pdfUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(newId)}/export?mimeType=application/pdf`;
  const blob = await fetchFileBlob(pdfUrl);

  // 3. Delete temp file
  await apiFetchJSON(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(newId)}`, 'DELETE');

  return blob;
}

function apiFetchJSON(url, method, body) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { 
        type: 'FETCH_WITH_AUTH', 
        url, 
        responseType: 'json', 
        method, 
        body, 
        headers: body ? { 'Content-Type': 'application/json' } : {} 
      },
      (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          const err = chrome.runtime.lastError?.message || response?.error || 'Unknown API error';
          if (window.showToast) {
            window.showToast(`PDF API Error: ${err.slice(0,100)}`, 'error');
          }
          resolve(null);
        } else {
          resolve(response.data);
        }
      }
    );
  });
}

// ------------------------------------------------------------------
// HTML Dashboard Generation Helper
// ------------------------------------------------------------------

function generateHtmlBlob(links) {
  // Group links by type
  const groups = {
    'youtube': { title: 'YouTube Videos', icon: '🎥', class: 'cat-youtube', items: [] },
    'form': { title: 'Google Forms', icon: '📝', class: 'cat-form', items: [] },
    'folder': { title: 'Google Drive Folders', icon: '📁', class: 'cat-folder', items: [] },
    'link': { title: 'Web Resources', icon: '🔗', class: 'cat-link', items: [] }
  };

  links.forEach(link => {
    const t = link.linkType || 'link';
    if (groups[t]) {
      groups[t].items.push(link);
    } else {
      groups['link'].items.push(link);
    }
  });

  const countByGroup = {
    youtube: groups['youtube'].items.length,
    form: groups['form'].items.length,
    folder: groups['folder'].items.length,
    link: groups['link'].items.length,
    total: links.length
  };

  let cardsHtml = '';
  Object.keys(groups).forEach(key => {
    const group = groups[key];
    if (group.items.length === 0) return;

    let itemsHtml = '';
    group.items.forEach(item => {
      const escapedTitle = escapeHtml(item.name || 'Resource Link');
      const escapedPostTitle = escapeHtml(item.postTitle || 'General Post');
      const escapedTopic = escapeHtml(item.topic || 'General Topic');
      const escapedUrl = escapeHtml(item.url || '#');

      itemsHtml += `
        <li class="link-item" data-name="${escapedTitle}" data-post="${escapedPostTitle}" data-topic="${escapedTopic}" data-url="${escapedUrl}">
          <div class="link-item-content">
            <a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" class="link-title" title="${escapedTitle}">${escapedTitle}</a>
            <div class="link-meta">
              <span class="badge badge-post" title="Classroom Post: ${escapedPostTitle}">${escapedPostTitle}</span>
              <span class="badge badge-topic" title="Topic: ${escapedTopic}">${escapedTopic}</span>
            </div>
          </div>
          <div class="link-actions">
            <button class="action-btn copy-btn" data-url="${escapedUrl}" title="Copy Link">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
              </svg>
            </button>
            <a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" class="action-btn" title="Open Link">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>
              </svg>
            </a>
          </div>
        </li>
      `;
    });

    cardsHtml += `
      <div class="category-card ${group.class}">
        <div class="category-header">
          <div class="category-header-title">
            <span>${group.icon}</span>
            <span>${group.title}</span>
          </div>
          <span class="category-badge">${group.items.length}</span>
        </div>
        <ul class="links-list">
          ${itemsHtml}
        </ul>
      </div>
    `;
  });

  const timestamp = new Date().toLocaleString();

  const htmlContent = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Classroom External Resources Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #090d16;
      --bg-secondary: #131b2e;
      --bg-tertiary: #1e293b;
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --accent-color: #3b82f6;
      --accent-hover: #2563eb;
      --card-border: rgba(255, 255, 255, 0.06);
      --card-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -4px rgba(0, 0, 0, 0.3);
      --transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      
      --color-youtube: #ef4444;
      --color-form: #a855f7;
      --color-folder: #eab308;
      --color-link: #10b981;
    }

    [data-theme="light"] {
      --bg-primary: #f8fafc;
      --bg-secondary: #ffffff;
      --bg-tertiary: #f1f5f9;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --accent-color: #1a73e8;
      --accent-hover: #1557b0;
      --card-border: rgba(0, 0, 0, 0.08);
      --card-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05), 0 4px 6px -4px rgba(0, 0, 0, 0.05);
      
      --color-youtube: #dc2626;
      --color-form: #8b5cf6;
      --color-folder: #ca8a04;
      --color-link: #059669;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Outfit', sans-serif;
      background-color: var(--bg-primary);
      color: var(--text-primary);
      transition: var(--transition);
      line-height: 1.5;
      padding-bottom: 60px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 24px;
    }

    header {
      background: linear-gradient(135deg, var(--bg-secondary) 0%, rgba(19, 27, 46, 0.8) 100%);
      border-bottom: 1px solid var(--card-border);
      padding: 40px 0;
      margin-bottom: 40px;
      position: relative;
      overflow: hidden;
    }
    
    [data-theme="light"] header {
      background: linear-gradient(135deg, var(--bg-secondary) 0%, rgba(255, 255, 255, 0.8) 100%);
    }

    header::before {
      content: '';
      position: absolute;
      top: -50%;
      right: -10%;
      width: 400px;
      height: 400px;
      background: radial-gradient(circle, rgba(59, 130, 246, 0.1) 0%, transparent 70%);
      pointer-events: none;
    }

    .header-content {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 20px;
    }

    .title-area h1 {
      font-size: 2.25rem;
      font-weight: 700;
      letter-spacing: -0.025em;
      margin-bottom: 8px;
      background: linear-gradient(to right, var(--text-primary), var(--accent-color));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .title-area p {
      color: var(--text-secondary);
      font-size: 1rem;
    }

    .controls-wrapper {
      display: flex;
      flex-direction: column;
      gap: 20px;
      margin-bottom: 30px;
    }

    .search-filter-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }

    .search-container {
      position: relative;
      flex: 1;
      min-width: 280px;
    }

    .search-input {
      width: 100%;
      padding: 14px 16px 14px 46px;
      background-color: var(--bg-secondary);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 0.95rem;
      transition: var(--transition);
      outline: none;
      box-shadow: var(--card-shadow);
    }

    .search-input:focus {
      border-color: var(--accent-color);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
    }

    .search-icon {
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-secondary);
      pointer-events: none;
      width: 18px;
      height: 18px;
    }

    .filter-pills {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .filter-pill {
      background-color: var(--bg-secondary);
      border: 1px solid var(--card-border);
      color: var(--text-secondary);
      padding: 10px 16px;
      border-radius: 99px;
      font-family: inherit;
      font-weight: 500;
      font-size: 0.9rem;
      cursor: pointer;
      transition: var(--transition);
      box-shadow: var(--card-shadow);
    }

    .filter-pill:hover {
      color: var(--text-primary);
      background-color: var(--bg-tertiary);
    }

    .filter-pill.active {
      color: #ffffff;
      background-color: var(--accent-color);
      border-color: var(--accent-color);
    }

    .theme-toggle-btn {
      background-color: var(--bg-secondary);
      border: 1px solid var(--card-border);
      color: var(--text-primary);
      padding: 12px 18px;
      border-radius: 12px;
      cursor: pointer;
      font-family: inherit;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: var(--transition);
      box-shadow: var(--card-shadow);
    }

    .theme-toggle-btn:hover {
      background-color: var(--bg-tertiary);
      border-color: var(--text-secondary);
    }

    .stats-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 40px;
    }

    .stat-card {
      background-color: var(--bg-secondary);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 16px 20px;
      display: flex;
      align-items: center;
      gap: 16px;
      box-shadow: var(--card-shadow);
    }

    .stat-icon {
      font-size: 1.75rem;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      background-color: var(--bg-tertiary);
      border-radius: 10px;
    }

    .stat-info {
      display: flex;
      flex-direction: column;
    }

    .stat-value {
      font-size: 1.5rem;
      font-weight: 700;
      line-height: 1.2;
    }

    .stat-label {
      font-size: 0.8rem;
      color: var(--text-secondary);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .resources-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 30px;
    }

    @media (min-width: 900px) {
      .resources-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    .category-card {
      background-color: var(--bg-secondary);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      box-shadow: var(--card-shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: var(--transition);
    }

    .category-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 20px -5px rgba(0,0,0,0.15);
    }

    .category-header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
      font-size: 1.2rem;
    }

    .category-header-title {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .category-badge {
      font-size: 0.8rem;
      background-color: var(--bg-tertiary);
      color: var(--text-primary);
      padding: 4px 10px;
      border-radius: 99px;
      font-weight: 500;
    }

    .links-list {
      list-style: none;
      padding: 8px 0;
      flex: 1;
      max-height: 500px;
      overflow-y: auto;
    }

    .link-item {
      padding: 16px 24px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      align-items: flex-start;
      gap: 16px;
      transition: var(--transition);
    }

    .link-item:last-child {
      border-bottom: none;
    }

    .link-item:hover {
      background-color: rgba(255, 255, 255, 0.02);
    }

    [data-theme="light"] .link-item:hover {
      background-color: rgba(0, 0, 0, 0.01);
    }

    .link-item-content {
      flex: 1;
      min-width: 0;
    }

    .link-title {
      display: block;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--text-primary);
      text-decoration: none;
      margin-bottom: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: var(--transition);
    }

    .link-title:hover {
      color: var(--accent-color);
    }

    .link-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .badge {
      display: inline-block;
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 6px;
      font-weight: 500;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .badge-post {
      background-color: var(--bg-tertiary);
      color: var(--text-secondary);
      border: 1px solid var(--card-border);
    }

    .badge-topic {
      background-color: rgba(59, 130, 246, 0.1);
      color: var(--accent-color);
    }

    .link-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .action-btn {
      background-color: var(--bg-tertiary);
      border: 1px solid var(--card-border);
      color: var(--text-secondary);
      cursor: pointer;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: var(--transition);
      text-decoration: none;
    }

    .action-btn:hover {
      color: var(--text-primary);
      border-color: var(--text-secondary);
      background-color: rgba(255, 255, 255, 0.05);
    }
    
    [data-theme="light"] .action-btn:hover {
      background-color: rgba(0, 0, 0, 0.05);
    }

    .action-btn svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
    }

    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background-color: var(--bg-secondary);
      color: var(--text-primary);
      border: 1px solid var(--card-border);
      box-shadow: var(--card-shadow);
      padding: 12px 24px;
      border-radius: 10px;
      font-weight: 500;
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      z-index: 1000;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    .no-results {
      text-align: center;
      padding: 60px 20px;
      background-color: var(--bg-secondary);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      box-shadow: var(--card-shadow);
      margin-top: 20px;
      display: none;
    }

    .no-results-icon {
      font-size: 3rem;
      margin-bottom: 16px;
    }

    .no-results h3 {
      font-size: 1.25rem;
      margin-bottom: 8px;
    }

    .no-results p {
      color: var(--text-secondary);
    }

    .cat-youtube { border-top: 4px solid var(--color-youtube); }
    .cat-youtube .category-header { color: var(--color-youtube); }
    
    .cat-form { border-top: 4px solid var(--color-form); }
    .cat-form .category-header { color: var(--color-form); }
    
    .cat-folder { border-top: 4px solid var(--color-folder); }
    .cat-folder .category-header { color: var(--color-folder); }
    
    .cat-link { border-top: 4px solid var(--color-link); }
    .cat-link .category-header { color: var(--color-link); }
  </style>
</head>
<body>
  <header>
    <div class="container header-content">
      <div class="title-area">
        <h1>External Resources Dashboard</h1>
        <p>Generated on ${timestamp} — Compiled from your Google Classroom course</p>
      </div>
      <button class="theme-toggle-btn" id="theme-toggle-btn">
        <span id="theme-toggle-icon">☀️</span>
        <span id="theme-toggle-text">Light Mode</span>
      </button>
    </div>
  </header>

  <main class="container">
    <div class="controls-wrapper">
      <div class="search-filter-row">
        <div class="search-container">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M15.5 14H14.79L14.54 13.75C15.42 12.72 15.96 11.39 15.96 9.96C15.96 6.65 13.27 3.96 9.96 3.96C6.65 3.96 3.96 6.65 3.96 9.96C3.96 13.27 6.65 15.96 9.96 15.96C11.39 15.96 12.72 15.42 13.75 14.54L13.75 14.79V15.5L18.25 20L19.5 18.75L15.5 14ZM9.96 14C7.72 14 5.92 12.2 5.92 9.96C5.92 7.72 7.72 5.92 9.96 5.92C12.2 5.92 14 7.72 14 9.96C14 12.2 12.2 14 9.96 14Z" fill="currentColor"/>
          </svg>
          <input type="text" id="search-input" class="search-input" placeholder="Search by resource title, topic, or post title...">
        </div>
        <div class="filter-pills" id="filter-pills">
          <button class="filter-pill active" data-filter="all">All</button>
          <button class="filter-pill" data-filter="cat-youtube">🎥 Videos</button>
          <button class="filter-pill" data-filter="cat-form">📝 Forms</button>
          <button class="filter-pill" data-filter="cat-folder">📁 Folders</button>
          <button class="filter-pill" data-filter="cat-link">🔗 Web Links</button>
        </div>
      </div>
    </div>

    <div class="stats-bar">
      <div class="stat-card">
        <div class="stat-icon">📚</div>
        <div class="stat-info">
          <span class="stat-value">${countByGroup.total}</span>
          <span class="stat-label">Total Links</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🎥</div>
        <div class="stat-info">
          <span class="stat-value">${countByGroup.youtube}</span>
          <span class="stat-label">Videos</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📝</div>
        <div class="stat-info">
          <span class="stat-value">${countByGroup.form}</span>
          <span class="stat-label">Google Forms</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📁</div>
        <div class="stat-info">
          <span class="stat-value">${countByGroup.folder}</span>
          <span class="stat-label">Folders</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🔗</div>
        <div class="stat-info">
          <span class="stat-value">${countByGroup.link}</span>
          <span class="stat-label">Web Links</span>
        </div>
      </div>
    </div>

    <div class="resources-grid" id="resources-grid">
      ${cardsHtml}
    </div>

    <div class="no-results" id="no-results">
      <div class="no-results-icon">🔍</div>
      <h3>No matching resources found</h3>
      <p>Try refining your search term or checking for typos.</p>
    </div>
  </main>

  <div class="toast" id="toast">Copied to clipboard!</div>

  <script>
    // Theme Toggle
    const themeBtn = document.getElementById('theme-toggle-btn');
    const themeIcon = document.getElementById('theme-toggle-icon');
    const themeText = document.getElementById('theme-toggle-text');

    function toggleTheme() {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('gcr-dashboard-theme', newTheme);
      
      if (newTheme === 'dark') {
        themeIcon.textContent = '☀️';
        themeText.textContent = 'Light Mode';
      } else {
        themeIcon.textContent = '🌙';
        themeText.textContent = 'Dark Mode';
      }
    }

    // Load persisted theme
    const savedTheme = localStorage.getItem('gcr-dashboard-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    if (savedTheme === 'light') {
      themeIcon.textContent = '🌙';
      themeText.textContent = 'Dark Mode';
    }

    themeBtn.addEventListener('click', toggleTheme);

    // Search & Filter
    const searchInput = document.getElementById('search-input');
    const listItems = document.querySelectorAll('.link-item');
    const categoryCards = document.querySelectorAll('.category-card');
    const noResults = document.getElementById('no-results');

    // Filter Pills
    const filterPills = document.querySelectorAll('.filter-pill');
    let activeFilter = 'all';

    filterPills.forEach(pill => {
      pill.addEventListener('click', () => {
        filterPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        activeFilter = pill.getAttribute('data-filter');
        filterResources();
      });
    });

    function filterResources() {
      const query = searchInput.value.toLowerCase().trim();
      let totalVisible = 0;

      categoryCards.forEach(card => {
        const isCorrectCategory = activeFilter === 'all' || card.classList.contains(activeFilter);
        const items = card.querySelectorAll('.link-item');
        let visibleInCard = 0;

        items.forEach(item => {
          const name = item.getAttribute('data-name').toLowerCase();
          const post = item.getAttribute('data-post').toLowerCase();
          const topic = item.getAttribute('data-topic').toLowerCase();
          const url = item.getAttribute('data-url').toLowerCase();
          
          const matchesSearch = name.includes(query) || post.includes(query) || topic.includes(query) || url.includes(query);
          
          if (isCorrectCategory && matchesSearch) {
            item.style.display = 'flex';
            visibleInCard++;
            totalVisible++;
          } else {
            item.style.display = 'none';
          }
        });

        // Update badge count
        const badge = card.querySelector('.category-badge');
        if (badge) {
          badge.textContent = visibleInCard;
        }

        // Hide card if no visible items
        if (visibleInCard === 0) {
          card.style.display = 'none';
        } else {
          card.style.display = 'flex';
        }
      });

      if (totalVisible === 0) {
        noResults.style.display = 'block';
      } else {
        noResults.style.display = 'none';
      }
    }

    searchInput.addEventListener('input', filterResources);

    // Toast & Copy Functionality
    const toast = document.getElementById('toast');
    let toastTimeout;

    function showToast(message) {
      toast.textContent = message;
      toast.classList.add('show');
      clearTimeout(toastTimeout);
      toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
      }, 2000);
    }

    // Attach copy click listeners safely (Vanilla JS best practice, no inline JS)
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-url');
        if (url) {
          navigator.clipboard.writeText(url).then(() => {
            showToast('Copied link to clipboard!');
          }).catch(() => {
            showToast('Failed to copy link');
          });
        }
      });
    });
  </script>
</body>
</html>`;

  return new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
}

function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe.replace(/[&<>"']/g, function (c) {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case '\'': return '&#039;';
    }
  });
}

// ------------------------------------------------------------------
// Export
// ------------------------------------------------------------------
window.GCRZipper = { downloadAsZip };
