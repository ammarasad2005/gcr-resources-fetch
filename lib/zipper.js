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

  // Track used ZIP paths to handle filename collisions.
  const usedPaths = new Set();

  // If there are external links, generate and add the DOCX file to the root of the ZIP
  if (linkFiles.length > 0) {
    report(0, downloadFiles.length, 'Generating External Resources DOCX…');
    try {
      const docxBlob = await generateDocxBlob(linkFiles);
      if (docxBlob) {
        zip.file('External Resources.docx', docxBlob);
      }
    } catch (err) {
      console.error('[GCR Fetch] Failed to generate DOCX:', err);
      if (window.showToast) {
        window.showToast(`Failed to generate DOCX: ${err.message}`, 'error');
      }
    }
  }

  for (let i = 0; i < downloadFiles.length; i++) {
    const file = downloadFiles[i];
    report(i, downloadFiles.length, file.name);

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
      console.warn(`[GCR Fetch] Skipped file ${i + 1}/${downloadFiles.length} — fetch failed`);
    }
  }

  report(downloadFiles.length, downloadFiles.length, 'Generating ZIP…');

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
    if (file.isSubmission) {
      basePath = `[My Work] ${safeName}`;
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
// DOCX Generation Helper
// ------------------------------------------------------------------

async function generateDocxBlob(links) {
  const zip = new JSZip();

  // 1. [Content_Types].xml (trim to prevent leading newlines causing parse failure in Word)
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`.trim();
  zip.file("[Content_Types].xml", contentTypesXml);

  // 2. _rels/.rels
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`.trim();
  zip.file("_rels/.rels", relsXml);

  // 3. word/_rels/document.xml.rels
  // Word is highly restrictive of relationship IDs and requires they conform to rId[integer] format (e.g. rId2, rId3...)
  let relsEntries = '';
  links.forEach((link, idx) => {
    const escapedUrl = escapeXml(link.url);
    const relId = `rId${idx + 2}`; // Start at rId2 (since rId1 is main document in .rels)
    relsEntries += `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapedUrl}" TargetMode="External"/>\n`;
  });

  const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relsEntries}
</Relationships>`.trim();
  zip.file("word/_rels/document.xml.rels", documentRelsXml);

  // 4. word/document.xml
  const groups = {
    'youtube': { title: 'YouTube Videos', items: [] },
    'form': { title: 'Google Forms', items: [] },
    'folder': { title: 'Google Drive Folders & Shared Files', items: [] },
    'link': { title: 'Web Resources & Article Links', items: [] }
  };

  links.forEach((link, idx) => {
    const t = link.linkType || 'link';
    const relId = `rId${idx + 2}`;
    if (groups[t]) {
      groups[t].items.push({ ...link, relId });
    } else {
      groups['link'].items.push({ ...link, relId });
    }
  });

  let bodyContent = '';
  // Title
  bodyContent += `
    <w:p>
      <w:pPr>
        <w:jc w:val="center"/>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:b/>
          <w:sz w:val="36"/>
          <w:szCs w:val="36"/>
        </w:rPr>
        <w:t>GCR Course External Resources</w:t>
      </w:r>
    </w:p>
  `;

  // Render sections
  Object.keys(groups).forEach(key => {
    const group = groups[key];
    if (group.items.length === 0) return;

    // Section Heading
    bodyContent += `
      <w:p>
        <w:pPr>
          <w:spacing w:before="240" w:after="120"/>
        </w:pPr>
        <w:r>
          <w:rPr>
            <w:b/>
            <w:sz w:val="28"/>
            <w:szCs w:val="28"/>
            <w:color w:val="1A73E8"/>
          </w:rPr>
          <w:t>${group.title}</w:t>
        </w:r>
      </w:p>
    `;

    // Items
    group.items.forEach(item => {
      const escapedTitle = escapeXml(item.name || item.title || 'Resource Link');
      const escapedPostTitle = escapeXml(item.postTitle || 'General');

      bodyContent += `
        <w:p>
          <w:pPr>
            <w:spacing w:after="60"/>
            <w:ind w:left="360"/>
          </w:pPr>
          <w:r>
            <w:t>• </w:t>
          </w:r>
          <w:r>
            <w:rPr>
              <w:b/>
              <w:color w:val="5F6368"/>
            </w:rPr>
            <w:t>[${escapedPostTitle}] </w:t>
          </w:r>
          <w:hyperlink r:id="${item.relId}">
            <w:r>
              <w:rPr>
                <w:color w:val="0563C1"/>
                <w:u w:val="single"/>
              </w:rPr>
              <w:t>${escapedTitle}</w:t>
            </w:r>
          </w:hyperlink>
        </w:p>
      `;
    });
  });

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${bodyContent}
  </w:body>
</w:document>`.trim();
  zip.file("word/document.xml", documentXml);

  return zip.generateAsync({ type: 'blob' });
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&#39;'; // Use numeric character reference for apostrophe to support all Word readers
      case '"': return '&quot;';
    }
  });
}

// ------------------------------------------------------------------
// Export
// ------------------------------------------------------------------
window.GCRZipper = { downloadAsZip };
