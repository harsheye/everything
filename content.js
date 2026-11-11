// Smart Command Palette: Browser-wide Productivity Platform
let ccRoot = null;
let ccShadow = null;
let ccBackdrop = null;
let ccSearchInput = null;
let ccResultsList = null;
let ccEmptyState = null;
let ccBreadcrumbs = null;
let ccSubmenu = null;
let ccAudioMeter = null;

// Global settings
let EXT_SETTINGS = {
  enableClipboard: true,
  enableScreenshots: true,
  enableCookies: true,
  enableDashboard: true
};

chrome.storage.local.get(['app_settings'], (res) => {
  if (res.app_settings) {
    EXT_SETTINGS = { ...EXT_SETTINGS, ...res.app_settings };
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.app_settings) {
    EXT_SETTINGS = { ...EXT_SETTINGS, ...changes.app_settings.newValue };
  }
});

// Command Mode UI elements
let ccBackBtn = null;
let ccCommandTagContainer = null;

// Registry and States
let selectedIndex = -1;
let visibleItems = [];
let activeQuery = "";
let isSubmenuOpen = false;
let isAudioBoosterActive = false;
let audioMeterInterval = null;
let clipboardHistoryCache = [];
let commandStats = {}; // { id: { frequency: 0, lastUsed: 0 } }
let currentSearchRequestId = 0;
let activeSuggestion = "";
let undoStack = [];
let redoStack = [];

// Command Mode State
let currentCommandMode = null; // 'image', 'pdf', 'note', 'boost', 'timer', 'translate'
let commandModeParams = {};    // sub-state parameters (e.g., resizing size)

// Audio Boost Nodes
let audioContext = null;
let gainNode = null;
let compressorNode = null;
let analyserNode = null;
let mediaSources = new Map();

// --- DB INTERFACE IMPORT FALLBACK ---
const DB = typeof CommandPaletteDB !== 'undefined' ? CommandPaletteDB : {
  async get(store, id) { return null; },
  async getAll(store) { return []; },
  async put(store, data) { return null; },
  async delete(store, id) { return true; },
  async addClipboardItem(c, t) { return null; },
  async getClipboardHistory() { return []; },
  async getNotes() { return []; }
};

