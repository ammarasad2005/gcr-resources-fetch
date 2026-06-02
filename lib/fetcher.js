/**
 * GCR Fetch — lib/fetcher.js
 *
 * Hybrid resource fetcher:
 *  Phase 1 — receives DOM-scraped links from the content script.
 *  Phase 2 — calls Google Classroom REST API to discover attachments
 *             not yet rendered in the DOM (lazy-loaded, hidden behind
 *             "See more", or in unexpanded Classwork topics).
 *
 * Returns a de-duplicated, normalized array of FileEntry objects:
 *   { id, name, url, driveFileId, mimeType, topic, source }
 *
 * Security:
 *  - All API calls go through background.js which enforces the origin
 *    allowlist and HTTPS-only policy.
 *  - Filenames returned from the API are sanitized before use.
 *  - No eval(), no innerHTML, no dynamic code execution.
 *  - The auth token is never stored — it is obtained per-session and
 *    discarded after use (held only in the service-worker).
 */

'use strict';

// ------------------------------------------------------------------
// Exported entry point
// ------------------------------------------------------------------

/**
 * Fetches all resources for the current Google Classroom course.
 *
 * @param {string}   courseId      - GCR course ID (extracted from URL)
 * @param {FileEntry[]} domFiles   - Pre-scraped results from the DOM
 * @param {function} onProgress    - Progress callback (message string)
 * @returns {Promise<FileEntry[]>}
 */
async function fetchAllResources(courseId, domFiles, onProgress) {
  const report = (msg) => { if (onProgress) onProgress(msg); };

  report('Starting API scan…');

  const allFiles = [...domFiles];
  const errors = [];
  const seenIds  = new Set(domFiles.map((f) => f.id).filter(Boolean));
  const seenUrls = new Set(domFiles.map((f) => f.url).filter(Boolean));

  // Helper: add if not duplicate
  function merge(entry) {
    const dedupeKey = entry.driveFileId || entry.url;
    if (!dedupeKey) return;
    if (seenIds.has(entry.driveFileId)) return;
    if (seenUrls.has(entry.url)) return;
    if (entry.driveFileId) seenIds.add(entry.driveFileId);
    if (entry.url) seenUrls.add(entry.url);
    entry.name = sanitizeFilename(entry.name || 'untitled');
    allFiles.push(entry);
  }

  // ── Phase 2a: Classwork (courseWork) ─────────────────────────────
  try {
    report('Fetching coursework list…');
    const cwData = await apiGet(
      `https://classroom.googleapis.com/v1/courses/${encodeURIComponent(courseId)}/courseWork?pageSize=250`
    );
    if (cwData && cwData.courseWork) {
      for (const cw of cwData.courseWork) {
        const topic = sanitizeFilename(cw.title || 'Coursework');
        const materials = cw.materials || [];
        for (const mat of materials) {
          const entry = materialToFileEntry(mat, topic, 'coursework-api');
          if (entry) merge(entry);
        }
      }
    }
  } catch (err) {
    console.error('[GCR Fetch] Coursework API error:', err);
    report('Coursework API error: ' + err.message + ' — relying on DOM.');
    errors.push(err.message);
  }

  // ── Phase 2b: Course Materials (announcements + materials) ────────
  try {
    report('Fetching course materials…');
    const matData = await apiGet(
      `https://classroom.googleapis.com/v1/courses/${encodeURIComponent(courseId)}/courseWorkMaterials?pageSize=250`
    );
    if (matData && matData.courseWorkMaterial) {
      for (const item of matData.courseWorkMaterial) {
        const topic = sanitizeFilename(item.title || 'Materials');
        const materials = item.materials || [];
        for (const mat of materials) {
          const entry = materialToFileEntry(mat, topic, 'materials-api');
          if (entry) merge(entry);
        }
      }
    }
  } catch (err) {
    console.error('[GCR Fetch] Materials API error:', err);
    report('Materials API error: ' + err.message + ' — relying on DOM.');
    errors.push(err.message);
  }

  // ── Phase 2c: Announcements (Stream posts) ────────────────────────
  try {
    report('Fetching announcements…');
    const annData = await apiGet(
      `https://classroom.googleapis.com/v1/courses/${encodeURIComponent(courseId)}/announcements?pageSize=250`
    );
    if (annData && annData.announcements) {
      for (const ann of annData.announcements) {
        const topic = 'Stream';
        const materials = ann.materials || [];
        for (const mat of materials) {
          const entry = materialToFileEntry(mat, topic, 'announcement-api');
          if (entry) merge(entry);
        }
      }
    }
  } catch (err) {
    console.error('[GCR Fetch] Announcements API error:', err);
    report('Announcements API error: ' + err.message + ' — relying on DOM.');
    errors.push(err.message);
  }

  report(`Found ${allFiles.length} file(s) total.`);
  return { files: allFiles, errors };
}

