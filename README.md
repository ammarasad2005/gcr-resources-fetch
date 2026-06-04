# GCR Fetch — Google Classroom Resource Downloader

<p align="center">
  <strong>Bulk-download every resource from a Google Classroom course as a single ZIP archive.</strong>
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

## Setup Instructions (Developer Mode)

Since this extension is not published on the Chrome Web Store, you'll need to install it manually using Chrome's Developer Mode. Here's how:

### Prerequisites

- **Google Chrome** (or any Chromium-based browser like Edge, Brave, etc.)
- The extension source code (clone or download this repository)

### Step-by-Step Installation

1. **Clone or download the repository**

   ```bash
   git clone https://github.com/ammarasad2005/gcr-resources-fetch.git
   cd gcr-resources-fetch
   ```

   Or download the ZIP from GitHub and extract it to a folder on your computer.

2. **Open Chrome's Extension Management page**

   - Type `chrome://extensions` in the Chrome address bar and press Enter
   - Alternatively, go to Chrome Menu → More Tools → Extensions

3. **Enable Developer Mode**

   - In the top-right corner of the Extensions page, toggle the **Developer mode** switch to **ON**

4. **Load the extension**

   - Click the **"Load unpacked"** button (appears after enabling Developer Mode)
   - Navigate to and select the `gcr-resources-fetch` folder (the root folder containing `manifest.json`)
   - Click **Select Folder**

5. **Verify installation**

   - The extension should now appear in your extensions list as **"GCR Fetch"**
   - You should see the GCR Fetch icon in your Chrome toolbar (you may need to pin it using the puzzle piece icon)

6. **Use it**

   - Navigate to [Google Classroom](https://classroom.google.com)
   - Open any course
   - The **"GCR Fetch"** floating button will appear in the bottom-right corner
   - Click it to open the sidebar, sign in with your Google account, and start scanning!

### Important Notes

- **The backend must be deployed** for the OAuth flow to work. The extension communicates with a Vercel serverless function at `https://gcr-fetch-backend.vercel.app/api/token` for token exchange. If you're forking this project, you'll need to deploy your own Vercel backend and update the `BACKEND_URL` constant in `background.js` as well as the `EXTENSION_ID` in both `background.js` and `gcr-fetch-backend/api/token.js`.
- **Do not modify files inside the loaded extension folder** while Chrome is running, as changes will be auto-detected and the extension will reload. Use the circular refresh arrow on the extension card if you make changes.
- **Permissions**: The extension requests access to your Google Classroom courses, coursework materials, Drive files, and basic profile info. All API calls are proxied through the service worker with a strict origin allowlist — no data is sent to any third-party server.

---

## Backend Deployment (For Contributors)

If you want to deploy your own instance of the OAuth backend:

1. **Fork this repository**

2. **Deploy to Vercel**

   ```bash
   cd gcr-fetch-backend
   npm install -g vercel
   vercel login
   vercel --prod
   ```

3. **Set environment variables in Vercel**

   Go to your Vercel project dashboard → Settings → Environment Variables and add:

   | Variable | Description |
   |---|---|
   | `GCR_CLIENT_ID` | Your Google OAuth 2.0 Client ID |
   | `GCR_CLIENT_SECRET` | Your Google OAuth 2.0 Client Secret |

4. **Create a Google Cloud project and OAuth credentials**

   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project
   - Enable the Google Classroom API and Google Drive API
   - Create OAuth 2.0 credentials (Chrome extension type)
   - Set the redirect URI to `https://<YOUR_EXTENSION_ID>.chromiumapp.org`
   - Use the Client ID and Client Secret as Vercel environment variables

5. **Update the extension constants**

   In `background.js`, update:
   - `CLIENT_ID` — your Google OAuth Client ID
   - `EXTENSION_ID` — your extension's ID (from `chrome://extensions` after loading unpacked)
   - `BACKEND_URL` — your Vercel deployment URL

   In `gcr-fetch-backend/api/token.js`, update:
   - `EXTENSION_ID` — must match the extension's actual ID

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
