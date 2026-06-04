# GCR Fetch — Google Classroom Resource Downloader

<p align="center">
  <strong>Bulk-download every resource from a Google Classroom course as a single ZIP archive.</strong>
</p>

<p align="center">
  <a href="#install"><strong>🚀 Quick Install Guide (For Users)</strong></a> &nbsp;•&nbsp; 
  <a href="#dev-setup"><strong>🛠️ Developer Setup & Self-Hosting</strong></a>
</p>

---

## The Problem

If you've ever used Google Classroom during exam season, you know the pain. Teachers share resources — PDFs, slides, documents, spreadsheets — across dozens of posts, announcements, and classwork items throughout the semester. When exam day approaches and you finally sit down to study, you realize you need to download all of them first. That means scrolling through the entire classroom feed, from the oldest post at the bottom to the newest at the top, hunting for every attachment one by one.

This process is slow, tedious, and disorganized. A typical course with a semester's worth of material can easily take 20–25 minutes of manual clicking and downloading. Worse, it becomes a procrastination trigger — the friction of "I have to download everything first" is enough to push students away from preparing for their exams entirely. Resources are scattered across Stream posts, Classwork topics, and announcements with no centralized way to grab them all.

**GCR Fetch eliminates this entirely.** One click scans your entire course and bundles every downloadable resource into a single ZIP file.

---

## Overview

GCR Fetch is a Chrome extension (Manifest V3) that integrates directly into Google Classroom. When you open a course page, a floating "GCR Fetch" button appears. Clicking it opens a sidebar panel where you can:

- **Sign in** with your Google account (OAuth 2.0, works with any Google account regardless of your Chrome profile)
- **Scan** the course for all resources using a hybrid detection approach (DOM scraping + Google Classroom API)
- **Browse, filter, and select** which files to download
- **Download** everything as a neatly organized ZIP archive

The extension also handles non-downloadable resources (YouTube links, Google Forms, Drive folders, external URLs) by generating a polished, interactive **External Resources Dashboard** — an HTML file included in the ZIP with search, filtering, and one-click copy/open functionality.

---

## Key Features