// Video Screenshot Overlay Logic
// =============================================================
// SMART VIDEO CONTROLLER & HUD (PROFILES, CAPTURE, ZOOM, PICTURE, AMBIENCE, FLUIDITY)
// =============================================================
const SmartVideoHUD = {
  hostEl: null,
  shadow: null,
  activeVideo: null,
  isPillHovered: false,
  isOpen: false,
  activeTab: 'capture',
  hideTimer: null,
  mouseInactivityTimer: null,
  fpsTracker: {
    lastTime: performance.now(),
    frameCount: 0,
    fps: 60,
    active: false,
    rafId: null
  },
  ambience: {
    canvas: null,
    ctx: null,
    intervalId: null
  },
  profiles: {
    lift: {
      name: 'Lift',
      lighting: 15,
      shadows: 10,
      contrast: 15,
      sharpness: 10,
      vibrance: 10,
      hdrBoost: 0,
      ambienceAudioPulse: 0
    },
    movie: {
      name: 'Movie',
      lighting: 20,
      shadows: 15,
      contrast: 25,
      sharpness: 15,
      vibrance: 20,
      hdrBoost: 10,
      ambienceAudioPulse: 0
    },
    game: {
      name: 'Game',
      lighting: 25,
      shadows: 20,
      contrast: 30,
      sharpness: 40,
      vibrance: 30,
      hdrBoost: 20,
      ambienceAudioPulse: 30
    },
    music: {
      name: 'Music',
      lighting: 10,
      shadows: 10,
      contrast: 20,
      sharpness: 10,
      vibrance: 35,
      hdrBoost: 15,
      ambienceAudioPulse: 60
    },
    sport: {
      name: 'Sport',
      lighting: 20,
      shadows: 15,
      contrast: 25,
      sharpness: 45,
      vibrance: 15,
      hdrBoost: 10,
      ambienceAudioPulse: 0
    },
    none: {
      name: 'None',
      lighting: 0,
      shadows: 0,
      contrast: 0,
      sharpness: 0,
      vibrance: 0,
      hdrBoost: 0,
      ambienceAudioPulse: 0
    }
  },
  settings: {
    activeProfile: 'none',
    pictureEnabled: false,
    lighting: 0,
    shadows: 0,
    contrast: 0,
    sharpness: 0,
    vibrance: 0,
    hdrBoost: 0,
    zoomEnabled: false,
    zoomScale: 100, // 100% -> x1.00
    elasticStretch: 0, // 0%
    removeBlackbars: false,
    aspectRatio: '16:9',
    panX: 0,
    panY: 0,
    panActive: false,
    ambienceEnabled: false,
    ambienceSpread: 100,
    ambienceIntensity: 100,
    ambienceBlur: 45,
    ambienceSyncRate: 90,
    ambienceAudioPulse: 0,
    keepBlackBars: false,
    fluidityEnabled: true,
    pinStats: false
  },

  _elasticMapUrl: null,

  getElasticMapDataUrl(strength = 1.0) {
    try {
      const cvs = document.createElement('canvas');
      cvs.width = 256;
      cvs.height = 4;
      const ctx = cvs.getContext('2d');
      const imgData = ctx.createImageData(256, 4);
      const data = imgData.data;

      for (let x = 0; x < 256; x++) {
        const u = x / 255;
        const normX = (u - 0.5) * 2; // -1 to +1
        const absX = Math.abs(normX);

        // Center zone: counter-compress to keep 1:1; edges relax to stretch
        let disp = 0;
        if (absX < 0.48) {
          disp = -normX * 0.72 * strength;
        } else {
          const t = (absX - 0.48) / 0.52;
          disp = -Math.sign(normX) * (0.72 * (1 - t * t)) * strength;
        }

        const r = Math.max(0, Math.min(255, Math.round(128 + disp * 127)));

        for (let y = 0; y < 4; y++) {
          const idx = (y * 256 + x) * 4;
          data[idx] = r;       // R channel controls horizontal displacement
          data[idx + 1] = 128; // G channel controls vertical (0 displacement)
          data[idx + 2] = 128;
          data[idx + 3] = 255;
        }
      }
      ctx.putImageData(imgData, 0, 0);
      return cvs.toDataURL();
    } catch(e) {
      return '';
    }
  },

  ensureElasticSvgFilter() {
    if (document.getElementById('cc-elastic-svg-root')) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'cc-elastic-svg-root';
    svg.style.cssText = 'position:fixed; top:-9999px; left:-9999px; width:0; height:0; pointer-events:none;';
    svg.innerHTML = `
      <defs>
        <filter id="cc-elastic-filter" x="-20%" y="0%" width="140%" height="100%" color-interpolation-filters="sRGB">
          <feImage id="cc-elastic-fe-image" href="" result="warpMap" preserveAspectRatio="none"/>
          <feDisplacementMap id="cc-elastic-fe-disp" in="SourceGraphic" in2="warpMap" scale="0" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </defs>
    `;
    (document.body || document.documentElement).appendChild(svg);
  },

  updateElasticFilter(elastic) {
    this.ensureElasticSvgFilter();
    const dispEl = document.getElementById('cc-elastic-fe-disp');
    const imgEl = document.getElementById('cc-elastic-fe-image');
    if (!dispEl || !imgEl) return;

    if (!this._elasticMapUrl) {
      this._elasticMapUrl = this.getElasticMapDataUrl(1.0);
    }
    if (imgEl.getAttribute('href') !== this._elasticMapUrl) {
      imgEl.setAttribute('href', this._elasticMapUrl);
    }

    const vW = (this.activeVideo ? (this.activeVideo.videoWidth || this.activeVideo.clientWidth) : 1920) || 1920;
    const dispScale = Math.round(vW * 0.18 * elastic);
    dispEl.setAttribute('scale', dispScale);
  },

  getDefaultSettings() {
    return {
      activeProfile: 'none',
      pictureEnabled: false,
      lighting: 0,
      shadows: 0,
      contrast: 0,
      sharpness: 0,
      vibrance: 0,
      hdrBoost: 0,
      zoomEnabled: false,
      autoZoomToFill: false, // Auto-rescale zoom dynamically on player resize/fullscreen
      autoElasticStretch: false, // Auto-rescale elastic stretch dynamically on player resize/fullscreen
      zoomScale: 100, // 100% -> x1.00
      elasticStretch: 0, // 0%
      removeBlackbars: false,
      aspectRatio: '16:9',
      panX: 0,
      panY: 0,
      panActive: false,
      ambienceEnabled: false,
      ambienceSpread: 100,
      ambienceIntensity: 100,
      ambienceBlur: 45,
      ambienceSyncRate: 90,
      ambienceAudioPulse: 0,
      keepBlackBars: false,
      fluidityEnabled: true,
      pinStats: false
    };
  },
  resizeObserver: null,

  loadSettings() {
    // On page reload, automatically reset all settings to default
    try {
      const key = `smart_vid_${window.location.hostname}`;
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    } catch (e) {}
    this.settings = this.getDefaultSettings();
  },

  saveSettings() {
    // Settings remain active during the page session and reset automatically on page reload
  },

  init() {
    if (this.hostEl) {
      if (!this.hostEl.isConnected) {
        (document.fullscreenElement || document.body || document.documentElement)?.appendChild(this.hostEl);
      }
      return;
    }
    this.loadSettings();

    this.hostEl = document.createElement('div');
    this.hostEl.id = 'smart-video-hud-root';
    this.hostEl.style.cssText = 'position:fixed !important; z-index:2147483647 !important; top:0 !important; left:0 !important; width:0 !important; height:0 !important; pointer-events:none !important; overflow:visible !important; display:block !important;';
    this.shadow = this.hostEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host, .hud-container {
        /* ── REFERENCE DESIGN TOKENS (SLATE-NAVY GLASS) ── */
        /* Surfaces & Glass */
        --hud-surface-base: rgba(11, 17, 30, 0.86);
        --hud-surface-header: rgba(11, 17, 30, 0.86);
        --hud-surface-panel: rgba(11, 17, 30, 0.86);
        --hud-surface-pill: rgba(11, 17, 30, 0.86);
        --hud-surface-pill-hover: rgba(11, 17, 30, 0.94);
        --hud-surface-sliding: rgba(11, 17, 30, 0.96);
        --hud-surface-card: rgba(255, 255, 255, 0.045);
        --hud-surface-card-hover: rgba(255, 255, 255, 0.08);
        --hud-surface-toast: rgba(11, 17, 30, 0.92);
        --hud-surface-tooltip: rgba(11, 17, 30, 0.94);

        /* Backdrop Filter */
        --hud-backdrop-filter: blur(24px);

        /* Borders & Outlines */
        --hud-border: rgba(255, 255, 255, 0.11);
        --hud-border-subtle: rgba(255, 255, 255, 0.06);
        --hud-border-hover: rgba(255, 255, 255, 0.22);
        --hud-border-active-tab: rgba(255, 255, 255, 0.11);

        /* Controls (Idle, Hover, Selected) */
        --hud-control-idle-fill: rgba(255, 255, 255, 0.07);
        --hud-control-segmented-fill: rgba(255, 255, 255, 0.06);
        --hud-control-ghost-fill: rgba(255, 255, 255, 0.05);
        --hud-control-tile-fill: rgba(255, 255, 255, 0.08);
        --hud-control-hover-fill: rgba(255, 255, 255, 0.17);
        --hud-control-selected-fill: rgba(139, 92, 246, 0.24);
        --hud-control-selected-border: rgba(139, 92, 246, 0.80);

        /* Tabs */
        --hud-tab-active-fill: rgba(255, 255, 255, 0.13);
        --hud-tab-active-border: rgba(255, 255, 255, 0.11);
        --hud-tab-underline: #ffffff;

        /* Sliders */
        --hud-slider-rail: rgba(255, 255, 255, 0.18);
        --hud-slider-fill: #8b5cf6;
        --hud-slider-thumb: #ffffff;

        /* Toggles */
        --hud-toggle-off-track: rgba(255, 255, 255, 0.18);
        --hud-toggle-on-track: #8b5cf6;
        --hud-toggle-knob: #ffffff;

        /* Typography (Tailwind Slate) */
        --hud-text-primary: #f8fafc;
        --hud-text-values: #ffffff;
        --hud-text-label-row: #f1f5f9;
        --hud-text-label-card: #cbd5e1;
        --hud-text-chip: #cbd5e1;
        --hud-text-secondary: #94a3b8;
        --hud-text-muted: #64748b;
        --hud-text-section: #64748b;
        --hud-text-active-tab-sub: #e2e8f0;

        /* Accents & States */
        --hud-primary: #8b5cf6;
        --hud-primary-hover: #7c3aed;
        --hud-record: #ef4444;
        --hud-record-hover: #dc2626;
        --hud-record-tint: rgba(239, 68, 68, 0.24);
        --hud-record-tint-hover: rgba(239, 68, 68, 0.45);
        --hud-record-live-border: #ff8888;
        --hud-record-dot-idle: #fca5a5;

        /* Badges & Icons */
        --hud-badge-fill: rgba(255, 255, 255, 0.07);
        --hud-badge-border: rgba(255, 255, 255, 0.11);
        --hud-badge-text: #cbd5e1;
        --hud-info-icon: #64748b;
        --hud-info-icon-hover: #cbd5e1;

        /* Divider & Scrollbar */
        --hud-divider-line: rgba(255, 255, 255, 0.08);
        --hud-scrollbar-thumb: rgba(255, 255, 255, 0.16);

        /* Highlights & Shines */
        --hud-shine-edge: rgba(255, 255, 255, 0.12);
        --hud-shine-center: rgba(255, 255, 255, 0.40);
        --hud-highlight-top: rgba(255, 255, 255, 0.15);
        --hud-highlight-fade: rgba(255, 255, 255, 0.01);

        /* Focus Ring */
        --hud-focus-ring: rgba(139, 92, 246, 0.50);

        /* Shadows, Highlights & Glows */
        --hud-shadow-header: 0 16px 40px rgba(0, 0, 0, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.20);
        --hud-shadow-panel: 0 24px 64px rgba(0, 0, 0, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.20);
        --hud-shadow-pill: 0 8px 24px rgba(0, 0, 0, 0.65), inset 0 1px 0 rgba(255, 255, 255, 0.20);
        --hud-shadow-pill-hover: 0 14px 40px rgba(0, 0, 0, 0.85), 0 0 18px rgba(139, 92, 246, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.20);
        --hud-shadow-active-tab: 0 4px 16px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.20);
        --hud-shadow-underline: 0 0 6px rgba(255, 255, 255, 0.70);
        --hud-shadow-glow-accent: 0 0 10px rgba(139, 92, 246, 0.35);
        --hud-shadow-btn-primary: 0 4px 12px rgba(139, 92, 246, 0.30);
        --hud-shadow-btn-primary-hover: 0 6px 18px rgba(139, 92, 246, 0.50);
        --hud-shadow-btn-record: 0 4px 12px rgba(239, 68, 68, 0.30);
        --hud-shadow-btn-record-hover: 0 6px 18px rgba(239, 68, 68, 0.50);
        --hud-shadow-record-dot: 0 0 8px rgba(239, 68, 68, 0.70);
        --hud-shadow-record-dot-hover: 0 0 12px rgba(239, 68, 68, 0.70);
        --hud-shadow-thumb: 0 0 10px rgba(139, 92, 246, 0.60), 0 2px 6px rgba(0, 0, 0, 0.50);
        --hud-shadow-thumb-hover: 0 0 14px rgba(139, 92, 246, 0.90), 0 2px 8px rgba(0, 0, 0, 0.60);
        --hud-shadow-toggle-knob: 0 2px 4px rgba(0, 0, 0, 0.30);

        /* Radii & Fonts */
        --hud-radius-header: 24px;
        --hud-radius-panel: 22px;
        --hud-radius-card: 16px;
        --hud-radius-btn: 12px;
        --hud-radius-pill: 20px;
        --hud-font: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }

      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
        font-family: var(--hud-font);
      }

      /* Main Container positioned at top-center of active video */
      .hud-container {
        position: fixed;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        z-index: 2147483647;
        user-select: none;
        opacity: 0;
        pointer-events: none;
        transform: translateX(-50%) translateY(-6px);
        transition: opacity 0.3s cubic-bezier(0.22, 1, 0.36, 1), transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
      }

      /* When mouse is over video: appear at top-center */
      .hud-container.visible {
        opacity: 0.94;
        pointer-events: auto;
        transform: translateX(-50%) translateY(0);
      }

      .hud-container.visible.faded {
        opacity: 0.80;
        pointer-events: auto;
        transform: translateX(-50%) translateY(0);
      }

      .hud-container.visible.near-button,
      .hud-container.mouse-close,
      .hud-container.pill-hovered,
      .hud-container.open,
      .hud-container:hover {
        opacity: 1 !important;
        pointer-events: auto !important;
        transform: translateX(-50%) translateY(0) !important;
      }

      /* Button / Pill Base State (Restyled with REFERENCE tokens) */
      .hud-pill {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 38px;
        width: 38px;
        border-radius: 19px;
        background: var(--hud-surface-pill);
        border: 1px solid var(--hud-border);
        box-shadow: var(--hud-shadow-pill);
        backdrop-filter: var(--hud-backdrop-filter);
        -webkit-backdrop-filter: var(--hud-backdrop-filter);
        color: var(--hud-text-secondary);
        cursor: pointer;
        transition: width 0.35s cubic-bezier(0.22, 1, 0.36, 1),
                    height 0.35s cubic-bezier(0.22, 1, 0.36, 1),
                    padding 0.35s cubic-bezier(0.22, 1, 0.36, 1),
                    gap 0.35s cubic-bezier(0.22, 1, 0.36, 1),
                    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1),
                    border-radius 0.35s cubic-bezier(0.22, 1, 0.36, 1),
                    background 0.3s ease,
                    border-color 0.3s ease,
                    box-shadow 0.35s cubic-bezier(0.22, 1, 0.36, 1);
        overflow: visible;
        white-space: nowrap;
      }

      .hud-pill-bg {
        position: absolute;
        inset: 0;
        border-radius: inherit;
        overflow: hidden;
        pointer-events: none;
        z-index: 0;
      }

      .hud-pill-bg::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 50%;
        background: linear-gradient(180deg, var(--hud-highlight-top) 0%, var(--hud-highlight-fade) 100%);
        border-radius: 22px 22px 0 0;
        opacity: 0;
        transition: opacity 0.35s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .hud-pill:hover .hud-pill-bg::before,
      .hud-container.pill-hovered .hud-pill-bg::before {
        opacity: 1;
      }

      .hud-pill-bg::after {
        content: '';
        position: absolute;
        top: -60%;
        left: -80%;
        width: 45%;
        height: 220%;
        background: linear-gradient(
          75deg,
          transparent 20%,
          var(--hud-shine-edge) 45%,
          var(--hud-shine-center) 50%,
          var(--hud-shine-edge) 55%,
          transparent 80%
        );
        transform: rotate(25deg);
        opacity: 0;
        transition: opacity 0.4s ease;
      }
      .hud-pill:hover .hud-pill-bg::after,
      .hud-container.pill-hovered .hud-pill-bg::after {
        opacity: 1;
        animation: hud-shine-sweep 3s infinite cubic-bezier(0.4, 0, 0.2, 1);
      }
      @keyframes hud-shine-sweep {
        0% { left: -80%; }
        45% { left: 160%; }
        100% { left: 160%; }
      }

      /* Hover Expansion into Action Capsule */
      .hud-pill:hover,
      .hud-container.pill-hovered .hud-pill,
      .hud-container.mouse-close .hud-pill {
        width: auto;
        height: 42px;
        border-radius: 22px;
        padding: 0 14px;
        gap: 10px;
        transform: scale(1.06);
        background: var(--hud-surface-pill-hover);
        border: 1px solid var(--hud-border-hover);
        box-shadow: var(--hud-shadow-pill-hover);
      }

      .hud-pill-icon {
        width: 22px;
        height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        color: var(--hud-text-secondary);
        position: relative;
        z-index: 1;
      }
      .hud-pill-divider {
        width: 1px;
        height: 18px;
        background: var(--hud-border-hover);
        opacity: 0;
        transition: opacity 0.3s cubic-bezier(0.22, 1, 0.36, 1);
        flex-shrink: 0;
        position: relative;
        z-index: 1;
      }
      .hud-pill:hover .hud-pill-divider,
      .hud-container.pill-hovered .hud-pill-divider,
      .hud-container.mouse-close .hud-pill-divider {
        opacity: 1;
      }

      .hud-pill-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        opacity: 0;
        max-width: 0;
        overflow: hidden;
        transition: opacity 0.3s 0.05s cubic-bezier(0.22, 1, 0.36, 1),
                    max-width 0.35s cubic-bezier(0.22, 1, 0.36, 1);
        position: relative;
        z-index: 1;
      }
      .hud-pill:hover .hud-pill-actions,
      .hud-container.pill-hovered .hud-pill-actions,
      .hud-container.mouse-close .hud-pill-actions {
        opacity: 1;
        max-width: 220px;
      }

      .hud-pill-btn-shot {
        background: var(--hud-control-tile-fill);
        border: 1px solid var(--hud-border);
        color: var(--hud-text-values);
        width: 30px;
        height: 30px;
        border-radius: 50%;
        padding: 0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s cubic-bezier(0.22, 1, 0.36, 1);
        flex-shrink: 0;
      }
      .hud-pill-btn-shot:hover {
        background: var(--hud-control-selected-fill);
        border-color: var(--hud-primary);
        color: var(--hud-text-values);
        transform: scale(1.15);
        box-shadow: var(--hud-shadow-btn-primary);
      }

      .hud-pill-btn-rec {
        background: var(--hud-record-tint);
        border: 1px solid var(--hud-record-tint-hover);
        color: var(--hud-record-dot-idle);
        width: 30px;
        height: 30px;
        border-radius: 50%;
        padding: 0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s cubic-bezier(0.22, 1, 0.36, 1);
        flex-shrink: 0;
      }
      .hud-rec-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--hud-record);
        box-shadow: var(--hud-shadow-record-dot);
        display: inline-block;
        transition: all 0.2s;
      }
      .hud-pill-btn-rec:hover {
        background: var(--hud-record-tint-hover);
        border-color: var(--hud-record);
        transform: scale(1.15);
        box-shadow: var(--hud-shadow-record-dot-hover);
      }
      .hud-pill-btn-rec:hover .hud-rec-dot {
        transform: scale(1.15);
      }
      .hud-pill-rec-live {
        background: var(--hud-record) !important;
        border-color: var(--hud-record-live-border) !important;
        color: var(--hud-text-values) !important;
        animation: hud-pulse-red 1.2s infinite;
      }

      .hud-pill-btn-more {
        background: var(--hud-control-segmented-fill);
        border: 1px solid var(--hud-border);
        color: var(--hud-text-secondary);
        width: 30px;
        height: 30px;
        border-radius: 50%;
        padding: 0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s cubic-bezier(0.22, 1, 0.36, 1);
        flex-shrink: 0;
      }
      .hud-pill-btn-more:hover {
        background: var(--hud-control-hover-fill);
        border-color: var(--hud-border-hover);
        color: var(--hud-text-values);
        transform: scale(1.15);
      }

      .hud-container.open .hud-pill {
        display: none;
      }

      /* HEADER BAR (REFERENCE) */
      .hud-top-bar {
        display: none;
        align-items: center;
        padding: 6px 10px;
        background: var(--hud-surface-header);
        border: 1px solid var(--hud-border);
        border-radius: var(--hud-radius-header);
        box-shadow: var(--hud-shadow-header);
        backdrop-filter: var(--hud-backdrop-filter);
        -webkit-backdrop-filter: var(--hud-backdrop-filter);
        gap: 6px;
        animation: hud-pop-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .hud-container.open .hud-top-bar {
        display: flex;
      }

      /* Magic Wand Profiles Button on Left */
      .hud-bar-profiles-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-width: 38px;
        height: 38px;
        padding: 0 10px;
        border-radius: 50%;
        background: var(--hud-control-segmented-fill);
        border: 1px solid var(--hud-border);
        color: var(--hud-text-secondary);
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        flex-shrink: 0;
        font-size: 15px;
      }
      .hud-bar-profiles-btn:hover,
      .hud-bar-profiles-btn.active {
        background: var(--hud-control-selected-fill);
        border-color: var(--hud-control-selected-border);
        box-shadow: var(--hud-shadow-glow-accent);
        color: var(--hud-text-values);
      }
      .hud-profile-wand-label {
        font-size: 12px;
        font-weight: 700;
        color: var(--hud-text-values);
      }

      /* Top Bar Tabs */
      .hud-tab-item {
        background: transparent;
        border: 1px solid transparent;
        color: var(--hud-text-muted);
        padding: 6px 14px;
        border-radius: 14px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
        min-width: 76px;
        position: relative;
      }
      .hud-tab-item:hover {
        background: var(--hud-control-segmented-fill);
        color: var(--hud-text-primary);
      }
      .hud-tab-item.active {
        background: var(--hud-tab-active-fill);
        border-color: var(--hud-tab-active-border);
        color: var(--hud-text-primary);
        box-shadow: var(--hud-shadow-active-tab);
      }
      .hud-tab-title {
        font-size: 12.5px;
        font-weight: 700;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .hud-tab-sub {
        font-size: 10px;
        color: var(--hud-text-muted);
        font-weight: 500;
        margin-top: 1px;
      }
      .hud-tab-item.active .hud-tab-sub {
        color: var(--hud-text-active-tab-sub);
      }
      /* Active tab short white underline bar */
      .hud-tab-indicator {
        display: none;
        width: 22px;
        height: 2.5px;
        background: var(--hud-tab-underline);
        border-radius: 2px;
        margin-top: 3px;
        box-shadow: var(--hud-shadow-underline);
      }
      .hud-tab-item.active .hud-tab-indicator {
        display: block;
      }

      .hud-top-right-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-left: 2px;
      }
      .hud-tool-btn {
        background: transparent;
        border: none;
        color: var(--hud-text-muted);
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        transition: all 0.15s;
        flex-shrink: 0;
      }
      .hud-tool-btn:hover {
        background: var(--hud-border);
        color: var(--hud-text-values);
      }

      /* Sliding Collapse State */
      .hud-container.slider-dragging .hud-pill,
      .hud-container.slider-dragging .hud-top-bar,
      .hud-container.slider-dragging .hud-row-header,
      .hud-container.slider-dragging .hud-divider-label,
      .hud-container.slider-dragging .hud-section-label,
      .hud-container.slider-dragging .hud-pip-row,
      .hud-container.slider-dragging .hud-speed-section,
      .hud-container.slider-dragging .hud-aspect-header,
      .hud-container.slider-dragging .hud-aspect-grid,
      .hud-container.slider-dragging .hud-profiles-list,
      .hud-container.slider-dragging .hud-card-action,
      .hud-container.slider-dragging .hud-slider-row:not(.is-active-sliding) {
        display: none !important;
      }

      .hud-container.slider-dragging .hud-panel-wrap {
        width: 440px !important;
        max-width: 90vw !important;
        border-radius: 18px !important;
        background: var(--hud-surface-sliding) !important;
        border: 1px solid var(--hud-control-selected-fill) !important;
        box-shadow: var(--hud-shadow-pill-hover) !important;
        padding: 0 !important;
        margin: 0 !important;
        overflow: hidden !important;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
      }

      .hud-container.slider-dragging .hud-body-pane {
        padding: 8px 18px !important;
        gap: 0 !important;
        display: flex !important;
        max-height: none !important;
        overflow: visible !important;
      }

      .hud-container.slider-dragging .hud-slider-row.is-active-sliding {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        width: 100% !important;
        gap: 16px !important;
        margin: 0 !important;
      }

      .hud-container.slider-dragging .hud-slider-row.is-active-sliding .hud-slider-label {
        font-size: 13.5px !important;
        font-weight: 500 !important;
        color: var(--hud-text-label-row) !important;
        white-space: nowrap !important;
        min-width: 110px !important;
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
      }

      .hud-container.slider-dragging .hud-slider-row.is-active-sliding .hud-slider-label .hud-info-icon,
      .hud-container.slider-dragging .hud-slider-row.is-active-sliding .hud-slider-label .hud-badge-ext,
      .hud-container.slider-dragging .hud-slider-row.is-active-sliding .hud-slider-label .hud-badge-pro {
        display: none !important;
      }

      .hud-container.slider-dragging .hud-slider-row.is-active-sliding .hud-slider-field {
        flex: 1 !important;
        display: flex !important;
        align-items: center !important;
        gap: 14px !important;
      }

      .hud-container.slider-dragging .hud-slider-row.is-active-sliding .hud-range {
        flex: 1 !important;
        height: 4px !important;
      }

      .hud-container.slider-dragging .hud-slider-row.is-active-sliding .hud-range-val {
        font-size: 13.5px !important;
        font-weight: 700 !important;
        color: var(--hud-text-values) !important;
        min-width: 32px !important;
        text-align: right !important;
      }

      /* MAIN BODY PANEL (REFERENCE) */
      .hud-panel-wrap {
        display: none;
        flex-direction: column;
        width: 530px;
        max-width: 95vw;
        border-radius: var(--hud-radius-panel);
        background: var(--hud-surface-panel);
        border: 1px solid var(--hud-border);
        box-shadow: var(--hud-shadow-panel);
        backdrop-filter: var(--hud-backdrop-filter);
        -webkit-backdrop-filter: var(--hud-backdrop-filter);
        overflow: hidden;
        animation: hud-pop-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .hud-container.open .hud-panel-wrap {
        display: flex;
      }

      /* Dropdown Panel Body */
      .hud-body-pane {
        padding: 20px 24px;
        display: none;
        flex-direction: column;
        gap: 14px;
        max-height: 490px;
        overflow-y: auto;
      }
      .hud-body-pane.active {
        display: flex;
      }
      .hud-body-pane::-webkit-scrollbar {
        width: 5px;
      }
      .hud-body-pane::-webkit-scrollbar-thumb {
        background: var(--hud-scrollbar-thumb);
        border-radius: 4px;
      }

      /* Section Header (Title + Toggle + Badge + Reset) */
      .hud-row-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 2px;
      }
      .hud-header-left {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .hud-pane-title {
        font-size: 15px;
        font-weight: 700;
        color: var(--hud-text-primary);
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .hud-info-icon {
        font-size: 12px;
        color: var(--hud-info-icon);
        cursor: help;
        transition: color 0.15s;
      }
      .hud-info-icon:hover { color: var(--hud-info-icon-hover); }

      .hud-badge-site {
        background: var(--hud-control-idle-fill);
        border: 1px solid var(--hud-border);
        color: var(--hud-text-chip);
        font-size: 11px;
        font-weight: 700;
        padding: 4px 10px;
        border-radius: var(--hud-radius-btn);
        display: flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        transition: all 0.15s;
      }
      .hud-badge-site:hover {
        background: var(--hud-control-hover-fill);
        color: var(--hud-text-values);
      }

      .hud-badge-action {
        background: var(--hud-control-idle-fill);
        border: 1px solid var(--hud-border);
        color: var(--hud-text-chip);
        font-size: 11px;
        font-weight: 700;
        padding: 5px 12px;
        border-radius: var(--hud-radius-btn);
        cursor: pointer;
        transition: all 0.18s;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .hud-badge-action:hover {
        background: var(--hud-control-hover-fill);
        border-color: var(--hud-border-hover);
        color: var(--hud-text-values);
      }
      .hud-badge-action.active {
        background: var(--hud-control-selected-fill);
        border-color: var(--hud-control-selected-border);
        color: var(--hud-text-values);
        box-shadow: var(--hud-shadow-glow-accent);
      }

      .hud-btn-reset {
        background: var(--hud-control-idle-fill);
        border: 1px solid var(--hud-border);
        color: var(--hud-text-muted);
        width: 28px;
        height: 28px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        transition: all 0.15s;
      }
      .hud-btn-reset:hover {
        background: var(--hud-control-hover-fill);
        color: var(--hud-text-values);
        transform: rotate(-45deg);
      }

      /* iOS Toggle Switch in REFERENCE Language */
      .hud-toggle-wrap {
        position: relative;
        display: inline-block;
        width: 40px;
        height: 22px;
        flex-shrink: 0;
      }
      .hud-toggle-wrap input { opacity: 0; width: 0; height: 0; }
      .hud-toggle-track {
        position: absolute;
        cursor: pointer;
        top: 0; left: 0; right: 0; bottom: 0;
        background: var(--hud-toggle-off-track);
        border-radius: 22px;
        transition: 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        border: 1px solid var(--hud-border);
      }
      .hud-toggle-track:before {
        position: absolute;
        content: "";
        height: 16px;
        width: 16px;
        left: 2px;
        bottom: 2px;
        background-color: var(--hud-toggle-knob);
        border-radius: 50%;
        transition: 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        box-shadow: var(--hud-shadow-toggle-knob);
      }
      .hud-toggle-wrap input:checked + .hud-toggle-track {
        background: var(--hud-toggle-on-track);
        border-color: var(--hud-toggle-on-track);
      }
      .hud-toggle-wrap input:checked + .hud-toggle-track:before {
        transform: translateX(18px);
      }

      /* Control Sliders in REFERENCE Language */
      .hud-slider-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      .hud-slider-label {
        font-size: 13.5px;
        font-weight: 500;
        color: var(--hud-text-label-row);
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 125px;
      }
      .hud-slider-field {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .hud-range {
        flex: 1;
        -webkit-appearance: none;
        height: 4px;
        border-radius: 2px;
        background: var(--hud-slider-rail);
        outline: none;
        cursor: pointer;
      }
      .hud-range::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 15px;
        height: 15px;
        border-radius: 50%;
        background: var(--hud-slider-thumb);
        cursor: pointer;
        box-shadow: var(--hud-shadow-thumb);
        transition: transform 0.12s, box-shadow 0.12s;
      }
      .hud-range::-webkit-slider-thumb:hover {
        transform: scale(1.25);
        box-shadow: var(--hud-shadow-thumb-hover);
      }
      .hud-range-val {
        font-size: 13px;
        font-weight: 700;
        color: var(--hud-text-values);
        min-width: 32px;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      .hud-badge-ext {
        background: var(--hud-badge-fill);
        border: 1px solid var(--hud-badge-border);
        color: var(--hud-badge-text);
        font-size: 9px;
        font-weight: 700;
        padding: 1px 5px;
        border-radius: 4px;
      }

      /* Section Divider Labels (Hairline rule matching REFERENCE) */
      .hud-section-label,
      .hud-divider-label {
        display: flex;
        align-items: center;
        gap: 12px;
        color: var(--hud-text-section);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        margin: 8px 0 4px 0;
      }
      .hud-section-label:after,
      .hud-divider-label:after {
        content: "";
        flex: 1;
        height: 1px;
        background: var(--hud-divider-line);
      }

      /* PROFILES TAB STYLES */
      .hud-profiles-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .hud-profile-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        border-radius: 14px;
        background: var(--hud-surface-card);
        border: 1px solid var(--hud-border);
        cursor: pointer;
        transition: all 0.16s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .hud-profile-item:hover {
        background: var(--hud-surface-card-hover);
        border-color: var(--hud-border-hover);
        transform: translateX(2px);
      }
      .hud-profile-item.active {
        background: var(--hud-control-selected-fill);
        border-color: var(--hud-control-selected-border);
        box-shadow: var(--hud-shadow-glow-accent);
      }
      .hud-profile-left {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .hud-profile-icon {
        font-size: 16px;
        width: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--hud-text-label-row);
      }
      .hud-profile-name {
        font-size: 13.5px;
        font-weight: 700;
        color: var(--hud-text-primary);
      }
      .hud-profile-desc {
        font-size: 11px;
        color: var(--hud-text-muted);
      }
      .hud-profile-tags {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--hud-text-secondary);
        font-size: 12.5px;
      }

      /* ZOOM TAB STYLES */
      .hud-zoom-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
      }
      .hud-zoom-pill-btn {
        background: var(--hud-control-idle-fill);
        border: 1px solid var(--hud-border);
        border-radius: var(--hud-radius-btn);
        padding: 7px 14px;
        font-size: 12px;
        font-weight: 600;
        color: var(--hud-text-label-row);
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.18s;
      }
      .hud-zoom-pill-btn:hover {
        background: var(--hud-control-hover-fill);
        border-color: var(--hud-border-hover);
        color: var(--hud-text-values);
      }
      .hud-zoom-pill-btn.active {
        background: var(--hud-control-selected-fill);
        border-color: var(--hud-control-selected-border);
        color: var(--hud-text-values);
        box-shadow: var(--hud-shadow-glow-accent);
      }
      .hud-aspect-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 10px;
        margin-bottom: 2px;
      }
      .hud-aspect-title {
        color: var(--hud-text-section);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.8px;
        text-transform: uppercase;
      }
      .hud-aspect-meta {
        font-size: 11px;
        color: var(--hud-text-secondary);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .hud-aspect-grid {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .hud-aspect-btn {
        flex: 1;
        text-align: center;
        background: var(--hud-control-segmented-fill);
        border: 1px solid var(--hud-border);
        border-radius: var(--hud-radius-btn);
        padding: 8px 0;
        font-size: 12px;
        font-weight: 600;
        color: var(--hud-text-secondary);
        cursor: pointer;
        transition: all 0.18s;
      }
      .hud-aspect-btn:hover {
        background: var(--hud-control-hover-fill);
        border-color: var(--hud-border-hover);
        color: var(--hud-text-values);
      }
      .hud-aspect-btn.active {
        background: var(--hud-control-selected-fill);
        border: 1px solid var(--hud-control-selected-border);
        color: var(--hud-text-values);
        font-weight: 700;
        box-shadow: var(--hud-shadow-glow-accent);
      }

      /* CAPTURE TAB ACTION CARDS (REFERENCE) */
      .hud-card-action {
        background: var(--hud-surface-card);
        border: 1px solid var(--hud-border);
        border-radius: var(--hud-radius-card);
        padding: 14px 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .hud-card-action:hover {
        background: var(--hud-surface-card-hover);
        border-color: var(--hud-border-hover);
        transform: translateY(-1px);
      }
      .hud-card-left {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .hud-card-ico {
        width: 42px;
        height: 42px;
        border-radius: var(--hud-radius-btn);
        background: var(--hud-control-tile-fill);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        color: var(--hud-text-label-row);
        flex-shrink: 0;
      }
      .hud-card-title {
        font-size: 14px;
        font-weight: 700;
        color: var(--hud-text-primary);
      }
      .hud-card-desc {
        font-size: 11.5px;
        color: var(--hud-text-secondary);
        margin-top: 2px;
        line-height: 1.4;
      }
      .hud-card-btn {
        background: var(--hud-primary);
        color: var(--hud-text-values);
        border: none;
        padding: 8px 18px;
        border-radius: var(--hud-radius-btn);
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.18s ease;
        box-shadow: var(--hud-shadow-btn-primary);
        white-space: nowrap;
      }
      .hud-card-btn:hover {
        background: var(--hud-primary-hover);
        transform: translateY(-1px);
        box-shadow: var(--hud-shadow-btn-primary-hover);
      }
      .hud-card-btn-rec {
        background: var(--hud-record);
        box-shadow: var(--hud-shadow-btn-record);
      }
      .hud-card-btn-rec:hover {
        background: var(--hud-record-hover);
        box-shadow: var(--hud-shadow-btn-record-hover);
      }

      /* Picture in Picture row */
      .hud-pip-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 2px;
      }
      .hud-pip-title {
        font-size: 13.5px;
        font-weight: 600;
        color: var(--hud-text-label-card);
      }
      .hud-btn-ghost {
        background: var(--hud-control-ghost-fill);
        border: 1px solid var(--hud-border);
        border-radius: var(--hud-radius-btn);
        padding: 8px 18px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--hud-text-label-card);
        cursor: pointer;
        transition: all 0.18s ease;
      }
      .hud-btn-ghost:hover {
        background: var(--hud-control-hover-fill);
        border-color: var(--hud-border-hover);
        color: var(--hud-text-values);
      }

      /* Playback Speed section with 5 equal-width buttons + full-width 2.0x on row 2 */
      .hud-speed-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 4px 2px;
      }
      .hud-speed-title {
        font-size: 13.5px;
        font-weight: 600;
        color: var(--hud-text-label-card);
      }
      .hud-speed-grid {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 8px;
        width: 100%;
      }
      .hud-speed-btn {
        background: var(--hud-control-idle-fill);
        border: 1px solid var(--hud-border);
        border-radius: var(--hud-radius-btn);
        color: var(--hud-text-label-card);
        font-size: 12.5px;
        font-weight: 600;
        padding: 8px 0;
        text-align: center;
        cursor: pointer;
        transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .hud-speed-btn:hover {
        background: var(--hud-control-hover-fill);
        border-color: var(--hud-border-hover);
        color: var(--hud-text-values);
      }
      .hud-speed-btn.active {
        background: var(--hud-control-selected-fill);
        border: 1px solid var(--hud-control-selected-border);
        color: var(--hud-text-values);
        box-shadow: var(--hud-shadow-glow-accent);
      }
      .hud-speed-btn-full {
        width: 100%;
        margin-top: 0;
      }

      @keyframes hud-pulse-red {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.6; transform: scale(0.96); }
      }
      @keyframes hud-pop-in {
        from { opacity: 0; transform: translateY(-8px) scale(0.97); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
    `;
    this.shadow.appendChild(style);

    const container = document.createElement('div');
    container.className = 'hud-container';
    container.innerHTML = `
      <!-- COLLAPSED PILL (RESTYLED IN TARGET UI B TOKENS) -->
      <div class="hud-pill" id="hud-pill">
        <div class="hud-pill-bg"></div>
        <div class="hud-pill-icon" title="Smart Video Suite">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2.5"></rect>
            <path d="m2 8 20 0"></path>
            <path d="m6 4 2 4"></path>
            <path d="m11 4 2 4"></path>
            <path d="m16 4 2 4"></path>
            <path d="m7 14 1 2 2 1-2 1-1 2-1-2-2-1 2-1z" fill="currentColor" stroke="none"></path>
            <path d="m14 12 .5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5z" fill="currentColor" stroke="none"></path>
          </svg>
        </div>
        <div class="hud-pill-divider"></div>
        <div class="hud-pill-actions">
          <button class="hud-pill-btn-shot" id="pill-btn-shot" title="Capture Screenshot" aria-label="Capture Screenshot">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
              <circle cx="12" cy="13" r="4"></circle>
            </svg>
          </button>
          <button class="hud-pill-btn-rec" id="pill-btn-rec" title="Record Video" aria-label="Record Video">
            <span class="hud-rec-dot"></span>
          </button>
          <button class="hud-pill-btn-more" id="pill-btn-more" title="More Video Options" aria-label="More Video Options">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2 2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
        </div>
      </div>

      <!-- FULL GLASSMORPHIC TOP BAR (TARGET UI B) -->
      <div class="hud-top-bar" id="hud-top-bar">
        <!-- Magic Wand Profiles Capsule on Left -->
        <button class="hud-bar-profiles-btn" id="hud-bar-profiles" data-tab="profiles" title="Visual Profiles">
          <span>🪄</span>
          <span class="hud-profile-wand-label" id="hud-profile-wand-label" style="display:none;">Lift</span>
        </button>

        <!-- Navigation Tabs: Capture (Active by default in UI B), Zoom, Picture, Ambience -->
        <button class="hud-tab-item active" data-tab="capture">
          <span class="hud-tab-title">📸 Capture</span>
          <span class="hud-tab-sub" id="tab-sub-cap">Shot & Rec</span>
          <div class="hud-tab-indicator"></div>
        </button>

        <button class="hud-tab-item" data-tab="zoom">
          <span class="hud-tab-title">⛶ Zoom</span>
          <span class="hud-tab-sub" id="tab-sub-zoom">Off</span>
          <div class="hud-tab-indicator"></div>
        </button>

        <button class="hud-tab-item" data-tab="picture">
          <span class="hud-tab-title">◩ Picture</span>
          <span class="hud-tab-sub" id="tab-sub-pic">Neutral</span>
          <div class="hud-tab-indicator"></div>
        </button>

        <button class="hud-tab-item" data-tab="ambience">
          <span class="hud-tab-title">🔆 Ambience</span>
          <span class="hud-tab-sub" id="tab-sub-amb">Off</span>
          <div class="hud-tab-indicator"></div>
        </button>

        <div class="hud-top-right-actions">
          <button class="hud-tool-btn" id="btn-top-settings" title="Settings">⚙</button>
          <button class="hud-tool-btn" id="hud-close-btn" title="Close Panel">✕</button>
        </div>
      </div>

      <!-- FULL CONTROLLER HUD PANEL WRAPPER -->
      <div class="hud-panel-wrap" id="hud-panel-wrap">
        <!-- TAB 0: PROFILES (Visual presets drawer) -->
        <div class="hud-body-pane" id="pane-profiles">
          <div class="hud-row-header">
            <div class="hud-header-left">
              <span class="hud-pane-title">🪄 Visual Profiles <span class="hud-info-icon" title="One-click visual mastering profiles">ⓘ</span></span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <button class="hud-badge-site" id="badge-site-profiles">📍 ON THIS SITE</button>
              <button class="hud-btn-reset" id="btn-reset-profiles" title="Reset Profile">↺</button>
            </div>
          </div>

          <div class="hud-profiles-list">
            <div class="hud-profile-item" data-profile="lift">
              <div class="hud-profile-left">
                <div class="hud-profile-icon">🪄</div>
                <div class="hud-profile-info">
                  <div class="hud-profile-name">Lift</div>
                  <div class="hud-profile-desc">A small step up, the picture still itself</div>
                </div>
              </div>
              <div class="hud-profile-tags">
                <span title="Lighting">☼</span>
                <span title="Texture">◓</span>
                <span title="Contrast">◑</span>
              </div>
            </div>

            <div class="hud-profile-item" data-profile="movie">
              <div class="hud-profile-left">
                <div class="hud-profile-icon">🎞️</div>
                <div class="hud-profile-info">
                  <div class="hud-profile-name">Movie</div>
                  <div class="hud-profile-desc">Range and colour, motion left alone</div>
                </div>
              </div>
              <div class="hud-profile-tags">
                <span title="Grain">◒</span>
                <span title="Contrast">◑</span>
                <span title="Vibrance">🎨</span>
                <span title="Shadows">🌘</span>
                <span title="Lighting">☼</span>
                <span title="Aspect">⛶</span>
              </div>
            </div>

            <div class="hud-profile-item" data-profile="game">
              <div class="hud-profile-left">
                <div class="hud-profile-icon">🎮</div>
                <div class="hud-profile-info">
                  <div class="hud-profile-name">Game</div>
                  <div class="hud-profile-desc">Sharp and bright, the glow on the sound</div>
                </div>
              </div>
              <div class="hud-profile-tags">
                <span title="Sharpness">◒</span>
                <span title="Contrast">◑</span>
                <span title="Vibrance">🎨</span>
                <span title="Shadows">🌘</span>
                <span title="Lighting">☼</span>
                <span title="Fluidity">⚡</span>
                <span title="Audio Pulse">🔊</span>
              </div>
            </div>

            <div class="hud-profile-item" data-profile="music">
              <div class="hud-profile-left">
                <div class="hud-profile-icon">🎵</div>
                <div class="hud-profile-info">
                  <div class="hud-profile-name">Music</div>
                  <div class="hud-profile-desc">Colour up, the glow on the beat</div>
                </div>
              </div>
              <div class="hud-profile-tags">
                <span title="Contrast">◑</span>
                <span title="Vibrance">🎨</span>
                <span title="Shadows">🌘</span>
                <span title="Lighting">☼</span>
                <span title="Ambience">🔆</span>
              </div>
            </div>

            <div class="hud-profile-item" data-profile="sport">
              <div class="hud-profile-left">
                <div class="hud-profile-icon">🏀</div>
                <div class="hud-profile-info">
                  <div class="hud-profile-name">Sport</div>
                  <div class="hud-profile-desc">Smooth motion, crisp detail</div>
                </div>
              </div>
              <div class="hud-profile-tags">
                <span title="HDR">☼</span>
                <span title="Contrast">◑</span>
                <span title="Vibrance">🎨</span>
                <span title="Shadows">🌘</span>
                <span title="Lighting">☼</span>
                <span title="Motion">⚡</span>
              </div>
            </div>

            <div class="hud-profile-item active" data-profile="none">
              <div class="hud-profile-left">
                <div class="hud-profile-icon">⊘</div>
                <div class="hud-profile-info">
                  <div class="hud-profile-name">None</div>
                  <div class="hud-profile-desc">Raw video untouched</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 1: CAPTURE (Screenshot, Record, PiP, Speed - EXACT TARGET UI B SCREENSHOT 3) -->
        <div class="hud-body-pane active" id="pane-capture">
          <div class="hud-card-action" id="card-take-screenshot">
            <div class="hud-card-left">
              <div class="hud-card-ico">📸</div>
              <div>
                <div class="hud-card-title">Capture Video Frame</div>
                <div class="hud-card-desc">Saves to gallery, auto-downloads & copies to clipboard</div>
              </div>
            </div>
            <button class="hud-card-btn" id="btn-card-shot">Capture (PNG)</button>
          </div>

          <div class="hud-card-action" id="card-toggle-record">
            <div class="hud-card-left">
              <div class="hud-card-ico" id="rec-card-icon" style="color:var(--hud-record);">⏺</div>
              <div>
                <div class="hud-card-title" id="rec-card-title">Record Video</div>
                <div class="hud-card-desc" id="rec-card-desc">Record playing stream directly without limits</div>
              </div>
            </div>
            <button class="hud-card-btn hud-card-btn-rec" id="rec-card-btn">Record</button>
          </div>

          <div class="hud-section-label">PLAYBACK & VIDEO UTILITIES</div>

          <div class="hud-pip-row">
            <div class="hud-pip-title">Picture-in-Picture</div>
            <button class="hud-btn-ghost" id="btn-toggle-pip">Toggle PiP</button>
          </div>

          <div class="hud-speed-section">
            <div class="hud-speed-title">Playback Speed</div>
            <div class="hud-speed-grid">
              <button class="hud-speed-btn" data-speed="0.5">0.5x</button>
              <button class="hud-speed-btn" data-speed="0.75">0.75x</button>
              <button class="hud-speed-btn active" data-speed="1.0">1.0x</button>
              <button class="hud-speed-btn" data-speed="1.25">1.25x</button>
              <button class="hud-speed-btn" data-speed="1.5">1.5x</button>
            </div>
            <button class="hud-speed-btn hud-speed-btn-full" data-speed="2.0">2.0x</button>
          </div>
        </div>

        <!-- TAB 2: ZOOM (RESTYLED IN TARGET UI B LANGUAGE) -->
        <div class="hud-body-pane" id="pane-zoom">
          <div class="hud-row-header">
            <div class="hud-header-left">
              <span class="hud-pane-title">⛶ Zoom</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <button class="hud-badge-action" id="btn-zoom-pan">⤢ PAN</button>
              <button class="hud-badge-action" id="btn-zoom-reapply">🔄 RE-APPLY OPTIONS</button>
              <button class="hud-btn-reset" id="btn-reset-zoom" title="Reset Zoom">↺</button>
            </div>
          </div>

          <!-- Row 1: Zoom to Fill button pill + Slider + x1.00 -->
          <div class="hud-zoom-row">
            <button class="hud-zoom-pill-btn active" id="btn-action-zoom-fill">
              ⛶ Zoom to Fill
            </button>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-zoom-scale" min="100" max="250" value="100">
              <span class="hud-range-val" id="val-zoom-scale">×1.00</span>
            </div>
          </div>

          <!-- Row 2: Elastic Stretch button pill + Slider + 0% -->
          <div class="hud-zoom-row">
            <button class="hud-zoom-pill-btn" id="btn-action-elastic-stretch">
              ⯌ Auto Stretch
            </button>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-elastic-stretch" min="0" max="100" value="0">
              <span class="hud-range-val" id="val-elastic-stretch">0%</span>
            </div>
          </div>

          <!-- Row 3: Remove blackbars automatically toggle -->
          <div class="hud-zoom-row" style="justify-content:space-between; margin-top:2px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:13px; font-weight:600; color:var(--hud-text-label-row); display:flex; align-items:center; gap:6px;">
                ⛶ Remove blackbars automatically
              </span>
              <span class="hud-info-icon" title="Intelligently detects and crops letterbox/pillarbox borders">ⓘ</span>
            </div>
            <label class="hud-toggle-wrap">
              <input type="checkbox" id="toggle-remove-blackbars">
              <span class="hud-toggle-track"></span>
            </label>
          </div>

          <!-- Pan Coordinates (revealed when Pan is active) -->
          <div id="hud-pan-controls" style="display:none; flex-direction:column; gap:10px; padding:12px 14px; background:var(--hud-surface-card); border-radius:var(--hud-radius-card); border:1px solid var(--hud-border);">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:2px;">
              <span style="font-size:12px; font-weight:700; color:var(--hud-text-label-card); letter-spacing:0.5px;">PAN POSITION</span>
              <button class="hud-badge-action" id="btn-reset-pan" title="Reset Pan coordinates to center (0%, 0%)" style="padding:4px 10px; font-size:11px; cursor:pointer;">↺ RESET PAN</button>
            </div>
            <div class="hud-slider-row">
              <div class="hud-slider-label">↔ Pan X</div>
              <div class="hud-slider-field">
                <input type="range" class="hud-range" id="slider-pan-x" min="-50" max="50" value="0">
                <span class="hud-range-val" id="val-pan-x">0%</span>
              </div>
            </div>
            <div class="hud-slider-row">
              <div class="hud-slider-label">↕ Pan Y</div>
              <div class="hud-slider-field">
                <input type="range" class="hud-range" id="slider-pan-y" min="-50" max="50" value="0">
                <span class="hud-range-val" id="val-pan-y">0%</span>
              </div>
            </div>
          </div>

          <!-- Aspect Ratios Section -->
          <div class="hud-aspect-header">
            <span class="hud-aspect-title">CROP TO ASPECT RATIO</span>
            <span class="hud-aspect-meta" id="stat-aspect-meta">Video: 16:9 · 1920×1080</span>
          </div>
          <div class="hud-aspect-grid">
            <button class="hud-aspect-btn" data-ratio="4:3">4:3</button>
            <button class="hud-aspect-btn" data-ratio="16:10">16:10</button>
            <button class="hud-aspect-btn active" data-ratio="16:9">16:9</button>
            <button class="hud-aspect-btn" data-ratio="18:9">18:9</button>
            <button class="hud-aspect-btn" data-ratio="21:9">21:9</button>
            <button class="hud-aspect-btn" data-ratio="32:9">32:9</button>
          </div>
        </div>

        <!-- TAB 3: PICTURE (RESTYLED IN TARGET UI B LANGUAGE) -->
        <div class="hud-body-pane" id="pane-picture">
          <div class="hud-row-header">
            <div class="hud-header-left">
              <span class="hud-pane-title">◩ Picture</span>
              <label class="hud-toggle-wrap">
                <input type="checkbox" id="toggle-picture">
                <span class="hud-toggle-track"></span>
              </label>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <button class="hud-badge-site" id="badge-site-picture">📍 ON THIS SITE</button>
              <button class="hud-btn-reset" id="btn-reset-picture" title="Reset Filters">↺</button>
            </div>
          </div>

          <div class="hud-slider-row">
            <div class="hud-slider-label">☼ Lighting</div>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-lighting" min="-100" max="100" value="0">
              <span class="hud-range-val" id="val-lighting">0</span>
            </div>
          </div>

          <div class="hud-slider-row">
            <div class="hud-slider-label">◓ Shadows</div>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-shadows" min="-100" max="100" value="0">
              <span class="hud-range-val" id="val-shadows">0</span>
            </div>
          </div>

          <div class="hud-slider-row">
            <div class="hud-slider-label">◑ Contrast</div>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-contrast" min="-100" max="100" value="0">
              <span class="hud-range-val" id="val-contrast">0</span>
            </div>
          </div>

          <div class="hud-section-label">REMASTER</div>

          <div class="hud-slider-row">
            <div class="hud-slider-label">
              ◒ Sharpness <span class="hud-info-icon" title="Enhances texture micro-contrast">ⓘ</span>
            </div>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-sharpness" min="0" max="100" value="0">
              <span class="hud-range-val" id="val-sharpness">0</span>
            </div>
          </div>

          <div class="hud-slider-row">
            <div class="hud-slider-label">
              🎨 Vibrance <span class="hud-info-icon" title="Intelligently enriches muted tones without clipping">ⓘ</span>
            </div>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-vibrance" min="0" max="100" value="0">
              <span class="hud-range-val" id="val-vibrance">0</span>
            </div>
          </div>

          <div class="hud-slider-row">
            <div class="hud-slider-label">
              ☼ HDR Boost <span class="hud-info-icon" title="Dynamic range highlight boost">ⓘ</span>
              <span class="hud-badge-ext">EXT</span>
            </div>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-hdr" min="0" max="100" value="0">
              <span class="hud-range-val" id="val-hdr">0</span>
            </div>
          </div>
        </div>

        <!-- TAB 4: AMBIENCE (RESTYLED IN TARGET UI B LANGUAGE) -->
        <div class="hud-body-pane" id="pane-ambience">
          <div class="hud-row-header">
            <div class="hud-header-left">
              <span class="hud-pane-title">🔆 Ambience</span>
              <label class="hud-toggle-wrap">
                <input type="checkbox" id="toggle-ambience">
                <span class="hud-toggle-track"></span>
              </label>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              <button class="hud-badge-site" id="badge-site-ambience">📍 ON THIS SITE</button>
              <button class="hud-btn-reset" id="btn-reset-ambience" title="Reset Ambience">↺</button>
            </div>
          </div>

          <div class="hud-slider-row">
            <div class="hud-slider-label">🪄 Spread</div>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-amb-spread" min="0" max="100" value="100">
              <span class="hud-range-val" id="val-amb-spread">100</span>
            </div>
          </div>

          <div class="hud-slider-row">
            <div class="hud-slider-label">💧 Intensity</div>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-amb-intensity" min="0" max="100" value="100">
              <span class="hud-range-val" id="val-amb-intensity">100</span>
            </div>
          </div>

          <div class="hud-slider-row">
            <div class="hud-slider-label">🫧 Blur</div>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-amb-blur" min="10" max="100" value="45">
              <span class="hud-range-val" id="val-amb-blur">45</span>
            </div>
          </div>

          <div class="hud-slider-row">
            <div class="hud-slider-label">⏱ Sync Rate</div>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-amb-sync" min="20" max="100" value="90">
              <span class="hud-range-val" id="val-amb-sync">90</span>
            </div>
          </div>

          <div class="hud-slider-row">
            <div class="hud-slider-label">🔊 Audio Pulse</div>
            <div class="hud-slider-field">
              <input type="range" class="hud-range" id="slider-amb-audio" min="0" max="100" value="0">
              <span class="hud-range-val" id="val-amb-audio">0</span>
            </div>
          </div>
        </div>

      </div>
    `;

    this.shadow.appendChild(container);
    (document.fullscreenElement || document.body || document.documentElement)?.appendChild(this.hostEl);

    try {
      this.bindEvents();
      this.syncUIFromSettings();
    } catch (e) {
      console.warn('SmartVideoHUD init error:', e);
    }
  },

  bindEvents() {
    const s = this.shadow;
    if (!s) return;
    const container = s.querySelector('.hud-container');
    const pill = s.getElementById('hud-pill');
    if (!container || !pill) return;

    // Keep visible while hovering over pill or panel
    container.addEventListener('mouseenter', () => {
      this.isPillHovered = true;
      clearTimeout(this.panelCloseTimer);
      clearTimeout(this.hideTimer);
      clearTimeout(this.mouseInactivityTimer);
      container.classList.add('visible', 'mouse-close', 'pill-hovered');
      container.classList.remove('near-button', 'faded');
    });

    container.addEventListener('mouseleave', () => {
      this.isPillHovered = false;
      container.classList.remove('pill-hovered');
      clearTimeout(this.panelCloseTimer);
      this.panelCloseTimer = setTimeout(() => {
        if (this.isOpen) {
          this.closePanel();
        }
      }, 300);
    });

    // Pill direct actions
    s.getElementById('pill-btn-shot')?.addEventListener('click', (e) => {
      e.stopPropagation();
      captureVideoFrame(this.activeVideo);
    });

    s.getElementById('pill-btn-rec')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleVideoRecording(this.activeVideo);
    });

    s.getElementById('pill-btn-more')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePanel();
    });

    // Clicking anywhere on the pill opens the full panel
    pill.addEventListener('click', (e) => {
      if (e.target.closest('#pill-btn-shot') || e.target.closest('#pill-btn-rec') || e.target.closest('#pill-btn-more')) return;
      this.togglePanel();
    });

    s.getElementById('hud-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePanel();
    });

    s.getElementById('btn-top-settings')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (chrome.runtime && chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        window.open(chrome.runtime.getURL('settings.html'));
      }
    });

    // =========================================================
    // TAB HOVER SWITCHING & ZOOM CLICK TO AUTO-FILL
    // =========================================================
    s.querySelectorAll('.hud-tab-item').forEach(btn => {
      btn.addEventListener('mouseenter', () => {
        const tab = btn.dataset.tab;
        this.openTab(tab);
        if (this.activeVideo) { this.updatePlaybackSpeedUI(this.activeVideo.playbackRate); }
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tab = btn.dataset.tab;
        if (tab === 'zoom') {
          // Clicking on zoom auto-zooms to available space or toggles off
          this.autoZoomToAvailableSpace();
        } else if (tab === 'ambience') {
          // Clicking on ambience directly toggles ambient lighting in empty video screen
          this.settings.ambienceEnabled = !this.settings.ambienceEnabled;
          this.applyAmbience();
          this.updateSubtexts();
          this.syncUIFromSettings();
          this.saveSettings();
          showToast(this.settings.ambienceEnabled ? "Ambience lighting enabled 🔆" : "Ambience disabled", "info");
        } else {
          this.openTab(tab);
        }
      });
    });

    // Magic wand profiles capsule button (Images 1 & 2)
    const wandBtn = s.getElementById('hud-bar-profiles');
    if (wandBtn) {
      wandBtn.addEventListener('mouseenter', () => {
        this.openTab('profiles');
      });
      wandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Clicking when active profile is set toggles it back to none
        if (this.settings.activeProfile && this.settings.activeProfile !== 'none') {
          this.applyProfile('none');
        } else {
          this.openTab('profiles');
        }
      });
    }

    // Profiles List Selection (Images 1 & 2): clicking active profile again makes it none; auto-closes
    s.querySelectorAll('.hud-profile-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const profKey = item.dataset.profile;
        if (this.settings.activeProfile === profKey && profKey !== 'none') {
          this.applyProfile('none');
        } else {
          this.applyProfile(profKey);
        }
        // Auto-close panel after profile selection so video is unobstructed
        setTimeout(() => {
          this.closePanel();
        }, 220);
      });
    });

    s.getElementById('btn-reset-profiles').addEventListener('click', (e) => {
      e.stopPropagation();
      this.applyProfile('none');
    });

    // Capture tab actions
    s.getElementById('card-take-screenshot').addEventListener('click', () => {
      captureVideoFrame(this.activeVideo);
    });

    s.getElementById('card-toggle-record').addEventListener('click', () => {
      toggleVideoRecording(this.activeVideo);
    });

    s.getElementById('btn-toggle-pip').addEventListener('click', () => {
      if (this.activeVideo) {
        if (document.pictureInPictureElement) {
          document.exitPictureInPicture().catch(() => {});
        } else if (typeof this.activeVideo.requestPictureInPicture === 'function') {
          this.activeVideo.requestPictureInPicture().catch(() => {});
        }
      }
    });

    s.querySelectorAll('[data-speed]').forEach(btn => {
      btn.addEventListener('click', () => {
        s.querySelectorAll('[data-speed]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const speed = parseFloat(btn.dataset.speed);
        if (this.activeVideo) this.activeVideo.playbackRate = speed;
        showToast(`Playback speed: ${speed}x`, 'info');
      });
    });

    // Zoom Tab Controls (Image 3)
    s.getElementById('btn-action-zoom-fill').addEventListener('click', (e) => {
      e.stopPropagation();
      this.autoZoomToAvailableSpace();
    });

    // Auto zoom disables on touching the zoom line (enters manual mode)
    const zoomScale = s.getElementById('slider-zoom-scale');
    const onZoomLineTouch = () => {
      if (this.settings.autoZoomToFill) {
        this.settings.autoZoomToFill = false;
        const fillBtn = s.getElementById('btn-action-zoom-fill');
        if (fillBtn) fillBtn.classList.remove('active');
        showToast("Auto-zoom disabled (Manual Mode)", "info");
      }
    };
    zoomScale.addEventListener('pointerdown', onZoomLineTouch);
    zoomScale.addEventListener('mousedown', onZoomLineTouch);
    zoomScale.addEventListener('touchstart', onZoomLineTouch);

    zoomScale.addEventListener('input', () => {
      onZoomLineTouch();
      this.settings.zoomScale = parseInt(zoomScale.value);
      s.getElementById('val-zoom-scale').textContent = `×${(this.settings.zoomScale / 100).toFixed(2)}`;
      this.settings.zoomEnabled = (this.settings.zoomScale > 100);
      this.applyZoom();
      this.updateSubtexts();
    });

    // Auto stretch button toggle
    const stretchBtn = s.getElementById('btn-action-elastic-stretch');
    if (stretchBtn) {
      stretchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.autoStretchToAvailableSpace();
      });
    }

    const elasticStretch = s.getElementById('slider-elastic-stretch');
    const onStretchLineTouch = () => {
      if (this.settings.autoElasticStretch) {
        this.settings.autoElasticStretch = false;
        if (stretchBtn) stretchBtn.classList.remove('active');
        showToast("Auto-stretch disabled (Manual Mode)", "info");
      }
    };
    elasticStretch.addEventListener('pointerdown', onStretchLineTouch);
    elasticStretch.addEventListener('mousedown', onStretchLineTouch);
    elasticStretch.addEventListener('touchstart', onStretchLineTouch);

    elasticStretch.addEventListener('input', () => {
      onStretchLineTouch();
      this.settings.elasticStretch = parseInt(elasticStretch.value);
      s.getElementById('val-elastic-stretch').textContent = `${this.settings.elasticStretch}%`;
      this.applyZoom();
      this.updateSubtexts();
    });

    // Universal slider-dragging focus: when user adjusts ANY picture/zoom/ambience slider,
    // the rest of the HUD disappears and collapses into a sleek floating capsule (Images 1 & 2)
    s.querySelectorAll('.hud-range').forEach(sliderEl => {
      const row = sliderEl.closest('.hud-slider-row');
      if (!row) return;

      let releaseTimer = null;
      const startSliding = () => {
        clearTimeout(releaseTimer);
        container.classList.add('slider-dragging');
        s.querySelectorAll('.hud-slider-row').forEach(r => r.classList.remove('is-active-sliding'));
        row.classList.add('is-active-sliding');
      };

      const endSliding = () => {
        clearTimeout(releaseTimer);
        releaseTimer = setTimeout(() => {
          container.classList.remove('slider-dragging');
          row.classList.remove('is-active-sliding');
        }, 280);
      };

      sliderEl.addEventListener('pointerdown', startSliding);
      sliderEl.addEventListener('mousedown', startSliding);
      sliderEl.addEventListener('touchstart', startSliding);
      sliderEl.addEventListener('input', startSliding);

      sliderEl.addEventListener('pointerup', endSliding);
      sliderEl.addEventListener('mouseup', endSliding);
      sliderEl.addEventListener('touchend', endSliding);
      sliderEl.addEventListener('change', endSliding);
    });

    const toggleBlackbars = s.getElementById('toggle-remove-blackbars');
    toggleBlackbars.addEventListener('change', () => {
      this.settings.removeBlackbars = toggleBlackbars.checked;
      if (toggleBlackbars.checked) {
        this.settings.zoomScale = Math.max(115, this.settings.zoomScale);
        s.getElementById('slider-zoom-scale').value = this.settings.zoomScale;
        s.getElementById('val-zoom-scale').textContent = `×${(this.settings.zoomScale / 100).toFixed(2)}`;
        showToast('Auto-cropping blackbars', 'info');
      }
      this.applyZoom();
      this.saveSettings();
    });

    // Pan Toggle Button
    const panBtn = s.getElementById('btn-zoom-pan');
    const panControls = s.getElementById('hud-pan-controls');
    panBtn.addEventListener('click', () => {
      this.settings.panActive = !this.settings.panActive;
      panBtn.classList.toggle('active', this.settings.panActive);
      panControls.style.display = this.settings.panActive ? 'flex' : 'none';
    });

    const panX = s.getElementById('slider-pan-x');
    panX.addEventListener('input', () => {
      this.settings.panX = parseInt(panX.value);
      s.getElementById('val-pan-x').textContent = `${this.settings.panX}%`;
      this.applyZoom();
      this.saveSettings();
    });

    const panY = s.getElementById('slider-pan-y');
    panY.addEventListener('input', () => {
      this.settings.panY = parseInt(panY.value);
      s.getElementById('val-pan-y').textContent = `${this.settings.panY}%`;
      this.applyZoom();
      this.saveSettings();
    });

    const btnResetPan = s.getElementById('btn-reset-pan');
    if (btnResetPan) {
      btnResetPan.addEventListener('click', (e) => {
        e.stopPropagation();
        this.settings.panX = 0;
        this.settings.panY = 0;
        panX.value = 0;
        panY.value = 0;
        s.getElementById('val-pan-x').textContent = '0%';
        s.getElementById('val-pan-y').textContent = '0%';
        this.applyZoom();
        this.saveSettings();
        showToast('Pan reset to center (0%, 0%)', 'info');
      });
    }

    // Aspect Ratio Buttons (Image 3)
    s.querySelectorAll('.hud-aspect-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        s.querySelectorAll('.hud-aspect-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.settings.aspectRatio = btn.dataset.ratio;
        this.settings.zoomEnabled = true;
        this.applyZoom();
        this.updateSubtexts();
        this.saveSettings();
        showToast(`Aspect ratio set to ${btn.dataset.ratio}`, 'info');
      });
    });

    s.getElementById('btn-zoom-reapply').addEventListener('click', () => {
      this.applyZoom();
      showToast('Zoom settings re-applied', 'info');
    });

    s.getElementById('btn-reset-zoom').addEventListener('click', () => {
      this.settings.zoomEnabled = false;
      this.settings.zoomScale = 100;
      this.settings.elasticStretch = 0;
      this.settings.removeBlackbars = false;
      this.settings.aspectRatio = '16:9';
      this.settings.panX = 0;
      this.settings.panY = 0;
      this.syncUIFromSettings();
      this.applyZoom();
      this.updateSubtexts();
      this.saveSettings();
      showToast('Zoom reset to default', 'info');
    });

    // Picture Tab Controls (Image 4)
    const togglePic = s.getElementById('toggle-picture');
    togglePic.addEventListener('change', () => {
      this.settings.pictureEnabled = togglePic.checked;
      this.applyFilters();
      this.updateSubtexts();
      this.saveSettings();
    });

    const bindPicSlider = (id, prop, unit = '') => {
      const slider = s.getElementById(`slider-${id}`);
      slider.addEventListener('input', () => {
        this.settings[prop] = parseInt(slider.value);
        s.getElementById(`val-${id}`).textContent = `${this.settings[prop]}${unit}`;
        this.settings.pictureEnabled = true;
        togglePic.checked = true;
        this.applyFilters();
        this.updateSubtexts();
        this.saveSettings();
      });
    };

    bindPicSlider('lighting', 'lighting');
    bindPicSlider('shadows', 'shadows');
    bindPicSlider('contrast', 'contrast');
    bindPicSlider('sharpness', 'sharpness');
    bindPicSlider('vibrance', 'vibrance');
    bindPicSlider('hdr', 'hdrBoost');

    s.getElementById('btn-reset-picture').addEventListener('click', () => {
      this.settings.pictureEnabled = false;
      this.settings.lighting = 0;
      this.settings.shadows = 0;
      this.settings.contrast = 0;
      this.settings.sharpness = 0;
      this.settings.vibrance = 0;
      this.settings.hdrBoost = 0;
      this.syncUIFromSettings();
      this.applyFilters();
      this.updateSubtexts();
      this.saveSettings();
      showToast('Picture settings reset', 'info');
    });

    // Ambience Tab Controls
    const toggleAmb = s.getElementById('toggle-ambience');
    toggleAmb.addEventListener('change', () => {
      this.settings.ambienceEnabled = toggleAmb.checked;
      this.applyAmbience();
      this.updateSubtexts();
      this.saveSettings();
    });

    const bindAmbSlider = (id, prop) => {
      const slider = s.getElementById(`slider-amb-${id}`);
      slider.addEventListener('input', () => {
        this.settings[prop] = parseInt(slider.value);
        s.getElementById(`val-amb-${id}`).textContent = this.settings[prop];
        this.settings.ambienceEnabled = true;
        toggleAmb.checked = true;
        this.applyAmbience();
        this.saveSettings();
      });
    };

    bindAmbSlider('spread', 'ambienceSpread');
    bindAmbSlider('intensity', 'ambienceIntensity');
    bindAmbSlider('blur', 'ambienceBlur');
    bindAmbSlider('sync', 'ambienceSyncRate');
    bindAmbSlider('audio', 'ambienceAudioPulse');

    s.getElementById('btn-reset-ambience')?.addEventListener('click', () => {
      this.settings.ambienceEnabled = false;
      this.settings.ambienceSpread = 100;
      this.settings.ambienceIntensity = 100;
      this.settings.ambienceBlur = 45;
      this.settings.ambienceSyncRate = 90;
      this.settings.ambienceAudioPulse = 0;
      this.syncUIFromSettings();
      this.applyAmbience();
      this.updateSubtexts();
      this.saveSettings();
      showToast('Ambience reset', 'info');
    });

    const pinStatsBtn = s.getElementById('btn-pin-stats');
    if (pinStatsBtn) {
      pinStatsBtn.addEventListener('click', () => {
        this.settings.pinStats = !this.settings.pinStats;
        showToast(this.settings.pinStats ? 'Stats pinned to video' : 'Stats unpinned', 'info');
        this.saveSettings();
      });
    }
  },

  setupResizeObserver(video) {
    if (!video) return;
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    const playerContainer = video.closest('.html5-video-player, .video-player, [data-a-target="video-player"], #player, #movie_player, .player-container') || video.parentElement || document.body;
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        handleVideoRelayout();
      });
      try {
        this.resizeObserver.observe(video);
        if (playerContainer && playerContainer !== video) {
          this.resizeObserver.observe(playerContainer);
        }
      } catch (e) {}
    }
  },

  recomputeAutoStretch() {
    let v = this.activeVideo;
    if (!v) {
      const videos = Array.from(document.querySelectorAll('video'));
      v = videos.find(vid => !vid.paused && vid.readyState > 1) || videos[0];
      if (v) this.activeVideo = v;
    }
    if (!v || !this.settings.autoElasticStretch) return;

    const playerContainer = v.closest('.html5-video-player, .video-player, [data-a-target="video-player"], #player, #movie_player, .player-container') || v.parentElement || document.body;
    const cRect = playerContainer ? playerContainer.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
    const cW = Math.max(100, cRect.width || window.innerWidth);
    const cH = Math.max(100, cRect.height || window.innerHeight);
    const vW = Math.max(100, v.videoWidth || cW);
    const vH = Math.max(100, v.videoHeight || cH);

    const cAspect = cW / cH;
    const vAspect = vW / vH;

    let neededStretch = 0;
    // When container is wider than video (pillarbox on sides, e.g. ultrawide / theater mode) -> upscale stretch to fill
    if (cAspect > vAspect + 0.03) {
      const extraRatio = (cAspect / vAspect) - 1;
      neededStretch = Math.max(0, Math.min(100, Math.round((extraRatio / 0.38) * 100)));
    } else {
      // Container matches video (standard 16:9) -> downscale stretch to 0%
      neededStretch = 0;
    }

    this.settings.elasticStretch = neededStretch;
    this.syncUIFromSettings();
    this.applyZoom();
    this.updateSubtexts();
  },

  autoStretchToAvailableSpace() {
    let v = this.activeVideo;
    if (!v) {
      const videos = Array.from(document.querySelectorAll('video'));
      v = videos.find(vid => !vid.paused && vid.readyState > 1) || videos[0];
      if (v) this.activeVideo = v;
    }
    if (!v) return;

    // Toggle OFF if already active or stretched
    if (this.settings.autoElasticStretch || this.settings.elasticStretch > 0) {
      this.settings.autoElasticStretch = false;
      this.settings.elasticStretch = 0;
      this.syncUIFromSettings();
      this.applyZoom();
      this.updateSubtexts();
      showToast("Auto stretch disabled (0%)", "info");
      return;
    }

    // Toggle ON: activate dynamic autoElasticStretch
    this.settings.autoElasticStretch = true;
    this.setupResizeObserver(v);
    this.recomputeAutoStretch();
    showToast(`Auto stretch enabled (${this.settings.elasticStretch}%)`, "success");
  },

  recomputeAutoZoom() {
    let v = this.activeVideo;
    if (!v) {
      const videos = Array.from(document.querySelectorAll('video'));
      v = videos.find(vid => !vid.paused && vid.readyState > 1) || videos[0];
      if (v) this.activeVideo = v;
    }
    if (!v || !this.settings.autoZoomToFill) return;

    const playerContainer = v.closest('.html5-video-player, .video-player, [data-a-target="video-player"], #player, #movie_player, .player-container') || v.parentElement || document.body;
    const cRect = playerContainer ? playerContainer.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
    const cW = Math.max(100, cRect.width || window.innerWidth);
    const cH = Math.max(100, cRect.height || window.innerHeight);
    const vW = Math.max(100, v.videoWidth || cW);
    const vH = Math.max(100, v.videoHeight || cH);

    const cAspect = cW / cH;
    const vAspect = vW / vH;

    let neededScale = 1.0;
    // Auto upscale or downscale based on exact container vs video aspect ratio
    if (cAspect > vAspect + 0.03) {
      // Container is wider than video (pillarbox black bars on left/right, e.g. fullscreen ultrawide) -> upscale to fill
      neededScale = cAspect / vAspect;
    } else if (vAspect > cAspect + 0.03) {
      // Container is taller than video (letterbox black bars top/bottom) -> upscale to fill
      neededScale = vAspect / cAspect;
    } else {
      // Container aspect matches video aspect ratio (no black bars, e.g. non-fullscreen standard 16:9 player) -> downscale to 1.00!
      neededScale = 1.0;
    }

    const scalePercent = Math.max(100, Math.min(300, Math.round(neededScale * 100)));
    this.settings.zoomScale = scalePercent;
    this.settings.zoomEnabled = (scalePercent > 100);

    this.syncUIFromSettings();
    this.applyZoom();
    this.updateSubtexts();
  },

  autoZoomToAvailableSpace() {
    let v = this.activeVideo;
    if (!v) {
      const videos = Array.from(document.querySelectorAll('video'));
      v = videos.find(vid => !vid.paused && vid.readyState > 1) || videos[0];
      if (v) this.activeVideo = v;
    }
    if (!v) {
      showToast("No active video found to zoom", "error");
      return;
    }

    // Toggle OFF if already zoomed
    if (this.settings.autoZoomToFill || (this.settings.zoomEnabled && this.settings.zoomScale > 100)) {
      this.settings.autoZoomToFill = false;
      this.settings.zoomEnabled = false;
      this.settings.zoomScale = 100;
      this.settings.elasticStretch = 0;
      this.settings.aspectRatio = '16:9';
      this.settings.panX = 0;
      this.settings.panY = 0;
      this.syncUIFromSettings();
      this.applyZoom();
      this.updateSubtexts();
      showToast("Zoom reset to normal (×1.00)", "info");
      return;
    }

    // Toggle ON: activate dynamic autoZoomToFill
    this.settings.autoZoomToFill = true;
    this.setupResizeObserver(v);
    this.recomputeAutoZoom();

    showToast(`Auto zoomed to available space (×${((this.settings.zoomScale || 100) / 100).toFixed(2)})`, "success");
  },

  applyProfile(profileKey) {
    const prof = this.profiles[profileKey] || this.profiles.none;
    this.settings.activeProfile = profileKey;
    this.settings.pictureEnabled = (profileKey !== 'none');
    this.settings.lighting = prof.lighting;
    this.settings.shadows = prof.shadows;
    this.settings.contrast = prof.contrast;
    this.settings.sharpness = prof.sharpness;
    this.settings.vibrance = prof.vibrance;
    this.settings.hdrBoost = prof.hdrBoost;
    if (prof.ambienceAudioPulse > 0) {
      this.settings.ambienceEnabled = true;
      this.settings.ambienceAudioPulse = prof.ambienceAudioPulse;
    }
    this.syncUIFromSettings();
    this.applyFilters();
    this.applyAmbience();
    this.updateSubtexts();
    this.saveSettings();
    showToast(profileKey === 'none' ? 'Profile reset to default' : `Profile applied: ${prof.name}`, 'info');
  },

  updatePlaybackSpeedUI(rate) {
    const s = this.shadow;
    if (!s) return;
    const currentRate = parseFloat(rate !== undefined ? rate : (this.activeVideo?.playbackRate || 1.0));
    s.querySelectorAll('[data-speed]').forEach(btn => {
      const speedVal = parseFloat(btn.dataset.speed);
      btn.classList.toggle('active', Math.abs(speedVal - currentRate) < 0.05);
    });
  },

  syncUIFromSettings() {
    const s = this.shadow;
    if (!s) return;

    // Profiles
    s.querySelectorAll('.hud-profile-item').forEach(item => {
      item.classList.toggle('active', item.dataset.profile === (this.settings.activeProfile || 'none'));
    });

    // Zoom
    const fillBtn = s.getElementById('btn-action-zoom-fill');
    if (fillBtn) {
      fillBtn.classList.toggle('active', !!(this.settings.autoZoomToFill || (this.settings.zoomEnabled && this.settings.zoomScale > 100)));
    }
    const stretchBtnSync = s.getElementById('btn-action-elastic-stretch');
    if (stretchBtnSync) {
      stretchBtnSync.classList.toggle('active', !!(this.settings.autoElasticStretch || this.settings.elasticStretch > 0));
    }
    const setVal = (id, val) => {
      const el = s.getElementById(id);
      if (el) el.value = val;
    };
    const setText = (id, txt) => {
      const el = s.getElementById(id);
      if (el) el.textContent = txt;
    };
    const setChecked = (id, bool) => {
      const el = s.getElementById(id);
      if (el) el.checked = bool;
    };

    setVal('slider-zoom-scale', this.settings.zoomScale || 100);
    setText('val-zoom-scale', `×${((this.settings.zoomScale || 100) / 100).toFixed(2)}`);
    setVal('slider-elastic-stretch', this.settings.elasticStretch || 0);
    setText('val-elastic-stretch', `${this.settings.elasticStretch || 0}%`);
    setChecked('toggle-remove-blackbars', !!this.settings.removeBlackbars);
    setVal('slider-pan-x', this.settings.panX || 0);
    setText('val-pan-x', `${this.settings.panX || 0}%`);
    setVal('slider-pan-y', this.settings.panY || 0);
    setText('val-pan-y', `${this.settings.panY || 0}%`);

    s.querySelectorAll('.hud-aspect-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.ratio === (this.settings.aspectRatio || '16:9'));
    });

    // Picture
    setChecked('toggle-picture', !!this.settings.pictureEnabled);
    setVal('slider-lighting', this.settings.lighting);
    setText('val-lighting', this.settings.lighting);
    setVal('slider-shadows', this.settings.shadows);
    setText('val-shadows', this.settings.shadows);
    setVal('slider-contrast', this.settings.contrast);
    setText('val-contrast', this.settings.contrast);
    setVal('slider-sharpness', this.settings.sharpness);
    setText('val-sharpness', this.settings.sharpness);
    setVal('slider-vibrance', this.settings.vibrance);
    setText('val-vibrance', this.settings.vibrance);
    setVal('slider-hdr', this.settings.hdrBoost);
    setText('val-hdr', this.settings.hdrBoost);

    // Ambience
    setChecked('toggle-ambience', !!this.settings.ambienceEnabled);
    setVal('slider-amb-spread', this.settings.ambienceSpread);
    setText('val-amb-spread', this.settings.ambienceSpread);
    setVal('slider-amb-intensity', this.settings.ambienceIntensity);
    setText('val-amb-intensity', this.settings.ambienceIntensity);
    setVal('slider-amb-blur', this.settings.ambienceBlur);
    setText('val-amb-blur', this.settings.ambienceBlur);
    setVal('slider-amb-sync', this.settings.ambienceSyncRate);
    setText('val-amb-sync', this.settings.ambienceSyncRate);
    setVal('slider-amb-audio', this.settings.ambienceAudioPulse);
    setText('val-amb-audio', this.settings.ambienceAudioPulse);

    this.updatePlaybackSpeedUI();
    this.updateSubtexts();
  },

  updateSubtexts() {
    const s = this.shadow;
    if (!s) return;

    // Profiles Wand Button (Images 1 & 2)
    const wandLabel = s.getElementById('hud-profile-wand-label');
    if (wandLabel) {
      if (this.settings.activeProfile && this.settings.activeProfile !== 'none') {
        const prof = this.profiles[this.settings.activeProfile];
        wandLabel.textContent = prof ? prof.name : this.settings.activeProfile;
        wandLabel.style.display = 'inline';
      } else {
        wandLabel.style.display = 'none';
      }
    }

    // Zoom
    const zoomActive = (this.settings.zoomScale > 100 || this.settings.elasticStretch > 0 || (this.settings.aspectRatio && this.settings.aspectRatio !== '16:9'));
    const tabZoom = s.getElementById('tab-sub-zoom');
    if (tabZoom) tabZoom.textContent = zoomActive ? 'On' : 'Off';

    // Picture count: "On · 3" (Images 1, 3, 4)
    let picCount = 0;
    if (this.settings.lighting !== 0) picCount++;
    if (this.settings.shadows !== 0) picCount++;
    if (this.settings.contrast !== 0) picCount++;
    if (this.settings.sharpness !== 0) picCount++;
    if (this.settings.vibrance !== 0) picCount++;
    if (this.settings.hdrBoost !== 0) picCount++;

    const tabPic = s.getElementById('tab-sub-pic');
    if (tabPic) {
      if (this.settings.pictureEnabled) {
        tabPic.textContent = picCount > 0 ? `On · ${picCount}` : 'On';
      } else {
        tabPic.textContent = 'Off';
      }
    }

    // Ambience
    const tabAmb = s.getElementById('tab-sub-amb');
    if (tabAmb) tabAmb.textContent = this.settings.ambienceEnabled ? 'On' : 'Off';

    // Fluidity
    const tabFps = s.getElementById('tab-sub-fps');
    if (tabFps) tabFps.textContent = `${this.fpsTracker.fps || 60} FPS`;
  },

  getVideoViewportRect(video) {
    if (!video) return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };

    // 1. Check known video player container elements (YouTube, Netflix, Twitch, Vimeo, etc.)
    const playerContainer = video.closest(
      '.html5-video-player, #movie_player, .video-player, [data-a-target="video-player"], #player, .player-container, .jwplayer, .video-js, .vjs-tech, .shaka-video-container'
    );
    if (playerContainer) {
      const pRect = playerContainer.getBoundingClientRect();
      if (pRect.width > 80 && pRect.height > 60) {
        return pRect;
      }
    }

    // 2. Check parent elements with overflow:hidden (which clip the zoomed video)
    let parent = video.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const style = window.getComputedStyle(parent);
      if (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden') {
        const pRect = parent.getBoundingClientRect();
        if (pRect.width > 80 && pRect.height > 60 && pRect.width <= window.innerWidth && pRect.height <= window.innerHeight) {
          return pRect;
        }
      }
      parent = parent.parentElement;
    }

    // 3. Fallback: if video has transform zoom applied, use parent or unzoomed dimensions
    const vRect = video.getBoundingClientRect();
    if (this.settings.zoomEnabled && (this.settings.zoomScale > 100 || this.settings.elasticStretch > 0 || this.settings.aspectRatio !== '16:9' || this.settings.panX !== 0 || this.settings.panY !== 0)) {
      if (video.parentElement && video.parentElement !== document.body) {
        const pRect = video.parentElement.getBoundingClientRect();
        if (pRect.width > 80 && pRect.height > 60) {
          return pRect;
        }
      }
      const origW = video.offsetWidth || video.clientWidth;
      const origH = video.offsetHeight || video.clientHeight;
      if (origW > 0 && origH > 0 && (origW < vRect.width || origH < vRect.height)) {
        const centerX = vRect.left + vRect.width / 2;
        const centerY = vRect.top + vRect.height / 2;
        return {
          top: centerY - origH / 2,
          bottom: centerY + origH / 2,
          left: centerX - origW / 2,
          right: centerX + origW / 2,
          width: origW,
          height: origH
        };
      }
    }

    return vRect;
  },

  show(video, mouseX, mouseY) {
    if (!video) return;
    this.init();
    this.activeVideo = video;
    if (video && !video.__smartHudRateBound) {
      video.__smartHudRateBound = true;
      video.addEventListener('ratechange', () => {
        this.updatePlaybackSpeedUI(video.playbackRate);
      });
    }
    clearTimeout(this.hideTimer);

    // Ensure host element is attached to current fullscreenElement or body
    const targetParent = document.fullscreenElement || document.body || document.documentElement;
    if (targetParent && this.hostEl && this.hostEl.parentElement !== targetParent) {
      try {
        targetParent.appendChild(this.hostEl);
      } catch (e) {}
    }

    const container = this.shadow?.querySelector('.hud-container');
    const pill = this.shadow?.getElementById('hud-pill');
    if (!container || !pill) return;

    // Position container at TOP-CENTER of the visible video viewport/container
    const rect = this.getVideoViewportRect(video);
    const visibleTop = Math.max(0, rect.top);
    const topPos = Math.max(8, visibleTop + 14);
    const leftPos = Math.max(10, rect.left + rect.width / 2);
    container.style.top = `${topPos}px`;
    container.style.left = `${leftPos}px`;

    if (mouseX !== undefined && mouseY !== undefined) {
      this.updatePositionAndProximity(video, mouseX, mouseY);
      return;
    }

    container.classList.add('visible');

    // Apply active video adjustments automatically
    this.applyZoom();
    this.applyFilters();
    this.applyAmbience();
    this.startFpsTracking();
    this.updateStatsDisplay();
  },

  updatePositionAndProximity(video, mouseX, mouseY) {
    if (!video) return;
    this.init();
    this.activeVideo = video;
    clearTimeout(this.hideTimer);

    const targetParent = document.fullscreenElement || document.body || document.documentElement;
    if (targetParent && this.hostEl && this.hostEl.parentElement !== targetParent) {
      try {
        targetParent.appendChild(this.hostEl);
      } catch (e) {}
    }

    const container = this.shadow?.querySelector('.hud-container');
    const pill = this.shadow?.getElementById('hud-pill');
    if (!container || !pill) return;

    // Position container at TOP-CENTER of the visible video viewport/container
    const rect = this.getVideoViewportRect(video);
    const visibleTop = Math.max(0, rect.top);
    const topPos = Math.max(8, visibleTop + 14);
    const leftPos = Math.max(10, rect.left + rect.width / 2);
    container.style.top = `${topPos}px`;
    container.style.left = `${leftPos}px`;

    // If panel is open, keep it visible
    if (this.isOpen) {
      container.classList.add('visible', 'open', 'mouse-close');
      return;
    }

    // Direct hover on HUD
    if (this.isPillHovered) {
      container.classList.add('visible', 'pill-hovered', 'mouse-close');
      container.classList.remove('near-button', 'faded');
      return;
    }

    // Proximity detection: calculate distance to the pill button itself
    const pillRect = pill.getBoundingClientRect();
    const dx = Math.max(pillRect.left - mouseX, 0, mouseX - pillRect.right);
    const dy = Math.max(pillRect.top - mouseY, 0, mouseY - pillRect.bottom);
    const dist = Math.hypot(dx, dy);

    // On hover anywhere over the video: the HUD button appears clearly
    // Moving towards or hovering the button: expands into action capsule (Screenshot, Record, More)
    if (dist <= 80) {
      container.classList.add('visible', 'mouse-close', 'pill-hovered');
      container.classList.remove('faded', 'near-button');
    } else if (dist <= 180) {
      container.classList.add('visible', 'near-button');
      container.classList.remove('faded', 'mouse-close', 'pill-hovered');
    } else {
      container.classList.add('visible');
      container.classList.remove('near-button', 'mouse-close', 'pill-hovered', 'faded');
    }

    if (!this.resizeObserver) {
      this.setupResizeObserver(video);
    }

    // Apply active video adjustments automatically
    this.applyZoom();
    this.applyFilters();
    this.applyAmbience();
    this.startFpsTracking();
    this.updateStatsDisplay();
  },

  hide() {
    if (this.isOpen) return; // Keep open if panel is expanded
    const container = this.shadow?.querySelector('.hud-container');
    if (container) {
      container.classList.remove('visible', 'near-button', 'mouse-close', 'pill-hovered');
    }
  },

  togglePanel() {
    if (this.isOpen) {
      this.closePanel();
    } else {
      this.openPanel();
    }
  },

  openPanel(tab = 'capture') {
    this.isOpen = true;
    const container = this.shadow.querySelector('.hud-container');
    container.classList.add('open', 'mouse-close');
    this.openTab(tab);
  },

  closePanel() {
    this.isOpen = false;
    const container = this.shadow.querySelector('.hud-container');
    container.classList.remove('open');
  },

  openTab(tabName) {
    this.activeTab = tabName;
    const s = this.shadow;
    s.querySelectorAll('.hud-tab-item').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    const wandBtn = s.getElementById('hud-bar-profiles');
    if (wandBtn) {
      wandBtn.classList.toggle('active', tabName === 'profiles');
    }
    s.querySelectorAll('.hud-body-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === `pane-${tabName}`);
    });
  },

  applyZoom() {
    const video = this.activeVideo;
    if (!video) return;

    const scale = (this.settings.zoomScale || 100) / 100;
    const elastic = (this.settings.elasticStretch || 0) / 100;
    const panX = this.settings.panX || 0;
    const panY = this.settings.panY || 0;

    let aspectX = 1;
    let aspectY = 1;
    if (this.settings.aspectRatio === '4:3') aspectX = 1.33;
    else if (this.settings.aspectRatio === '16:10') aspectY = 1.1;
    else if (this.settings.aspectRatio === '18:9') aspectY = 1.12;
    else if (this.settings.aspectRatio === '21:9') aspectY = 1.33;
    else if (this.settings.aspectRatio === '32:9') aspectY = 1.8;

    // Elastic Stretch: keeps center 1:1, non-linearly stretches edges to fill screen without cropping (Images 3, 4, 5)
    let elasticScaleX = 1;
    if (elastic > 0) {
      this.updateElasticFilter(elastic);
      elasticScaleX = 1 + elastic * 0.38;
    }

    if (!this.settings.zoomEnabled && elastic === 0 && scale === 1 && aspectX === 1 && aspectY === 1 && panX === 0 && panY === 0) {
      video.style.removeProperty('object-fit');
      video.style.removeProperty('transform');
      video.style.removeProperty('transform-origin');
    } else {
      video.style.setProperty('transform', `scale(${scale * aspectX * elasticScaleX}, ${scale * aspectY}) translate(${panX}%, ${panY}%)`, 'important');
      video.style.setProperty('transform-origin', 'center center', 'important');
    }

    // Apply filters (which attaches elastic displacement filter if elastic > 0)
    this.applyFilters();

    // Auto-rescale ambience whenever zoom is modified or scaled!
    if (this.settings.ambienceEnabled) {
      this.applyAmbience();
    }
  },

  applyFilters() {
    const video = this.activeVideo;
    if (!video) return;

    let filterStr = '';
    if (this.settings.pictureEnabled) {
      const brightness = 1 + (this.settings.lighting || 0) / 100;
      const contrast = 1 + (this.settings.contrast || 0) / 100;
      const saturate = 1 + (this.settings.vibrance || 0) / 100;
      const hdr = (this.settings.hdrBoost || 0) / 100;
      const sharpness = (this.settings.sharpness || 0) / 200;
      filterStr = `brightness(${brightness * (1 + hdr * 0.15)}) contrast(${contrast * (1 + hdr * 0.25 + sharpness)}) saturate(${saturate * (1 + hdr * 0.2)})`;
    }

    if (this.settings.elasticStretch > 0) {
      filterStr = (filterStr ? filterStr + ' ' : '') + 'url(#cc-elastic-filter)';
    }

    if (filterStr) {
      video.style.setProperty('filter', filterStr.trim(), 'important');
    } else {
      video.style.removeProperty('filter');
    }
  },

  applyAmbience() {
    let video = this.activeVideo;
    if (!video) {
      const videos = Array.from(document.querySelectorAll('video'));
      video = videos.find(v => !v.paused && v.readyState > 1) || videos[0];
      if (video) this.activeVideo = video;
    }
    if (!video || !this.settings.ambienceEnabled) {
      this.stopAmbience();
      return;
    }

    const playerContainer = video.closest('.video-player, .video-player__container, .html5-video-player, [data-a-target="video-player"], #player, #movie_player, .player-container') || video.parentElement || document.body;
    if (!playerContainer) return;

    // Ensure player container has positioning context
    const computedParent = window.getComputedStyle(playerContainer);
    if (computedParent.position === 'static') {
      playerContainer.style.setProperty('position', 'relative', 'important');
    }

    const pRect = playerContainer.getBoundingClientRect();
    const pW = Math.max(100, Math.round(pRect.width) || window.innerWidth);
    const pH = Math.max(100, Math.round(pRect.height) || window.innerHeight);
    const vW = Math.max(100, video.videoWidth || 1920);
    const vH = Math.max(100, video.videoHeight || 1080);
    const vAspect = vW / vH;
    const pAspect = pW / pH;

    let actualW = pW;
    let actualH = pH;
    let holeLeft = 0;
    let holeTop = 0;

    if (pAspect > vAspect) {
      // Pillarbox bars on left & right (ultrawide / theater mode)
      actualW = Math.round(pH * vAspect);
      actualH = pH;
      holeLeft = Math.round((pW - actualW) / 2);
      holeTop = 0;
    } else if (pAspect < vAspect) {
      // Letterbox bars on top & bottom
      actualW = pW;
      actualH = Math.round(pW / vAspect);
      holeLeft = 0;
      holeTop = Math.round((pH - actualH) / 2);
    }

    // Base unzoomed video box
    const baseW = actualW;
    const baseH = actualH;

    // Account for Zoom AND Elastic Stretch scaling so Ambience cutout dynamically rescales with both!
    const zoomScale = (this.settings.zoomEnabled ? (this.settings.zoomScale || 100) / 100 : 1);
    const elasticScaleX = (this.settings.elasticStretch > 0 ? (1 + (this.settings.elasticStretch / 100) * 0.38) : 1);
    const totalScaleX = zoomScale * elasticScaleX;
    const totalScaleY = zoomScale;

    const effW = Math.round(baseW * totalScaleX);
    const effH = Math.round(baseH * totalScaleY);
    holeLeft = Math.max(0, Math.round((pW - effW) / 2));
    holeTop = Math.max(0, Math.round((pH - effH) / 2));
    const holeW = Math.min(pW, effW);
    const holeH = Math.min(pH, effH);

    // 1. Size video element so empty screen area is not occluded by Chrome's native solid black bars
    // Video base size remains baseW and baseH (zoom is handled purely by transform scale in applyZoom!)
    video.style.setProperty('width', `${baseW}px`, 'important');
    video.style.setProperty('height', `${baseH}px`, 'important');
    video.style.setProperty('max-width', '100%', 'important');
    video.style.setProperty('max-height', '100%', 'important');
    video.style.setProperty('margin', '0 auto', 'important');
    video.style.setProperty('position', 'relative', 'important');
    video.style.setProperty('z-index', '2', 'important');
    video.style.setProperty('display', 'block', 'important');

    if (video.parentElement && video.parentElement !== playerContainer) {
      video.parentElement.style.setProperty('background', 'transparent', 'important');
    }

    // 2. Create or reuse ambient canvas
    if (!this.ambience.canvas) {
      const c = document.createElement('canvas');
      c.id = 'cc-video-ambience-glow';
      c.width = 64;
      c.height = 36;
      this.ambience.canvas = c;
      this.ambience.ctx = c.getContext('2d');
    }

    const c = this.ambience.canvas;
    if (c.parentElement !== playerContainer) {
      try {
        playerContainer.insertBefore(c, playerContainer.firstChild);
      } catch (e) {
        playerContainer.appendChild(c);
      }
    }

    const blur = this.settings.ambienceBlur || 45;
    const opacity = (this.settings.ambienceIntensity || 100) / 100;
    const spread = (this.settings.ambienceSpread || 100) / 100;

    // Use clip-path cutout polygon when there are empty bars so the video stream in center is 100% crystal-clear
    // and the ambient lighting fills the entire empty screen (left/right/top/bottom)
    let clipRule = 'none';
    if (holeLeft > 4 || holeTop > 4) {
      clipRule = `polygon(evenodd, 0px 0px, ${pW}px 0px, ${pW}px ${pH}px, 0px ${pH}px, 0px 0px, ${holeLeft}px ${holeTop}px, ${holeLeft + holeW}px ${holeTop}px, ${holeLeft + holeW}px ${holeTop + holeH}px, ${holeLeft}px ${holeTop + holeH}px, ${holeLeft}px ${holeTop}px)`;
    }

    c.style.setProperty('position', 'absolute', 'important');
    c.style.setProperty('top', '0', 'important');
    c.style.setProperty('left', '0', 'important');
    c.style.setProperty('width', `${pW}px`, 'important');
    c.style.setProperty('height', `${pH}px`, 'important');
    c.style.setProperty('pointer-events', 'none', 'important');
    c.style.setProperty('z-index', '3', 'important');
    c.style.setProperty('filter', `blur(${blur}px) saturate(260%) brightness(1.45)`, 'important');
    c.style.setProperty('opacity', `${opacity}`, 'important');
    c.style.setProperty('transition', 'opacity 0.25s ease, filter 0.2s ease', 'important');
    if (clipRule !== 'none') {
      c.style.setProperty('clip-path', clipRule, 'important');
      c.style.setProperty('-webkit-clip-path', clipRule, 'important');
    } else {
      c.style.removeProperty('clip-path');
      c.style.removeProperty('-webkit-clip-path');
    }

    const renderAmbienceFrame = () => {
      if (!this.activeVideo || !this.settings.ambienceEnabled) return;
      const cvs = this.ambience.canvas;
      const ctx = this.ambience.ctx;
      if (!cvs || !ctx) return;

      const baseOpacity = (this.settings.ambienceIntensity || 100) / 100;
      let pulse = 1;

      // Dynamic Audio Pulse Lightning in empty screen (User Request: "doing that lightning in this empty video screen")
      if (this.settings.ambienceAudioPulse > 0) {
        const pulseAmp = (this.settings.ambienceAudioPulse / 100);
        const time = Date.now();
        const wave = Math.sin(time / 140) * 0.26 + Math.sin(time / 65) * 0.14;
        const lightning = (Math.random() > 0.93) ? (Math.random() * 0.55 + 0.35) : 0;
        pulse = 1 + (wave + lightning) * pulseAmp;
      }

      try {
        if (this.activeVideo.readyState >= 1) {
          ctx.drawImage(this.activeVideo, 0, 0, cvs.width, cvs.height);
        }
      } catch (err) {
        // Fallback for CORS-restricted live streams: vibrant dynamic atmospheric lighting
        const time = Date.now();
        const hue = (time / 35) % 360;
        const grad = ctx.createLinearGradient(0, 0, cvs.width, cvs.height);
        grad.addColorStop(0, `hsla(${hue}, 95%, 62%, 0.95)`);
        grad.addColorStop(0.5, `hsla(${(hue + 60) % 360}, 95%, 55%, 0.95)`);
        grad.addColorStop(1, `hsla(${(hue + 120) % 360}, 90%, 50%, 0.95)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, cvs.width, cvs.height);
      }

      cvs.style.setProperty('opacity', `${Math.min(1, Math.max(0.12, baseOpacity * pulse))}`, 'important');
    };

    renderAmbienceFrame();

    if (this.ambience.intervalId) {
      clearInterval(this.ambience.intervalId);
      this.ambience.intervalId = null;
    }
    const rate = Math.max(25, 200 - (this.settings.ambienceSyncRate || 90) * 1.6);
    this.ambience.intervalId = setInterval(renderAmbienceFrame, rate);
  },

  stopAmbience() {
    if (this.ambience.intervalId) {
      clearInterval(this.ambience.intervalId);
      this.ambience.intervalId = null;
    }
    if (this.ambience.canvas) {
      this.ambience.canvas.remove();
      this.ambience.canvas = null;
    }
    if (this.activeVideo) {
      this.activeVideo.style.removeProperty('width');
      this.activeVideo.style.removeProperty('height');
      this.activeVideo.style.removeProperty('max-width');
      this.activeVideo.style.removeProperty('max-height');
      this.activeVideo.style.removeProperty('margin');
      this.activeVideo.style.removeProperty('position');
      this.activeVideo.style.removeProperty('z-index');
      this.activeVideo.style.removeProperty('display');
    }
  },

  startFpsTracking() {
    if (this.fpsTracker.active) return;
    this.fpsTracker.active = true;

    const tick = (now) => {
      this.fpsTracker.frameCount++;
      const elapsed = now - this.fpsTracker.lastTime;
      if (elapsed >= 1000) {
        this.fpsTracker.fps = Math.round((this.fpsTracker.frameCount * 1000) / elapsed);
        this.fpsTracker.frameCount = 0;
        this.fpsTracker.lastTime = now;
        
        const fpsStr = `${this.fpsTracker.fps} FPS`;
        const fpsEl = this.shadow?.getElementById('fps-big-val');
        const tabFps = this.shadow?.getElementById('tab-sub-fps');
        if (fpsEl) fpsEl.textContent = fpsStr;
        if (tabFps) tabFps.textContent = fpsStr;
      }
      this.fpsTracker.rafId = requestAnimationFrame(tick);
    };
    this.fpsTracker.rafId = requestAnimationFrame(tick);
  },

  updateStatsDisplay() {
    const v = this.activeVideo;
    if (!v || !this.shadow) return;
    const resEl = this.shadow.getElementById('stat-resolution');
    const playEl = this.shadow.getElementById('stat-play-state');
    const durEl = this.shadow.getElementById('stat-duration');
    const aspectMeta = this.shadow.getElementById('stat-aspect-meta');

    const w = v.videoWidth || v.clientWidth || 1920;
    const h = v.videoHeight || v.clientHeight || 1080;
    if (resEl) resEl.textContent = `${w} × ${h}`;
    if (playEl) playEl.textContent = v.paused ? 'Paused' : 'Playing';
    if (durEl) {
      const cur = Math.floor(v.currentTime || 0);
      const m = Math.floor(cur / 60);
      const s = cur % 60;
      durEl.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    if (aspectMeta) {
      const ratio = (w / h).toFixed(2);
      let ratioName = '16:9';
      if (ratio > 2.2) ratioName = '21:9';
      else if (ratio < 1.4) ratioName = '4:3';
      else if (ratio < 1.65) ratioName = '16:10';
      else if (ratio > 1.85 && ratio < 2.1) ratioName = '18:9';
      aspectMeta.textContent = `Video: ${ratioName} · ${w}×${h}`;
    }
  },

  updateRecordingState(isRecording, timerText = '') {
    const s = this.shadow;
    if (!s) return;
    const btn = s.getElementById('pill-btn-rec');
    const cardTitle = s.getElementById('rec-card-title');
    const cardBtn = s.getElementById('rec-card-btn');
    const capSub = s.getElementById('tab-sub-cap');

    if (isRecording) {
      if (btn) {
        btn.innerHTML = `<span class="hud-rec-dot" style="background:var(--hud-text-values); border-radius:2px; width:8px; height:8px;"></span>`;
        btn.title = `Stop Recording (${timerText})`;
        btn.classList.add('hud-pill-rec-live');
      }
      if (cardTitle) cardTitle.textContent = `Recording (${timerText})`;
      if (cardBtn) cardBtn.textContent = 'Stop Recording';
      if (capSub) capSub.textContent = `🔴 ${timerText}`;
    } else {
      if (btn) {
        btn.innerHTML = `<span class="hud-rec-dot"></span>`;
        btn.title = 'Record Video';
        btn.classList.remove('hud-pill-rec-live');
      }
      if (cardTitle) cardTitle.textContent = 'Record Video';
      if (cardBtn) cardBtn.textContent = 'Record';
      if (capSub) capSub.textContent = 'Shot & Rec';
    }
  }
};


