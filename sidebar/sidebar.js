/**
 * GCR Fetch -- sidebar/sidebar.js
 *
 * Controls the sidebar panel UI.
 * Now includes a full auth flow using chrome.runtime messages to background.js,
 * which uses launchWebAuthFlow + the Vercel backend. Works with ANY Google account.
 *
 * Security:
 *  - All DOM manipulation uses createElement/textContent/setAttribute -- no innerHTML.
 *  - Tokens are never stored here; they live in chrome.storage.local via background.js.
 *  - postMessage origin is validated on every incoming message.
 */

'use strict';

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------
let allFiles       = [];
let filteredFiles  = [];
let activeFilter   = 'all';
let zipMode        = 'flat';
let isScanning     = false;
let authToken      = null; // held in memory only for the session

const pendingRequests = new Map();
let requestCounter = 0;

// ------------------------------------------------------------------
// DOM refs
// ------------------------------------------------------------------
const el = {
  // Auth
  authPanel:       document.getElementById('auth-panel'),
  signinBtn:       document.getElementById('signin-btn'),
  mainContent:     document.getElementById('main-content'),
  userBar:         document.getElementById('user-bar'),
  userBarEmail:    document.getElementById('user-bar-email'),
  signoutBtn:      document.getElementById('signout-btn'),
  userBadge:       document.getElementById('user-badge'),
  userAvatar:      document.getElementById('user-avatar'),
  // Header
  courseName:      document.getElementById('course-name'),
  closeBtn:        document.getElementById('close-btn'),
  // Scanner
  scanStateIdle:   document.getElementById('scan-state-idle'),
  scanStateLoad:   document.getElementById('scan-state-loading'),
  scanStatusText:  document.getElementById('scan-status-text'),
  scanBtn:         document.getElementById('scan-btn'),
  // Results
  resultsArea:     document.getElementById('results-area'),
  fileList:        document.getElementById('file-list'),
  fileCount:       document.getElementById('file-count'),
  emptyState:      document.getElementById('empty-state'),
  selectAllBtn:    document.getElementById('select-all-btn'),
  deselectAllBtn:  document.getElementById('deselect-all-btn'),
  filterAll:       document.getElementById('filter-all'),
  filterDocuments: document.getElementById('filter-documents'),
  filterImages:    document.getElementById('filter-images'),
  // Download
  downloadBar:     document.getElementById('download-bar'),
  downloadBtn:     document.getElementById('download-btn'),
  modeFlat:        document.getElementById('mode-flat'),
  modeCategorized: document.getElementById('mode-categorized'),
  // Progress
  progressOverlay: document.getElementById('progress-overlay'),
  progressFill:    document.getElementById('progress-fill'),
  progressDetail:  document.getElementById('progress-detail'),
  progressTrack:   document.getElementById('progress-track'),
  // Toast
  toastContainer:  document.getElementById('toast-container'),
};

// ------------------------------------------------------------------
// Startup
// ------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  wireEvents();
  checkAuthState();
  postToParent({ type: 'SIDEBAR_READY' });
});

// ------------------------------------------------------------------
// Auth state check -- runs on every sidebar open
// ------------------------------------------------------------------
async function checkAuthState() {
  chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' }, (response) => {
    if (response && response.success && response.token) {
      authToken = response.token;
      // Fetch stored user info to show in UI.
      chrome.runtime.sendMessage({ type: 'GET_USER_INFO' }, (infoRes) => {
        showMainUI(infoRes && infoRes.userInfo ? infoRes.userInfo : null);
      });
    } else {
      showAuthPanel();
    }
  });
}

// ------------------------------------------------------------------
// Auth UI helpers
// ------------------------------------------------------------------
function showAuthPanel() {
  el.authPanel.classList.remove('hidden');
  el.mainContent.classList.add('hidden');
  el.userBadge.classList.add('hidden');
  authToken = null;
}