| Feature | Description |
|---|---|
| **Hybrid Resource Detection** | Combines DOM scraping (finds what's visible on the page) with Google Classroom REST API calls (finds attachments behind "See more", in collapsed topics, or in unexpanded classwork). No resource goes undetected. |
| **Smart File Conversion** | Google Docs, Sheets, Slides, and Drawings are automatically exported to their Microsoft Office equivalents (`.docx`, `.xlsx`, `.pptx`) or as PDFs. Optionally convert all documents to PDF with one toggle. |
| **Organized ZIP Archives** | Choose between a flat file structure or a categorized structure that groups files by their Classroom topic/post. Filename collisions are resolved automatically with numeric suffixes. |
| **External Resources Dashboard** | YouTube videos, Google Forms, Drive folders, and web links are compiled into a beautifully designed, self-contained HTML page with dark/light mode, search, category filters, and clipboard copy buttons. |
| **OAuth 2.0 with Any Account** | Uses `chrome.identity.launchWebAuthFlow` with a serverless Vercel backend for secure token exchange. Works with any Google account — no need to be signed into Chrome with that account. |
| **Student Submissions** | Optionally include your own submitted work ("Your Work" attachments) in the download. |
| **Security-First Design** | No `innerHTML`/`outerHTML` usage anywhere. All filenames are sanitized against directory traversal. API calls are restricted to an HTTPS-only Google-domain allowlist. Client secret never touches the extension — it lives only on the Vercel backend. |

---

## How It Works

GCR Fetch follows a multi-phase architecture to discover and download resources:

### Phase 1: DOM Scraping

When you click **Scan**, the content script (`content.js`) parses the Google Classroom page DOM to find all links that point to downloadable resources — Drive files, Google Docs/Sheets/Slides, direct file links, and external URLs. It also extracts topic context for each file by traversing up the DOM to find the nearest heading or topic container. This catches everything that's currently rendered on the page.

### Phase 2: Google Classroom API Scan

The fetcher module (`lib/fetcher.js`) takes the DOM-scraped results and augments them by querying four Google Classroom API endpoints:

1. **Coursework** — Assignments and their attached materials
2. **Course Materials** — Resources posted under the Classwork tab
3. **Announcements** — Stream posts with attachments
4. **Student Submissions** — Your own submitted work (optional)

Each API response is parsed for Drive files, links, YouTube videos, and Google Forms. URLs embedded in post descriptions are also extracted via regex. Results are de-duplicated against the DOM findings by Drive file ID and URL.

### Phase 3: ZIP Assembly

Selected files are downloaded through the authenticated background proxy and assembled into a ZIP archive using JSZip:

- **Downloadable files** (PDFs, Office docs, images, etc.) are fetched as blobs via the Drive API
- **Google Workspace files** (Docs, Sheets, Slides, Drawings) are exported to their corresponding Office formats or PDFs
- **External links** (YouTube, Forms, folders, web URLs) are compiled into the interactive HTML dashboard
- The ZIP is compressed with DEFLATE level 6 and triggered as a browser download

### Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Google Classroom                    │
│              (classroom.google.com)                  │
└──────────────┬──────────────────────┬───────────────┘
               │                      │
    ┌──────────▼──────────┐  ┌───────▼──────────────┐
    │     content.js       │  │   Google Classroom    │
    │  (DOM Scraping +     │  │   REST API            │
    │   UI Injection)      │  │  (Coursework,         │
    └──────────┬──────────┘  │   Materials,          │
               │              │   Announcements,      │
    ┌──────────▼──────────┐  │   Submissions)        │
    │   sidebar/           │  └───────┬──────────────┘
    │   (HTML + CSS + JS)  │          │
    │   User-facing panel  │          │
    └──────────┬──────────┘          │
               │                      │
    ┌──────────▼──────────────────────▼──┐
    │          background.js              │
    │   (MV3 Service Worker)             │
    │   - OAuth 2.0 auth flow            │
    │   - Token management & refresh     │
    │   - Authenticated fetch proxy      │
    │   - Origin allowlist enforcement   │
    └──────────┬────────────────────────┘
               │
    ┌──────────▼──────────┐
    │   Vercel Backend     │
    │   (api/token.js)     │
    │   - Code → Tokens    │
    │   - Token refresh    │
    │   - Client secret    │
    │     stays here only  │
    └─────────────────────┘
```

### Message Flow

```
Sidebar ──postMessage──▶ Content Script ──chrome.runtime.sendMessage──▶ Background (Service Worker)
                                    │                                      │
                                    │                          chrome.identity.launchWebAuthFlow
                                    │                                      │
                                    │                              Google OAuth
                                    │                                      │
                                    │                          Vercel Backend (/api/token)
                                    │                                      │
                                    ◀──────────────────────────────────────┘
                               Auth Token / API Data
```

---

## Target Audience

- **Students** who need to bulk-download course materials for exam preparation, offline study, or archival
- **Educators** who want to save a course's shared resources before the classroom is archived or deleted
- **Anyone** who uses Google Classroom and has experienced the tedium of downloading resources one by one

---

## Project Structure

```
gcr-resources-fetch/
├── manifest.json              # Chrome Extension manifest (MV3)
├── background.js              # Service worker: OAuth, token management, fetch proxy
├── content.js                 # Content script: DOM scraping, UI injection, message relay
├── icons/
│   ├── icon16.png             # Extension icon (16x16)
│   ├── icon48.png             # Extension icon (48x48)
│   └── icon128.png            # Extension icon (128x128)
├── lib/
│   ├── fetcher.js             # Hybrid resource fetcher (DOM + Classroom API)
│   ├── zipper.js              # ZIP creation, PDF conversion, HTML dashboard generator
│   └── jszip.min.js           # JSZip library for archive creation
├── sidebar/
│   ├── sidebar.html           # Sidebar panel UI structure
│   ├── sidebar.css            # Sidebar styling (Google design language)
│   └── sidebar.js             # Sidebar controller: auth, scanning, filtering, download
└── gcr-fetch-backend/
    ├── api/
    │   └── token.js           # Vercel serverless function for OAuth token exchange
    ├── package.json           # Backend package definition
    └── vercel.json            # Vercel deployment configuration
```

---

<a name="install"></a>
## Installation Guide (For Users)

Since this extension is not published on the Chrome Web Store, you'll need to load it manually in your browser. This takes less than a minute and requires no coding or credentials setup.

### Prerequisites
- A Chromium-based browser (Google Chrome, Microsoft Edge, Brave, Opera, etc.)
- The extension folder (downloaded from this repository)

### Step-by-Step Installation

1. **Download the Extension Code**
   - Click the green **Code** button at the top of this GitHub repository page, and click **Download ZIP**.
   - Extract the downloaded ZIP file to a folder on your computer (e.g., in your Documents folder).

2. **Open Extensions Management**
   - In Chrome, open a new tab and go to `chrome://extensions` (or go to **Menu > Extensions > Manage Extensions**).

3. **Enable Developer Mode**
   - Toggle the **Developer mode** switch in the top-right corner to **ON**.

4. **Load the Extension**
   - Click the **Load unpacked** button in the top-left corner.
   - Select the folder you extracted in Step 1 (the one containing the `manifest.json` file).
   - Click **Select Folder**.

5. **Pin the Extension (Optional)**
   - Click the puzzle piece icon in the top-right corner of your browser toolbar, find **GCR Fetch**, and click the pin icon.

6. **Start Using It**
   - Go to [Google Classroom](https://classroom.google.com).
   - Open any course page.
   - You will see a floating **⬇ GCR Fetch** button in the bottom-right corner. Click it to open the sidebar, log in, and scan your course resources!

> [!NOTE]
> **No Developer Setup Needed**: The extension is already pre-configured to use our secure, hosted backend and Google OAuth Client credentials. You only need to sign in using your university `@isb.nu.edu.pk` email address to use it.

---

<a name="dev-setup"></a>
## Deployment & Setup Guide (For Developers & Self-Hosters)

If you are a developer who has forked this repository and wants to run your own custom instance of GCR Fetch with your own Google Cloud project and hosting backend, follow the instructions below.

### 1. Backend Deployment (Vercel)
The extension securely exchanges authorization codes for API tokens using a serverless backend to keep client secrets safe.
1. Navigate to the backend folder:
   ```bash
   cd gcr-fetch-backend
   ```
2. Install the Vercel CLI globally (if you haven't already):
   ```bash
   npm install -g vercel
   ```
3. Authenticate and deploy the backend:
   ```bash
   vercel login
   # Run the deployment and link it to your account
   vercel --prod
   ```
   Note down your deployed backend URL (e.g., `https://your-project.vercel.app`).

### 2. Google Cloud Platform Configuration
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project.
3. Enable the following APIs:
   - **Google Classroom API**
   - **Google Drive API**
4. Set up your **OAuth Consent Screen**:
   - Set the User Type to **Internal** (if deploying within your university/organization domain) or **External** (if deploying publicly).
   - Add the necessary scopes: `classroom.courses.readonly`, `classroom.coursework.me.readonly`, `classroom.courseworkmaterials.readonly`, `classroom.announcements.readonly`, `drive.readonly`, and `drive.file`.
5. Create credentials:
   - Click **Create Credentials > OAuth client ID**.
   - Select **Web application** as the application type.
   - Under **Authorized redirect URIs**, add `https://<YOUR_CHROME_EXTENSION_ID>.chromiumapp.org` (replace with your extension's ID, which you can find in `chrome://extensions` after loading it).
   - Copy the generated **Client ID** and **Client Secret**.

### 3. Configure Environment Variables
In your Vercel project dashboard (Settings > Environment Variables), add the following:
- `GCR_CLIENT_ID`: Your Google OAuth Client ID.
- `GCR_CLIENT_SECRET`: Your Google OAuth Client Secret.

Redeploy the backend to apply these variables:
```bash
vercel --prod --force
```

### 4. Update Extension Code Configurations
In your local repository, configure the following:

- **In [background.js](file:///e:/gcr-resources-fetch/background.js)**:
  - Update `CLIENT_ID` with your new Google Client ID.
  - Update `EXTENSION_ID` with your local extension ID.
  - Update `BACKEND_URL` with your Vercel deployment URL.

- **In [gcr-fetch-backend/api/token.js](file:///e:/gcr-resources-fetch/gcr-fetch-backend/api/token.js)**:
  - Update `EXTENSION_ID` to match your extension ID (used for CORS policy verification).

---

## Permissions Explained

| Permission | Why It's Needed |
|---|---|
| `identity` | Required for `chrome.identity.launchWebAuthFlow` to open the Google OAuth consent popup |
| `scripting` | Used to inject the floating button and sidebar into Google Classroom pages |
| `downloads` | Triggers the browser file download for the generated ZIP archive |
| `storage` | Stores OAuth tokens and user info in `chrome.storage.local` (sandboxed to this extension) |
| `classroom.google.com/*` | Content script injection + DOM scraping for resource detection |
| `classroom.googleapis.com/*` | Google Classroom REST API calls for comprehensive resource discovery |
| `www.googleapis.com/*` | Google Drive API for file downloads and format conversion |
| `drive.google.com/*` | Parsing Drive URLs and detecting file/folder types |
| `docs.google.com/*` | Parsing Google Docs/Sheets/Slides URLs for export |

---

## Tech Stack

| Component | Technology |
|---|---|
| Extension | Chrome Manifest V3, Vanilla JavaScript |
| UI | Custom HTML/CSS/JS (Google-style design), no frameworks |
| Authentication | OAuth 2.0 via `chrome.identity.launchWebAuthFlow` |
| Backend | Vercel Serverless Functions (Node.js) |
| ZIP Generation | [JSZip](https://stuk.github.io/jszip/) |
| File Conversion | Google Drive API export endpoints (Docs → DOCX/PDF, Sheets → XLSX, Slides → PPTX) |
| External Resources Dashboard | Self-contained HTML with CSS, search, filtering, dark/light mode |

---

## Security Architecture

GCR Fetch was designed with a security-first mindset:

- **No `innerHTML`/`outerHTML`** — Every DOM manipulation uses `createElement`, `setAttribute`, `textContent`, and `appendChild`. This eliminates XSS vectors entirely.
- **Client secret never touches the extension** — The OAuth client secret is stored exclusively as a Vercel environment variable and is never included in the extension source code.
- **HTTPS-only, origin-restricted fetch proxy** — The `FETCH_WITH_AUTH` handler in `background.js` enforces an allowlist of allowed Google API origins. Non-HTTPS URLs and off-origin requests are rejected.
- **Filename sanitization** — All filenames are sanitized at multiple layers (content script, fetcher, zipper) to prevent directory traversal attacks within the ZIP archive. Path segments with `..` are rejected, and characters are restricted to an alphanumeric allowlist.
- **Token storage** — OAuth tokens are stored in `chrome.storage.local`, which is sandboxed to the extension and inaccessible to web pages. Tokens are never logged or transmitted to third parties.
- **CORS restriction** — The Vercel backend sets `Access-Control-Allow-Origin` to the specific Chrome extension origin only. No other origin can call the token endpoint.
- **Content Security Policy** — The sidebar HTML includes a strict CSP meta tag that limits resource loading to `self`, Google Fonts, and Google Drive thumbnails.

---

## License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">
  Built for students, by a student who got tired of clicking "Download" 47 times.
</p>