function handleVideoRelayout() {
  const v = SmartVideoHUD.activeVideo;
  if (!v) return;

  // 1. Auto upscale and auto downscale zoom as player becomes smaller or larger
  if (SmartVideoHUD.settings.autoZoomToFill) {
    SmartVideoHUD.recomputeAutoZoom();
  } else if (SmartVideoHUD.settings.zoomEnabled) {
    SmartVideoHUD.applyZoom();
  }

  // 2. Auto upscale and downscale elastic stretch as player becomes smaller or larger
  if (SmartVideoHUD.settings.autoElasticStretch) {
    SmartVideoHUD.recomputeAutoStretch();
  }

  // 3. Auto upscale and downscale ambience as player and video resize or stretch
  if (SmartVideoHUD.settings.ambienceEnabled) {
    SmartVideoHUD.applyAmbience();
  }

  // 3. Update HUD position if pill or panel is visible
  if (SmartVideoHUD.isOpen || SmartVideoHUD.isPillHovered) {
    SmartVideoHUD.show(v);
  }
}

function handleFullscreenChange() {
  if (SmartVideoHUD.hostEl) {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      try {
        fsEl.appendChild(SmartVideoHUD.hostEl);
      } catch (e) {
        document.body.appendChild(SmartVideoHUD.hostEl);
      }
    } else {
      document.body.appendChild(SmartVideoHUD.hostEl);
    }
  }
  // Seamlessly relayout and auto-rescale zoom & ambience when entering or exiting fullscreen
  setTimeout(handleVideoRelayout, 50);
  setTimeout(handleVideoRelayout, 150);
  setTimeout(handleVideoRelayout, 300);
  setTimeout(handleVideoRelayout, 600);
}