function showMainUI(userInfo) {
  el.authPanel.classList.add('hidden');
  el.mainContent.classList.remove('hidden');

  if (userInfo) {
    el.userBarEmail.textContent = userInfo.email || '';
    if (userInfo.picture) {
      // Use setAttribute for security -- no dynamic src injection via innerHTML.
      el.userAvatar.setAttribute('src', userInfo.picture);
      el.userBadge.classList.remove('hidden');
    }
  }
}

// ------------------------------------------------------------------
// Sign In
// ------------------------------------------------------------------
async function handleSignIn() {
  el.signinBtn.disabled = true;
  el.signinBtn.textContent = 'Signing in...';

  chrome.runtime.sendMessage({ type: 'LAUNCH_AUTH_FLOW' }, (response) => {
    el.signinBtn.disabled = false;
    el.signinBtn.textContent = 'Sign in with Google';

    if (response && response.success) {
      authToken = null; // will be fetched fresh on next GET_AUTH_TOKEN
      showMainUI(response.userInfo);
      showToast('Signed in successfully!', 'success');
    } else {
      const msg = (response && response.error) || 'Sign-in failed. Please try again.';
      showToast(msg, 'error');
    }
  });
}

// ------------------------------------------------------------------
// Sign Out
// ------------------------------------------------------------------
function handleSignOut() {
  chrome.runtime.sendMessage({ type: 'SIGN_OUT' }, () => {
    authToken = null;
    allFiles  = [];
    filteredFiles = [];
    showAuthPanel();
    showToast('Signed out.', 'info');
  });
}

// ------------------------------------------------------------------
// Event wiring
// ------------------------------------------------------------------
function wireEvents() {
  el.closeBtn.addEventListener('click', () => postToParent({ type: 'CLOSE_SIDEBAR' }));
  el.signinBtn.addEventListener('click', handleSignIn);
  el.signoutBtn.addEventListener('click', handleSignOut);
  el.scanBtn.addEventListener('click', startScan);
  el.selectAllBtn.addEventListener('click', selectAll);
  el.deselectAllBtn.addEventListener('click', deselectAll);
  el.downloadBtn.addEventListener('click', startDownload);

  [el.filterAll, el.filterDocuments, el.filterImages].forEach((chip) => {
    chip.addEventListener('click', () => setFilter(chip.dataset.filter));
  });

  [el.modeFlat, el.modeCategorized].forEach((btn) => {
    btn.addEventListener('click', () => setZipMode(btn.dataset.mode));
  });

  window.addEventListener('message', handleParentMessage);
}

// ------------------------------------------------------------------
// Parent (content.js) message handling
// ------------------------------------------------------------------
const CLASSROOM_ORIGIN = 'https://classroom.google.com';

function handleParentMessage(event) {
  if (event.origin !== CLASSROOM_ORIGIN) return;

  const { type } = event.data || {};

  switch (type) {
    case 'SCAN_PAGE':
      handleScanPage(event.data.url);
      break;
    case 'FETCH_RESPONSE':
      handleFetchResponse(event.data);
      break;
    case 'DOM_SCRAPE_RESULT':
      handleDomScrapeResult(event.data.files || []);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------
// Scan orchestration
// ------------------------------------------------------------------
let currentCourseId = null;
let currentPageUrl  = null;

function handleScanPage(url) {
  const newCourseId = window.GCRFetcher
    ? window.GCRFetcher.extractCourseId(url)
    : null;

  if (newCourseId !== currentCourseId) {
    currentCourseId = newCourseId;
    allFiles = [];
    filteredFiles = [];
    showScanState('idle');
  }

  currentPageUrl = url;

  el.courseName.textContent = currentCourseId
    ? 'Course ID: ' + currentCourseId
    : 'Open a course to scan';
}

async function startScan() {
  if (isScanning) return;
  isScanning = true;
  allFiles   = [];

  showScanState('loading');
  updateStatus('Requesting permissions...');

  // Ensure we have a valid token.
  try {
    authToken = await requestAuthToken();
  } catch (err) {
    const needsSignIn = err.needsSignIn;
    if (needsSignIn) {
      showToast('Please sign in first.', 'error');
      showAuthPanel();
    } else {
      showToast('Authentication failed. Please sign out and try again.', 'error');
    }
    showScanState('idle');
    isScanning = false;
    return;
  }

  updateStatus('Scanning page...');
  postToParent({ type: 'REQUEST_DOM_SCRAPE' });
}

async function handleDomScrapeResult(domFiles) {
  updateStatus('Found ' + domFiles.length + ' file(s) in DOM. Querying API...');

  let finalFiles = domFiles;
  if (currentCourseId && window.GCRFetcher) {
    try {
      finalFiles = await window.GCRFetcher.fetchAllResources(
        currentCourseId,
        domFiles,
        (msg) => updateStatus(msg)
      );
    } catch (err) {
      showToast('API scan incomplete -- showing DOM results only.', 'info');
    }
  }

  allFiles      = finalFiles;
  activeFilter  = 'all';
  isScanning    = false;

  showScanState('results');
  applyFilter(activeFilter);
  showToast('Found ' + allFiles.length + ' file(s).', allFiles.length > 0 ? 'success' : 'info');
}

// ------------------------------------------------------------------
// Auth token via chrome.runtime (direct -- sidebar has chrome access)
// ------------------------------------------------------------------
function requestAuthToken() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Auth token timeout')), 15000);
    chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' }, (response) => {
      clearTimeout(timeout);
      if (response && response.success) {
        resolve(response.token);
      } else if (response && response.needsSignIn) {
        const err = new Error('Sign in required');
        err.needsSignIn = true;
        reject(err);
      } else {
        reject(new Error((response && response.error) || 'Auth failed'));
      }
    });
  });
}

