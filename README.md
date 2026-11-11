# 🌟 Everything — The All-in-One Browser Productivity & Video Cinema Platform

[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Privacy First](https://img.shields.io/badge/Privacy-100%25%20Local-green.svg)](#-privacy--security-first)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)
[![GitHub Repository](https://img.shields.io/badge/GitHub-harsheye%2Feverything-black.svg)](https://github.com/harsheye/everything)

> **Everything** transforms your web browser into an ultra-fast, local-first power suite. Combining a **Raycast-style global command palette**, an **audiophile-grade cinema video player HUD** with reactive ambient lighting, an **intelligent bookmark organizer**, an **in-browser media capture & recording studio**, and **private image/PDF tools**—all isolated with zero telemetry.

---

## 📑 Table of Contents

- [✨ Overview](#-overview)
- [🎬 1. Smart Video Controller & Cinema HUD](#-1-smart-video-controller--cinema-hud)
  - [On-Hover Minimalist Pill & Action Capsule](#on-hover-minimalist-pill--action-capsule)
  - [One-Click Visual Profiles (Magic Wand 🪄)](#one-click-visual-profiles-magic-wand-)
  - [Dynamic Auto-Zoom & Non-Linear Elastic Stretch](#dynamic-auto-zoom--non-linear-elastic-stretch)
  - [Real-Time Ambient Lighting Engine](#real-time-ambient-lighting-engine)
  - [Studio-Grade Picture Calibration](#studio-grade-picture-calibration)
  - [Frame-Accurate Video Screenshots & HD Screen Recording](#frame-accurate-video-screenshots--hd-screen-recording)
- [⚡ 2. Universal Command Palette (`Alt+A`)](#-2-universal-command-palette-alta)
  - [Omnisearch & Query Syntax](#omnisearch--query-syntax)
  - [Instant Built-in Utilities & Converters](#instant-built-in-utilities--converters)
- [📚 3. Intelligent Bookmark Organizer & Health Center](#-3-intelligent-bookmark-organizer--health-center)
  - [Automatic Categorization & Smart Grouping](#automatic-categorization--smart-grouping)
  - [Duplicate Detector & Dead Link (404) Cleaner](#duplicate-detector--dead-link-404-cleaner)
- [🖼️ 4. Media Engine & Gallery Suite](#️-4-media-engine--gallery-suite)
- [🛠️ 5. In-Browser Image & PDF Workshop](#️-5-in-browser-image--pdf-workshop)
- [📋 6. Clipboard History & Smart Form Autofill](#-6-clipboard-history--smart-form-autofill)
- [🔊 7. Audio Booster Engine (Up to 400%)](#-7-audio-booster-engine-up-to-400)
- [🌌 8. Minimalist New Tab Dashboard](#-8-minimalist-new-tab-dashboard)
- [⌨️ Keyboard Shortcuts & Cheatsheet](#️-keyboard-shortcuts--cheatsheet)
- [🔒 Privacy & Security First](#-privacy--security-first)
- [🚀 Installation & Setup](#-installation--setup)

---

## ✨ Overview

Modern web workflows require multiple disconnected tools: screenshot extensions, bookmark managers, video zoomers, ambient light scripts, clipboard managers, and PDF editors. 

**Everything** unifies all of these capabilities into a single, cohesive, high-performance browser extension. Crafted with an **obsidian glassmorphic design language**, it runs completely in-memory and in local IndexedDB storage for unmatched speed and total privacy.

---

## 🎬 1. Smart Video Controller & Cinema HUD

A comprehensive video player suite compatible with **YouTube, Netflix, Twitch, Vimeo, Prime Video, and any HTML5 `<video>` element** on the web.

### On-Hover Minimalist Pill & Action Capsule
- **Discreet Presence**: Hovering over any video reveals a sleek 38px obsidian glass capsule positioned at the top-center.
- **Proximity Expansion**: As your cursor approaches the pill, it seamlessly expands into an action capsule with one-click triggers:
  - 📸 **Quick Screenshot**: Capture high-res frames with zero UI artifacts.
  - ⏺ **Record Video**: Initiate live clip recording with audio.
  - ⚙ **More Options**: Open the full glassmorphic HUD panel.

### One-Click Visual Profiles (Magic Wand 🪄)
Instant visual presets optimized for different content types:
- **Lift**: Subtle contrast and shadow lift for low-light scenes.
- **Movie**: Cinematic contrast curves, warm saturation, and HDR enhancement.
- **Game**: High vibrance, boosted sharpness, and enhanced dark levels.
- **Music**: Rich saturation and dynamic audio-reactive ambient pulsing.
- **Sport**: High sharpness and fluid motion clarity.
- **None**: Neutral uncalibrated reference output.

### Dynamic Auto-Zoom & Non-Linear Elastic Stretch
- **Auto-Zoom to Fill**: Automatically detects available player space and scales video to eliminate letterboxing without distortion.
- **Elastic Stretch**: Proprietary SVG displacement matrix stretching edges non-linearly to fill **16:9, 18:9, 21:9, and 32:9 ultra-wide** monitors while preserving 1:1 aspect ratio at the center (no distorted faces or logos).
- **Auto Upscale / Downscale**: Dynamic resize observers automatically recalibrate scaling during window resizes, theater mode toggling, and full-screen transitions.
- **Manual Mode Transition**: Touching any zoom slider immediately transitions out of auto mode into full manual control.
- **2D Pan Control**: Smooth $X$ and $Y$ axis pan sliders with instant center-reset.

### Real-Time Ambient Lighting Engine
- **Edge Color Sampling**: Real-time canvas engine samples perimeter video pixels to cast a vibrant, zero-latency ambient glow behind and around the player.
- **Customizable Dynamics**: Sliders for spread width, intensity, blur radius, sync refresh rate (up to 90 FPS), and audio-reactive pulsing.
- **Auto-Rescaling**: Ambient canvas dynamically scales in sync with zooms, elastic stretches, and full-screen modes.

### Studio-Grade Picture Calibration
Real-time GPU-accelerated CSS filter calibration:
- **Lighting & Shadows**: Lift blacks or deepen shadows without clipping.
- **Contrast & Sharpness**: Crisp line definition for text and game streams.
- **Vibrance & Saturation**: Perceptual color boosting.
- **HDR Boost**: Simulates extended dynamic range on standard SDR monitors.

### Frame-Accurate Video Screenshots & HD Screen Recording
- **Native Resolution Capture (`Alt+C`)**: Snaps current frame at raw video resolution (e.g. 4K/1080p), ignoring player scale.
- **Background Video Recording (`Ctrl+Alt+B`)**: Captures video stream and audio via MediaRecorder, automatically streaming chunks to IndexedDB with auto-recovery if tabs close.

---

## ⚡ 2. Universal Command Palette (`Alt+A`)

A lightning-fast spotlight launcher accessible anywhere on any web page with `Alt+A` or `Ctrl+Shift+P`.

### Omnisearch & Query Syntax
Filter your digital space instantly using keyword prefixes:
- `/b <query>` — Search and open Bookmarks.
- `/h <query>` — Search Browsing History.
- `/t <query>` — Switch to or close Open Tabs across all windows.
- `/c <query>` — Search Clipboard History snippets.
- `/n <query>` — Quick scratchpad notes.
- `/d <domain>` — Filter history/bookmarks specifically by domain (e.g., `/d github.com`).
- `/m <mode>` — Enter utility sub-modes (Image, PDF, Audio Boost, Timer).

### Instant Built-in Utilities & Converters
Type directly into the palette:
- **Math Calculator**: Evaluate expressions (`(128 * 4) / 1.5`, `sqrt(144)`, `25% of 850`).
- **Currency & Unit Conversion**: Convert live units (`100 USD to EUR`, `50 kg to lbs`, `2560 px to rem`).
- **QR Code Generator**: Generate scannable QR codes for the current page URL or custom text.
- **Color Picker**: Inspect and copy HEX, RGB, and HSL values.
- **JSON Formatter & Validator**: Beautify, minify, and inspect JSON payloads.
- **Encoders & Decoders**: Base64, URL encoding, HTML entity conversions.
- **Secure Password Generator**: Configurable length with symbol and digit rules.
- **Stopwatch & Countdown Timer**: Floating countdown badge with notification alerts.

---

## 📚 3. Intelligent Bookmark Organizer & Health Center

Dedicated dashboard (`dashboard.html`) designed to eliminate bookmark rot.

### Automatic Categorization & Smart Grouping
- **Domain & Tag Clustering**: Automatically aggregates sprawling bookmarks into clean, hierarchical folders based on domain patterns and content topics.
- **Frequency Analytics**: Identifies most-visited bookmarks and promotes them to quick-access rails.

### Duplicate Detector & Dead Link (404) Cleaner
- **Deduplication Engine**: Scans thousands of bookmarks in milliseconds to identify duplicate URLs and identical page titles with one-click cleanup.
- **Dead Link Checker**: Tests bookmark endpoints in the background, flagging 404s, redirected domains, and unreachable servers.
- **Import & Export**: Full interoperability with standard Chrome HTML bookmark files and portable JSON backups.

---

## 🖼️ 4. Media Engine & Gallery Suite

Centralized storage and preview gallery (`screenshots.html`) for all captures.

- **Virtualized Masonry Grid**: Renders hundreds of images and video recordings with buttery-smooth 60 FPS scrolling and low memory usage.
- **Temporal Filters**: Instant sorting by *Today*, *This Week*, *This Month*, *Favorites*, or *Videos Only*.
- **Interactive Lightbox**: Full-resolution zoom, pan, video playback controls, and metadata inspection.
- **Batch Export**: Select multiple media files and export them bundled inside a single `.zip` archive via `jszip`.

---

## 🛠️ 5. In-Browser Image & PDF Workshop

Private, client-side utility studios eliminating the need for sketchy online file converters.

### Image Studio (`image.html`)
- **Lossless & Lossy Compression**: Downsize PNG and JPEG files with adjustable quality sliders.
- **Format Converter**: Instant bi-directional conversion between PNG, JPEG, WebP, and BMP.
- **Canvas Operations**: Crop to custom aspect ratios, rotate, flip, and apply watermarks.

### PDF Suite (`pdf.html`)
- **Merge & Split**: Combine multiple documents or extract target page ranges.
- **Page Reordering & Rotation**: Visual drag-and-drop page organizer.
- **Page Extraction**: Export individual pages as standalone high-res images.
- **Zero Server Uploads**: Powered by `pdf-lib`—all operations occur locally in browser memory.

---

## 📋 6. Clipboard History & Smart Form Autofill

- **Smart Clipboard Cache**: Silently archives copied text snippets, URLs, and code blocks with automatic syntax highlighting and search.
- **One-Click Profile Autofill (`Alt+Shift+A`)**: Configure custom identity profiles (Name, Email, Phone, Company, Shipping Address) and fill web forms accurately with a single hotkey.

---

## 🔊 7. Audio Booster Engine (Up to 400%)

Quiet laptop speakers or softly-recorded podcasts?
- Utilizes the **Web Audio API** (`AudioContext`, `GainNode`, and `DynamicsCompressorNode`).
- Amplifies HTML5 audio and video elements up to **400% volume**.
- Built-in multi-band compression prevents distortion and harsh clipping.

---

## 🌌 8. Minimalist New Tab Dashboard

- Replaces the default blank tab with a clean, distraction-free obsidian dashboard (`newtab.html`).
- Features dynamic greetings, live time/date, custom search, and categorized bookmark launchpads.

---

## ⌨️ Keyboard Shortcuts & Cheatsheet

| Shortcut | Action | Scope |
| :--- | :--- | :--- |
| <kbd>Alt</kbd> + <kbd>A</kbd> | Toggle Command Palette | Global Webpages |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> | Toggle Command Palette (Alternative) | Global Webpages |
| <kbd>Alt</kbd> + <kbd>C</kbd> | Capture Native Frame Screenshot | Active Video |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>B</kbd> | Start / Stop Video Recording | Active Video |
| <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>A</kbd> | Auto-fill Form Fields with Profile | Active Form |
| <kbd>Esc</kbd> | Close Active Palette / Video HUD | Global |

---

## 🔒 Privacy & Security First

- **100% Local Execution**: All computations (image compression, PDF splitting, video zooming, bookmark analysis) execute entirely inside your local Chrome sandbox.
- **Zero Third-Party Analytics**: No telemetry, no tracking cookies, no external API beacons.
- **Zero Remote Dependencies**: Packaged with all necessary libraries (`pdf-lib`, `jszip`) bundled locally within the extension.

---

## 🚀 Installation & Setup

1. **Clone or Download the Repository**:
   ```bash
   git clone git@github.com:harsheye/everything.git
   ```
2. **Open Extensions Management**:
   - Open Google Chrome, Brave, or any Chromium-based browser.
   - Navigate to `chrome://extensions`.
3. **Enable Developer Mode**:
   - Toggle the **Developer mode** switch in the top-right corner.
4. **Load Unpacked**:
   - Click **Load unpacked** in the top-left corner.
   - Select the folder containing `manifest.json`.
5. **Pin and Enjoy**:
   - Pin the **Everything** extension icon to your toolbar and press <kbd>Alt</kbd> + <kbd>A</kbd> on any page to begin!

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for more information.

---

<div align="center">
  <sub>Built with ❤️ for power users, creators, and professionals who want everything in one place.</sub>
</div>