function initVideoOverlay() {
  SmartVideoHUD.init();
  window.addEventListener('mousemove', handleVideoMouseMove, { capture: true, passive: true });
  document.addEventListener('mousemove', handleVideoMouseMove, { capture: true, passive: true });
  window.addEventListener('resize', handleVideoRelayout, { passive: true });
  window.addEventListener('scroll', handleVideoRelayout, { passive: true });
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
  window.addEventListener('yt-navigate-finish', handleVideoRelayout, { passive: true });
  window.addEventListener('popstate', handleVideoRelayout, { passive: true });
}

function removeVideoOverlay() {
  window.removeEventListener('mousemove', handleVideoMouseMove, true);
  document.removeEventListener('mousemove', handleVideoMouseMove, true);
  document.removeEventListener('mousemove', handleVideoMouseMove);
  window.removeEventListener('resize', handleVideoRelayout);
  window.removeEventListener('scroll', handleVideoRelayout);
  document.removeEventListener('fullscreenchange', handleFullscreenChange);
  document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
  SmartVideoHUD.hide();
  SmartVideoHUD.stopAmbience();
}

function handleVideoMouseMove(e) {
  // If moving inside HUD itself, keep it open and unfaded
  if (SmartVideoHUD.hostEl) {
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(SmartVideoHUD.hostEl)) {
      clearTimeout(SmartVideoHUD.hideTimer);
      clearTimeout(SmartVideoHUD.mouseInactivityTimer);
      clearTimeout(SmartVideoHUD.panelCloseTimer);
      const container = SmartVideoHUD.shadow?.querySelector('.hud-container');
      if (container) {
        container.classList.add('visible', 'mouse-close', 'pill-hovered');
        container.classList.remove('faded', 'near-button');
      }
      return;
    }
  }

  // 1. Direct video element under cursor
  let videoEl = e.target.tagName === 'VIDEO' ? e.target : null;

  // 2. Element under cursor contains or is part of a video player
  if (!videoEl && e.target && e.target.querySelector) {
    const v = e.target.querySelector('video');
    if (v) {
      const vRect = SmartVideoHUD.getVideoViewportRect(v);
      if (e.clientX >= vRect.left && e.clientX <= vRect.right &&
          e.clientY >= vRect.top && e.clientY <= vRect.bottom) {
        videoEl = v;
      }
    }
  }

  // 3. ElementsFromPoint (accounting for transparent overlays like on YouTube, Twitch, etc.)
  if (!videoEl) {
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    for (const el of els) {
      if (el.tagName === 'VIDEO') { videoEl = el; break; }
      const player = el.closest?.('.video-player, .video-player__container, .html5-video-player, [data-a-target="video-player"], #player, #movie_player, .player-container');
      if (player) {
        const v = player.querySelector('video');
        if (v) { videoEl = v; break; }
      }
    }
  }

  // 4. Fallback: check all video elements on the page if cursor is within their viewport
  if (!videoEl) {
    const allVideos = Array.from(document.querySelectorAll('video'));
    for (const v of allVideos) {
      const rect = SmartVideoHUD.getVideoViewportRect(v);
      if (rect.width > 40 && rect.height > 40 &&
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
        videoEl = v;
        break;
      }
    }
  }

  // 5. Also check if mouse is near active video's button even if element under cursor is an overlay
  if (!videoEl && SmartVideoHUD.activeVideo && SmartVideoHUD.activeVideo.isConnected) {
    const rect = SmartVideoHUD.getVideoViewportRect(SmartVideoHUD.activeVideo);
    if (e.clientX >= rect.left - 60 && e.clientX <= rect.right + 60 &&
        e.clientY >= rect.top - 60 && e.clientY <= rect.bottom + 60) {
      videoEl = SmartVideoHUD.activeVideo;
    }
  }

  if (videoEl) {
    const rect = SmartVideoHUD.getVideoViewportRect(videoEl);
    if (rect.width > 50 && rect.height > 40) {
      clearTimeout(SmartVideoHUD.hideTimer);
      clearTimeout(SmartVideoHUD.panelCloseTimer);
      SmartVideoHUD.show(videoEl, e.clientX, e.clientY);

      // Inactivity timeout: if mouse stops moving on video for 3.5s and panel is not open -> hide!
      clearTimeout(SmartVideoHUD.mouseInactivityTimer);
      SmartVideoHUD.mouseInactivityTimer = setTimeout(() => {
        if (!SmartVideoHUD.isOpen && !SmartVideoHUD.isPillHovered) {
          SmartVideoHUD.hide();
        }
      }, 3500);
      return;
    }
  }

  // Mouse left video area
  clearTimeout(SmartVideoHUD.hideTimer);
  SmartVideoHUD.hideTimer = setTimeout(() => {
    if (!SmartVideoHUD.isPillHovered && !SmartVideoHUD.isOpen) {
      SmartVideoHUD.hide();
    }
  }, 400);
}
document.addEventListener("copy", (e) => {
  const selection = window.getSelection().toString();
  if (selection) {
    let type = "text";
    if (selection.startsWith("http://") || selection.startsWith("https://")) type = "link";
    else if (selection.includes("{") || selection.includes("function") || selection.includes("class ")) type = "code";
    DB.addClipboardItem(selection, type).catch(() => {});
  }
});

// Setup key listener with capture phase to prevent page hotkey conflicts
window.addEventListener("keydown", (e) => {
  const isA = e.key.toLowerCase() === "a" || e.code === "KeyA";
  const isP = e.key.toLowerCase() === "p" || e.code === "KeyP";
  const isF = e.key.toLowerCase() === "f" || e.code === "KeyF";
  const isB = e.key.toLowerCase() === "b" || e.code === "KeyB";
  const isC = e.key.toLowerCase() === "c" || e.code === "KeyC";
  
  const toggleAltA = e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && isA;
  const toggleCtrlShiftP = e.ctrlKey && e.shiftKey && !e.altKey && isP;
  const toggleAutofill = e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (isF || isA);
  const toggleCtrlAltB = e.altKey && e.ctrlKey && !e.shiftKey && !e.metaKey && isB;
  const toggleAltC = e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && isC;
  
  if (toggleAltA || toggleCtrlShiftP) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    toggleCommandPalette();
    return;
  }
  
  if (toggleAutofill) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    triggerAutofillForm();
    return;
  }

  if (toggleCtrlAltB) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (window === window.top) {
      toggleVideoRecording();
    }
    return;
  }

  if (toggleAltC) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (window === window.top && EXT_SETTINGS.enableScreenshots) {
      captureVideoFrame();
    }
    return;
  }

  // If palette is active, block ALL events from reaching the page
  if (ccBackdrop && ccBackdrop.classList.contains("active")) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    handlePaletteKeydown(e);
  }
}, true);

window.addEventListener("keyup", (e) => {
  if (ccBackdrop && ccBackdrop.classList.contains("active")) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
}, true);

window.addEventListener("keypress", (e) => {
  if (ccBackdrop && ccBackdrop.classList.contains("active")) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
}, true);

// Focus trap to keep focus inside the command palette
document.addEventListener("focusin", (e) => {
  if (ccBackdrop && ccBackdrop.classList.contains("active")) {
    const path = e.composedPath();
    if (ccRoot && !path.includes(ccRoot)) {
      const active = e.target;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
        return;
      }
      if (ccSearchInput) {
        ccSearchInput.focus();
      }
    }
  }
}, true);

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "ping") {
    sendResponse({ status: "pong" });
  } else if (message.action === "toggle_command_center") {
    toggleCommandPalette();
    sendResponse({ success: true });
  } else if (message.action === "autofill_form") {
    triggerAutofillForm();
    sendResponse({ success: true });
  } else if (message.action === "capture_video_frame") {
    if (EXT_SETTINGS.enableScreenshots) {
      captureVideoFrame();
    }
    sendResponse({ success: true });
  } else if (message.action === "record_video_toggle") {
    if (window === window.top) {
      toggleVideoRecording();
    }
    sendResponse({ success: true });
  }
  return true;
});

function cameraFlashEffect(targetEl) {
  if (!targetEl) return;
  const rect = targetEl.getBoundingClientRect();
  const flash = document.createElement('div');
  flash.style.cssText = `
    position: fixed;
    top: ${rect.top}px;
    left: ${rect.left}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    background: #ffffff;
    opacity: 0.85;
    z-index: 2147483647;
    pointer-events: none;
    transition: opacity 0.28s cubic-bezier(0.16, 1, 0.3, 1);
  `;
  document.body.appendChild(flash);
  requestAnimationFrame(() => {
    flash.style.opacity = '0';
    setTimeout(() => flash.remove(), 300);
  });
}

function downloadDataUrl(dataUrl, filename) {
  try {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    console.warn("Auto-download error:", e);
  }
}

async function copyDataUrlToClipboard(dataUrl) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    if (navigator.clipboard && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type || 'image/png']: blob })
      ]);
    }
  } catch (e) {
    console.debug("Clipboard copy optional:", e);
  }
}

function handleScreenshotSuccess(dataUrl, filename, videoEl) {
  // 1. Camera shutter flash animation
  cameraFlashEffect(videoEl);

  // 2. Always auto-download the screenshot file
  downloadDataUrl(dataUrl, filename);

  // 3. Save to CommandPaletteDB gallery
  if (typeof CommandPaletteDB !== 'undefined' && CommandPaletteDB) {
    CommandPaletteDB.addScreenshot(dataUrl, {
      sourceUrl: window.location.href,
      title: document.title || 'Video Screenshot',
      type: 'image',
      width: videoEl?.videoWidth || 0,
      height: videoEl?.videoHeight || 0
    }).catch(e => console.warn("Gallery save:", e));
  }

  // 4. Copy to clipboard
  copyDataUrlToClipboard(dataUrl);

  // 5. Toast notification
  showToast("📸 Screenshot captured & saved to gallery!", "success");
}

function captureVideoFrame(targetVideo = null) {
  let bestVideo = targetVideo || SmartVideoHUD.activeVideo;

  if (!bestVideo) {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) {
      showToast("No video elements found on the page.", "error");
      return;
    }
    // Find largest playing video, or largest video
    bestVideo = videos.find(v => !v.paused && v.readyState > 1) || videos[0];
    let maxArea = 0;
    for (const v of videos) {
      const area = (v.videoWidth || v.clientWidth) * (v.videoHeight || v.clientHeight);
      if (!v.paused && area > 0) {
        bestVideo = v;
        break;
      }
      if (area > maxArea) {
        maxArea = area;
        bestVideo = v;
      }
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `video_frame_${timestamp}.png`;

  // 1. Try high-performance direct canvas export
  let directDataUrl = null;
  try {
    const vw = bestVideo.videoWidth || bestVideo.clientWidth || 640;
    const vh = bestVideo.videoHeight || bestVideo.clientHeight || 360;
    const canvas = document.createElement('canvas');
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bestVideo, 0, 0, canvas.width, canvas.height);
    directDataUrl = canvas.toDataURL('image/png');
  } catch (corsErr) {
    console.debug("Direct canvas tainted (CORS / live stream), using precision tab crop fallback...", corsErr);
  }

  if (directDataUrl) {
    handleScreenshotSuccess(directDataUrl, filename, bestVideo);
    return;
  }

  // 2. CORS / WebRTC / Live Stream Fallback:
  // Precision Tab Crop via background Service Worker (100% immune to CORS tainting!)
  showToast("Capturing live video frame...", "info");
  const rect = bestVideo.getBoundingClientRect();
  chrome.runtime.sendMessage({
    action: "capture_video_crop",
    rect: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      dpr: window.devicePixelRatio || 1
    },
    sourceUrl: window.location.href,
    title: document.title || 'Video Screenshot'
  }, (res) => {
    if (res && res.dataUrl) {
      handleScreenshotSuccess(res.dataUrl, filename, bestVideo);
    } else {
      showToast("Failed to capture video frame: " + (chrome.runtime.lastError?.message || res?.error || "Error"), "error");
    }
  });
}

// Load stats for scoring
function preloadStats() {
  DB.getAll("commands").then(stats => {
    stats.forEach(s => {
      commandStats[s.id] = s;
    });
  }).catch(() => {});
}

// Typo Autocorrect for media queries
function autoCorrectMediaName(str) {
  let cleaned = str.trim().replace(/\s+/g, " ");
  const corrections = {
    "whjats": "whats",
    "retunrs": "returns",
    "movei": "movie",
    "tomb rider": "tomb raider",
    "judg returns": "judge returns",
    "the judge retuns": "the judge returns",
    "squid gmae": "squid game"
  };
  Object.keys(corrections).forEach(typo => {
    const regex = new RegExp("\\b" + typo + "\\b", "gi");
    cleaned = cleaned.replace(regex, corrections[typo]);
  });
  return cleaned;
}

function getCommandArg(query) {
  const clean = query.trim();
  const firstSpace = clean.indexOf(" ");
  if (firstSpace === -1) return "";
  return clean.substring(firstSpace + 1).trim();
}

// -------------------------------------------------------------
// CORE REGISTRY
// -------------------------------------------------------------
const CommandRegistry = {
  commands: new Map(),
  register(cmd) {
    this.commands.set(cmd.id, cmd);
  },
  getAll() {
    return Array.from(this.commands.values());
  }
};

// --- TEXT EDITING HELPERS FOR EVENT ISOLATION ---
function saveUndoState() {
  if (!ccSearchInput) return;
  const state = {
    value: ccSearchInput.value,
    selStart: ccSearchInput.selectionStart,
    selEnd: ccSearchInput.selectionEnd
  };
  if (undoStack.length === 0 || undoStack[undoStack.length - 1].value !== state.value) {
    undoStack.push(state);
    if (undoStack.length > 100) undoStack.shift();
    redoStack = []; // Clear redo stack on new action
  }
}

function handleSearchInputChange() {
  if (!ccSearchInput) return;
  const val = ccSearchInput.value;
  if (val.startsWith("/")) {
    ccSearchInput.style.color = "#60a5fa";
  } else {
    ccSearchInput.style.color = "#ffffff";
  }
  handleSearchChange(val);
}

function insertTextAtCursor(input, text) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const val = input.value;
  input.value = val.slice(0, start) + text + val.slice(end);
  input.selectionStart = input.selectionEnd = start + text.length;
}

function handleBackspace(input) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const val = input.value;
  if (start !== end) {
    input.value = val.slice(0, start) + val.slice(end);
    input.selectionStart = input.selectionEnd = start;
  } else if (start > 0) {
    input.value = val.slice(0, start - 1) + val.slice(end);
    input.selectionStart = input.selectionEnd = start - 1;
  }
}

function handleDelete(input) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const val = input.value;
  if (start !== end) {
    input.value = val.slice(0, start) + val.slice(end);
    input.selectionStart = input.selectionEnd = start;
  } else if (start < val.length) {
    input.value = val.slice(0, start) + val.slice(start + 1);
    input.selectionStart = input.selectionEnd = start;
  }
}

function handleArrowLeft(input, shiftKey) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  if (shiftKey) {
    if (input.selectionDirection === "backward") {
      if (start > 0) {
        input.setSelectionRange(start - 1, end, "backward");
      }
    } else {
      if (start < end) {
        input.setSelectionRange(start, end - 1, "forward");
      } else if (start > 0) {
        input.setSelectionRange(start - 1, end, "backward");
      }
    }
  } else {
    const newPos = Math.max(0, start === end ? start - 1 : start);
    input.setSelectionRange(newPos, newPos);
  }
}

function handleArrowRight(input, shiftKey) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  if (shiftKey) {
    if (input.selectionDirection === "forward") {
      if (end < input.value.length) {
        input.setSelectionRange(start, end + 1, "forward");
      }
    } else {
      if (start < end) {
        input.setSelectionRange(start + 1, end, "backward");
      } else if (end < input.value.length) {
        input.setSelectionRange(start, end + 1, "forward");
      }
    }
  } else {
    const newPos = Math.min(input.value.length, start === end ? start + 1 : end);
    input.setSelectionRange(newPos, newPos);
  }
}

function handleHome(input, shiftKey) {
  if (shiftKey) {
    if (input.selectionDirection === "forward") {
      input.setSelectionRange(0, input.selectionStart, "backward");
    } else {
      input.setSelectionRange(0, input.selectionEnd, "backward");
    }
  } else {
    input.setSelectionRange(0, 0);
  }
}

function handleEnd(input, shiftKey) {
  const len = input.value.length;
  if (shiftKey) {
    input.setSelectionRange(input.selectionStart, len, "forward");
  } else {
    input.setSelectionRange(len, len);
  }
}

function handlePaletteKeydown(e) {
  if (!ccSearchInput) return;

  const key = e.key;
  const isCtrlOrMeta = e.ctrlKey || e.metaKey;
  const isAlt = e.altKey;
  const isShift = e.shiftKey;

  // 1. Keyboard shortcuts: Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z, Ctrl+K, Alt+K
  if (isCtrlOrMeta && !isAlt && !isShift && key.toLowerCase() === "a") {
    ccSearchInput.select();
    return;
  }
  if (isCtrlOrMeta && !isAlt && !isShift && key.toLowerCase() === "c") {
    const selectedText = ccSearchInput.value.slice(ccSearchInput.selectionStart, ccSearchInput.selectionEnd);
    if (selectedText) {
      navigator.clipboard.writeText(selectedText).catch(() => {});
    }
    return;
  }
  if (isCtrlOrMeta && !isAlt && !isShift && key.toLowerCase() === "x") {
    saveUndoState();
    const start = ccSearchInput.selectionStart;
    const end = ccSearchInput.selectionEnd;
    const selectedText = ccSearchInput.value.slice(start, end);
    if (selectedText) {
      navigator.clipboard.writeText(selectedText).catch(() => {});
      ccSearchInput.value = ccSearchInput.value.slice(0, start) + ccSearchInput.value.slice(end);
      ccSearchInput.setSelectionRange(start, start);
      handleSearchInputChange();
    }
    return;
  }
  if (isCtrlOrMeta && !isAlt && !isShift && key.toLowerCase() === "v") {
    navigator.clipboard.readText().then(text => {
      if (text) {
        saveUndoState();
        insertTextAtCursor(ccSearchInput, text);
        handleSearchInputChange();
      }
    }).catch(() => {});
    return;
  }
  if (isCtrlOrMeta && !isAlt && !isShift && key.toLowerCase() === "z") {
    if (undoStack.length > 0) {
      const currentState = {
        value: ccSearchInput.value,
        selStart: ccSearchInput.selectionStart,
        selEnd: ccSearchInput.selectionEnd
      };
      redoStack.push(currentState);
      const prevState = undoStack.pop();
      ccSearchInput.value = prevState.value;
      ccSearchInput.setSelectionRange(prevState.selStart, prevState.selEnd);
      handleSearchInputChange();
    }
    return;
  }
  if ((isCtrlOrMeta && !isAlt && !isShift && key.toLowerCase() === "y") ||
      (isCtrlOrMeta && !isAlt && isShift && key.toLowerCase() === "z")) {
    if (redoStack.length > 0) {
      const nextState = redoStack.pop();
      undoStack.push({
        value: ccSearchInput.value,
        selStart: ccSearchInput.selectionStart,
        selEnd: ccSearchInput.selectionEnd
      });
      ccSearchInput.value = nextState.value;
      ccSearchInput.setSelectionRange(nextState.selStart, nextState.selEnd);
      handleSearchInputChange();
    }
    return;
  }
  if (key.toLowerCase() === "k" && (isCtrlOrMeta || isAlt)) {
    toggleSubmenu();
    return;
  }

  // 2. Autocomplete and suggestion replacement
  if ((key === "Tab" || key === "ArrowRight") && activeSuggestion) {
    if (ccSearchInput.selectionStart === ccSearchInput.value.length) {
      saveUndoState();
      ccSearchInput.value = activeSuggestion;
      handleSearchInputChange();
      return;
    }
  }

  // 3. Navigation/Editing keys
  if (key === "ArrowDown") {
    moveSelection(1);
    return;
  }
  if (key === "ArrowUp") {
    moveSelection(-1);
    return;
  }
  if (key === "ArrowLeft") {
    handleArrowLeft(ccSearchInput, isShift);
    return;
  }
  if (key === "ArrowRight") {
    handleArrowRight(ccSearchInput, isShift);
    return;
  }
  if (key === "Home") {
    handleHome(ccSearchInput, isShift);
    return;
  }
  if (key === "End") {
    handleEnd(ccSearchInput, isShift);
    return;
  }
  if (key === "Enter") {
    executeMainAction(isCtrlOrMeta || isAlt);
    return;
  }
  if (key === "Escape") {
    if (isSubmenuOpen) {
      closeSubmenu();
    } else {
      closeCommandPalette();
    }
    return;
  }
  if (key === "Delete") {
    triggerDeleteAction();
    return;
  }
  if (key === "Backspace") {
    if (!ccSearchInput.value) {
      if (currentCommandMode) {
        if (commandModeParams.step === "view_content") {
          delete commandModeParams.step;
          renderSearchResults("");
        } else if (commandModeParams.selectedNote) {
          delete commandModeParams.selectedNote;
          renderSearchResults("");
        } else if (commandModeParams.targetLang) {
          delete commandModeParams.targetLang;
          ccSearchInput.placeholder = "Select target language...";
          renderSearchResults("");
        } else {
          exitCommandMode();
        }
      }
    } else {
      saveUndoState();
      handleBackspace(ccSearchInput);
      handleSearchInputChange();
    }
    return;
  }

  // 4. Character typing
  if (key.length === 1 && !isCtrlOrMeta && !isAlt) {
    saveUndoState();
    insertTextAtCursor(ccSearchInput, key);
    handleSearchInputChange();
  }
}

// -------------------------------------------------------------
// COMMAND PALETTE UI TOGGLE
// -------------------------------------------------------------
function toggleCommandPalette() {
  const isNewTabPage = window.location.pathname.endsWith("newtab.html") || !!document.querySelector(".center-section");
  if (!ccRoot) {
    createCommandPalette();
  } else if (!ccRoot.isConnected) {
    (document.fullscreenElement || document.body || document.documentElement)?.appendChild(ccRoot);
  }
  if (isNewTabPage) {
    openCommandPalette();
    return;
  }
  const isActive = ccBackdrop.classList.contains("active");
  if (isActive) {
    closeCommandPalette();
  } else {
    openCommandPalette();
  }
}