function handleFetchResponse(data) {
  const { requestId, ...rest } = data;
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  pending.resolve(rest);
}

// ------------------------------------------------------------------
// UI state machine
// ------------------------------------------------------------------
function showScanState(state) {
  el.scanStateIdle.classList.add('hidden');
  el.scanStateLoad.classList.add('hidden');
  el.resultsArea.classList.add('hidden');
  el.downloadBar.classList.add('hidden');

  if (state === 'idle') {
    el.scanStateIdle.classList.remove('hidden');
  } else if (state === 'loading') {
    el.scanStateLoad.classList.remove('hidden');
  } else if (state === 'results') {
    el.resultsArea.classList.remove('hidden');
    el.downloadBar.classList.remove('hidden');
  }
}

function updateStatus(msg) {
  el.scanStatusText.textContent = msg;
}

// ------------------------------------------------------------------
// Filter
// ------------------------------------------------------------------
const DOCUMENT_EXTS = new Set([
  'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv', 'odt', 'odp', 'ods'
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']);

function getFileExtension(filename) {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

function matchesFilter(file, filter) {
  if (filter === 'all') return true;
  const ext = getFileExtension(file.name);
  if (filter === 'documents') return DOCUMENT_EXTS.has(ext);
  if (filter === 'images')    return IMAGE_EXTS.has(ext);
  return true;
}

function setFilter(filter) {
  activeFilter = filter;
  [el.filterAll, el.filterDocuments, el.filterImages].forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.filter === filter);
  });
  applyFilter(filter);
}

function applyFilter(filter) {
  filteredFiles = allFiles.filter((f) => matchesFilter(f, filter));
  renderFileList(filteredFiles);
  updateDownloadBtn();
}

// ------------------------------------------------------------------
// File list rendering -- entirely via createElement, no innerHTML
// ------------------------------------------------------------------
function getFileIcon(filename) {
  const ext = getFileExtension(filename);
  if (ext === 'pdf')                        return '\uD83D\uDCD5';
  if (['ppt', 'pptx'].includes(ext))        return '\uD83D\uDCCA';
  if (['doc', 'docx'].includes(ext))        return '\uD83D\uDCDD';
  if (['xls', 'xlsx'].includes(ext))        return '\uD83D\uDCD7';
  if (IMAGE_EXTS.has(ext))                  return '\uD83D\uDDBC';
  if (['zip', 'rar', '7z'].includes(ext))   return '\uD83D\uDCE6';
  return '\uD83D\uDCC4';
}

