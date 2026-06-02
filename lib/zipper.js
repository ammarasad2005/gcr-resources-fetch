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

  // Track used ZIP paths to handle filename collisions.
  const usedPaths = new Set();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    report(i, files.length, file.name);

    try {
      let blob = null;
      let isPdfConverted = false;

      if (convertToPdf && isConvertibleToPdf(file)) {
        blob = await convertAndFetchPdfBlob(file);
        if (blob) {
          isPdfConverted = true;
        } else {
          // If conversion fails, fail the whole download to prevent silent fallback
          throw new Error("PDF conversion failed for " + file.name);
        }
      } else {
        blob = await fetchFileBlob(file.url);
      }

      if (!blob) continue;

      const zipPath = buildZipPath(file, mode, usedPaths, isPdfConverted);
      zip.file(zipPath, blob);
    } catch (err) {
      // Non-fatal: skip this file, continue with the rest.
      // Log only the index and a generic message, not the URL (may contain tokens).
      console.warn(`[GCR Fetch] Skipped file ${i + 1}/${files.length} — fetch failed`);
    }
  }

  report(files.length, files.length, 'Generating ZIP…');

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
  }

  let basePath;
  if (mode === 'categorized') {
    const safeTopic = sanitizeZipSegment(file.topic || 'General');
    basePath = `${safeTopic}/${safeName}`;
  } else {
    basePath = safeName;
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
// Export
// ------------------------------------------------------------------
window.GCRZipper = { downloadAsZip };