function openCommandPalette() {
  ccRoot.style.pointerEvents = "auto";
  ccBackdrop.classList.add("active");
  ccSearchInput.value = "";
  selectedIndex = 0;
  activeQuery = "";
  isSubmenuOpen = false;
  ccSubmenu.classList.remove("active");
  exitCommandMode(false); // reset command mode
  
  if (document.activeElement && document.activeElement !== ccSearchInput && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  
  applyPaletteSettings();
  ccSearchInput.focus();
  requestAnimationFrame(() => ccSearchInput.focus());
  setTimeout(() => ccSearchInput.focus(), 50);
  setTimeout(() => ccSearchInput.focus(), 150);
  setTimeout(() => ccSearchInput.focus(), 350);

  // Sync recent clipboard clips
  DB.getClipboardHistory(10).then(clips => {
    clipboardHistoryCache = clips;
  });

  renderSearchResults("");
}

function closeCommandPalette() {
  const isNewTabPage = window.location.pathname.endsWith("newtab.html") || !!document.querySelector(".center-section");
  if (isNewTabPage) return;

  if (ccBackdrop) {
    ccBackdrop.classList.remove("active");
    ccRoot.style.pointerEvents = "none";
    ccSearchInput.blur();
    isSubmenuOpen = false;
    ccSubmenu.classList.remove("active");
    clearInterval(audioMeterInterval);
  }
}

// -------------------------------------------------------------
// COMMAND MODE TRIGGERS
// -------------------------------------------------------------
const CommandModeMetadata = {
  image_tools: { name: "Image Tools", icon: "🖼", placeholder: "Choose image subcommand..." },
  pdf_tools: { name: "PDF Tools", icon: "📄", placeholder: "Choose PDF subcommand..." },
  note_tools: { name: "Notes", icon: "📝", placeholder: "Create or search notes..." },
  boost_tools: { name: "Volume Boost", icon: "🔊", placeholder: "Select boost level..." },
  timer_tools: { name: "Timer", icon: "⏱", placeholder: "Set timer interval..." },
  translate_tools: { name: "Translate", icon: "🗣", placeholder: "Select source language..." },
  help_tools: { name: "Help & Guide", icon: "💡", placeholder: "Browse guide..." },
  bookmark_tools: { name: "Bookmarks", icon: "🔖", placeholder: "Search bookmarks..." },
  download_tools: { name: "Downloads", icon: "📥", placeholder: "Search downloads..." },
  history_tools: { name: "History", icon: "📜", placeholder: "Search history..." },
  tab_tools: { name: "Tabs", icon: "📑", placeholder: "Search active tabs..." },
  mappings_tools: { name: "Mappings", icon: "🔗", placeholder: "Add: <keyword> <label> <url>..." },
  settings_tools: { name: "Settings", icon: "⚙️", placeholder: "Configure palette settings..." }
};

function enterCommandMode(modeId, initialParams = {}) {
  currentCommandMode = modeId;
  commandModeParams = { ...initialParams };
  selectedIndex = 0;

  const metadata = CommandModeMetadata[modeId];
  if (metadata) {
    ccBackBtn.classList.remove("hidden");
    ccCommandTagContainer.innerHTML = `
      <div class="cc-command-pill">
        <span>${metadata.icon}</span>
        <span>${metadata.name}</span>
      </div>
    `;
    ccSearchInput.value = "";
    ccSearchInput.style.color = "#ffffff";
    ccSearchInput.placeholder = metadata.placeholder;
    activeQuery = "";

    // Set search icon based on command mode
    let iconType = "search";
    if (modeId === "bookmark_tools") iconType = "bookmark";
    else if (modeId === "history_tools") iconType = "history";
    else if (modeId === "tab_tools") iconType = "tab";
    else if (modeId === "mappings_tools") iconType = "mapping";
    updateSearchIcon(iconType);
  }
  
  // Clear autocomplete suggestion
  activeSuggestion = "";
  const shadowEl = ccBackdrop ? ccBackdrop.querySelector(".cc-autocomplete-shadow") : null;
  if (shadowEl) shadowEl.innerHTML = "";

  ccSearchInput.focus();
  renderSearchResults("");
}

function exitCommandMode(refresh = true) {
  currentCommandMode = null;
  commandModeParams = {};
  selectedIndex = 0;

  if (ccBackBtn) ccBackBtn.classList.add("hidden");
  if (ccCommandTagContainer) ccCommandTagContainer.innerHTML = "";
  if (ccSearchInput) {
    ccSearchInput.placeholder = "Search...";
    ccSearchInput.value = "";
    ccSearchInput.style.color = "#ffffff";
  }

  updateSearchIcon("search");

  // Clear autocomplete suggestion
  activeSuggestion = "";
  const shadowEl = ccBackdrop ? ccBackdrop.querySelector(".cc-autocomplete-shadow") : null;
  if (shadowEl) shadowEl.innerHTML = "";

  if (refresh) {
    ccSearchInput.focus();
    renderSearchResults("");
  }
}

// -------------------------------------------------------------
// CREATE PALETTE ELEMENT (SHADOW DOM)
// -------------------------------------------------------------
function createCommandPalette() {
  const isNewTabPage = window.location.pathname.endsWith("newtab.html") || !!document.querySelector(".center-section");

  ccRoot = document.createElement("div");
  ccRoot.id = "smart-command-palette-root";
  if (isNewTabPage) {
    ccRoot.style.cssText = "width:100%; max-width:600px; display:flex; align-items:center; justify-content:center; pointer-events:auto;";
    const placeholder = document.getElementById("palette-placeholder");
    if (placeholder) {
      placeholder.appendChild(ccRoot);
    } else {
      const centerSection = document.querySelector(".center-section");
      if (centerSection) {
        centerSection.appendChild(ccRoot);
      } else {
        document.body.appendChild(ccRoot);
      }
    }
  } else {
    ccRoot.style.cssText = "position:fixed; top:0; left:0; width:100vw; height:100vh; z-index:2147483647; pointer-events:none;";
    document.body.appendChild(ccRoot);
  }

  ccShadow = ccRoot.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap');
    
    :host {
      all: initial;
    }
    /* Sleek custom scrollbars */
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.12);
      border-radius: 10px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.25);
    }
    .cc-backdrop {
      --cc-width: 600px;
      --cc-font-size-base: 13px;
      --cc-accent-color: #8b5cf6;
      --cc-accent-gradient: linear-gradient(135deg, #a78bfa, #8b5cf6);
      --cc-backdrop-blur: 8px;
      --cc-max-results: 8;

      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(4, 5, 8, 0.45);
      backdrop-filter: blur(var(--cc-backdrop-blur));
      -webkit-backdrop-filter: blur(var(--cc-backdrop-blur));
      z-index: 2147483647;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding-top: 15vh;
      box-sizing: border-box;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.16s ease-out;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #f3f4f6;
      font-size: var(--cc-font-size-base);
    }
    .cc-backdrop.active {
      opacity: 1;
      pointer-events: auto;
    }
    .cc-backdrop.cc-embedded {
      position: static;
      width: 100%;
      height: auto;
      max-height: 500px;
      background: transparent;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      opacity: 1 !important;
      pointer-events: auto !important;
      display: flex;
      align-items: flex-start;
      padding-top: 0;
    }
    .cc-backdrop.cc-embedded .cc-modal {
      transform: scale(1) !important;
      transition: none !important;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }
    .cc-backdrop.cc-embedded .cc-close {
      display: none !important;
    }
    .cc-modal {
      width: var(--cc-width);
      max-height: 90vh;
      background: #0e111a; /* Solid dark blue-slate */
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.08);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transform: scale(0.96);
      transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
    }
    .cc-backdrop.active .cc-modal {
      transform: scale(1);
    }
    .cc-header {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      padding: 12px 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      gap: 10px;
    }
    .cc-header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      width: 100%;
    }
    .cc-header-bottom {
      display: flex;
      align-items: center;
      width: 100%;
      gap: 10px;
    }
    .cc-back-btn {
      cursor: pointer;
      font-size: 18px;
      font-weight: 500;
      color: #9ca3af;
      padding: 0 8px;
      display: flex;
      align-items: center;
      border-radius: 4px;
      transition: background 0.15s, color 0.15s;
    }
    .cc-back-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
    }
    .cc-back-btn.hidden {
      display: none;
    }
    .cc-command-tag-container {
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }
    .cc-command-pill {
      display: inline-flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--cc-accent-color);
      color: var(--cc-accent-color);
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 600;
      gap: 6px;
    }
    .cc-logo {
      color: #9ca3af;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .cc-search-input {
      flex-grow: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #ffffff;
      font-size: calc(var(--cc-font-size-base, 13px) + 2px);
      font-family: inherit;
      height: 24px;
      line-height: 24px;
      padding: 0;
      margin: 0;
    }
    .cc-search-input::placeholder {
      color: #4b5563;
    }
    .cc-close {
      cursor: pointer;
      color: rgba(255, 255, 255, 0.3);
      font-size: 14px;
      transition: color 0.15s;
    }
    .cc-close:hover {
      color: #ef4444;
    }
    .cc-content-pane {
      display: flex;
      flex-direction: row;
      position: relative;
      overflow: hidden;
    }
    .cc-results-container {
      flex: 1;
      height: calc(52px * 5 + 30px);
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 8px 0;
      display: block;
      min-width: 0;
    }
    .cc-group-header {
      font-size: calc(var(--cc-font-size-base, 13px) - 2px);
      font-weight: 600;
      color: #5f6e85;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      padding: 8px 18px 4px 18px;
    }
    .cc-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 18px;
      background: transparent;
      cursor: pointer;
      transition: background 0.1s ease;
    }
    .cc-item.selected {
      background: rgba(255, 255, 255, 0.04);
      box-shadow: inset 3px 0 0 var(--cc-accent-color);
    }
    .cc-item-left {
      display: flex;
      align-items: center;
      gap: 12px;
      overflow: hidden;
    }
    .cc-item-icon {
      color: #6b7280;
      display: flex;
      align-items: center;
      width: 16px;
      justify-content: center;
      flex-shrink: 0;
    }
    .cc-item.selected .cc-item-icon {
      color: #9ca3af;
    }
    .cc-item-title-wrap {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .cc-item-title {
      font-size: calc(var(--cc-font-size-base, 13px) + 0.5px);
      font-weight: 500;
      color: #d1d5db;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cc-item.selected .cc-item-title {
      color: #ffffff;
    }
    .cc-item-subtitle {
      font-size: calc(var(--cc-font-size-base, 13px) - 2px);
      color: #4b5563;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cc-item-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .cc-kbd-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.04);
      color: rgba(255, 255, 255, 0.4);
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 10px;
      font-family: inherit;
    }
    .cc-badge {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.04);
      color: rgba(255, 255, 255, 0.4);
    }
    
    .cc-empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #4b5563;
      font-size: 13px;
      gap: 4px;
    }
    .hidden {
      display: none !important;
    }
    .cc-submenu {
      width: 0px;
      height: 100%;
      background: #0b0d14;
      border-left: 0px solid rgba(255, 255, 255, 0.06);
      transition: all 0.18s ease;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .cc-submenu.active {
      width: 220px;
      border-left: 1px solid rgba(255, 255, 255, 0.08);
    }
    .cc-submenu-title {
      padding: 14px 16px;
      font-size: 11px;
      font-weight: 600;
      color: #5f6e85;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .cc-submenu-list {
      flex-grow: 1;
      overflow-y: auto;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .cc-submenu-item {
      display: flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 12.5px;
      cursor: pointer;
      color: #9ca3af;
      gap: 8px;
    }
    .cc-submenu-item:hover {
      background: rgba(255, 255, 255, 0.05);
      color: #ffffff;
    }
    .cc-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 20px;
      background: #090b10;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 10.5px;
      color: #4b5563;
    }
    .cc-breadcrumbs {
      font-weight: 500;
      color: #6b7280;
      display: flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: calc(var(--cc-width, 600px) - 60px);
    }
    .cc-breadcrumb-badge {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 1px 6px;
      border-radius: 4px;
      color: #e2e8f0;
      margin-left: 6px;
      font-weight: 600;
      font-size: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 350px;
      display: inline-block;
      vertical-align: middle;
    }
    .cc-shortcuts {
      display: flex;
      gap: 12px;
    }
    .cc-shortcuts span {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 1px 5px;
      border-radius: 3px;
      color: #9ca3af;
    }
    
    .cc-audio-meter-panel {
      padding: 10px;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 8px;
      margin: 8px 18px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .cc-meter-row {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: #9ca3af;
    }
    .cc-meter-bar-outer {
      height: 4px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      overflow: hidden;
    }
    .cc-meter-bar-inner {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #10b981, #f59e0b);
      transition: width 0.1s;
    }
    .cc-dropzone {
      border: 1px dashed rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      padding: 18px;
      text-align: center;
      color: #6b7280;
      cursor: pointer;
      margin: 8px 18px;
    }
    .cc-dropzone.active {
      border-color: #8b5cf6;
      background: rgba(139, 92, 246, 0.03);
    }
    .cc-screenshot-crop {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0,0,0,0.3);
      z-index: 2147483645;
      cursor: crosshair;
    }
    .cc-canvas-draw-overlay {
      position: fixed;
      top: 8%;
      left: 8%;
      width: 84%;
      height: 84%;
      background: #0e111a;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.8);
      z-index: 2147483646;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .cc-input-container {
      position: relative;
      flex-grow: 1;
      display: flex;
      align-items: center;
    }
    .cc-autocomplete-shadow {
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      color: rgba(255, 255, 255, 0.25);
      font-size: calc(var(--cc-font-size-base, 13px) + 2px);
      font-family: inherit;
      pointer-events: none;
      white-space: pre;
      line-height: 24px;
      height: 24px;
      font-weight: 400;
      padding: 0;
      margin: 0;
    }
  `;
  ccShadow.appendChild(style);

  ccBackdrop = document.createElement("div");
  ccBackdrop.className = "cc-backdrop";
  if (isNewTabPage) {
    ccBackdrop.classList.add("cc-embedded");
  }

  ccBackdrop.innerHTML = `
    <div class="cc-modal">
      <div class="cc-header">
        <div class="cc-header-top">
          <div class="cc-breadcrumbs">Command Palette</div>
          <span class="cc-close">✕</span>
        </div>
        <div class="cc-header-bottom">
          <div class="cc-back-btn hidden">‹</div>
          <div class="cc-command-tag-container"></div>
          <span class="cc-logo">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          </span>
          <div class="cc-input-container">
            <span class="cc-autocomplete-shadow"></span>
            <input class="cc-search-input" placeholder="Search..." autocomplete="off" autofocus>
          </div>
        </div>
      </div>
      <div class="cc-content-pane">
        <div class="cc-results-container">
          <div class="cc-group-header">Recent searches</div>
          <div class="cc-results-list"></div>
          <div class="cc-empty-state hidden">
            <span>No results found</span>
          </div>
        </div>
        <div class="cc-submenu">
          <div class="cc-submenu-title">Actions</div>
          <div class="cc-submenu-list"></div>
        </div>
      </div>
      <div class="cc-footer">
        <div class="cc-shortcuts">
          <span>↑↓ Navigate</span>
          <span>↵ Run</span>
          <span>Alt+Enter New Tab</span>
          <span>Alt+K Actions</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  `;

  ccShadow.appendChild(ccBackdrop);

  // Bind UI Elements
  ccSearchInput = ccBackdrop.querySelector(".cc-search-input");
  ccResultsList = ccBackdrop.querySelector(".cc-results-container");
  ccEmptyState = ccBackdrop.querySelector(".cc-empty-state");
  ccBreadcrumbs = ccBackdrop.querySelector(".cc-breadcrumbs");
  ccSubmenu = ccBackdrop.querySelector(".cc-submenu");
  ccBackBtn = ccBackdrop.querySelector(".cc-back-btn");
  ccCommandTagContainer = ccBackdrop.querySelector(".cc-command-tag-container");

  setupUIEventListeners();
  applyPaletteSettings();
}

// -------------------------------------------------------------
// EVENT BINDINGS
// -------------------------------------------------------------
function setupUIEventListeners() {
  // Backdrop close click
  ccBackdrop.addEventListener("click", (e) => {
    if (e.target === ccBackdrop) closeCommandPalette();
  });

  // Close icon click
  ccBackdrop.querySelector(".cc-close").addEventListener("click", closeCommandPalette);

  // Back button click
  ccBackBtn.addEventListener("click", () => {
    exitCommandMode();
  });

  // Intercept image pastes in the search input to open in Image Studio
  ccSearchInput.addEventListener("paste", async (e) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image") !== -1) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = async (event) => {
          const base64 = event.target.result;
          chrome.storage.local.set({
            temp_pasted_image: base64,
            temp_pasted_image_name: file.name || "pasted_image.png"
          }, () => {
            window.open(chrome.runtime.getURL("image.html"), "_blank");
            closeCommandPalette();
          });
        };
        reader.readAsDataURL(file);
        return;
      }
    }
  });
}

function updateSearchIcon(type) {
  const logoEl = ccBackdrop ? ccBackdrop.querySelector(".cc-logo") : null;
  if (!logoEl) return;
  
  let iconHtml = Icons.search;
  if (type === "mapping_redirect" || type === "mapping") {
    iconHtml = Icons.globe;
  } else if (type === "bookmark") {
    iconHtml = Icons.tag;
  } else if (type === "history") {
    iconHtml = Icons.clock;
  } else if (type === "tab") {
    iconHtml = Icons.globe;
  }
  
  logoEl.innerHTML = iconHtml;
}

function closeSubmenu() {
  isSubmenuOpen = false;
  ccSubmenu.classList.remove("active");
  ccSearchInput.focus();
}

function toggleSubmenu() {
  if (visibleItems.length === 0) return;
  isSubmenuOpen = !isSubmenuOpen;
  if (isSubmenuOpen) {
    ccSubmenu.classList.add("active");
    renderSubmenuActions();
  } else {
    ccSubmenu.classList.remove("active");
    ccSearchInput.focus();
  }
}

// -------------------------------------------------------------
// FUZZY SEARCH ENGINE & ROUTER
// -------------------------------------------------------------
async function handleSearchChange(query) {
  activeQuery = query;
  selectedIndex = 0;
  closeSubmenu();

  // "Auto-trigger command mode" if user types aliases directly and hits Space
  const cleanQ = query.trim().toLowerCase();
  
  if (!currentCommandMode) {
    if (cleanQ === "/image") {
      window.open(chrome.runtime.getURL("image.html"), "_blank");
      closeCommandPalette();
      return;
    } else if (cleanQ === "/pdf") {
      window.open(chrome.runtime.getURL("pdf.html"), "_blank");
      closeCommandPalette();
      return;
    } else if (cleanQ === "/note") {
      enterCommandMode("note_tools");
      return;
    } else if (cleanQ === "/boost") {
      enterCommandMode("boost_tools");
      return;
    } else if (cleanQ === "/timer") {
      enterCommandMode("timer_tools");
      return;
    } else if (cleanQ === "/translate") {
      enterCommandMode("translate_tools");
      return;
    } else if (cleanQ === "/help") {
      enterCommandMode("help_tools");
      return;
    } else if (cleanQ === "/wizard") {
      chrome.runtime.sendMessage({ action: "open_dashboard", view: "wizard" });
      closeCommandPalette();
      return;
    } else if (cleanQ === "/bookmarks") {
      enterCommandMode("bookmark_tools");
      return;
    } else if (cleanQ === "/downloads") {
      enterCommandMode("download_tools");
      return;
    } else if (cleanQ === "/history") {
      enterCommandMode("history_tools");
      return;
    } else if (cleanQ === "/tabs") {
      enterCommandMode("tab_tools");
      return;
    } else if (cleanQ === "/mappings") {
      enterCommandMode("mappings_tools");
      return;
    } else if (cleanQ === "/settings") {
      enterCommandMode("settings_tools");
      return;
    }
  }

  await renderSearchResults(activeQuery);
}

// Define dynamic vector icons
const Icons = {
  search: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  folder: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
  file: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`,
  globe: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
  hash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>`,
  tag: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>`,
  download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  clock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
  volume: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`,
  crop: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"></path><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"></path></svg>`
};

function matchCommandAlias(query) {
  const clean = query.trim().toLowerCase();
  const firstSpace = clean.indexOf(" ");
  
  let firstWord = firstSpace === -1 ? clean : clean.substring(0, firstSpace);
  if (firstWord.startsWith("/")) {
    firstWord = firstWord.substring(1);
  }
  
  if (!firstWord) return null;
  
  for (const cmd of CommandRegistry.getAll()) {
    const aliases = cmd.aliases || [];
    if (cmd.id.toLowerCase() === firstWord || aliases.some(a => a.toLowerCase() === firstWord)) {
      const arg = firstSpace === -1 ? "" : query.substring(firstSpace + 1).trim();
      return { command: cmd, arg: arg };
    }
  }
  return null;
}

async function renderSearchResults(query) {
  const requestId = ++currentSearchRequestId;
  const startedInMode = currentCommandMode;
  
  let scored = [];
  const qClean = query.trim().toLowerCase();

  // --- CASE A: COMMAND SUB-MENU PARAMETERS MODE ---
  if (currentCommandMode) {
    scored = await getCommandModeCandidates(currentCommandMode, qClean);
  } else {
    if (!qClean) {
      let candidates = CommandRegistry.getAll().map(cmd => ({
        id: cmd.id,
        title: cmd.name,
        subtitle: cmd.description,
        icon: cmd.icon || Icons.search,
        type: "command",
        aliases: cmd.aliases || [],
        execute: cmd.execute,
        pinned: cmd.pinned || false,
        favorite: cmd.favorite || false
      }));
      
      // Add custom account mappings
      let mappingsObj = await DB.get("settings", "account_mappings");
      let mappings = mappingsObj ? mappingsObj.value : [];
      
      // Add default mappings for Gmail if none exist
      if (mappings.length === 0) {
        mappings = [
          { id: "gmail_personal", keyword: "gmail", label: "personal", url: "https://mail.google.com/mail/u/0/" },
          { id: "gmail_work", keyword: "gmail", label: "work", url: "https://mail.google.com/mail/u/1/" },
          { id: "gmail_0", keyword: "gmail", label: "0", url: "https://mail.google.com/mail/u/0/" },
          { id: "gmail_1", keyword: "gmail", label: "1", url: "https://mail.google.com/mail/u/1/" }
        ];
        // Save default ones
        await DB.put("settings", { key: "account_mappings", value: mappings });
      }

      mappings.forEach(m => {
        candidates.push({
          id: "mapping_root_" + m.id,
          title: `${m.keyword} (${m.label})`,
          subtitle: `Redirect to: ${m.url}`,
          icon: Icons.globe,
          type: "mapping_redirect",
          mappingData: m,
          aliases: [m.keyword, `${m.keyword} ${m.label}`]
        });
      });

      let notesResults = [];
      // Query local notes from DB
      const notes = await DB.getNotes();
      notes.forEach(note => {
        notesResults.push({
          id: "note_" + note.id,
          title: note.title,
          subtitle: `Notes • ${note.content.substring(0, 50)}`,
          icon: Icons.file,
          type: "note",
          noteData: note,
          pinned: note.pinned,
          favorite: note.favorite
        });
      });

      const allCandidates = [
        ...candidates,
        ...notesResults
      ];

      scored = allCandidates.map(item => ({ ...item, score: 1 }));

      // Sort: Pinned > Favorite
      scored.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        if (a.favorite && !b.favorite) return -1;
        if (!a.favorite && b.favorite) return 1;
        return 0;
      });
    } else {
      let results = [];

      const cmdMatch = matchCommandAlias(query);
      if (cmdMatch) {
        const cmd = cmdMatch.command;
        const arg = cmdMatch.arg;
        
        let title = `Run command: ${cmd.name}`;
        if (arg) {
          title = `Search ${cmd.name.replace("Search ", "")} for "${arg}"`;
        }
        
        results.push({
          id: "cmd_run_" + cmd.id,
          title: title,
          subtitle: cmd.description,
          icon: cmd.icon || Icons.globe,
          type: "command",
          execute: () => {
            activeQuery = query;
            cmd.execute();
          },
          score: 1000
        });

        // Add Google search fallback as secondary option
        results.push({
          id: "google_search_fallback",
          title: `Search Google for "${query}"`,
          subtitle: "Search web using Google",
          icon: Icons.search,
          type: "google_search",
          searchQuery: query,
          score: 1
        });
      } else {
        // A. Mappings Search
        let mappingsObj = await DB.get("settings", "account_mappings");
        let mappings = mappingsObj ? mappingsObj.value : [];
        if (mappings.length === 0) {
          mappings = [
            { id: "gmail_personal", keyword: "gmail", label: "personal", url: "https://mail.google.com/mail/u/0/" },
            { id: "gmail_work", keyword: "gmail", label: "work", url: "https://mail.google.com/mail/u/1/" },
            { id: "gmail_0", keyword: "gmail", label: "0", url: "https://mail.google.com/mail/u/0/" },
            { id: "gmail_1", keyword: "gmail", label: "1", url: "https://mail.google.com/mail/u/1/" }
          ];
          await DB.put("settings", { key: "account_mappings", value: mappings });
        }

        let mappingCandidates = [];
        mappings.forEach(m => {
          const title = `${m.keyword} (${m.label})`;
          const subtitle = `Redirect to: ${m.url}`;
          const titleLower = title.toLowerCase();
          const subLower = subtitle.toLowerCase();
          const kwLower = m.keyword.toLowerCase();
          let score = 0;
          if (titleLower === qClean) score += 100;
          else if (titleLower.startsWith(qClean)) score += 80;
          else if (titleLower.includes(qClean)) score += 50;
          else if (subLower.includes(qClean)) score += 20;
          else if (kwLower.includes(qClean)) score += 60;

          if (score > 0) {
            mappingCandidates.push({
              id: "mapping_root_" + m.id,
              title: title,
              subtitle: subtitle,
              icon: Icons.globe,
              type: "mapping_redirect",
              mappingData: m,
              aliases: [m.keyword, `${m.keyword} ${m.label}`],
              score: score
            });
          }
        });

        if (mappingCandidates.length > 0) {
          mappingCandidates.sort((a, b) => b.score - a.score);
          results = mappingCandidates;
        } else {
          // B. Bookmarks Search
          const bkList = await new Promise(res => chrome.runtime.sendMessage({ action: "get_bookmarks_tree" }, res));
          if (requestId !== currentSearchRequestId || currentCommandMode !== startedInMode) return;

          let bookmarkCandidates = [];
          function traverseSearch(node) {
            if (node.url) {
              const title = node.title || node.url;
              const url = node.url;
              const titleLower = title.toLowerCase();
              const urlLower = url.toLowerCase();
              let score = 0;
              if (titleLower === qClean) score += 100;
              else if (titleLower.startsWith(qClean)) score += 80;
              else if (titleLower.includes(qClean)) score += 50;
              else if (urlLower.includes(qClean)) score += 20;

              if (score > 0) {
                bookmarkCandidates.push({
                  id: "bm_" + node.id,
                  title: title,
                  subtitle: `Bookmark • ${url}`,
                  icon: Icons.tag,
                  type: "bookmark",
                  bmData: node,
                  score: score
                });
              }
            }
            if (node.children) node.children.forEach(traverseSearch);
          }
          if (bkList && bkList[0]) traverseSearch(bkList[0]);

          if (bookmarkCandidates.length > 0) {
            bookmarkCandidates.sort((a, b) => b.score - a.score);
            results = bookmarkCandidates;
          } else {
            // C. History Search
            const histList = await new Promise(res => chrome.runtime.sendMessage({ action: "search_history", query: query }, res));
            if (requestId !== currentSearchRequestId || currentCommandMode !== startedInMode) return;

            let historyCandidates = [];
            if (histList && Array.isArray(histList)) {
              histList.forEach(h => {
                const title = h.title || h.url;
                const url = h.url;
                const titleLower = title.toLowerCase();
                const urlLower = url.toLowerCase();
                let score = 0;
                if (titleLower === qClean) score += 100;
                else if (titleLower.startsWith(qClean)) score += 80;
                else if (titleLower.includes(qClean)) score += 50;
                else if (urlLower.includes(qClean)) score += 20;

                if (score > 0) {
                  historyCandidates.push({
                    id: h.id,
                    title: title,
                    subtitle: `History • ${url}`,
                    icon: Icons.clock,
                    type: "history",
                    histData: h,
                    score: score
                  });
                }
              });
            }

            if (historyCandidates.length > 0) {
              historyCandidates.sort((a, b) => b.score - a.score);
              results = historyCandidates;
            } else {
              // D. Active Tabs Search
              const tabsList = await new Promise(res => chrome.runtime.sendMessage({ action: "get_tabs" }, res));
              if (requestId !== currentSearchRequestId || currentCommandMode !== startedInMode) return;

              let tabCandidates = [];
              if (tabsList && Array.isArray(tabsList)) {
                tabsList.forEach(t => {
                  const title = t.title || "Tab";
                  const url = t.url || "";
                  const titleLower = title.toLowerCase();
                  const urlLower = url.toLowerCase();
                  let score = 0;
                  if (titleLower === qClean) score += 100;
                  else if (titleLower.startsWith(qClean)) score += 80;
                  else if (titleLower.includes(qClean)) score += 50;
                  else if (urlLower.includes(qClean)) score += 20;

                  if (score > 0) {
                    tabCandidates.push({
                      id: "tab_" + t.id,
                      title: title,
                      subtitle: `Active Tab • ${url}`,
                      icon: Icons.globe,
                      type: "tab",
                      tabData: t,
                      score: score
                    });
                  }
                });
              }

              if (tabCandidates.length > 0) {
                tabCandidates.sort((a, b) => b.score - a.score);
                results = tabCandidates;
              }
            }
          }
        }
        
        // Always append Google Search Fallback if there is a query
        results.push({
          id: "google_search_fallback",
          title: `Search Google for "${query}"`,
          subtitle: "Search web using Google",
          icon: Icons.search,
          type: "google_search",
          searchQuery: query,
          score: 1
        });
      }

      scored = results;
    }
  }

  // Safety Check before Rendering
  if (requestId !== currentSearchRequestId || currentCommandMode !== startedInMode) return;

  visibleItems = scored;
  renderResultsUI();
  updateAutocompleteShadow(query);

  // Dynamic search icon based on search results type
  if (visibleItems.length > 0) {
    const firstType = visibleItems[0].type;
    updateSearchIcon(firstType);
  } else {
    updateSearchIcon("search");
  }
}

function updateAutocompleteShadow(query) {
  const shadowEl = ccBackdrop ? ccBackdrop.querySelector(".cc-autocomplete-shadow") : null;
  if (!shadowEl) return;
  
  activeSuggestion = "";
  shadowEl.innerHTML = "";
  
  if (!query) return;

  const qLower = query.toLowerCase();

  // Find matches from CommandRegistry aliases first
  for (const cmd of CommandRegistry.getAll()) {
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        const slashAlias = "/" + alias;
        if (slashAlias.startsWith(qLower) && slashAlias !== qLower) {
          activeSuggestion = query + slashAlias.substring(query.length);
          break;
        } else if (alias.startsWith(qLower) && alias !== qLower) {
          activeSuggestion = query + alias.substring(query.length);
          break;
        }
      }
    }
    if (activeSuggestion) break;
  }

  // If no alias match, check top visible item title
  if (!activeSuggestion && visibleItems[0]) {
    const topTitle = visibleItems[0].title.toLowerCase();
    const topClean = topTitle.startsWith("/") ? topTitle : "/" + topTitle;
    
    if (topTitle.startsWith(qLower) && topTitle !== qLower) {
      activeSuggestion = query + visibleItems[0].title.substring(query.length);
    } else if (topClean.startsWith(qLower) && topClean !== qLower) {
      activeSuggestion = query + (visibleItems[0].title.startsWith("/") ? "" : "/") + visibleItems[0].title.substring(qLower.startsWith("/") ? query.length : query.length + 1);
    }
  }

  if (activeSuggestion) {
    shadowEl.innerHTML = `<span style="color:transparent">${query}</span><span>${activeSuggestion.substring(query.length)}</span>`;
  }
}