function renderFileList(files) {
  el.fileList.replaceChildren();

  const count = files.length;
  el.fileCount.textContent = count + ' file' + (count !== 1 ? 's' : '');

  if (count === 0) {
    el.emptyState.classList.remove('hidden');
    el.fileList.classList.add('hidden');
    return;
  }

  el.emptyState.classList.add('hidden');
  el.fileList.classList.remove('hidden');

  files.forEach((file, index) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.setAttribute('role', 'listitem');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'file-checkbox';
    checkbox.id = 'file-check-' + index;
    checkbox.checked = true;
    checkbox.setAttribute('aria-label', 'Select ' + file.name);
    checkbox.addEventListener('change', updateDownloadBtn);

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = getFileIcon(file.name);

    const info = document.createElement('div');
    info.className = 'file-info';

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = file.name;

    const topic = document.createElement('div');
    topic.className = 'file-topic';
    topic.textContent = file.topic || 'General';

    info.appendChild(name);
    info.appendChild(topic);

    li.appendChild(checkbox);
    li.appendChild(icon);
    li.appendChild(info);

    li.addEventListener('click', (e) => {
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
        updateDownloadBtn();
      }
    });

    el.fileList.appendChild(li);
  });
}

// ------------------------------------------------------------------
// Select / Deselect all
// ------------------------------------------------------------------
function selectAll() {
  el.fileList.querySelectorAll('.file-checkbox').forEach((cb) => { cb.checked = true; });
  updateDownloadBtn();
}

function deselectAll() {
  el.fileList.querySelectorAll('.file-checkbox').forEach((cb) => { cb.checked = false; });
  updateDownloadBtn();
}

// ------------------------------------------------------------------
// Download button state
// ------------------------------------------------------------------
function getSelectedFiles() {
  const checkboxes = el.fileList.querySelectorAll('.file-checkbox');
  const selected = [];
  checkboxes.forEach((cb, i) => {
    if (cb.checked) selected.push(filteredFiles[i]);
  });
  return selected.filter(Boolean);
}

function updateDownloadBtn() {
  const count = getSelectedFiles().length;
  el.downloadBtn.disabled = count === 0;
  // Safe text update -- no innerHTML.
  const textNode = el.downloadBtn.lastChild;
  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    textNode.textContent = count > 0
      ? ' Download ' + count + ' file' + (count !== 1 ? 's' : '') + ' as ZIP'
      : ' Download ZIP';
  }
}

// ------------------------------------------------------------------
// ZIP mode
// ------------------------------------------------------------------
function setZipMode(mode) {
  zipMode = mode;
  [el.modeFlat, el.modeCategorized].forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

// ------------------------------------------------------------------
// Download
// ------------------------------------------------------------------
async function startDownload() {
  const selected = getSelectedFiles();
  if (selected.length === 0) return;

  el.progressOverlay.classList.remove('hidden');
  setProgress(0, selected.length, 'Starting...');

  try {
    await window.GCRZipper.downloadAsZip(selected, zipMode, (curr, total, name) => {
      setProgress(curr, total, 'Fetching ' + (curr + 1) + ' / ' + total + ': ' + name);
    });
    showToast('ZIP downloaded successfully!', 'success');
  } catch (err) {
    showToast('Download failed. Some files may be restricted.', 'error');
  } finally {
    el.progressOverlay.classList.add('hidden');
  }
}

function setProgress(current, total, detail) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  el.progressFill.style.width = pct + '%';
  el.progressTrack.setAttribute('aria-valuenow', pct);
  el.progressDetail.textContent = detail;
}

// ------------------------------------------------------------------
// Toast notifications -- using createElement, not innerHTML
// ------------------------------------------------------------------
function showToast(message, type) {
  type = type || 'info';
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  toast.setAttribute('role', 'alert');
  el.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toast-out 0.22s ease forwards';
    setTimeout(() => {
      if (toast.parentNode) el.toastContainer.removeChild(toast);
    }, 220);
  }, 3500);
}

// ------------------------------------------------------------------
// postMessage to parent (content.js)
// ------------------------------------------------------------------
function postToParent(message) {
  window.parent.postMessage(message, 'https://classroom.google.com');
}
