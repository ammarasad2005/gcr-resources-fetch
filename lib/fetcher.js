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
  const courseWorkMap = new Map();

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
        if (cw.id && cw.title) {
          courseWorkMap.set(cw.id, cw.title);
        }
        const topic = sanitizeFilename(cw.title || 'Coursework');
        
        // 1. Scan materials attachments
        const materials = cw.materials || [];
        for (const mat of materials) {
          const entry = materialToFileEntry(mat, topic, 'coursework-api', cw.title || 'Coursework');
          if (entry) merge(entry);
        }

        // 2. Scan plaintext description
        if (cw.description) {
          const textUrls = extractUrlsFromText(cw.description);
          for (const url of textUrls) {
            const entry = createExternalLinkEntry(url, topic, 'coursework-api-text', cw.title || 'Coursework');
            if (entry) merge(entry);
          }
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
        
        // 1. Scan materials attachments
        const materials = item.materials || [];
        for (const mat of materials) {
          const entry = materialToFileEntry(mat, topic, 'materials-api', item.title || 'Materials');
          if (entry) merge(entry);
        }

        // 2. Scan plaintext description
        if (item.description) {
          const textUrls = extractUrlsFromText(item.description);
          for (const url of textUrls) {
            const entry = createExternalLinkEntry(url, topic, 'materials-api-text', item.title || 'Materials');
            if (entry) merge(entry);
          }
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
        const postTitle = ann.text ? ann.text.split('\n')[0].slice(0, 45).trim() : 'Announcement';
        
        // 1. Scan materials attachments
        const materials = ann.materials || [];
        for (const mat of materials) {
          const entry = materialToFileEntry(mat, topic, 'announcement-api', postTitle);
          if (entry) merge(entry);
        }

        // 2. Scan plaintext text body
        if (ann.text) {
          const textUrls = extractUrlsFromText(ann.text);
          for (const url of textUrls) {
            const entry = createExternalLinkEntry(url, topic, 'announcement-api-text', postTitle);
            if (entry) merge(entry);
          }
        }
      }
    }
  } catch (err) {
    console.error('[GCR Fetch] Announcements API error:', err);
    report('Announcements API error: ' + err.message + ' — relying on DOM.');
    errors.push(err.message);
  }

  // ── Phase 2d: Student Submissions ("Your Work") ──────────────────
  try {
    report('Fetching student submissions…');
    const subData = await apiGet(
      `https://classroom.googleapis.com/v1/courses/${encodeURIComponent(courseId)}/courseWork/-/studentSubmissions?userId=me&pageSize=100`
    );
    if (subData && subData.studentSubmissions) {
      for (const sub of subData.studentSubmissions) {
        if (sub.assignmentSubmission && sub.assignmentSubmission.attachments) {
          const cwTitle = courseWorkMap.get(sub.courseWorkId) || 'Assignment';
          const topic = `My Submissions/${sanitizeFilename(cwTitle)}`;
          for (const att of sub.assignmentSubmission.attachments) {
            const entry = materialToFileEntry(att, topic, 'submissions-api', cwTitle);
            if (entry) {
              entry.isSubmission = true;
              merge(entry);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[GCR Fetch] Submissions API error:', err);
    report('Submissions API error: ' + err.message);
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
 * @param {object} mat       - A material object from the GCR API response
 * @param {string} topic     - The topic/section name this material belongs to
 * @param {string} source    - A tag indicating where this entry came from
 * @param {string} postTitle - The title of the parent coursework/post
 * @returns {FileEntry|null}
 */
function materialToFileEntry(mat, topic, source, postTitle) {
  const pTitle = postTitle || 'General';

  // Google Drive file attachment
  if (mat.driveFile) {
    const df = mat.driveFile.driveFile || mat.driveFile;
    const id = df.id;
    let title = df.title || df.name || 'Drive File';
    const mimeType = df.mimeType || '';

    // Handle Google Drive folder as an external link
    if (mimeType === 'application/vnd.google-apps.folder') {
      return {
        id: `folder-${id}`,
        name: title,
        url: df.alternateLink || `https://drive.google.com/drive/folders/${id}`,
        driveFileId: id,
        mimeType,
        topic,
        source,
        isExternalLink: true,
        linkType: 'folder',
        postTitle: pTitle
      };
    }

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
      url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
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
      postTitle: pTitle
    };
  }

  // Link attachment (PDF/doc hosted elsewhere or general link)
  if (mat.link) {
    const link = mat.link;
    try {
      const parsedUrl = new URL(link.url);
      if (parsedUrl.protocol !== 'https:') return null;
      
      const pathLower = parsedUrl.pathname.toLowerCase();
      const isDownloadable = /\.(pdf|pptx?|docx?|xlsx?|png|jpe?g|gif|zip)$/.test(pathLower);
      
      if (isDownloadable) {
        return {
          id: `link-${link.url}`,
          name: sanitizeFilename(link.title || deriveNameFromUrl(link.url)),
          url: link.url,
          driveFileId: null,
          mimeType: '',
          topic,
          source,
          postTitle: pTitle
        };
      } else {
        // External link
        return {
          id: `link-${link.url}`,
          name: link.title || deriveNameFromUrl(link.url),
          url: link.url,
          driveFileId: null,
          mimeType: 'text/html',
          topic,
          source,
          isExternalLink: true,
          linkType: 'link',
          postTitle: pTitle
        };
      }
    } catch {
      return null;
    }
  }

  // Google Form
  if (mat.form) {
    const form = mat.form;
    return {
      id: `form-${form.formUrl || Date.now()}`,
      name: form.title || 'Google Form',
      url: form.formUrl,
      driveFileId: null,
      mimeType: 'application/vnd.google-apps.form',
      topic,
      source,
      isExternalLink: true,
      linkType: 'form',
      postTitle: pTitle
    };
  }

  // YouTube Video
  if (mat.youtubeVideo) {
    const yt = mat.youtubeVideo;
    return {
      id: `youtube-${yt.id || Date.now()}`,
      name: yt.title || 'YouTube Video',
      url: yt.alternateLink || `https://www.youtube.com/watch?v=${yt.id}`,
      driveFileId: null,
      mimeType: 'video/youtube',
      topic,
      source,
      isExternalLink: true,
      linkType: 'youtube',
      postTitle: pTitle
    };
  }

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
 * Extracts all unique HTTP/HTTPS URLs from a given plaintext string.
 * Trims trailing sentence punctuation from matched URLs.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractUrlsFromText(text) {
  if (!text) return [];
  const urls = [];
  const regex = /https?:\/\/[^\s'"<>\(\)\[\]]+/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    let url = match[0];
    while (/[.,;:!?]$/.test(url)) {
      url = url.slice(0, -1);
    }
    try {
      new URL(url);
      if (!urls.includes(url)) {
        urls.push(url);
      }
    } catch (e) {}
  }
  return urls;
}

/**
 * Creates a FileEntry for an external link found in plaintext,
 * ensuring internal navigation and blacklisted Google domains are ignored.
 *
 * @param {string} url
 * @param {string} topic
 * @param {string} source
 * @param {string} postTitle
 * @returns {FileEntry|null}
 */
function createExternalLinkEntry(url, topic, source, postTitle) {
  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname.toLowerCase();
    const path = parsedUrl.pathname.toLowerCase();

    // Ignore internal Google Classroom navigation
    if (host.includes('classroom.google.com')) {
      if (path === '/' || path.startsWith('/c/') || path.startsWith('/u/') || path.startsWith('/h') || path.startsWith('/g/')) {
        return null;
      }
    }

    // Ignore standard account or support services
    const ignoredHosts = [
      'accounts.google.com',
      'support.google.com',
      'myaccount.google.com',
      'policies.google.com',
      'google.com/intl'
    ];
    if (ignoredHosts.some(h => host === h || host.endsWith('.' + h))) {
      return null;
    }

    const pathLower = path.toLowerCase();
    const isDownloadable = /\.(pdf|pptx?|docx?|xlsx?|png|jpe?g|gif|zip|rar|txt|csv)$/.test(pathLower);

    if (isDownloadable) {
      return {
        id: `link-${url}`,
        name: deriveNameFromUrl(url),
        url,
        driveFileId: null,
        mimeType: '',
        topic,
        source,
        postTitle: postTitle || 'General'
      };
    }

    // Determine type of external link
    let linkType = 'link';
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      linkType = 'youtube';
    } else if (host.includes('docs.google.com') && (path.startsWith('/forms/') || path.startsWith('/file/d/') || path.startsWith('/open'))) {
      if (path.startsWith('/forms/')) {
        linkType = 'form';
      } else if (path.startsWith('/drive/folders/')) {
        linkType = 'folder';
      }
    } else if (host.includes('forms.gle')) {
      linkType = 'form';
    } else if (host.includes('drive.google.com') && path.startsWith('/drive/folders/')) {
      linkType = 'folder';
    }

    return {
      id: `link-${url}`,
      name: deriveNameFromUrl(url),
      url,
      driveFileId: null,
      mimeType: 'text/html',
      topic,
      source,
      isExternalLink: true,
      linkType,
      postTitle: postTitle || 'General'
    };
  } catch {
    return null;
  }
}

/**
 * Derives a display name from a URL's path basename.
 */
function deriveNameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^www\./i, '');
    let pathName = u.pathname;
    if (pathName.endsWith('/')) {
      pathName = pathName.slice(0, -1);
    }
    const parts = pathName.split('/');
    const last = parts[parts.length - 1];
    const decodedLast = last ? decodeURIComponent(last).trim() : '';
    
    if (decodedLast && decodedLast.length > 2) {
      return decodedLast.replace(/[-_]+/g, ' ');
    }
    
    return host || 'attachment';
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
    if (!match) return null;
    let id = match[1];
    
    // If the ID is not purely numeric, it might be base64-encoded by Classroom web UI.
    if (!/^\d+$/.test(id)) {
      try {
        const decoded = atob(id);
        if (/^\d+$/.test(decoded)) {
          id = decoded;
        }
      } catch {
        // ignore decoding errors
      }
    }
    return id;
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