// -------------------------------------------------------------
// GET CANDIDATES FOR COMMAND MODES
// -------------------------------------------------------------
async function getCommandModeCandidates(modeId, filter) {
  let list = [];

  try {
    switch (modeId) {
    case "image_tools":
      if (commandModeParams.step === "resize") {
        list = [
          { id: "img_res_800", title: "Scale to 800px Width", subtitle: "Maintains proportional height", icon: Icons.crop, type: "subaction", run: () => runImageResizer(800) },
          { id: "img_res_1200", title: "Scale to 1200px Width", subtitle: "Proportional scaling", icon: Icons.crop, type: "subaction", run: () => runImageResizer(1200) },
          { id: "img_res_1080p", title: "Full HD (1920x1080)", subtitle: "Crops/stretches to standard display", icon: Icons.crop, type: "subaction", run: () => runImageResizer(1920, 1080) },
          { id: "img_res_50", title: "Scale down by 50%", subtitle: "Halves image resolution", icon: Icons.crop, type: "subaction", run: () => runImageResizer(0.5) }
        ];
      } else {
        list = [
          { id: "cmd_clip_dl", title: "Download Clipboard Image", subtitle: "Extract and download any copied image file", icon: Icons.download, type: "subaction", run: () => executeDirectCommand("clipboard_download") },
          { id: "cmd_clip_resize", title: "Resize Clipboard Image...", subtitle: "Select dimensions and scaling properties", icon: Icons.crop, type: "subaction", run: () => { commandModeParams.step = "resize"; renderSearchResults(""); } },
          { id: "cmd_clip_webp", title: "Convert to WebP format", subtitle: "Re-save copied image as WebP", icon: Icons.globe, type: "subaction", run: () => executeDirectCommand("clipboard_image_convert", "webp") },
          { id: "cmd_clip_png", title: "Convert to PNG format", subtitle: "Re-save copied image as PNG", icon: Icons.file, type: "subaction", run: () => executeDirectCommand("clipboard_image_convert", "png") },
          { id: "cmd_clip_jpg", title: "Convert to JPG format", subtitle: "Re-save copied image as JPG", icon: Icons.tag, type: "subaction", run: () => executeDirectCommand("clipboard_image_convert", "jpg") }
        ];
      }
      break;

    case "pdf_tools":
      list = [
        { id: "cmd_pdf_compress", title: "Compress PDF Document", subtitle: "Reduces size using native streams", icon: Icons.file, type: "subaction", run: () => executeDirectCommand("pdf_compressor") },
        { id: "cmd_pdf_merge", title: "Merge PDF Documents (Bulk Join)", subtitle: "Merges multiple local PDF files", icon: Icons.folder, type: "subaction", run: () => executeDirectCommand("pdf_merge") }
      ];
      break;

    case "note_tools":
      if (commandModeParams.step === "view_content") {
        const noteTitle = commandModeParams.selectedNote;
        const note = await DB.get("notes", noteTitle);
        const content = note ? note.content : "(empty)";
        list = [
          { id: "note_view_back", title: "‹ Back to Note Actions", subtitle: "Return to note options list", icon: Icons.crop, type: "subaction", run: () => { delete commandModeParams.step; renderSearchResults(""); } },
          { id: "note_text_display", title: noteTitle, subtitle: content, icon: Icons.file, type: "static_text" }
        ];
      } else if (commandModeParams.selectedNote) {
        const noteTitle = commandModeParams.selectedNote;
        list = [
          { id: "note_act_append", title: `Append text to "${noteTitle}"`, subtitle: "Type content in search input and run", icon: Icons.file, type: "subaction", run: () => appendNoteFromInput(noteTitle) },
          { id: "note_act_view", title: `View Note content`, subtitle: "View note content directly inside palette", icon: Icons.search, type: "subaction", run: () => viewNoteContent(noteTitle) },
          { id: "note_act_del", title: `Delete Note`, subtitle: "Permanently erase this note", icon: Icons.close, type: "subaction", run: () => deleteNoteFromMode(noteTitle) }
        ];
      } else {
        list = [
          { id: "note_act_new", title: "🆕 Create New Note", subtitle: "Creates note using query as title", icon: Icons.file, type: "subaction", run: () => createNoteFromInput() }
        ];
        const notes = await DB.getNotes();
        notes.forEach(n => {
          list.push({
            id: "note_select_" + n.id,
            title: `📝 Note: ${n.title}`,
            subtitle: `Contains: ${n.content.substring(0, 40)}...`,
            icon: Icons.file,
            type: "subaction",
            run: () => {
              commandModeParams.selectedNote = n.title;
              renderSearchResults("");
            }
          });
        });
      }
      break;

    case "boost_tools":
      list = [
        { id: "boost_lvl_100", title: "Boost to 100% (Default)", subtitle: "Standard audio level", icon: Icons.volume, type: "subaction", run: () => runAudioBoost(100) },
        { id: "boost_lvl_150", title: "Boost to 150%", subtitle: "Adds clean volume boost", icon: Icons.volume, type: "subaction", run: () => runAudioBoost(150) },
        { id: "boost_lvl_200", title: "Boost to 200%", subtitle: "Ideal for quiet media", icon: Icons.volume, type: "subaction", run: () => runAudioBoost(200) },
        { id: "boost_lvl_250", title: "Boost to 250%", subtitle: "Loud volume", icon: Icons.volume, type: "subaction", run: () => runAudioBoost(250) },
        { id: "boost_lvl_300", title: "Boost to 300% (Maximum)", subtitle: "Safety compressor active", icon: Icons.volume, type: "subaction", run: () => runAudioBoost(300) }
      ];
      break;

    case "timer_tools":
      list = [
        { id: "timer_int_5", title: "5 Minute Timer", subtitle: "Set custom timer", icon: Icons.clock, type: "subaction", run: () => runTimer(5, "5 Min Timer") },
        { id: "timer_int_10", title: "10 Minute Timer", subtitle: "Set custom timer", icon: Icons.clock, type: "subaction", run: () => runTimer(10, "10 Min Timer") },
        { id: "timer_int_25", title: "25 Minute Pomodoro", subtitle: "Focused session timer", icon: Icons.clock, type: "subaction", run: () => runTimer(25, "Pomodoro Session") },
        { id: "timer_int_60", title: "1 Hour Timer", subtitle: "Long interval countdown", icon: Icons.clock, type: "subaction", run: () => runTimer(60, "1 Hour Timer") },
        { id: "timer_int_cust", title: "Custom Timer", subtitle: "Type minutes inside search input and select", icon: Icons.clock, type: "subaction", run: () => runCustomTimer() }
      ];
      break;

    case "translate_tools":
      if (commandModeParams.sourceLang) {
        list = [
          { id: "trans_exec", title: `Translate ${commandModeParams.sourceLang.toUpperCase()} to ENGLISH`, subtitle: "Type phrase in search input and execute", icon: Icons.globe, type: "subaction", run: () => runTranslateText() }
        ];
      } else {
        const langs = ["French", "Spanish", "Japanese", "German", "Chinese", "Hindi", "Russian", "Auto-Detect"];
        langs.forEach(l => {
          list.push({
            id: "trans_lang_" + l.toLowerCase(),
            title: `🗣 Translate ${l} to English`,
            subtitle: "Select source language",
            icon: Icons.globe,
            type: "subaction",
            run: () => {
              commandModeParams.sourceLang = l.toLowerCase();
              ccSearchInput.placeholder = `Type ${l} text to translate to English...`;
              renderSearchResults("");
            }
          });
        });
      }
      break;

    case "help_tools":
      const guideText = `SMART COMMAND PALETTE GUIDE

--- GLOBAL SHORTCUTS ---
• Alt+A           : Open / Close Palette Overlay
• Ctrl+Shift+P    : Alternative Open hotkey
• Alt+Shift+A     : Auto-fill Form Fields with Profile
• Alt+C           : Capture Video Frame (Downloads playing video frame)

--- PALETTE NAVIGATION ---
• Up / Down Arrow : Navigate results list
• Enter           : Execute / Run action
• Alt+Enter       : Open result in new browser tab
• Alt+K           : Open sliding Action Sheet (for advanced options)
• Backspace       : Exit sub-command modes / Go back
• Esc             : Close palette

--- BUILT-IN WORKSPACES & TOOLS ---
Type these prefixes directly into the search bar:
• /image         : Open Image Editor (Resize, format conversion, etc.)
• /pdf           : Open PDF Workspace (Merge, compress, split, rotate, convert)
• /note          : Note Manager (Create, edit, copy notes inline)
• /boost         : Volume Booster (Set gain from 100% to 300% for active tab)
• /timer         : Start countdown or Pomodoro timer (e.g., timer 25)
• /translate     : Translate text inline (e.g., translate hello to french)
• /bookmarks     : Search, edit, and manage browser bookmarks
• /history       : Search browser history
• /downloads     : Search and open downloaded files
• /tabs          : Switch, pin, mute, or close active browser tabs
• /mappings      : Manage custom keyword to URL shortcuts (e.g., add: g https://google.com)
• /wizard        : Open the Smart Bookmark Sorter Onboarding Wizard
• /collections   : Browse custom workspace collections

--- MEDIA SEARCH SHORTCUTS ---
Quickly search media sites directly from the palette:
• /youtube <q>  : Search YouTube
• /twitch <q>   : Search Twitch streaming media
• /mkvdrama <q> : Search MKV Drama series
• /bollyflix <q>: Search Bollyflix catalog
• /katmovies <q>: Search KatMovieHD catalog

--- BOOKMARK EXPLORER (DASHBOARD) ---
When inside the full Dashboard Explorer, you can use these filters:
• /t <query>    : Filter bookmarks by Title only
• /u <query>    : Filter bookmarks by URL string only
• /c <category> : Filter by category (e.g., movies, study, software, adult, sports)
• /d <domain>   : Filter by domain name (e.g., github.com)
• /sort <type>  : Sort current visible items by "name", "date", or "url"
• /undo         : Restore your original bookmarks positions (or /restore)`;

      list = [
        { id: "help_view_back", title: "‹ Back to Search", subtitle: "Return to general search results", icon: Icons.crop, type: "subaction", run: () => exitCommandMode() },
        { id: "help_text_display", title: "Command Palette Guide", subtitle: guideText, icon: "💡", type: "static_text" }
      ];
      break;

    case "bookmark_tools":
      {
        const bkList = await new Promise(res => chrome.runtime.sendMessage({ action: "get_bookmarks_tree" }, res));
        let bookmarks = [];
        function traverse(node) {
          if (node.url) {
            bookmarks.push({
              id: "bm_" + node.id,
              title: node.title || node.url,
              subtitle: node.url,
              icon: Icons.tag,
              type: "bookmark",
              bmData: node
            });
          }
          if (node.children) node.children.forEach(traverse);
        }
        if (bkList && bkList[0]) traverse(bkList[0]);
        if (filter) {
          bookmarks = bookmarks.filter(b => b.title.toLowerCase().includes(filter) || b.subtitle.toLowerCase().includes(filter));
        }
        list = bookmarks;
      }
      break;

    case "download_tools":
      {
        const downloadsList = await new Promise(res => chrome.runtime.sendMessage({ action: "get_downloads", query: filter || "" }, res));
        if (downloadsList && Array.isArray(downloadsList)) {
          list = downloadsList.map(d => ({
            id: "download_" + d.id,
            title: d.filename.split(/[\\/]/).pop() || "Downloaded File",
            subtitle: d.url,
            icon: Icons.download,
            type: "download",
            downloadData: d
          }));
        }
      }
      break;

    case "history_tools":
      {
        const histList = await new Promise(res => chrome.runtime.sendMessage({ action: "search_history", query: filter || "" }, res));
        if (histList && Array.isArray(histList)) {
          list = histList.map(h => ({
            id: h.id,
            title: h.title || h.url,
            subtitle: h.url,
            icon: Icons.clock,
            type: "history",
            histData: h
          }));
        }
      }
      break;

    case "tab_tools":
      {
        const tabsList = await new Promise(res => chrome.runtime.sendMessage({ action: "get_tabs" }, res));
        if (tabsList && Array.isArray(tabsList)) {
          let tabs = tabsList.map(t => ({
            id: "tab_" + t.id,
            title: t.title || "Tab",
            subtitle: t.url,
            icon: Icons.globe,
            type: "tab",
            tabData: t
          }));
          if (filter) {
            tabs = tabs.filter(t => t.title.toLowerCase().includes(filter) || t.subtitle.toLowerCase().includes(filter));
          }
          list = tabs;
        }
      }
      break;

    case "mappings_tools":
      {
        let mappingsObj = await DB.get("settings", "account_mappings");
        let mappings = mappingsObj ? mappingsObj.value : [];
        
        let title = "➕ Create New Mapping";
        let subtitle = "Type label or '<keyword> <label> <url>' to map current or custom page";
        
        if (filter) {
          const parsed = parseMappingInput(filter);
          if (parsed.url === window.location.href) {
            title = `➕ Map Current Page as: ${parsed.keyword} (${parsed.label})`;
            subtitle = "Press Enter to map this webpage under these parameters";
          } else {
            title = `➕ Map Custom URL: ${parsed.keyword} (${parsed.label})`;
            subtitle = `URL: ${parsed.url}`;
          }
        }

        list = [
          {
            id: "mapping_add_new",
            title: title,
            subtitle: subtitle,
            icon: Icons.globe,
            type: "subaction",
            alwaysKeep: true,
            run: () => createMappingFromInput()
          }
        ];
        
        mappings.forEach(m => {
          list.push({
            id: "mapping_item_" + m.id,
            title: `🔗 ${m.keyword} (${m.label})`,
            subtitle: `Redirects to: ${m.url}`,
            icon: Icons.globe,
            type: "mapping",
            mappingData: m
          });
        });
      }
      break;

    case "settings_tools":
      {
        const config = await getPaletteConfig();
        
        list = [
          // Font Size options
          {
            id: "setting_font_small",
            title: "Set Font Size: Small (11px)",
            subtitle: config.fontSize === "11px" ? "⚡ Current setting" : "Change palette font size to small",
            icon: "🔤",
            type: "subaction",
            run: () => updatePaletteSetting("fontSize", "11px")
          },
          {
            id: "setting_font_normal",
            title: "Set Font Size: Normal (13px)",
            subtitle: config.fontSize === "13px" ? "⚡ Current setting" : "Change palette font size to normal",
            icon: "🔤",
            type: "subaction",
            run: () => updatePaletteSetting("fontSize", "13px")
          },
          {
            id: "setting_font_large",
            title: "Set Font Size: Large (15px)",
            subtitle: config.fontSize === "15px" ? "⚡ Current setting" : "Change palette font size to large",
            icon: "🔤",
            type: "subaction",
            run: () => updatePaletteSetting("fontSize", "15px")
          },
          
          // Width options
          {
            id: "setting_width_compact",
            title: "Set Palette Width: Compact (500px)",
            subtitle: config.width === "500px" ? "⚡ Current setting" : "Change layout width",
            icon: "📏",
            type: "subaction",
            run: () => updatePaletteSetting("width", "500px")
          },
          {
            id: "setting_width_default",
            title: "Set Palette Width: Default (600px)",
            subtitle: config.width === "600px" ? "⚡ Current setting" : "Change layout width",
            icon: "📏",
            type: "subaction",
            run: () => updatePaletteSetting("width", "600px")
          },
          {
            id: "setting_width_wide",
            title: "Set Palette Width: Wide (700px)",
            subtitle: config.width === "700px" ? "⚡ Current setting" : "Change layout width",
            icon: "📏",
            type: "subaction",
            run: () => updatePaletteSetting("width", "700px")
          },
          {
            id: "setting_width_longest",
            title: "Set Palette Width: Longest (800px)",
            subtitle: config.width === "800px" ? "⚡ Current setting" : "Change layout width",
            icon: "📏",
            type: "subaction",
            run: () => updatePaletteSetting("width", "800px")
          },

          // Accent colors
          {
            id: "setting_accent_purple",
            title: "Accent Color: Violet Purple (Default)",
            subtitle: config.accent === "purple" ? "⚡ Current setting" : "Set accent theme to Violet",
            icon: "🎨",
            type: "subaction",
            run: () => updatePaletteSetting("accent", "purple")
          },
          {
            id: "setting_accent_blue",
            title: "Accent Color: Ice Blue",
            subtitle: config.accent === "blue" ? "⚡ Current setting" : "Set accent theme to Blue",
            icon: "🎨",
            type: "subaction",
            run: () => updatePaletteSetting("accent", "blue")
          },
          {
            id: "setting_accent_green",
            title: "Accent Color: Emerald Green",
            subtitle: config.accent === "green" ? "⚡ Current setting" : "Set accent theme to Green",
            icon: "🎨",
            type: "subaction",
            run: () => updatePaletteSetting("accent", "green")
          },
          {
            id: "setting_accent_orange",
            title: "Accent Color: Sunset Orange",
            subtitle: config.accent === "orange" ? "⚡ Current setting" : "Set accent theme to Orange",
            icon: "🎨",
            type: "subaction",
            run: () => updatePaletteSetting("accent", "orange")
          },
          {
            id: "setting_accent_red",
            title: "Accent Color: Crimson Red",
            subtitle: config.accent === "red" ? "⚡ Current setting" : "Set accent theme to Red",
            icon: "🎨",
            type: "subaction",
            run: () => updatePaletteSetting("accent", "red")
          },

          // Max Results options
          {
            id: "setting_results_5",
            title: "Max Results Displayed: 5 items",
            subtitle: config.maxResults === 5 ? "⚡ Current setting" : "Compact lists layout",
            icon: "🔢",
            type: "subaction",
            run: () => updatePaletteSetting("maxResults", 5)
          },
          {
            id: "setting_results_8",
            title: "Max Results Displayed: 8 items (Default)",
            subtitle: config.maxResults === 8 ? "⚡ Current setting" : "Balanced list display",
            icon: "🔢",
            type: "subaction",
            run: () => updatePaletteSetting("maxResults", 8)
          },
          {
            id: "setting_results_12",
            title: "Max Results Displayed: 12 items",
            subtitle: config.maxResults === 12 ? "⚡ Current setting" : "Extended list display",
            icon: "🔢",
            type: "subaction",
            run: () => updatePaletteSetting("maxResults", 12)
          },

          // Backdrop Blur options
          {
            id: "setting_blur_none",
            title: "Backdrop Blur: None",
            subtitle: config.blur === "none" ? "⚡ Current setting" : "Disable background blur",
            icon: "👁️",
            type: "subaction",
            run: () => updatePaletteSetting("blur", "none")
          },
          {
            id: "setting_blur_sleek",
            title: "Backdrop Blur: Sleek (8px)",
            subtitle: config.blur === "8px" ? "⚡ Current setting" : "Apply standard blur",
            icon: "👁️",
            type: "subaction",
            run: () => updatePaletteSetting("blur", "8px")
          },
          {
            id: "setting_blur_intense",
            title: "Backdrop Blur: Intense Glassmorphism (20px)",
            subtitle: config.blur === "20px" ? "⚡ Current setting" : "Apply heavy cinematic blur",
            icon: "👁️",
            type: "subaction",
            run: () => updatePaletteSetting("blur", "20px")
          }
        ];
      }
      break;
    }
  } catch (err) {
    console.error("Error in getCommandModeCandidates:", err);
  }

  // Filter command candidates list
  if (filter) {
    const fLower = filter.toLowerCase();
    list = list.filter(item => 
      item.alwaysKeep ||
      item.title.toLowerCase().includes(fLower) || 
      item.subtitle.toLowerCase().includes(fLower)
    );
  }

  return list;
}

// -------------------------------------------------------------
// EXECUTE ACTION WORKFLOWS FOR SUB-MODES
// -------------------------------------------------------------
function executeDirectCommand(commandId, args = "") {
  const cmdObj = CommandRegistry.commands.get(commandId);
  if (cmdObj) {
    if (args) {
      activeQuery = `${commandId} ${args}`;
    } else {
      activeQuery = commandId;
    }
    cmdObj.execute();
  }
}

async function createMappingFromInput() {
  const text = ccSearchInput.value.trim();
  if (!text) {
    showToast("Type label or '<keyword> <label> <url>' first!", "error");
    return;
  }
  
  const parsed = parseMappingInput(text);

  let mappingsObj = await DB.get("settings", "account_mappings");
  let mappings = mappingsObj ? mappingsObj.value : [];
  
  const id = parsed.keyword + "_" + parsed.label;
  mappings = mappings.filter(m => m.id !== id);
  
  mappings.push({ id, keyword: parsed.keyword, label: parsed.label, url: parsed.url });
  await DB.put("settings", { key: "account_mappings", value: mappings });
  
  showToast(`Mapping for "${parsed.keyword} (${parsed.label})" created!`, "success");
  ccSearchInput.value = "";
  renderSearchResults("");
}

// Image Resizer action trigger
async function runImageResizer(dim1, dim2 = null) {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (type.startsWith("image/")) {
          const blob = await item.getType(type);
          const img = new Image();
          img.onload = () => {
            let w = dim1;
            let h = dim2;
            if (dim1 < 1) { // scale multiplier (e.g. 0.5)
              w = Math.round(img.width * dim1);
              h = Math.round(img.height * dim1);
            } else if (!dim2) { // width only proportional
              h = Math.round(img.height * (w / img.width));
            }
            
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, w, h);
            canvas.toBlob((resizedBlob) => {
              const url = URL.createObjectURL(resizedBlob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `resized_image.png`;
              a.click();
              showToast("Resized image downloaded!", "success");
              exitCommandMode();
              closeCommandPalette();
            }, "image/png");
          };
          img.src = URL.createObjectURL(blob);
          return;
        }
      }
    }
    showToast("No image found on clipboard!", "error");
  } catch(e) {
    showToast("Clipboard access blocked!", "error");
  }
}

// Audio Boost levels
function runAudioBoost(level) {
  enableAudioBooster(level);
}

// Timer triggers
function runTimer(mins, label) {
  chrome.runtime.sendMessage({
    action: "set_timer",
    minutes: mins,
    label: label
  }, () => {
    showToast(`Timer set for ${mins} minutes!`, "success");
    exitCommandMode();
    closeCommandPalette();
  });
}

function runCustomTimer() {
  const val = parseFloat(ccSearchInput.value);
  if (isNaN(val) || val <= 0) {
    showToast("Type minutes in search input first!", "error");
    return;
  }
  runTimer(val, "Timer");
}

// Translation runner
async function runTranslateText() {
  const text = ccSearchInput.value.trim();
  const lang = commandModeParams.sourceLang || "auto-detect";
  if (!text) {
    showToast("Type text in search input first!", "error");
    return;
  }

  try {
    showToast("Translating...", "success");
    const langPair = lang.startsWith("auto") ? "auto|en" : `${lang.substring(0, 2)}|en`;
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`);
    const data = await res.json();
    const translated = data.responseData?.translatedText || text;
    showToast(`Translated: "${translated}"`, "success");
    exitCommandMode();
    closeCommandPalette();
  } catch(e) {
    showToast("Translation service error", "error");
  }
}

// Notes triggers inside sub-mode
async function createNoteFromInput() {
  const title = ccSearchInput.value.trim();
  if (!title) {
    showToast("Type note title in search bar first!", "error");
    return;
  }
  const noteObj = {
    id: title,
    title: title,
    content: "",
    versions: [],
    tags: [],
    pinned: false,
    favorite: false,
    lastModified: Date.now()
  };
  await DB.put("notes", noteObj);
  showToast(`Note "${title}" created!`, "success");
  commandModeParams.selectedNote = title;
  renderSearchResults("");
}

async function appendNoteFromInput(title) {
  const text = ccSearchInput.value.trim();
  if (!text) {
    showToast("Type content in search bar first!", "error");
    return;
  }
  const existing = await DB.get("notes", title);
  if (existing) {
    existing.versions.unshift({ content: existing.content, timestamp: Date.now() });
    existing.content = existing.content ? existing.content + "\n" + text : text;
    existing.lastModified = Date.now();
    await DB.put("notes", existing);
    showToast(`Appended to note "${title}"!`, "success");
    exitCommandMode();
    closeCommandPalette();
  }
}

async function viewNoteContent(title) {
  commandModeParams.step = "view_content";
  renderSearchResults("");
}

async function deleteNoteFromMode(title) {
  await DB.delete("notes", title);
  showToast("Note deleted!", "success");
  delete commandModeParams.selectedNote;
  renderSearchResults("");
}

// -------------------------------------------------------------
// RENDER GENERAL RESULTS UI
// -------------------------------------------------------------
function renderResultsUI() {
  const listEl = ccResultsList.querySelector(".cc-results-list");
  const headerEl = ccResultsList.querySelector(".cc-group-header");
  listEl.innerHTML = "";

  if (currentCommandMode) {
    const metadata = CommandModeMetadata[currentCommandMode];
    headerEl.textContent = `${metadata.name} Actions`;
  } else if (activeQuery) {
    headerEl.textContent = "Search results";
  } else {
    headerEl.textContent = "Recent searches";
  }

  if (selectedIndex >= visibleItems.length) {
    selectedIndex = Math.max(0, visibleItems.length - 1);
  }

  if (visibleItems.length === 0) {
    ccEmptyState.classList.remove("hidden");
    ccBreadcrumbs.innerHTML = "Command Palette";
    return;
  }
  ccEmptyState.classList.add("hidden");

  visibleItems.forEach((item, idx) => {
    const itemEl = document.createElement("div");
    itemEl.className = `cc-item ${idx === selectedIndex ? "selected" : ""}`;

    if (item.type === "static_text") {
      itemEl.innerHTML = `
        <div class="cc-item-left" style="flex-direction:column; align-items:flex-start; width:100%; gap:8px;">
          <div style="font-weight:600; font-size:13px; color:var(--cc-accent-color); display:flex; align-items:center; gap:8px;">
            <span>${item.icon || "📝"}</span>
            <span>${item.title}</span>
          </div>
          <div style="white-space:pre-wrap; font-family:monospace; font-size:12px; color:#a3b3cc; max-height:220px; overflow-y:auto; width:100%; line-height:1.5; padding:8px; background:rgba(255,255,255,0.02); border-radius:6px; border:1px solid rgba(255,255,255,0.04); box-sizing:border-box;">${item.subtitle}</div>
        </div>
      `;
      itemEl.style.cursor = "default";
    } else {
      let iconHtml = `<span class="cc-item-icon">${Icons.search}</span>`;
      if (typeof item.icon === "string") {
        iconHtml = `<span class="cc-item-icon">${item.icon}</span>`;
      }

      // Show website favicons for bookmarks, tabs, and history entries
      if ((item.type === "bookmark" || item.type === "tab" || item.type === "history") && (item.bmData || item.tabData || item.histData)) {
        const url = (item.bmData?.url || item.tabData?.url || item.histData?.url);
        if (url) {
          const d = BookmarkRules.getDomain(url);
          iconHtml = `<img class="cc-item-icon" src="https://www.google.com/s2/favicons?sz=32&domain=${d}" onerror="this.src='https://www.google.com/s2/favicons?sz=32&domain=google.com'" style="width:14px; height:14px; border-radius:3px;">`;
        }
      }

      let rightBadgeHtml = "";
      if (item.pinned) rightBadgeHtml += `<span style="font-size:11px; margin-right:4px;">📌</span>`;
      if (item.favorite) rightBadgeHtml += `<span style="font-size:11px; margin-right:4px;">⭐</span>`;

      let kbdText = "";
      if (item.type === "tab") kbdText = "↵ Switch";
      else if (item.type === "bookmark") kbdText = "↵ Open";
      else if (item.type === "command") kbdText = "↵ Select";
      else if (item.type === "subaction") kbdText = "↵ Run";
      else if (item.type === "note") kbdText = "↵ Select";
      else if (item.type === "download") kbdText = "↵ Open";
      else kbdText = "↵ Go";

      itemEl.innerHTML = `
        <div class="cc-item-left">
          ${iconHtml}
          <div class="cc-item-title-wrap">
            <span class="cc-item-title">${item.title}</span>
            <span class="cc-item-subtitle">${item.subtitle || ""}</span>
          </div>
        </div>
        <div class="cc-item-right">
          ${rightBadgeHtml}
          <span class="cc-kbd-badge">${kbdText}</span>
        </div>
      `;

      itemEl.addEventListener("click", () => {
        selectedIndex = idx;
        executeMainAction(false);
      });
    }

    listEl.appendChild(itemEl);
  });

  const selectedEl = listEl.children[selectedIndex];
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: "nearest" });
  }

  if (currentCommandMode) {
    const metadata = CommandModeMetadata[currentCommandMode];
    ccBreadcrumbs.innerHTML = `Command Palette › <span class="cc-breadcrumb-badge">${metadata ? metadata.name : currentCommandMode}</span>`;
  } else {
    ccBreadcrumbs.innerHTML = "Command Palette";
  }
  if (isSubmenuOpen) {
    renderSubmenuActions();
  }
}

function moveSelection(direction) {
  const items = ccResultsList.querySelectorAll(".cc-item");
  if (items.length === 0) return;

  selectedIndex = (selectedIndex + direction + items.length) % items.length;

  items.forEach((item, idx) => {
    if (idx === selectedIndex) {
      item.classList.add("selected");
      item.scrollIntoView({ block: "nearest" });
    } else {
      item.classList.remove("selected");
    }
  });

  if (currentCommandMode) {
    const metadata = CommandModeMetadata[currentCommandMode];
    ccBreadcrumbs.innerHTML = `Command Palette › <span class="cc-breadcrumb-badge">${metadata ? metadata.name : currentCommandMode}</span>`;
  } else {
    ccBreadcrumbs.innerHTML = "Command Palette";
  }
  if (isSubmenuOpen) {
    renderSubmenuActions();
  }
}

// -------------------------------------------------------------
// EXECUTE CORE ACTIONS
// -------------------------------------------------------------
async function executeMainAction(inNewTab = false) {
  const item = visibleItems[selectedIndex];
  if (!item) return;

  // Command mode subaction triggers
  if (item.type === "subaction" && typeof item.run === "function") {
    item.run();
    return;
  }

  // Auto-route command mode entries when selected and pressed Enter
  if (item.type === "command") {
    if (item.id === "quick_note") { enterCommandMode("note_tools"); return; }
    else if (item.id === "audio_booster") { enterCommandMode("boost_tools"); return; }
    else if (item.id === "pomodoro_timer") { enterCommandMode("timer_tools"); return; }
    else if (item.id === "translate_utility") { enterCommandMode("translate_tools"); return; }
    else if (item.id === "pdf_merge" || item.id === "pdf_compressor") { enterCommandMode("pdf_tools"); return; }
    else if (item.id === "clipboard_image_resize" || item.id === "clipboard_image_convert" || item.id === "clipboard_download") { enterCommandMode("image_tools"); return; }
    else if (item.id === "search_bookmarks") { enterCommandMode("bookmark_tools"); return; }
    else if (item.id === "search_downloads") { enterCommandMode("download_tools"); return; }
    else if (item.id === "search_history") { enterCommandMode("history_tools"); return; }
    else if (item.id === "search_active_tabs") { enterCommandMode("tab_tools"); return; }
    else if (item.id === "mappings_manager") { enterCommandMode("mappings_tools"); return; }
    else if (item.id === "settings_manager") { enterCommandMode("settings_tools"); return; }
  }

  // Track stats
  const itemId = item.id;
  if (!commandStats[itemId]) {
    commandStats[itemId] = { id: itemId, frequency: 0, lastUsed: 0 };
  }
  commandStats[itemId].frequency++;
  commandStats[itemId].lastUsed = Date.now();
  await DB.put("commands", commandStats[itemId]);

  if (item.type === "command" && typeof item.execute === "function") {
    item.execute();
    return;
  }

  if (item.type === "google_search" && item.searchQuery) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(item.searchQuery)}#focus-palette=true`;
    if (inNewTab) {
      window.open(url, "_blank");
    } else {
      window.location.href = url;
    }
    closeCommandPalette();
    return;
  }

  if ((item.type === "mapping" || item.type === "mapping_redirect") && item.mappingData) {
    if (inNewTab) {
      window.open(item.mappingData.url, "_blank");
    } else {
      window.location.href = item.mappingData.url;
    }
    closeCommandPalette();
    return;
  }

  if (item.type === "bookmark" && item.bmData) {
    if (inNewTab) {
      window.open(item.bmData.url, "_blank");
    } else {
      window.location.href = item.bmData.url;
    }
    closeCommandPalette();
    return;
  }

  if (item.type === "history" && item.histData) {
    if (inNewTab) {
      window.open(item.histData.url, "_blank");
    } else {
      window.location.href = item.histData.url;
    }
    closeCommandPalette();
    return;
  }

  if (item.type === "tab" && item.tabData) {
    chrome.runtime.sendMessage({
      action: "activate_tab",
      id: item.tabData.id,
      windowId: item.tabData.windowId
    });
    closeCommandPalette();
    return;
  }

  if (item.type === "download" && item.downloadData) {
    chrome.runtime.sendMessage({ action: "open_download", id: item.downloadData.id });
    closeCommandPalette();
    return;
  }

  if (item.type === "note" && item.noteData) {
    enterCommandMode("note_tools");
    commandModeParams.selectedNote = item.noteData.title;
    renderSearchResults("");
    return;
  }

  if (item.type === "clipboard" && item.clipData) {
    navigator.clipboard.writeText(item.clipData.content);
    showToast("Copied clip to clipboard!", "success");
    closeCommandPalette();
    return;
  }
}

