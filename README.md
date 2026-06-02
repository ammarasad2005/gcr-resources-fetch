# GCR Fetch 🔽

> **Bulk-download all Google Classroom resources for a course — as a single ZIP file — without touching each post manually.**

A Chrome/Edge browser extension built for personal use. Works entirely inside your browser — no server, no backend, no data ever leaves your machine.

---

## Features

- **One-click scan** — detects all attachments from both the Stream and Classwork tabs.
- **Smart hybrid fetch** — scrapes visible DOM + queries the Google Classroom REST API for posts not yet rendered.
- **File type filters** — filter by Documents (PDF, PPTX, DOCX…), Images, or All.
- **Pre-download checklist** — every file is listed with its topic name; uncheck anything you don't need.
- **ZIP structure choice** — download flat (all in root) or categorized (subfolder per topic/section).
- **No manual OAuth setup** — uses your already-logged-in Chrome Google account silently.

---

## One-time Setup (Required Before First Use)

The extension uses the Google Classroom & Drive APIs. You must register it with Google once.

### Step 1 — Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (e.g. `gcr-fetch`).
2. Enable these APIs:
   - **Google Classroom API**
   - **Google Drive API**

### Step 2 — Configure OAuth Consent Screen (Branding)

Google requires you to set up a consent screen before creating credentials.
1. Click the **Configure consent screen** button (or click **Get started** under the **Branding** tab).
2. **App name**: Enter `GCR Fetch`.
3. **User support email**: Select your email from the dropdown.
4. Click **Next**.
5. **Audience**: Select **External** (if prompted).
6. **Contact Information**: Enter your email again and finish the wizard.

### Step 3 — Create OAuth 2.0 credentials

1. Go to **Clients** (or **Credentials** > **Create Credentials** > **OAuth client ID**).
2. Application type: **Chrome Extension**.
3. **Extension ID**: load the extension unpacked first (see below), then copy the ID shown in `chrome://extensions`.
4. Copy the generated **Client ID**.

### Step 3 — Add your Client ID to `manifest.json`

Open `manifest.json` and replace `YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com`:

```json
"oauth2": {
  "client_id": "YOUR_CLIENT_ID_HERE.apps.googleusercontent.com",
  ...
}
```

### Step 4 — Add yourself as a test user

In the Google Cloud Console, go to **OAuth consent screen → Test users** and add your school Google account email.

---

## Installation (Load Unpacked)

1. Open Chrome/Edge and go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `gcr-resources-fetch` folder.
4. The extension icon will appear in your toolbar.

---

## Usage

1. Navigate to [classroom.google.com](https://classroom.google.com).
2. Open a course.
3. Click the **⬇ GCR Fetch** button (bottom-right corner of the page).
4. Click **Scan for Resources** in the sidebar.
5. Filter by type if needed, uncheck any files you don't want.
6. Choose **Flat** or **By Topic** ZIP structure.
7. Click **Download X files as ZIP**.

---

## Project Structure

```
gcr-resources-fetch/
├── manifest.json       # MV3 extension manifest
├── background.js       # Service worker: OAuth token + authenticated fetch proxy
├── content.js          # Injected into classroom.google.com: button, sidebar, DOM scraper
├── sidebar/
│   ├── sidebar.html    # Sidebar panel markup
│   ├── sidebar.css     # Sidebar styles
│   └── sidebar.js      # Sidebar controller (filter, checklist, download)
├── lib/
│   ├── fetcher.js      # Hybrid DOM + API resource discoverer
│   ├── zipper.js       # ZIP packager using JSZip
│   └── jszip.min.js    # Bundled JSZip v3.10.1 (no CDN dependency)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Limitations (v1)

- **Google Drive native files** (Slides, Docs, Sheets) are linked as download-export URLs but may prompt for permission in your browser.
- **Lazy-loaded Stream posts**: if a course has hundreds of posts, scroll down the Stream tab first before scanning to help the DOM scraper pick them up.
- **Large files (>100 MB)**: may time out or cause memory issues in the ZIP stage.

---

## Security

- No data is stored anywhere. Auth tokens live in service-worker memory only.
- All API calls are proxied through `background.js` which enforces an HTTPS-only, origin-allowlist policy.
- All filenames are sanitized to prevent ZIP path traversal attacks.
- No `innerHTML`, `eval`, or remote code loading anywhere in the codebase.

---

*Built for personal exam-prep use. Share freely.*