// ------------------------------------------------------------------
// Material → FileEntry converter
// ------------------------------------------------------------------

/**
 * Converts a Google Classroom API "material" object into a FileEntry.
 * Handles driveFile, link, youtubeVideo, and form attachment types.
 *
 * @param {object} mat    - A material object from the GCR API response
 * @param {string} topic  - The topic/section name this material belongs to
 * @param {string} source - A tag indicating where this entry came from
 * @returns {FileEntry|null}
 */
function materialToFileEntry(mat, topic, source) {
  // Google Drive file attachment
  if (mat.driveFile) {
    const df = mat.driveFile.driveFile || mat.driveFile;
    const id = df.id;
    let title = df.title || df.name || 'Drive File';
    const mimeType = df.mimeType || '';

    let url;
    // Native Google Apps files must be exported via Drive API export endpoint,
    // rather than direct file download.
    if (mimeType === 'application/vnd.google-apps.document') {
      url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document`;
      if (!title.toLowerCase().endsWith('.docx')) title += '.docx';
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`;
      if (!title.toLowerCase().endsWith('.xlsx')) title += '.xlsx';
    } else if (mimeType === 'application/vnd.google-apps.presentation') {
      url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=application/vnd.openxmlformats-officedocument.presentationml.presentation`;
      if (!title.toLowerCase().endsWith('.pptx')) title += '.pptx';
    } else if (mimeType === 'application/vnd.google-apps.drawing') {
      url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=image/png`;
      if (!title.toLowerCase().endsWith('.png')) title += '.png';
    } else {
      url = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
    }

    return {
      id: `drive-${id}`,
      name: sanitizeFilename(title),
      url,
      driveFileId: id,
      mimeType,
      topic,
      source,
      thumbnailUrl: df.thumbnailUrl || null,
    };
  }

  // Link attachment (PDF/doc hosted elsewhere)
  if (mat.link) {
    const link = mat.link;
    try {
      const parsedUrl = new URL(link.url);
      // Only include HTTPS links to known file types.
      if (parsedUrl.protocol !== 'https:') return null;
      const pathLower = parsedUrl.pathname.toLowerCase();
      if (!/\.(pdf|pptx?|docx?|xlsx?|png|jpe?g|gif|zip)$/.test(pathLower)) return null;
    } catch {
      return null;
    }
    return {
      id: `link-${link.url}`,
      name: sanitizeFilename(link.title || deriveNameFromUrl(link.url)),
      url: link.url,
      driveFileId: null,
      mimeType: '',
      topic,
      source,
    };
  }

  // Google Form — skip (not a downloadable file)
  if (mat.form) return null;

  // YouTube — skip
  if (mat.youtubeVideo) return null;

  return null;
}

// ------------------------------------------------------------------
// API helper
// ------------------------------------------------------------------

/**
 * Makes an authenticated GET request via the background service worker.
 * @param {string} url
 * @returns {Promise<object>}
 */
function apiGet(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'FETCH_WITH_AUTH', url, responseType: 'json' },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.success) {
          reject(new Error(response?.error || 'API request failed'));
          return;
        }
        resolve(response.data);
      }
    );
  });
}

// ------------------------------------------------------------------
// Utility helpers
// ------------------------------------------------------------------

/**
 * Sanitizes a string to be safe as a filename inside a ZIP archive.
 * Strips path traversal sequences and non-safe characters.
 * Uses an allowlist approach.
 */
function sanitizeFilename(name) {
  if (!name) return 'untitled';
  // Strip traversal sequences.
  let safe = name.replace(/\.\.[/\\]/g, '');
  // Replace path separators with a dash.
  safe = safe.replace(/[/\\]/g, '-');
  // Keep only safe characters (allowlist).
  safe = safe.replace(/[^a-zA-Z0-9 \-_.()\[\]]/g, '_');
  // Trim and cap length to prevent excessively long filenames.
  safe = safe.trim().slice(0, 120);
  return safe || 'untitled';
}

/**
 * Derives a display name from a URL's path basename.
 */
function deriveNameFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/');
    const last = parts[parts.length - 1];
    return decodeURIComponent(last) || 'attachment';
  } catch {
    return 'attachment';
  }
}

/**
 * Extracts the Google Classroom course ID from the current page URL.
 * GCR URLs follow the pattern: /c/<courseId>/...
 * @param {string} url
 * @returns {string|null}
 */
function extractCourseId(url) {
  try {
    const match = new URL(url).pathname.match(/\/[cw]\/([^/]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Exports (available to sidebar.js loaded in the same iframe context)
// ------------------------------------------------------------------
window.GCRFetcher = {
  fetchAllResources,
  extractCourseId,
  sanitizeFilename,
};