// -------------------------------------------------------------
// CONTEXT ACTIONS SUB-MENU (Ctrl+K)
// -------------------------------------------------------------
function renderSubmenuActions() {
  const item = visibleItems[selectedIndex];
  const listEl = ccSubmenu.querySelector(".cc-submenu-list");
  listEl.innerHTML = "";

  if (!item) return;

  const actions = [];

  // General Actions
  actions.push({
    label: "Open / Run",
    icon: "↵",
    run: () => executeMainAction(false)
  });
  actions.push({
    label: "Open in New Tab",
    icon: "Alt+↵",
    run: () => executeMainAction(true)
  });

  // Favorite toggle
  actions.push({
    label: item.favorite ? "Unfavorite" : "Favorite / Star",
    icon: "⭐",
    run: async () => {
      item.favorite = !item.favorite;
      if (item.type === "note") {
        const note = item.noteData;
        note.favorite = item.favorite;
        await DB.put("notes", note);
      } else {
        await DB.put("favorites", { id: item.id, favorite: item.favorite });
      }
      showToast(item.favorite ? "Added to favorites" : "Removed from favorites", "success");
      renderSearchResults(activeQuery);
      closeSubmenu();
    }
  });

  // Pin toggle
  actions.push({
    label: item.pinned ? "Unpin" : "Pin to Top",
    icon: "📌",
    run: async () => {
      item.pinned = !item.pinned;
      if (item.type === "note") {
        const note = item.noteData;
        note.pinned = item.pinned;
        await DB.put("notes", note);
      } else {
        await DB.put("favorites", { id: item.id, pinned: item.pinned });
      }
      showToast(item.pinned ? "Pinned command" : "Unpinned command", "success");
      renderSearchResults(activeQuery);
      closeSubmenu();
    }
  });

  // Bookmarks details/actions
  if (item.type === "bookmark" && item.bmData) {
    actions.push({
      label: "Copy Bookmark URL",
      icon: "📋",
      run: () => {
        navigator.clipboard.writeText(item.bmData.url);
        showToast("URL copied!", "success");
        closeCommandPalette();
      }
    });
    actions.push({
      label: "Delete Bookmark",
      icon: "🗑",
      run: () => {
        chrome.runtime.sendMessage({ action: "delete_bookmark", id: item.bmData.id, isFolder: false }, () => {
          showToast("Bookmark deleted!", "success");
          renderSearchResults(activeQuery);
          closeSubmenu();
        });
      }
    });
  }

  // Notes details/actions
  if (item.type === "note" && item.noteData) {
    actions.push({
      label: "Edit Note Title",
      icon: "✏",
      run: async () => {
        const newTitle = prompt("Edit note title:", item.noteData.title);
        if (newTitle) {
          const oldNote = item.noteData;
          await DB.delete("notes", oldNote.id);
          oldNote.id = newTitle;
          oldNote.title = newTitle;
          await DB.put("notes", oldNote);
          showToast("Note renamed!", "success");
          renderSearchResults(activeQuery);
        }
        closeSubmenu();
      }
    });
    actions.push({
      label: "Delete Note",
      icon: "🗑",
      run: async () => {
        await DB.delete("notes", item.noteData.id);
        showToast("Note deleted!", "success");
        renderSearchResults(activeQuery);
        closeSubmenu();
      }
    });
  }

  // Tabs details/actions
  if (item.type === "tab" && item.tabData) {
    actions.push({
      label: "Close Tab",
      icon: "✕",
      run: () => {
        chrome.runtime.sendMessage({ action: "close_tab", id: item.tabData.id }, () => {
          showToast("Closed tab!", "success");
          renderSearchResults(activeQuery);
          closeSubmenu();
        });
      }
    });
    actions.push({
      label: "Duplicate Tab",
      icon: "⎘",
      run: () => {
        chrome.runtime.sendMessage({ action: "duplicate_tab", id: item.tabData.id }, () => {
          showToast("Tab duplicated!", "success");
          renderSearchResults(activeQuery);
          closeSubmenu();
        });
      }
    });
    actions.push({
      label: item.tabData.pinned ? "Unpin Tab" : "Pin Tab",
      icon: "📌",
      run: () => {
        chrome.runtime.sendMessage({ action: "set_tab_pinned", id: item.tabData.id, pinned: !item.tabData.pinned }, () => {
          showToast(item.tabData.pinned ? "Tab unpinned!" : "Tab pinned!", "success");
          renderSearchResults(activeQuery);
          closeSubmenu();
        });
      }
    });
    actions.push({
      label: item.tabData.mutedInfo?.muted ? "Unmute Tab" : "Mute Tab",
      icon: "🔇",
      run: () => {
        chrome.runtime.sendMessage({ action: "set_tab_muted", id: item.tabData.id, muted: !item.tabData.mutedInfo?.muted }, () => {
          showToast(item.tabData.mutedInfo?.muted ? "Tab unmuted!" : "Tab muted!", "success");
          renderSearchResults(activeQuery);
          closeSubmenu();
        });
      }
    });
  }

  // Downloads details/actions
  if (item.type === "download" && item.downloadData) {
    actions.push({
      label: "Open Downloaded File",
      icon: "↵",
      run: () => {
        chrome.runtime.sendMessage({ action: "open_download", id: item.downloadData.id });
        closeSubmenu();
      }
    });
    actions.push({
      label: "Clear from Downloads History",
      icon: "🗑",
      run: () => {
        chrome.runtime.sendMessage({ action: "delete_download", id: item.downloadData.id }, () => {
          showToast("Cleared download record!", "success");
          renderSearchResults(activeQuery);
          closeSubmenu();
        });
      }
    });
  }

  // History details/actions
  if (item.type === "history" && item.histData) {
    actions.push({
      label: "Copy History URL",
      icon: "📋",
      run: () => {
        navigator.clipboard.writeText(item.histData.url);
        showToast("URL copied!", "success");
        closeSubmenu();
      }
    });
    actions.push({
      label: "Delete from Browser History",
      icon: "🗑",
      run: () => {
        chrome.runtime.sendMessage({ action: "delete_history_url", url: item.histData.url }, () => {
          showToast("Deleted history record!", "success");
          renderSearchResults(activeQuery);
          closeSubmenu();
        });
      }
    });
  }

  // Mappings details/actions
  if (item.type === "mapping" && item.mappingData) {
    actions.push({
      label: "Delete Account Mapping",
      icon: "🗑",
      run: async () => {
        let mappingsObj = await DB.get("settings", "account_mappings");
        let mappings = mappingsObj ? mappingsObj.value : [];
        mappings = mappings.filter(m => m.id !== item.mappingData.id);
        await DB.put("settings", { key: "account_mappings", value: mappings });
        showToast("Deleted mapping!", "success");
        renderSearchResults(activeQuery);
        closeSubmenu();
      }
    });
  }

  // Clipboard details/actions
  if (item.type === "clipboard" && item.clipData) {
    actions.push({
      label: "Delete Clip from History",
      icon: "🗑",
      run: async () => {
        await DB.delete("clipboard", item.clipData.id);
        showToast("Deleted clip!", "success");
        const clips = await DB.getClipboardHistory(10);
        clipboardHistoryCache = clips;
        renderSearchResults(activeQuery);
        closeSubmenu();
      }
    });
  }

  // Mapping details/actions
  if (item.type === "mapping" && item.mappingData) {
    actions.push({
      label: "Delete Mapping",
      icon: "🗑",
      run: async () => {
        let mappingsObj = await DB.get("settings", "account_mappings");
        let mappings = mappingsObj ? mappingsObj.value : [];
        mappings = mappings.filter(m => m.id !== item.mappingData.id);
        await DB.put("settings", { key: "account_mappings", value: mappings });
        showToast("Mapping deleted!", "success");
        renderSearchResults(activeQuery);
        closeSubmenu();
      }
    });
  }

  // Render list
  actions.forEach(act => {
    const actEl = document.createElement("div");
    actEl.className = "cc-submenu-item";
    actEl.innerHTML = `
      <span style="font-weight:600; color:var(--cc-accent-color);">${act.icon}</span>
      <span>${act.label}</span>
    `;
    actEl.addEventListener("click", () => {
      act.run();
    });
    listEl.appendChild(actEl);
  });
}

function triggerDeleteAction() {
  const item = visibleItems[selectedIndex];
  if (!item) return;

  if (item.type === "note" && item.noteData) {
    DB.delete("notes", item.noteData.id).then(() => {
      showToast("Note deleted!", "success");
      renderSearchResults(activeQuery);
    });
  } else if (item.type === "clipboard" && item.clipData) {
    DB.delete("clipboard", item.clipData.id).then(() => {
      showToast("Clip deleted!", "success");
      DB.getClipboardHistory(10).then(clips => {
        clipboardHistoryCache = clips;
        renderSearchResults(activeQuery);
      });
    });
  } else if (item.type === "mapping" && item.mappingData) {
    DB.get("settings", "account_mappings").then(mappingsObj => {
      let mappings = mappingsObj ? mappingsObj.value : [];
      mappings = mappings.filter(m => m.id !== item.mappingData.id);
      DB.put("settings", { key: "account_mappings", value: mappings }).then(() => {
        showToast("Deleted mapping!", "success");
        renderSearchResults(activeQuery);
      });
    });
  }
}

// -------------------------------------------------------------
// MODULE REGISTRY DEFINITIONS
// -------------------------------------------------------------

// Open Image Studio Command
CommandRegistry.register({
  id: "open_image_studio",
  name: "Image Studio",
  aliases: ["image", "img", "pic"],
  description: "Open Premium Image Studio for editing, resizing, converting, and compressing images.",
  icon: Icons.crop,
  execute: () => {
    window.open(chrome.runtime.getURL("image.html"), "_blank");
    closeCommandPalette();
  }
});

// Open PDF Tools Command
CommandRegistry.register({
  id: "open_pdf_tools",
  name: "PDF Tools",
  aliases: ["pdf"],
  description: "Open PDF Tools for merging, splitting, converting, or compressing PDF files.",
  icon: Icons.globe,
  execute: () => {
    window.open(chrome.runtime.getURL("pdf.html"), "_blank");
    closeCommandPalette();
  }
});

// Bookmarks Search Command
CommandRegistry.register({
  id: "search_bookmarks",
  name: "Bookmarks",
  aliases: ["bookmarks", "bm"],
  description: "Enter Bookmarks command mode to browse and search.",
  icon: Icons.tag,
  execute: () => {
    enterCommandMode("bookmark_tools");
  }
});

// Downloads Browse Command
CommandRegistry.register({
  id: "search_downloads",
  name: "Downloads",
  aliases: ["downloads", "dl"],
  description: "Enter Downloads command mode to browse and search.",
  icon: Icons.download,
  execute: () => {
    enterCommandMode("download_tools");
  }
});

// History Search Command
CommandRegistry.register({
  id: "search_history",
  name: "History",
  aliases: ["history", "hist"],
  description: "Enter History command mode to browse and search.",
  icon: Icons.clock,
  execute: () => {
    enterCommandMode("history_tools");
  }
});

// Search Active Tabs Command
CommandRegistry.register({
  id: "search_active_tabs",
  name: "Tabs",
  aliases: ["tabs", "tab", "switchtab"],
  description: "Enter Active Tabs command mode to browse, search, and switch tabs.",
  icon: Icons.globe,
  execute: () => {
    enterCommandMode("tab_tools");
  }
});

// Clipboard History Command
CommandRegistry.register({
  id: "search_clipboard",
  name: "View Clipboard History",
  aliases: ["clipboard", "clip"],
  description: "Browse and search your copied clipboard items.",
  icon: Icons.file,
  execute: () => {
    ccSearchInput.value = "/clipboard";
    handleSearchChange("/clipboard");
  }
});

// Mappings Management Command
CommandRegistry.register({
  id: "mappings_manager",
  name: "Account Mappings",
  aliases: ["mappings", "mapping", "accounts"],
  description: "Configure custom domain and account redirects (e.g. gmail personal ➔ u/0).",
  icon: Icons.globe,
  execute: () => {
    enterCommandMode("mappings_tools");
  }
});

// Quick Map Current Page Command
CommandRegistry.register({
  id: "mapping_new",
  name: "Create Quick Mapping",
  aliases: ["mapping new", "mapping add", "new mapping", "add mapping"],
  description: "Map the current opened URL page to a label/keyword.",
  icon: Icons.globe,
  execute: async () => {
    const parsed = parseMappingInput(activeQuery);
    if (!parsed.label || parsed.label === "default") {
      showToast("Please specify a label, e.g. 'mapping new personal'", "error");
      return;
    }

    let mappingsObj = await DB.get("settings", "account_mappings");
    let mappings = mappingsObj ? mappingsObj.value : [];
    
    const id = parsed.keyword + "_" + parsed.label;
    mappings = mappings.filter(m => m.id !== id);
    
    mappings.push({ id, keyword: parsed.keyword, label: parsed.label, url: parsed.url });
    await DB.put("settings", { key: "account_mappings", value: mappings });
    
    showToast(`Mapped page to: ${parsed.keyword} (${parsed.label})`, "success");
    closeCommandPalette();
  }
});

// Settings Command
CommandRegistry.register({
  id: "settings_manager",
  name: "Settings",
  aliases: ["settings", "config", "preferences"],
  description: "Configure extension settings and toggle features.",
  icon: "⚙️",
  execute: () => {
    chrome.runtime.sendMessage({ action: "open_page", page: "settings.html" });
    closeCommandPalette();
  }
});

// Cookie Manager Command
CommandRegistry.register({
  id: "manage_cookies",
  name: "Cookie Manager",
  aliases: ["cookie", "cookies"],
  description: "Open the Cookie Manager dashboard to view and manage browser cookies.",
  icon: Icons.tag,
  execute: () => {
    if (!EXT_SETTINGS.enableCookies) { showToast("Cookie manager is disabled in Settings", "error"); return; }
    chrome.runtime.sendMessage({ action: "open_page", page: "dashboard.html?view=cookies" });
    closeCommandPalette();
  }
});

// Screenshots Gallery Command
CommandRegistry.register({
  id: "search_screenshots",
  name: "View Screenshot Gallery",
  aliases: ["screenshots", "gallery"],
  description: "Browse, view, and download all your captured screenshots and recordings.",
  icon: Icons.crop,
  execute: () => {
    if (!EXT_SETTINGS.enableScreenshots) { showToast("Gallery is disabled in Settings", "error"); return; }
    chrome.runtime.sendMessage({ action: "open_page", page: "screenshots.html" });
    closeCommandPalette();
  }
});

// Video Element Recording Command
let mediaRecorder = null;
let recordedChunks = [];
CommandRegistry.register({
  id: "record_video",
  name: "Start/Stop Video Recording",
  aliases: ["record", "video", "capture video"],
  description: "Record the playing video directly, allowing you to switch tabs while recording.",
  icon: Icons.monitor,
  execute: async () => {
    closeCommandPalette();
    toggleVideoRecording();
  }
});

let recordingIndicator = null;

// Helper to generate a crisp WebP thumbnail from recorded video blob
function captureVideoBlobThumbnail(blob) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      URL.revokeObjectURL(url);
      video.src = '';
      video.remove();
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 3500);

    video.onloadeddata = () => {
      video.currentTime = Math.min(0.2, (video.duration || 1) / 2);
    };

    video.onseeked = () => {
      clearTimeout(timer);
      try {
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 360;
        const maxW = 360;
        const scale = Math.min(1, maxW / w);
        const tw = Math.round(w * scale);
        const th = Math.round(h * scale);

        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, tw, th);
        const dataUrl = canvas.toDataURL('image/webp', 0.82);
        cleanup();
        resolve({ dataUrl, width: w, height: h });
      } catch (e) {
        cleanup();
        resolve(null);
      }
    };

    video.onerror = () => {
      clearTimeout(timer);
      cleanup();
      resolve(null);
    };

    video.src = url;
  });
}

// Auto-stop recording when tab closes — saves whatever was captured
window.addEventListener('beforeunload', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    // Fire-and-forget: tell background to finalize with whatever chunks it has
    chrome.runtime.sendMessage({ action: "recording_finalize", sourceUrl: window.location.href }).catch(()=>{});
  }
});

let recordingTimerInterval = null;
let recordingStartTimestamp = 0;

async function toggleVideoRecording(preferredVideo = null) {
  if (!EXT_SETTINGS.enableScreenshots) { showToast("Video Recording is disabled in Settings", "error"); return; }
  
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    showToast("Stopping recording & finalizing...", "info");
    if (recordingIndicator) {
      recordingIndicator.remove();
      recordingIndicator = null;
    }
    if (recordingTimerInterval) {
      clearInterval(recordingTimerInterval);
      recordingTimerInterval = null;
    }
    SmartVideoHUD.updateRecordingState(false);
    return;
  }
  try {
    const videos = Array.from(document.querySelectorAll('video'));
    const targetVideo = preferredVideo || SmartVideoHUD.activeVideo || videos.find(v => !v.paused && !v.ended && v.readyState > 1) || videos[0];

    let stream;
    try {
      if (!targetVideo) {
        throw new Error("No video element found in this frame.");
      }
      
      if (typeof targetVideo.captureStream === 'function') {
        stream = targetVideo.captureStream();
      } else if (typeof targetVideo.mozCaptureStream === 'function') {
        stream = targetVideo.mozCaptureStream();
      } else {
        throw new Error("captureStream is not supported.");
      }
      
      // If the stream has no tracks, it likely failed due to CORS silently
      if (!stream || stream.getVideoTracks().length === 0) {
        throw new Error("Stream has no video tracks (CORS protection likely).");
      }
    } catch (e) {
      console.warn("Video captureStream failed, falling back to display media:", e);
      showToast("Select this tab/window in the popup to record.", "info");
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" },
        audio: true,
        preferCurrentTab: true
      });
    }

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    recordedChunks = [];
    
    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };
    
    mediaRecorder.onstop = async () => {
      // Stop all tracks to remove the screen share banner
      if (stream) stream.getTracks().forEach(t => t.stop());
      mediaRecorder = null;
      if (recordingIndicator) {
        recordingIndicator.remove();
        recordingIndicator = null;
      }
      if (recordingTimerInterval) {
        clearInterval(recordingTimerInterval);
        recordingTimerInterval = null;
      }
      SmartVideoHUD.updateRecordingState(false);

      if (!recordedChunks || recordedChunks.length === 0) {
        showToast("Recording was empty or stopped too quickly.", "error");
        return;
      }

      showToast("Saving recording to gallery...", "info");

      const finalBlob = new Blob(recordedChunks, { type: 'video/webm' });
      recordedChunks = [];

      // 1. Always auto-download the recorded video file
      try {
        const videoDownloadUrl = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = videoDownloadUrl;
        a.download = `video_recording_${Date.now()}.webm`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(videoDownloadUrl), 15000);
      } catch (dlErr) {
        console.warn("Auto-downloading video error:", dlErr);
      }

      // 2. Extract real video thumbnail from the recording directly in the tab
      let thumbDataUrl = null;
      let width = 0;
      let height = 0;
      try {
        const thumbRes = await captureVideoBlobThumbnail(finalBlob);
        if (thumbRes) {
          thumbDataUrl = thumbRes.dataUrl;
          width = thumbRes.width;
          height = thumbRes.height;
        }
      } catch (e) {
        console.warn("Failed to generate video thumbnail:", e);
      }

      // 3. Save the raw Blob directly to IDB — no base64, no message bus, no 64 MB limit
      try {
        await CommandPaletteDB.saveVideoBlob(finalBlob, {
          thumbDataUrl,
          width,
          height,
          sourceUrl: window.location.href,
          title: document.title || 'Video Recording',
        });
        showToast("Video recording saved to gallery! 🎬", "success");
      } catch (err) {
        console.error("[recording] Failed to save video to IDB:", err);
        showToast("Failed to save recording: " + (err.message || "Unknown error"), "error");
      }
    };
    
    mediaRecorder.start(250); // Small 250ms timeslices so all frames are captured
    recordingStartTimestamp = Date.now();
    chrome.runtime.sendMessage({ action: "set_recording_state", isRecording: true }).catch(()=>{});
    showToast("🔴 Video recording started! Click stop when done.", "success");
    
    // Start live HUD timer
    SmartVideoHUD.updateRecordingState(true, '00:00');
    recordingTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTimestamp) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      const str = `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
      SmartVideoHUD.updateRecordingState(true, str);
    }, 1000);

    // Create recording indicator UI — minimal red dot, click to stop
    recordingIndicator = document.createElement('div');
    recordingIndicator.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      width: 16px;
      height: 16px;
      background: #ef4444;
      border-radius: 50%;
      z-index: 999999;
      cursor: pointer;
      box-shadow: 0 0 8px #ef4444;
      animation: cc-pulse-red 1.5s infinite;
    `;
    recordingIndicator.title = 'Click to stop recording';
    recordingIndicator.addEventListener('click', () => {
      toggleVideoRecording();
    });
    
    // Add pulsing animation if not exists
    if (!document.getElementById('cc-record-anim')) {
      const style = document.createElement('style');
      style.id = 'cc-record-anim';
      style.textContent = `
        @keyframes cc-pulse-red {
          0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
          70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
          100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
        }
      `;
      document.head.appendChild(style);
    }
    
    document.body.appendChild(recordingIndicator);
  } catch (err) {
    console.error(err);
    SmartVideoHUD.updateRecordingState(false);
    showToast("Failed to start recording: " + (err.message || ""), "error");
  }
}

// Tab Management Commands
CommandRegistry.register({
  id: "close_current_tab",
  name: "Close Current Tab",
  aliases: ["close", "closetab"],
  description: "Close the currently active browser tab.",
  icon: Icons.close,
  execute: () => {
    chrome.runtime.sendMessage({ action: "get_tabs" }, (tabs) => {
      const active = tabs.find(t => t.active);
      if (active) {
        chrome.runtime.sendMessage({ action: "close_tab", id: active.id }, () => {
          showToast("Closed active tab!", "success");
          closeCommandPalette();
        });
      }
    });
  }
});

CommandRegistry.register({
  id: "duplicate_current_tab",
  name: "Duplicate Tab",
  aliases: ["duplicate", "duptab"],
  description: "Duplicate the currently active browser tab.",
  icon: Icons.file,
  execute: () => {
    chrome.runtime.sendMessage({ action: "get_tabs" }, (tabs) => {
      const active = tabs.find(t => t.active);
      if (active) {
        chrome.runtime.sendMessage({ action: "duplicate_tab", id: active.id }, () => {
          showToast("Tab duplicated!", "success");
          closeCommandPalette();
        });
      }
    });
  }
});

CommandRegistry.register({
  id: "pin_current_tab",
  name: "Pin / Unpin Tab",
  aliases: ["pin", "pintab"],
  description: "Toggle pinning of the current tab.",
  icon: Icons.tag,
  execute: () => {
    chrome.runtime.sendMessage({ action: "get_tabs" }, (tabs) => {
      const active = tabs.find(t => t.active);
      if (active) {
        chrome.runtime.sendMessage({ action: "set_tab_pinned", id: active.id, pinned: !active.pinned }, () => {
          showToast(active.pinned ? "Tab unpinned!" : "Tab pinned!", "success");
          closeCommandPalette();
        });
      }
    });
  }
});

CommandRegistry.register({
  id: "mute_current_tab",
  name: "Mute / Unmute Tab",
  aliases: ["mute", "mutetab"],
  description: "Toggle muting audio on the current tab.",
  icon: Icons.volume,
  execute: () => {
    chrome.runtime.sendMessage({ action: "get_tabs" }, (tabs) => {
      const active = tabs.find(t => t.active);
      if (active) {
        const isMuted = active.mutedInfo?.muted;
        chrome.runtime.sendMessage({ action: "set_tab_muted", id: active.id, muted: !isMuted }, () => {
          showToast(isMuted ? "Tab unmuted!" : "Tab muted!", "success");
          closeCommandPalette();
        });
      }
    });
  }
});

// Website Shortcuts
const websites = [
  { id: "gmail", name: "Open Gmail", url: "https://mail.google.com" },
  { id: "github", name: "Open GitHub", url: "https://github.com" },
  { id: "reddit", name: "Open Reddit", url: "https://www.reddit.com" },
  { id: "chatgpt", name: "Open ChatGPT", url: "https://chatgpt.com" },
  { id: "netflix", name: "Open Netflix", url: "https://www.netflix.com" },
  { id: "spotify", name: "Open Spotify", url: "https://open.spotify.com" }
];

websites.forEach(site => {
  CommandRegistry.register({
    id: `web_${site.id}`,
    name: site.name,
    aliases: [site.id],
    description: `Instantly open ${site.url}`,
    icon: Icons.globe,
    execute: () => {
      window.open(site.url, "_blank");
      closeCommandPalette();
    }
  });
});

// Collections Module Commands
CommandRegistry.register({
  id: "view_collections",
  name: "View Collections / Spaces",
  aliases: ["collections", "spaces"],
  description: "Browse your created collections and spaces.",
  icon: Icons.folder,
  execute: async () => {
    const colls = await DB.getAll("collections");
    if (colls.length === 0) {
      showToast("No collections created yet. Type: addcollection <name> to create one!", "error");
      return;
    }
    visibleItems = colls.map(c => ({
      id: "coll_" + c.id,
      title: `Collection: ${c.name}`,
      subtitle: `${c.items.length} items stored`,
      icon: Icons.folder,
      type: "command",
      execute: () => {
        c.items.forEach(item => {
          if (item.url) window.open(item.url, "_blank");
        });
        showToast(`Opened ${c.items.length} items from ${c.name}!`, "success");
        closeCommandPalette();
      }
    }));
    renderResultsUI();
  }
});

CommandRegistry.register({
  id: "add_to_collection",
  name: "Add Current Tab to Collection",
  aliases: ["addcollection", "addspace"],
  description: "Add active page to a space: addcollection <name>",
  icon: Icons.tag,
  execute: async () => {
    const parts = activeQuery.split(" ");
    const name = parts.slice(1).join(" ").trim();
    if (!name) {
      showToast("Usage: addcollection <name>", "error");
      return;
    }

    const currentTitle = document.title;
    const currentUrl = window.location.href;

    const existing = await DB.get("collections", name);
    let collObj = { id: name, name: name, items: [] };
    if (existing) collObj = existing;

    collObj.items.push({ title: currentTitle, url: currentUrl, type: "tab" });
    await DB.put("collections", collObj);
    showToast(`Added "${currentTitle}" to collection "${name}"!`, "success");
    closeCommandPalette();
  }
});

// Translation Utility
CommandRegistry.register({
  id: "translate_utility",
  name: "Translate Text",
  aliases: ["translate", "lang"],
  description: "Translate foreign phrases inline to English. Usage: translate bonjour",
  icon: Icons.globe,
  execute: async () => {
    const cleanQuery = activeQuery.substring(9).trim(); // skip 'translate'
    if (!cleanQuery) {
      showToast("Usage: translate <text>", "error");
      return;
    }

    try {
      showToast("Translating to English...", "success");
      const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(cleanQuery)}&langpair=auto|en`);
      const data = await res.json();
      const translated = data.responseData?.translatedText || cleanQuery;
      showToast(`Translated: "${translated}"`, "success");
    } catch(e) {
      showToast(`Could not translate. Text: "${cleanQuery}" to English`, "error");
    }
  }
});

// Notes Module Command `/note <title> <content>`
CommandRegistry.register({
  id: "quick_note",
  name: "Save Quick Note",
  aliases: ["note", "notes", "todo"],
  description: "Create or append a note immediately: note <title> <content>",
  icon: Icons.file,
  execute: async () => {
    enterCommandMode("note_tools");
  }
});

// Sound Booster Module Command `/boost <percentage>`
CommandRegistry.register({
  id: "audio_booster",
  name: "Sound Booster",
  aliases: ["boost", "volume", "sound"],
  description: "Boost sound on active tab up to 300%. boost <100-300>",
  icon: Icons.volume,
  execute: () => {
    enterCommandMode("boost_tools");
  }
});

// Screenshot Module Commands
CommandRegistry.register({
  id: "screenshot_visible",
  name: "Capture Visible Viewport",
  aliases: ["screenshot", "capture"],
  description: "Capture the visible webpage area and copy/save it.",
  icon: Icons.crop,
  execute: () => {
    closeCommandPalette();
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: "capture_visible" }, (res) => {
        if (res && res.dataUrl) {
          triggerClipboardImageDownload(res.dataUrl, "viewport_screenshot.png");
        } else {
          showToast("Failed to capture screen", "error");
        }
      });
    }, 200);
  }
});

CommandRegistry.register({
  id: "screenshot_region",
  name: "Capture Screen Region",
  aliases: ["region", "crop"],
  description: "Select and crop a specific region of the webpage.",
  icon: Icons.crop,
  execute: () => {
    closeCommandPalette();
    setTimeout(startRegionScreenshot, 250);
  }
});

// Clipboard Media Module Commands
CommandRegistry.register({
  id: "clipboard_download",
  name: "Download Clipboard Image",
  aliases: ["clipimg", "saveimg"],
  description: "Retrieve any copied image from your clipboard and download it.",
  icon: Icons.download,
  execute: async () => {
    enterCommandMode("image_tools");
  }
});

CommandRegistry.register({
  id: "clipboard_image_resize",
  name: "Resize Clipboard Image",
  aliases: ["resize", "scale"],
  description: "Scale clipboard image. Usage: resize <width> <height>",
  icon: Icons.crop,
  execute: async () => {
    enterCommandMode("image_tools");
  }
});

CommandRegistry.register({
  id: "clipboard_image_convert",
  name: "Convert Clipboard Image Format",
  aliases: ["convert", "png", "jpg", "webp"],
  description: "Convert clipboard image format. Usage: convert <png|jpg|webp>",
  icon: Icons.globe,
  execute: async () => {
    enterCommandMode("image_tools");
  }
});

CommandRegistry.register({
  id: "pdf_compressor",
  name: "Compress PDF Document",
  aliases: ["compresspdf", "shrinkpdf"],
  description: "Compress or downscale PDF files. Drag & Drop or paste PDF.",
  icon: Icons.file,
  execute: () => {
    enterCommandMode("pdf_tools");
  }
});

CommandRegistry.register({
  id: "pdf_merge",
  name: "Merge PDF Documents (Bulk Join)",
  aliases: ["mergepdf", "joinpdf"],
  description: "Combine multiple PDF documents into a single PDF.",
  icon: Icons.folder,
  execute: () => {
    enterCommandMode("pdf_tools");
  }
});

// Utilities Module
CommandRegistry.register({
  id: "pomodoro_timer",
  name: "Start Pomodoro / Timer",
  aliases: ["timer", "pomo", "alarm"],
  description: "Start custom timer in minutes. Usage: timer <minutes> <label>",
  icon: Icons.clock,
  execute: () => {
    enterCommandMode("timer_tools");
  }
});

CommandRegistry.register({
  id: "unit_converter",
  name: "Unit Converter",
  aliases: ["convertunit", "units"],
  description: "Quickly convert currency, temperature, sizes. Usage: 10km, 50usd, 120f, 8gb",
  icon: Icons.hash,
  execute: () => {
    const query = activeQuery.toLowerCase();
    const match = query.match(/^(\d+(?:\.\d+)?)\s*(km|mi|f|c|gb|mb|usd|eur|inr)$/i);
    if (!match) {
      showToast("Usage: type like '10km', '120f', '8gb', '50usd' directly in search.", "error");
      return;
    }
    const val = parseFloat(match[1]);
    const unit = match[2];
    let result = "";

    if (unit === "km") result = `${val} km = ${(val * 0.621371).toFixed(2)} mi`;
    else if (unit === "mi") result = `${val} mi = ${(val / 0.621371).toFixed(2)} km`;
    else if (unit === "f") result = `${val}°F = ${(((val - 32) * 5) / 9).toFixed(1)}°C`;
    else if (unit === "c") result = `${val}°C = ${((val * 9) / 5 + 32).toFixed(1)}°F`;
    else if (unit === "gb") result = `${val} GB = ${val * 1024} MB = ${(val / 1024).toFixed(3)} TB`;
    else if (unit === "mb") result = `${val} MB = ${(val / 1024).toFixed(3)} GB`;
    else if (unit === "usd") result = `${val} USD = ${(val * 0.92).toFixed(2)} EUR = ${(val * 83.5).toFixed(1)} INR`;
    else if (unit === "eur") result = `${val} EUR = ${(val * 1.09).toFixed(2)} USD = ${(val * 90.8).toFixed(1)} INR`;
    else if (unit === "inr") result = `${val} INR = ${(val / 83.5).toFixed(2)} USD = ${(val / 90.8).toFixed(2)} EUR`;

    showToast(result, "success");
  }
});

// Media & Search Commands
CommandRegistry.register({
  id: "search_youtube",
  name: "YouTube",
  aliases: ["youtube", "yt"],
  description: "Search media on YouTube or open homepage",
  icon: Icons.globe,
  execute: () => {
    const query = getCommandArg(activeQuery);
    if (!query) {
      window.open("https://www.youtube.com", "_blank");
      closeCommandPalette();
      return;
    }
    const cleanQuery = autoCorrectMediaName(query);
    window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}`, "_blank");
    closeCommandPalette();
  }
});

CommandRegistry.register({
  id: "search_twitch",
  name: "Search Twitch",
  aliases: ["twitch"],
  description: "Search streams on Twitch: twitch <query>",
  icon: Icons.globe,
  execute: () => {
    const query = getCommandArg(activeQuery);
    if (!query) {
      showToast("Usage: twitch <query>", "error");
      return;
    }
    const cleanQuery = autoCorrectMediaName(query);
    window.open(`https://www.twitch.tv/search?term=${encodeURIComponent(cleanQuery)}`, "_blank");
    closeCommandPalette();
  }
});

CommandRegistry.register({
  id: "search_mkvdrama",
  name: "Search MKVDrama",
  aliases: ["mkvdrama", "kdrama"],
  description: "Search Asian dramas on MKVDrama: mkvdrama <query>",
  icon: Icons.globe,
  execute: () => {
    const query = getCommandArg(activeQuery);
    if (!query) {
      showToast("Usage: mkvdrama <query>", "error");
      return;
    }
    const cleanQuery = autoCorrectMediaName(query);
    window.open(`https://mkvdrama.net/?s=${encodeURIComponent(cleanQuery)}`, "_blank");
    closeCommandPalette();
  }
});

CommandRegistry.register({
  id: "search_bollyflix",
  name: "Search Bollyflix",
  aliases: ["bollyflix"],
  description: "Search Bollywood movies on Bollyflix: bollyflix <query>",
  icon: Icons.globe,
  execute: () => {
    const query = getCommandArg(activeQuery);
    if (!query) {
      showToast("Usage: bollyflix <query>", "error");
      return;
    }
    const cleanQuery = autoCorrectMediaName(query);
    window.open(`https://bollyflix.at/search/${encodeURIComponent(cleanQuery)}`, "_blank");
    closeCommandPalette();
  }
});

CommandRegistry.register({
  id: "search_katmovies",
  name: "Search KatMovieHD",
  aliases: ["katmovies", "katmoviehd"],
  description: "Search movies on KatMovieHD: katmovies <query>",
  icon: Icons.globe,
  execute: () => {
    const query = getCommandArg(activeQuery);
    if (!query) {
      showToast("Usage: katmovies <query>", "error");
      return;
    }
    const cleanQuery = autoCorrectMediaName(query);
    window.open(`https://new.katmoviehd.top/?s=${encodeURIComponent(cleanQuery)}`, "_blank");
    closeCommandPalette();
  }
});

CommandRegistry.register({
  id: "help_command",
  name: "Palette Help & Shortcuts",
  aliases: ["help", "guide"],
  description: "View shortcuts and help details.",
  icon: Icons.search,
  execute: () => {
    enterCommandMode("help_tools");
  }
});

CommandRegistry.register({
  id: "wizard_command",
  name: "Open Sorter Wizard",
  aliases: ["wizard", "sortwizard"],
  description: "Launch the Smart Sorter organization page.",
  icon: Icons.folder,
  execute: () => {
    chrome.runtime.sendMessage({ action: "open_dashboard", view: "wizard" });
    closeCommandPalette();
  }
});

// Autofill Form Fields Command
CommandRegistry.register({
  id: "autofill_form_fields",
  name: "Auto-fill Form Fields",
  aliases: ["autofill", "fill", "form"],
  description: "Populate forms and Google Forms with your personal/academic profile.",
  icon: Icons.file,
  execute: () => {
    triggerAutofillForm();
    closeCommandPalette();
  }
});

// -------------------------------------------------------------
// ADVANCED SOUND BOOSTER ENGINE (WEB AUDIO GRAPH)
// -------------------------------------------------------------
function enableAudioBooster(gainValue) {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      gainNode = audioContext.createGain();
      
      compressorNode = audioContext.createDynamicsCompressor();
      compressorNode.threshold.setValueAtTime(-12, audioContext.currentTime);
      compressorNode.knee.setValueAtTime(10, audioContext.currentTime);
      compressorNode.ratio.setValueAtTime(12, audioContext.currentTime);
      compressorNode.attack.setValueAtTime(0.003, audioContext.currentTime);
      compressorNode.release.setValueAtTime(0.08, audioContext.currentTime);

      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 64;

      gainNode.connect(compressorNode);
      compressorNode.connect(analyserNode);
      analyserNode.connect(audioContext.destination);

      hookMediaElements();
      
      new MutationObserver(mutations => {
        mutations.forEach(m => {
          m.addedNodes.forEach(node => {
            if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') hookElement(node);
            else if (node.querySelectorAll) node.querySelectorAll('video, audio').forEach(hookElement);
          });
        });
      }).observe(document.body, { childList: true, subtree: true });
    }

    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    gainNode.gain.setValueAtTime(gainValue / 100, audioContext.currentTime);
    isAudioBoosterActive = true;
    showToast(`Volume boosted to ${gainValue}%!`, "success");
    closeCommandPalette();
    
    const hostname = window.location.hostname;
    chrome.runtime.sendMessage({ action: "save_sound_level", level: gainValue });
    DB.put("audioProfiles", { hostname, currentBoost: gainValue, enabled: true });

  } catch (err) {
    showToast("Error activating Audio Booster", "error");
    console.error(err);
  }
}

function hookMediaElements() {
  document.querySelectorAll('video, audio').forEach(hookElement);
}

function hookElement(media) {
  if (media._connectedToBooster) return;
  try {
    const source = audioContext.createMediaElementSource(media);
    source.connect(gainNode);
    media._connectedToBooster = true;
  } catch(e) {}
}

// Volume Peak monitoring
function startAudioVisualizer() {
  if (!analyserNode) return;
  const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
  
  let panel = ccBackdrop.querySelector(".cc-audio-meter-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "cc-audio-meter-panel";
    panel.innerHTML = `
      <div class="cc-meter-row">
        <span>Live Audio Boost</span>
        <span class="cc-meter-value">100%</span>
      </div>
      <div class="cc-meter-bar-outer">
        <div class="cc-meter-bar-inner"></div>
      </div>
    `;
    ccBackdrop.querySelector(".cc-modal").appendChild(panel);
  }

  const valueEl = panel.querySelector(".cc-meter-value");
  const barEl = panel.querySelector(".cc-meter-bar-inner");

  clearInterval(audioMeterInterval);
  audioMeterInterval = setInterval(() => {
    analyserNode.getByteFrequencyData(dataArray);
    let max = 0;
    for (let i = 0; i < dataArray.length; i++) {
      if (dataArray[i] > max) max = dataArray[i];
    }
    const level = Math.round((max / 255) * 100);
    const boostStr = gainNode ? Math.round(gainNode.gain.value * 100) : 100;
    valueEl.textContent = `${boostStr}% | Meter: ${level}%`;
    barEl.style.width = `${level}%`;
    if (level > 85) {
      barEl.style.background = "#ef4444";
    } else {
      barEl.style.background = "linear-gradient(90deg, #10b981, #f59e0b)";
    }
  }, 100);
}

// -------------------------------------------------------------
// SCREENSHOT REGION DRAG SELECTION
// -------------------------------------------------------------
function startRegionScreenshot() {
  const overlay = document.createElement("div");
  overlay.className = "cc-screenshot-crop";
  document.body.appendChild(overlay);

  const selection = document.createElement("div");
  selection.style.cssText = "position:absolute; border:2px dashed #8b5cf6; background:rgba(139,92,246,0.15); pointer-events:none; display:none;";
  overlay.appendChild(selection);

  let startX = 0, startY = 0;
  let isDragging = false;

  const onMouseDown = (e) => {
    startX = e.clientX;
    startY = e.clientY;
    isDragging = true;
    selection.style.left = startX + "px";
    selection.style.top = startY + "px";
    selection.style.width = "0px";
    selection.style.height = "0px";
    selection.style.display = "block";
  };

  const onMouseMove = (e) => {
    if (!isDragging) return;
    const currentX = e.clientX;
    const currentY = e.clientY;
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(startX - currentX);
    const height = Math.abs(startY - currentY);

    selection.style.left = left + "px";
    selection.style.top = top + "px";
    selection.style.width = width + "px";
    selection.style.height = height + "px";
  };

  const onMouseUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    const rect = selection.getBoundingClientRect();
    overlay.remove();

    if (rect.width < 5 || rect.height < 5) return;

    setTimeout(() => {
      chrome.runtime.sendMessage({ action: "capture_visible" }, (res) => {
        if (res && res.dataUrl) {
          cropScreenshot(res.dataUrl, rect);
        } else {
          showToast("Failed to crop image", "error");
        }
      });
    }, 150);
  };

  overlay.addEventListener("mousedown", onMouseDown);
  overlay.addEventListener("mousemove", onMouseMove);
  overlay.addEventListener("mouseup", onMouseUp);
}

function cropScreenshot(dataUrl, rect) {
  const canvas = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext("2d");

  const img = new Image();
  img.onload = () => {
    ctx.drawImage(
      img,
      rect.left * dpr,
      rect.top * dpr,
      rect.width * dpr,
      rect.height * dpr,
      0,
      0,
      rect.width,
      rect.height
    );
    canvas.toBlob((blob) => {
      openAnnotationCanvas(blob);
    }, "image/png");
  };
  img.src = dataUrl;
}

// Annotation Draw Tool
function openAnnotationCanvas(imageBlob) {
  const overlay = document.createElement("div");
  overlay.className = "cc-canvas-draw-overlay";
  overlay.innerHTML = `
    <div style="padding:14px; background:#0b0d14; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.08);">
      <span style="font-weight:600; color:#9ca3af; font-size:13px;">Annotate Screenshot</span>
      <div style="display:flex; gap:8px;">
        <button class="cc-btn-save" style="background:#10b981; border:none; color:white; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600;">Copy & Save</button>
        <button class="cc-btn-close" style="background:#ef4444; border:none; color:white; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600;">Cancel</button>
      </div>
    </div>
    <div style="flex-grow:1; display:flex; justify-content:center; align-items:center; overflow:auto; padding:16px; background:#07080c;">
      <canvas class="cc-draw-canvas" style="box-shadow:0 10px 30px rgba(0,0,0,0.6); background:#ffffff;"></canvas>
    </div>
  `;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector(".cc-draw-canvas");
  const ctx = canvas.getContext("2d");
  const img = new Image();
  
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    let drawing = false;
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";

    canvas.addEventListener("mousedown", (e) => { drawing = true; draw(e); });
    canvas.addEventListener("mousemove", draw);
    canvas.addEventListener("mouseup", () => { drawing = false; ctx.beginPath(); });

    function draw(e) {
      if (!drawing) return;
      const bounds = canvas.getBoundingClientRect();
      const x = e.clientX - bounds.left;
      const y = e.clientY - bounds.top;
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y);
    }
  };
  img.src = URL.createObjectURL(imageBlob);

  overlay.querySelector(".cc-btn-save").addEventListener("click", () => {
    canvas.toBlob((blob) => {
      try {
        navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob })
        ]).then(() => {
          showToast("Annotated image copied!", "success");
        });
      } catch(e) {}
      triggerClipboardImageDownload(canvas.toDataURL(), "annotated_screenshot.png");
      overlay.remove();
    }, "image/png");
  });

  overlay.querySelector(".cc-btn-close").addEventListener("click", () => {
    overlay.remove();
  });
}

function triggerClipboardImageDownload(dataUrl, filename) {
  if (EXT_SETTINGS.enableScreenshots && typeof CommandPaletteDB !== 'undefined' && CommandPaletteDB) {
    const exactUrl = window.location.href;
    const pageTitle = document.title || 'Screenshot';
    CommandPaletteDB.addScreenshot(dataUrl, { sourceUrl: exactUrl, title: pageTitle }).then(() => {
      showToast("Screenshot saved to gallery!", "success");
    }).catch(err => {
      console.error(err);
      showToast("Failed to save screenshot.", "error");
    });
  } else {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    a.click();
    showToast("Image saved!", "success");
  }
}

// -------------------------------------------------------------
// PDF MERGE & COMPRESSION FILE DROP OVERLAYS
// -------------------------------------------------------------
function showDropzoneOverlay(mode) {
  let overlay = ccBackdrop.querySelector(".cc-dropzone-wrapper");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "cc-dropzone-wrapper";
    ccBackdrop.querySelector(".cc-modal").appendChild(overlay);
  }

  const dropLabel = mode === "merge" ? "Merge PDFs (Drop multiple PDF files)" : "Compress PDF (Drop a PDF file)";
  overlay.innerHTML = `
    <div class="cc-dropzone">
      <div style="font-size:24px;">📄</div>
      <div style="font-weight:600; margin-top:8px; font-size:13px; color:#d1d5db;">${dropLabel}</div>
      <div style="font-size:11px; opacity:0.6; margin-top:2px;">or click to select files</div>
      <input type="file" class="cc-file-input" style="display:none;" ${mode === 'merge' ? 'multiple' : ''} accept=".pdf">
      <div class="cc-file-list" style="margin-top:10px; font-size:11px; text-align:left; max-height:80px; overflow-y:auto; color:#9ca3af;"></div>
      <button class="cc-btn-execute-pdf" style="background:var(--cc-accent-color); border:none; color:white; padding:6px 12px; border-radius:6px; margin-top:10px; cursor:pointer; font-weight:600; font-size:12px; display:none;">
        Run ${mode === 'merge' ? 'PDF Joiner' : 'Compressor'}
      </button>
    </div>
  `;

  const input = overlay.querySelector(".cc-file-input");
  const zone = overlay.querySelector(".cc-dropzone");
  const list = overlay.querySelector(".cc-file-list");
  const btn = overlay.querySelector(".cc-btn-execute-pdf");
  let selectedFiles = [];

  zone.addEventListener("click", () => input.click());
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("active"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("active"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("active");
    handleSelectedFiles(e.dataTransfer.files);
  });

  input.addEventListener("change", (e) => {
    handleSelectedFiles(e.target.files);
  });

  function handleSelectedFiles(files) {
    selectedFiles = Array.from(files).filter(f => f.type === "application/pdf" || f.name.endsWith(".pdf"));
    list.innerHTML = selectedFiles.map(f => `<div>• ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)</div>`).join("");
    if (selectedFiles.length > 0) {
      btn.style.display = "inline-block";
    }
  }

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (selectedFiles.length === 0) return;

    btn.textContent = "Processing PDF...";
    btn.disabled = true;

    try {
      if (typeof window.PDFLib === "undefined") {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://unpkg.com/pdf-lib/dist/pdf-lib.min.js";
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }

      const { PDFDocument } = window.PDFLib;

      if (mode === "merge") {
        const mergedPdf = await PDFDocument.create();
        for (const file of selectedFiles) {
          const buffer = await file.arrayBuffer();
          const doc = await PDFDocument.load(buffer);
          const pages = await mergedPdf.copyPages(doc, doc.getPageIndices());
          pages.forEach(p => mergedPdf.addPage(p));
        }
        const mergedBytes = await mergedPdf.save();
        downloadBytes(mergedBytes, "merged_document.pdf");
        showToast("PDFs merged successfully!", "success");
      } else {
        const file = selectedFiles[0];
        const buffer = await file.arrayBuffer();
        const doc = await PDFDocument.load(buffer);
        const compressedBytes = await doc.save({ useObjectStreams: true });
        downloadBytes(compressedBytes, "compressed_document.pdf");
        showToast("PDF compressed!", "success");
      }
      overlay.remove();
      closeCommandPalette();
    } catch(err) {
      showToast("Error processing PDF files", "error");
      console.error(err);
      btn.textContent = "Failed. Try again";
      btn.disabled = false;
    }
  });
}

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

// -------------------------------------------------------------
// TOAST NOTIFICATIONS
// -------------------------------------------------------------
function showToast(message, type = "success") {
  // Remove any existing toast immediately so they don't pile up
  const existingToasts = document.querySelectorAll('.cc-toast-notification');
  existingToasts.forEach(t => t.remove());

  const isError = type === "error";
  const accentColor = isError ? "var(--hud-record, #ef4444)" : "var(--hud-primary, #8b5cf6)";

  const toast = document.createElement("div");
  toast.className = "cc-toast-notification";
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--hud-surface-toast, rgba(11, 17, 30, 0.92));
    border: 1px solid var(--hud-border, rgba(255, 255, 255, 0.11));
    border-left: 3px solid ${accentColor};
    color: var(--hud-text-primary, #f8fafc);
    padding: 10px 18px;
    border-radius: 12px;
    font-family: var(--hud-font, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: 12.5px;
    font-weight: 600;
    z-index: 2147483647;
    max-width: 340px;
    line-height: 1.45;
    pointer-events: none;
    box-shadow: var(--hud-shadow-panel, 0 24px 64px rgba(0, 0, 0, 0.85));
    backdrop-filter: var(--hud-backdrop-filter, blur(24px));
    -webkit-backdrop-filter: var(--hud-backdrop-filter, blur(24px));
    display: flex;
    align-items: center;
    gap: 8px;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 2600);
}

// -------------------------------------------------------------
// PALETTE SETTINGS AND CONFIG MANAGEMENT
// -------------------------------------------------------------
function getCleanKeyword() {
  try {
    const host = window.location.hostname.toLowerCase();
    let clean = host.replace(/^www\./, "");
    let parts = clean.split(".");
    if (parts.length >= 2) {
      if (parts[parts.length - 2] === "com" || parts[parts.length - 2] === "co" || parts[parts.length - 2] === "net" || parts[parts.length - 2] === "org") {
        return parts[0];
      }
      return parts[0];
    }
    return clean || "site";
  } catch (e) {
    return "site";
  }
}

function parseMappingInput(inputText) {
  let text = inputText.trim();
  text = text.replace(/^\//, "");

  const prefixes = [
    "mapping new", "mapping add", "new mapping", "add mapping",
    "mapping", "new", "add", "create"
  ];
  for (const p of prefixes) {
    const reg = new RegExp("^" + p + "\\s+", "i");
    const simpleReg = new RegExp("^" + p + "\\b", "i");
    if (reg.test(text)) {
      text = text.replace(reg, "");
      break;
    } else if (simpleReg.test(text) && text.toLowerCase() === p) {
      text = "";
      break;
    }
  }

  if (!text) {
    return { keyword: getCleanKeyword(), label: "default", url: window.location.href };
  }

  const parts = text.split(/\s+/);
  let keyword = "";
  let label = "";
  let url = "";

  const lastPart = parts[parts.length - 1] || "";
  const isUrl = lastPart.includes(".") || /^https?:\/\//i.test(lastPart) || lastPart.startsWith("localhost");

  if (isUrl && parts.length >= 3) {
    keyword = parts[0].toLowerCase();
    label = parts[1].toLowerCase();
    url = parts.slice(2).join(" ");
  } else {
    keyword = getCleanKeyword();
    label = parts.join(" ").toLowerCase();
    url = window.location.href;
  }

  return { keyword, label, url };
}

async function getPaletteConfig() {
  const settingsObj = await DB.get("settings", "palette_config");
  return settingsObj ? settingsObj.value : {
    width: "600px",
    fontSize: "13px",
    accent: "purple",
    maxResults: 8,
    blur: "8px"
  };
}

async function updatePaletteSetting(key, val) {
  const config = await getPaletteConfig();
  config[key] = val;
  await DB.put("settings", { key: "palette_config", value: config });
  await applyPaletteSettings();
  showToast(`Setting updated: ${key} = ${val}`, "success");
  renderSearchResults("");
}

async function applyPaletteSettings() {
  if (!ccBackdrop) return;
  const config = await getPaletteConfig();

  const style = ccBackdrop.style;
  style.setProperty("--cc-width", config.width || "600px");
  style.setProperty("--cc-font-size-base", config.fontSize || "13px");
  style.setProperty("--cc-max-results", config.maxResults || 8);

  // Accent Colors mapping
  let accentColor = "#8b5cf6";
  let accentGrad = "linear-gradient(135deg, #a78bfa, #8b5cf6)";
  if (config.accent === "blue") {
    accentColor = "#3b82f6";
    accentGrad = "linear-gradient(135deg, #60a5fa, #3b82f6)";
  } else if (config.accent === "green") {
    accentColor = "#10b981";
    accentGrad = "linear-gradient(135deg, #34d399, #10b981)";
  } else if (config.accent === "orange") {
    accentColor = "#f97316";
    accentGrad = "linear-gradient(135deg, #fb923c, #f97316)";
  } else if (config.accent === "red") {
    accentColor = "#ef4444";
    accentGrad = "linear-gradient(135deg, #f87171, #ef4444)";
  }
  style.setProperty("--cc-accent-color", accentColor);
  style.setProperty("--cc-accent-gradient", accentGrad);

  // Backdrop blur amount
  let blurVal = "8px";
  if (config.blur === "none") blurVal = "0px";
  else if (config.blur === "20px") blurVal = "20px";
  style.setProperty("--cc-backdrop-blur", blurVal);
}

// ─── Label → profile key mapping ─────────────────────────────────────────────
const LABEL_MAP = [
  // UID / Roll Number
  [/\buid\b/i,                        'uid'],
  [/university roll/i,                'rollNo'],
  [/roll\s*number/i,                  'rollNo'],
  [/enrollment\s*(no|number|id)?/i,   'uid'],
  [/registration\s*(no|number|id)?/i, 'uid'],

  // Name
  [/student\s*full\s*name/i,   'fullName'],
  [/full\s*name/i,             'fullName'],
  [/candidate\s*name/i,        'fullName'],
  [/applicant\s*name/i,        'fullName'],
  [/^name\s*\*?$/i,            'fullName'],
  [/first\s*name/i,            'firstName'],
  [/last\s*name/i,             'lastName'],
  [/surname/i,                 'lastName'],

  // Gender
  [/gender/i,                  'gender'],
  [/student\s*gender/i,        'gender'],

  // Email
  [/personal\s*email/i,        'email'],
  [/email\s*(id|address)?/i,   'email'],
  [/e-?mail/i,                 'email'],

  // Contact
  [/primary\s*mobile/i,        'mobile'],
  [/mobile\s*(number|no)?/i,   'mobile'],
  [/phone\s*(number|no)?/i,    'mobile'],
  [/contact\s*(number|no)?/i,  'mobile'],
  [/whatsapp/i,                'mobile'],

  // College
  [/college\s*name/i,          'college'],
  [/institution\s*name/i,      'college'],
  [/university\s*name/i,       'college'],
  [/school\s*name/i,           'college'],
  [/specify\s*college/i,       'collegeOther'],
  [/other\s*college/i,         'collegeOther'],
  [/college\s*(name\s*)?other/i,'collegeOther'],

  // Batch / Year
  [/year\s*of\s*passing/i,     'batch'],
  [/passing\s*year/i,          'batch'],
  [/graduation\s*year/i,       'batch'],
  [/batch\s*(year)?/i,         'batch'],

  // Course / Program
  [/course\s*\*?$/i,           'program'],
  [/program\s*(name)?\s*\*?$/i,'program'],
  [/degree\s*\*?/i,            'program'],

  // Stream / Branch
  [/current\s*stream/i,        'stream'],
  [/stream\s*\*?$/i,           'stream'],
  [/branch\s*\*?/i,            'stream'],
  [/specialization/i,          'stream'],
  [/discipline/i,              'stream'],
  [/department/i,              'stream'],

  // Percentages
  [/10th?\s*(percentage|%|marks|score)/i,  'tenth'],
  [/ssc\s*(percentage|%|marks)/i,          'tenth'],
  [/matric/i,                              'tenth'],
  [/12th?\s*(percentage|%|marks|score)/i,  'twelfth'],
  [/hsc\s*(percentage|%|marks)/i,          'twelfth'],
  [/inter(mediate)?\s*(percentage|%)?/i,   'twelfth'],
  [/graduation\s*(percentage|%|cgpa|gpa)/i,'grad'],
  [/ug\s*(percentage|%|cgpa)/i,            'grad'],
  [/\bcgpa\b/i,                            'grad'],
  [/\bgpa\b/i,                             'grad'],
  [/aggregate\s*(percentage|%|cgpa)/i,     'grad'],
  [/current\s*(cgpa|percentage|gpa)/i,     'grad'],

  // Backlog
  [/active\s*backlog\b(?!.*count|.*number|.*no)/i, 'backlog'],
  [/any\s*(active\s*)?backlog/i,                   'backlog'],
  [/no\s*of\s*active\s*backlog/i,                  'backlogCount'],
  [/number\s*of\s*(active\s*)?backlog/i,            'backlogCount'],
  [/backlog\s*(count|number|no)/i,                  'backlogCount'],

  // Position
  [/position\s*applying/i,     'position'],
  [/job\s*(role|position|title)/i, 'position'],
  [/role\s*applying/i,         'position'],
  [/applied\s*(for|role)/i,    'position'],

  // Location
  [/job\s*location/i,          'jobLocation'],
  [/preferred\s*location/i,    'jobLocation'],
  [/work\s*location/i,         'jobLocation'],
  [/location\s*(preference)?/i,'jobLocation'],

  // Japanese
  [/japanese\s*language\s*cert/i,    'japaneseCert'],
  [/have\s*you\s*japanese/i,         'japaneseCert'],
  [/jlpt\s*cert(ification)?/i,       'japaneseCert'],
  [/valid\s*jlpt/i,                  'jlptValid'],
  [/jlpt\s*level/i,                  'jlptLevel'],
  [/fluent\s*in\s*japanese/i,        'japaneseFluent'],
  [/japanese.*fluent/i,              'japaneseFluent'],
];

const IMPORTANT_MESSAGE_TEXTS = [
  /i understand that after submit/i,
  /i confirm that if i miss/i,
  /consent form/i,
  /registration is mandatory/i,
];

const UNDERTAKING_TEXTS = [
  /job description understanding/i,
  /placement process compliance/i,
  /ethical conduct/i,
  /consent and participation/i,
  /i hereby confirm/i,
  /i pledge to conduct/i,
  /i acknowledge that/i,
  /undertaking/i,
];

function getFormQuestions() {
  const questions = [];
  const questionBlocks = document.querySelectorAll('[role="listitem"], .freebirdFormviewerComponentsQuestionBaseRoot');

  questionBlocks.forEach(block => {
    const labelEl = block.querySelector('[role="heading"], .freebirdFormviewerComponentsQuestionBaseTitle, .M7eMe');
    if (!labelEl) return;
    const label = labelEl.textContent.trim().replace(/\s*\*\s*$/, '').trim();
    questions.push({ label, block });
  });

  return questions;
}

function matchLabel(label) {
  for (const [pattern, key] of LABEL_MAP) {
    if (pattern instanceof RegExp ? pattern.test(label) : label.toLowerCase().includes(pattern)) {
      return key;
    }
  }
  return null;
}

function triggerEvents(el, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

  if (el.tagName === 'INPUT' && nativeInputValueSetter) {
    nativeInputValueSetter.call(el, value);
  } else if (el.tagName === 'TEXTAREA' && nativeTextAreaValueSetter) {
    nativeTextAreaValueSetter.call(el, value);
  } else {
    el.value = value;
  }

  ['input', 'change', 'blur', 'keyup'].forEach(ev =>
    el.dispatchEvent(new Event(ev, { bubbles: true }))
  );
}

function fillTextInput(block, value, highlight) {
  const input = block.querySelector('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], textarea');
  if (!input || !value) return false;
  
  // Format UID as uppercase alphanumeric
  const isUID = input.id?.includes('uid') || input.name?.includes('uid') || input.getAttribute('aria-labelledby')?.includes('uid') || block.textContent.toLowerCase().includes('uid');
  if (isUID) {
    value = value.toString().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  }

  triggerEvents(input, value);
  if (highlight) flashElement(input);
  return true;
}

function fillDropdown(block, value, highlight) {
  if (!value) return false;

  const dropdown = block.querySelector('[role="listbox"], [role="combobox"]');
  if (dropdown) {
    const openBtn = block.querySelector('.exportSelect, [role="combobox"]');
    if (openBtn) openBtn.click();

    setTimeout(() => {
      const options = document.querySelectorAll('[role="option"]');
      for (const opt of options) {
        const text = opt.textContent.trim();
        if (normalizeVal(text) === normalizeVal(value) ||
            text.toLowerCase().includes(value.toLowerCase())) {
          opt.click();
          if (highlight) flashElement(opt);
          return;
        }
      }
      document.body.click();
    }, 200);
    return true;
  }

  const select = block.querySelector('select');
  if (select) {
    for (const opt of select.options) {
      if (normalizeVal(opt.text) === normalizeVal(value) ||
          opt.value.toLowerCase() === value.toLowerCase()) {
        select.value = opt.value;
        triggerEvents(select, opt.value);
        if (highlight) flashElement(select);
        return true;
      }
    }
  }

  return false;
}

function fillRadio(block, value, highlight) {
  if (!value) return false;

  const radios = block.querySelectorAll('[role="radio"], input[type="radio"]');
  for (const radio of radios) {
    const label = radio.closest('label')?.textContent.trim() ||
                  radio.nextElementSibling?.textContent.trim() ||
                  radio.getAttribute('data-value') || '';

    if (normalizeVal(label) === normalizeVal(value) ||
        label.toLowerCase().includes(value.toLowerCase())) {
      radio.click();
      if (highlight) flashElement(radio.closest('[role="radio"]') || radio);
      return true;
    }
  }
  return false;
}

function handleConsentCheckboxes(block, profile, highlight) {
  const text = block.textContent.trim();
  let shouldCheck = false;

  if (profile.autoImportantMsg !== false && IMPORTANT_MESSAGE_TEXTS.some(p => p.test(text))) {
    shouldCheck = true;
  }
  if (profile.autoUndertaking !== false && UNDERTAKING_TEXTS.some(p => p.test(text))) {
    shouldCheck = true;
  }

  if (!shouldCheck) return false;

  const checkboxes = block.querySelectorAll('[role="checkbox"], input[type="checkbox"]');
  let checked = false;
  checkboxes.forEach(cb => {
    const isChecked = cb.getAttribute('aria-checked') === 'true' || cb.checked;
    if (!isChecked) {
      cb.click();
      checked = true;
      if (highlight) flashElement(cb);
    }
  });

  return checked;
}

function normalizeVal(str) {
  return str.toLowerCase().replace(/\s+/g, ' ').trim();
}

function flashElement(el) {
  if (!el) return;
  const original = el.style.boxShadow;
  el.style.transition = 'box-shadow 0.3s';
  el.style.boxShadow = '0 0 0 3px #6c63ff88';
  setTimeout(() => { el.style.boxShadow = original; }, 800);
}

function fillForm(profile) {
  const questions = getFormQuestions();
  let filled = 0, skipped = 0;

  questions.forEach(({ label, block }) => {
    const key = matchLabel(label);

    if (profile.fillCheckboxes !== false) {
      if (handleConsentCheckboxes(block, profile, profile.showHighlight !== false)) {
        filled++;
        return;
      }
    }

    if (!key) { skipped++; return; }

    const value = profile[key];
    if (!value && value !== 0) { skipped++; return; }

    const highlight = profile.showHighlight !== false;

    const hasRadio = block.querySelector('[role="radio"], input[type="radio"]');
    const hasCheckbox = block.querySelector('[role="checkbox"], input[type="checkbox"]');
    const hasDropdown = block.querySelector('[role="listbox"], [role="combobox"], select');
    const hasText = block.querySelector('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], textarea');

    let success = false;

    if (hasRadio && profile.fillRadios !== false) {
      success = fillRadio(block, value, highlight);
    } else if (hasDropdown && profile.fillDropdowns !== false) {
      success = fillDropdown(block, value, highlight);
    } else if (hasText && profile.fillText !== false) {
      success = fillTextInput(block, value, highlight);
    } else if (hasCheckbox && profile.fillCheckboxes !== false) {
      success = fillRadio(block, value, highlight);
    }

    if (success) filled++;
    else skipped++;
  });

  return { filled, skipped, total: questions.length };
}

function triggerAutofillForm() {
  chrome.storage.local.get(["gformProfile", "autofill_profile"], (res) => {
    let profile = res.gformProfile;
    if (!profile || Object.keys(profile).length === 0) {
      profile = res.autofill_profile || {};
    }
    
    const hasValues = profile && Object.values(profile).some(val => val && val.toString().trim() !== "");
    if (!profile || !hasValues) {
      alert("No Autofill Profile configured!\n\nPlease open the Dashboard, go to the Settings tab, and fill out your Autofill Profile details first.");
      return;
    }
    
    // Normalize keys
    if (!profile.uid && profile.rollNumber) profile.uid = profile.rollNumber;
    if (!profile.rollNo && profile.rollNumber) profile.rollNo = profile.rollNumber;
    if (!profile.mobile && profile.contact) profile.mobile = profile.contact;
    if (!profile.grad && profile.graduationPercent) profile.grad = profile.graduationPercent;
    
    // For LABEL_MAP mapping consistency, ensure both sets of keys exist
    if (profile.rollNo && !profile.rollNumber) profile.rollNumber = profile.rollNo;
    if (profile.mobile && !profile.contact) profile.contact = profile.mobile;
    if (profile.grad && !profile.graduationPercent) profile.graduationPercent = profile.grad;

    // Set default flags
    if (profile.fillCheckboxes === undefined) profile.fillCheckboxes = true;
    if (profile.fillRadios === undefined) profile.fillRadios = true;
    if (profile.fillDropdowns === undefined) profile.fillDropdowns = true;
    if (profile.fillText === undefined) profile.fillText = true;
    if (profile.autoImportantMsg === undefined) profile.autoImportantMsg = true;
    if (profile.autoUndertaking === undefined) profile.autoUndertaking = true;
    if (profile.showHighlight === undefined) profile.showHighlight = true;
    
    const result = fillForm(profile);
    if (result && result.filled > 0) {
      showToast(`Autofilled ${result.filled} fields successfully!`, "success");
    } else {
      showToast("No matching fields found to autofill.", "error");
    }
  });
}

// =============================================================
// BOOTSTRAP / INITIALIZATION AT END OF SCRIPT
// =============================================================
function initExtensionOnLoad() {
  preloadStats();

  // Check if we came from Google Search fallback
  if (window.location && window.location.hash && window.location.hash.includes("focus-palette=true")) {
    history.replaceState(null, null, window.location.pathname + window.location.search);
    
    const urlParams = new URLSearchParams(window.location.search);
    const q = urlParams.get("q") || "";
    
    setTimeout(() => {
      if (!ccRoot) {
        createCommandPalette();
      }
      openCommandPalette();
      if (q && ccSearchInput) {
        ccSearchInput.value = q;
        ccSearchInput.setSelectionRange(0, q.length);
        handleSearchInputChange();
      }
    }, 150);
  }

  // Initialize the hover video overlay & player HUD
  initVideoOverlay();
}

// Immediately bind video hover detection and initialize HUD
try {
  initVideoOverlay();
} catch (e) {}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initExtensionOnLoad);
} else {
  initExtensionOnLoad();
}

window.addEventListener("load", () => {
  try {
    initVideoOverlay();
  } catch (e) {}
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.app_settings) {
    initVideoOverlay();
  }
});
