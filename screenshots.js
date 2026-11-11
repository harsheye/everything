document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const scrollArea = document.getElementById('scroll-area');
  const contentArea = document.getElementById('content-area');
  const emptyState = document.getElementById('empty-state');
  const statsLabel = document.getElementById('stats-label');
  
  const searchInput = document.getElementById('search-input');
  const filterPills = document.querySelectorAll('.filter-pill');
  const selectGroup = document.getElementById('select-group');
  const selectSort = document.getElementById('select-sort');
  const btnClearAll = document.getElementById('btn-clear-all');
  
  const btnToggleSelect = document.getElementById('btn-toggle-select');
  const selectionToolbar = document.getElementById('selection-toolbar');
  const selectionCount = document.getElementById('selection-count');
  const btnSelectAll = document.getElementById('btn-select-all');
  const btnDownloadSelected = document.getElementById('btn-download-selected');
  const btnDeleteSelected = document.getElementById('btn-delete-selected');
  const btnCancelSelect = document.getElementById('btn-cancel-select');
  
  const lightbox = document.getElementById('lightbox');
  const lbImg = document.getElementById('lb-img');
  const lbVid = document.getElementById('lb-vid');
  const btnLbClose = document.getElementById('btn-lb-close');
  const btnLbPrev = document.getElementById('btn-lb-prev');
  const btnLbNext = document.getElementById('btn-lb-next');
  const btnLbDownload = document.getElementById('btn-lb-download');
  const btnLbDelete = document.getElementById('btn-lb-delete');
  const lbMeta = document.getElementById('lightbox-meta');

  // State
  let allItems = [];
  let filteredItems = [];
  let layoutElements = []; // { id, type: 'header'|'card', y, height, width?, x?, data, groupKey? }
  let renderedDOM = new Map(); // id -> DOMElement
  let activeObjectUrls = new Map(); // id -> objectUrl (Memory management)

  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  
  let state = {
    filter: 'all',
    group: selectGroup ? selectGroup.value : 'domain',
    sort: 'newest',
    search: '',
    isSelectionMode: false,
    selectedIds: new Set(),
    collapsedGroups: new Set(),
    lightboxIndex: -1, // index in filteredItems
  };

  // Virtualization config
  const V_CONFIG = {
    headerHeight: 60,
    minColWidth: 200,
    gap: 16,
    overscan: 400, // Pre-render ~2 rows outside viewport
    unmountBuffer: 700, // Distance before unmounting DOM nodes
  };

  // --- PRIORITIZED SEQUENTIAL THUMBNAIL QUEUE ---
  // Controls concurrency (max 3 at once) and loads items in smooth waterfall order
  class SequentialThumbQueue {
    constructor(concurrency = 3) {
      this.concurrency = concurrency;
      this.running = 0;
      this.queue = [];
    }

    enqueue(elId, data, priority, callback) {
      this.queue = this.queue.filter(task => task.elId !== elId);
      this.queue.push({ elId, data, priority, callback });
      this.queue.sort((a, b) => b.priority - a.priority);
      this.drain();
    }

    cancel(elId) {
      this.queue = this.queue.filter(task => task.elId !== elId);
    }

    drain() {
      while (this.running < this.concurrency && this.queue.length > 0) {
        const task = this.queue.shift();
        this.running++;
        resolveThumbnailUrl(task.data)
          .then(url => task.callback(url))
          .catch(() => task.callback(''))
          .finally(() => {
            this.running--;
            this.drain();
          });
      }
    }
  }

  const thumbQueue = new SequentialThumbQueue(3);

  // --- SKELETON GRID PLACEHOLDER ---
  function renderSkeletonGrid() {
    emptyState.style.display = 'none';
    const containerWidth = scrollArea.clientWidth || window.innerWidth - 64;
    const columns = Math.max(2, Math.floor((containerWidth - 64 + V_CONFIG.gap) / (V_CONFIG.minColWidth + V_CONFIG.gap)));
    const colWidth = (containerWidth - 64 - (columns - 1) * V_CONFIG.gap) / columns;
    const rowHeight = colWidth * 0.75;
    const count = Math.min(15, columns * 3);

    // Cancel queued thumbnails and wipe DOM tracking so new elements mount fresh
    for (const [id] of renderedDOM.entries()) {
      thumbQueue.cancel(id);
    }
    renderedDOM.clear();
    contentArea.innerHTML = '';
    contentArea.style.height = `${Math.ceil(count / columns) * (rowHeight + V_CONFIG.gap) + 48}px`;

    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / columns);
      const col = i % columns;
      const x = 32 + col * (colWidth + V_CONFIG.gap);
      const y = 24 + row * (rowHeight + V_CONFIG.gap);

      const skel = document.createElement('div');
      skel.className = 'v-card initial-skeleton';
      skel.style.top = `${y}px`;
      skel.style.left = `${x}px`;
      skel.style.width = `${colWidth}px`;
      skel.style.height = `${rowHeight}px`;
      skel.innerHTML = '<div class="v-card-skeleton"></div>';
      contentArea.appendChild(skel);
    }
  }

  // --- INITIALIZATION ---
  async function loadData() {
    renderSkeletonGrid();
    try {
      allItems = await CommandPaletteDB.getScreenshots(10000);
      applyFiltersAndLayout();
      updateStorageBadge();

      // Silent non-blocking background migration for legacy Base64 items
      if (typeof MediaEngine !== 'undefined') {
        MediaEngine.migrateLegacyScreenshots(CommandPaletteDB, (done, total) => {
          if (done === total) {
            updateStorageBadge();
          }
        });
      }
    } catch (err) {
      console.error("Failed to load screenshots", err);
      statsLabel.textContent = "Error loading data";
    }
  }

  // --- SINGLE ITEM IN-PLACE DELETION (NO BLANK GALLERY / NO FULL RELOAD) ---
  async function deleteMediaItem(id) {
    try {
      await CommandPaletteDB.delete('screenshots', id);

      // Cancel thumbnail queue if pending
      thumbQueue.cancel(id);

      // Clean up object URL to free memory
      if (activeObjectUrls.has(id)) {
        URL.revokeObjectURL(activeObjectUrls.get(id));
        activeObjectUrls.delete(id);
      }

      // Remove from rendered DOM
      if (renderedDOM.has(id)) {
        const node = renderedDOM.get(id);
        if (node) node.remove();
        renderedDOM.delete(id);
      }

      // Remove from in-memory items array
      allItems = allItems.filter(item => item.id !== id);

      // Remove from selection if it was selected
      if (state.selectedIds.has(id)) {
        state.selectedIds.delete(id);
        updateSelectionToolbar();
      }

      // If lightbox is currently viewing this item
      if (state.lightboxIndex >= 0) {
        if (filteredItems[state.lightboxIndex]?.id === id) {
          if (filteredItems.length <= 1) {
            closeLightbox();
          } else {
            if (state.lightboxIndex >= filteredItems.length - 1) {
              state.lightboxIndex = Math.max(0, filteredItems.length - 2);
            }
          }
        }
      }

      // Smoothly re-layout remaining items in place!
      applyFiltersAndLayout();

      if (state.lightboxIndex >= 0 && filteredItems.length > 0) {
        updateLightboxUI();
      }

      updateStorageBadge();
    } catch (err) {
      console.error("Failed to delete media item:", id, err);
    }
  }

  // --- STORAGE STATS BADGE ---
  async function updateStorageBadge() {
    const storageBadge = document.getElementById('storage-badge');
    if (!storageBadge || typeof MediaEngine === 'undefined') return;
    try {
      const stats = await MediaEngine.getStorageStats();
      storageBadge.textContent = `⚡ ${stats.backend}: ${stats.usageFormatted}`;
      storageBadge.title = `High-Speed Browser Media Storage\nBackend: ${stats.backend}\nUsed: ${stats.usageFormatted} of ${stats.quotaFormatted} (${stats.percent}% quota used)`;
    } catch (e) {}
  }

  // --- MEMORY MANAGEMENT & ULTRA-FAST RETRIEVAL ---
  function getObjectUrl(item) {
    if (typeof item.content === 'string') return item.content; // Base64 legacy
    if (activeObjectUrls.has(item.id)) return activeObjectUrls.get(item.id);
    
    try {
      if (item.content instanceof Blob) {
        const url = URL.createObjectURL(item.content);
        activeObjectUrls.set(item.id, url);
        return url;
      }
    } catch (e) {
      console.warn("Invalid media content for item:", item.id, e);
    }
    return "";
  }

  async function resolveThumbnailUrl(item) {
    // Inline thumbnail stored directly (e.g. from content-script direct-IDB saves)
    if (item.thumbDataUrl) return item.thumbDataUrl;
    if (typeof MediaEngine !== 'undefined') {
      try {
        return await MediaEngine.getThumbnailUrl(item);
      } catch (e) {}
    }
    return getObjectUrl(item);
  }

  async function resolveFullMediaUrl(item) {
    // Content is a raw Blob stored directly in IDB (content-script direct save path)
    if (item.content instanceof Blob) return getObjectUrl(item);
    if (typeof MediaEngine !== 'undefined') {
      try {
        return await MediaEngine.getMediaUrl(item);
      } catch (e) {}
    }
    return getObjectUrl(item);
  }

  function cleanupObjectUrls(activeItemIds) {
    const keepIds = new Set(activeItemIds);
    for (const [id, url] of activeObjectUrls.entries()) {
      if (!keepIds.has(id)) {
        URL.revokeObjectURL(url);
        activeObjectUrls.delete(id);
      }
    }
  }

  // --- PIPELINE: Filter -> Sort -> Group -> Layout -> Render ---
  function applyFiltersAndLayout() {
    const q = (state.search || '').trim().toLowerCase();
    const now = Date.now();
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    const startOf7Days = now - 7 * 24 * 60 * 60 * 1000;
    
    // 1. Filter
    filteredItems = allItems.filter(item => {
      // Type and date filter pills
      if (state.filter === 'image' && item.type === 'video') return false;
      if (state.filter === 'video' && item.type !== 'video') return false;
      if (state.filter === 'today' && (item.timestamp || 0) < startOfToday) return false;
      if (state.filter === 'week' && (item.timestamp || 0) < startOf7Days) return false;
      if (state.filter === 'favorites' && !item.favorite && !item.pinned) return false;
      
      // Search query (URL, title, domain, date string)
      if (q) {
        const urlStr = (item.sourceUrl || '').toLowerCase();
        const titleStr = (item.title || '').toLowerCase();
        let domainStr = '';
        try {
          if (item.sourceUrl) domainStr = new URL(item.sourceUrl).hostname.toLowerCase();
        } catch(e) {}
        const dateStr = new Date(item.timestamp || 0).toLocaleDateString().toLowerCase();
        
        if (!urlStr.includes(q) && !titleStr.includes(q) && !domainStr.includes(q) && !dateStr.includes(q)) {
          return false;
        }
      }
      return true;
    });

    // 2. Comprehensive Sorting
    filteredItems.sort((a, b) => {
      switch (state.sort) {
        case 'newest':
          return (b.timestamp || 0) - (a.timestamp || 0);
        case 'oldest':
          return (a.timestamp || 0) - (b.timestamp || 0);
        case 'name_asc': {
          const nameA = (a.title || a.sourceUrl || '').toLowerCase();
          const nameB = (b.title || b.sourceUrl || '').toLowerCase();
          return nameA.localeCompare(nameB);
        }
        case 'name_desc': {
          const nameA = (a.title || a.sourceUrl || '').toLowerCase();
          const nameB = (b.title || b.sourceUrl || '').toLowerCase();
          return nameB.localeCompare(nameA);
        }
        case 'url_asc': {
          const urlA = (a.sourceUrl || '').toLowerCase();
          const urlB = (b.sourceUrl || '').toLowerCase();
          return urlA.localeCompare(urlB);
        }
        case 'size_desc':
          return (b.size || 0) - (a.size || 0);
        case 'size_asc':
          return (a.size || 0) - (b.size || 0);
        case 'type':
          if (a.type === b.type) return (b.timestamp || 0) - (a.timestamp || 0);
          return a.type === 'video' ? -1 : 1; // Videos first
        default:
          return (b.timestamp || 0) - (a.timestamp || 0);
      }
    });

    if (filteredItems.length === 0) {
      layoutElements = [];
      // Clean up all mounted DOM cards and queue
      for (const [id, domNode] of renderedDOM.entries()) {
        thumbQueue.cancel(id);
        domNode.remove();
      }
      renderedDOM.clear();
      contentArea.style.height = '0px';

      updateEmptyStateMessage();
      emptyState.style.display = 'flex';

      const initialSkels = contentArea.querySelectorAll('.initial-skeleton');
      initialSkels.forEach(s => s.remove());
      statsLabel.textContent = '0 items';
      return;
    }
    emptyState.style.display = 'none';

    // 3. Layout calculation
    layoutElements = [];
    const containerWidth = scrollArea.clientWidth || window.innerWidth - 64; // Fallback
    const columns = Math.max(2, Math.floor((containerWidth - 64 + V_CONFIG.gap) / (V_CONFIG.minColWidth + V_CONFIG.gap)));
    const colWidth = (containerWidth - 64 - (columns - 1) * V_CONFIG.gap) / columns;
    const rowHeight = colWidth * 0.75; // 4:3 aspect ratio

    let currentY = 24; // top padding

    if (state.group === 'none') {
      layoutElements.push({ id: 'header_all', type: 'header', y: currentY, height: 0, hidden: true }); // Dummy
      for (let i = 0; i < filteredItems.length; i++) {
        const row = Math.floor(i / columns);
        const col = i % columns;
        const x = 32 + col * (colWidth + V_CONFIG.gap);
        const y = currentY + row * (rowHeight + V_CONFIG.gap);
        layoutElements.push({ id: filteredItems[i].id, type: 'card', x, y, width: colWidth, height: rowHeight, data: filteredItems[i] });
      }
      const rows = Math.ceil(filteredItems.length / columns);
      currentY += rows * (rowHeight + V_CONFIG.gap);
    } else {
      // Flexible Grouping: Domain, Date, Type, Size
      const groupsMap = new Map();
      const currDate = new Date();
      const todayStart = new Date(currDate.getFullYear(), currDate.getMonth(), currDate.getDate()).getTime();
      const yesterdayStart = todayStart - 86400000;
      const weekStart = todayStart - 6 * 86400000;
      const monthStart = new Date(currDate.getFullYear(), currDate.getMonth(), 1).getTime();

      filteredItems.forEach(item => {
        let key = 'Other';
        if (state.group === 'domain') {
          try {
            const raw = item.sourceUrl || item.url || '';
            if (raw) {
              const u = new URL(raw);
              key = u.hostname.replace(/^www\./, '');
              if (!key) key = u.protocol.replace(':', '');
            } else {
              key = item.title ? `Local: ${item.title}` : 'Local / Unknown';
            }
          } catch(e) { key = item.sourceUrl || item.url || (item.title ? `Local: ${item.title}` : 'Local / Unknown'); }
        } else if (state.group === 'url') {
          try {
            const raw = item.sourceUrl || item.url || '';
            if (raw) {
              const u = new URL(raw);
              let displayUrl = (u.origin + u.pathname).replace(/\/$/, '');
              if (u.search) displayUrl += u.search;
              key = displayUrl || raw;
            } else {
              key = item.title ? `Local: ${item.title}` : 'Local / Webpage';
            }
          } catch(e) { key = item.sourceUrl || item.url || (item.title ? `Local: ${item.title}` : 'Local / Webpage'); }
        } else if (state.group === 'date') {
          const t = item.timestamp || 0;
          if (t >= todayStart) key = 'Today';
          else if (t >= yesterdayStart) key = 'Yesterday';
          else if (t >= weekStart) key = 'Previous 7 Days';
          else if (t >= monthStart) key = 'This Month';
          else key = 'Older';
        } else if (state.group === 'type') {
          key = item.type === 'video' ? 'Videos' : 'Screenshots & Images';
        } else if (state.group === 'size') {
          const sz = item.size || 0;
          if (sz >= 2 * 1024 * 1024) key = 'Large (> 2 MB)';
          else if (sz >= 500 * 1024) key = 'Medium (500 KB - 2 MB)';
          else key = 'Small (< 500 KB)';
        }

        if (!groupsMap.has(key)) groupsMap.set(key, []);
        groupsMap.get(key).push(item);
      });

      for (const [key, items] of groupsMap.entries()) {
        const isCollapsed = state.collapsedGroups.has(key);
        const imgC = items.filter(i => i.type !== 'video').length;
        const vidC = items.length - imgC;
        
        layoutElements.push({ 
          id: 'group_' + key, 
          type: 'header', 
          y: currentY, 
          height: V_CONFIG.headerHeight, 
          groupKey: key, 
          title: key,
          meta: `${items.length} items · ${imgC} imgs · ${vidC} vids`,
          isCollapsed 
        });
        currentY += V_CONFIG.headerHeight;

        if (!isCollapsed) {
          for (let i = 0; i < items.length; i++) {
            const row = Math.floor(i / columns);
            const col = i % columns;
            const x = 32 + col * (colWidth + V_CONFIG.gap);
            const y = currentY + row * (rowHeight + V_CONFIG.gap);
            layoutElements.push({ id: items[i].id, type: 'card', x, y, width: colWidth, height: rowHeight, data: items[i] });
          }
          const rows = Math.ceil(items.length / columns);
          currentY += rows * (rowHeight + V_CONFIG.gap) + 24; // bottom margin
        }
      }
    }

    contentArea.style.height = `${currentY + 100}px`;
    
    // Prune any rendered DOM nodes that are no longer part of current layout (e.g. filtered out)
    const activeLayoutIds = new Set(layoutElements.map(el => el.id));
    for (const [id, domNode] of renderedDOM.entries()) {
      if (!activeLayoutIds.has(id)) {
        thumbQueue.cancel(id);
        domNode.remove();
        renderedDOM.delete(id);
      }
    }

    // Stats update
    const imgCount = filteredItems.filter(i => i.type !== 'video').length;
    const vidCount = filteredItems.length - imgCount;
    statsLabel.textContent = `${filteredItems.length} items (${imgCount} images, ${vidCount} videos)`;
    
    // Remove initial placeholder skeletons smoothly
    const initialSkels = contentArea.querySelectorAll('.initial-skeleton');
    initialSkels.forEach(s => s.remove());

    updateVirtualDOM();
  }

  // --- CONTEXTUAL EMPTY STATE MESSAGING ---
  function updateEmptyStateMessage() {
    const titleEl = document.getElementById('empty-state-title');
    const descEl = document.getElementById('empty-state-desc');
    if (!titleEl || !descEl) return;

    if (state.search) {
      titleEl.textContent = 'No matching media found';
      descEl.textContent = `No screenshots or videos match "${escapeHTML(state.search)}".`;
    } else if (state.filter === 'video') {
      titleEl.textContent = 'No video recordings found';
      descEl.textContent = 'Video recordings captured from the player will appear here.';
    } else if (state.filter === 'image') {
      titleEl.textContent = 'No screenshots found';
      descEl.textContent = 'Screenshots captured while browsing will appear here.';
    } else if (state.filter === 'today') {
      titleEl.textContent = 'No media captured today';
      descEl.textContent = 'Screenshots and recordings from today will appear here.';
    } else if (state.filter === 'week') {
      titleEl.textContent = 'No media captured this week';
      descEl.textContent = 'Screenshots and recordings from the past 7 days will appear here.';
    } else if (state.filter === 'favorites') {
      titleEl.textContent = 'No favorites yet';
      descEl.textContent = 'Click the star icon on any media item in the gallery to favorite it.';
    } else {
      titleEl.textContent = 'Your gallery is empty';
      descEl.textContent = 'Images and videos captured while browsing will appear here.';
    }
  }

  // --- VIRTUAL DOM RENDERER ---
  let scrollTicking = false;
  scrollArea.addEventListener('scroll', () => {
    if (!scrollTicking) {
      window.requestAnimationFrame(() => {
        try {
          updateVirtualDOM();
        } finally {
          scrollTicking = false;
        }
      });
      scrollTicking = true;
    }
  }, { passive: true });

  window.addEventListener('resize', () => {
    applyFiltersAndLayout(); // Recalculate columns on resize
  });

  // --- O(log N) BINARY SEARCH FOR VISIBLE RANGE ---
  function findFirstVisibleIndex(elements, targetY) {
    let low = 0;
    let high = elements.length - 1;
    let result = 0;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (elements[mid].y + elements[mid].height >= targetY) {
        result = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return result;
  }

  function updateVirtualDOM() {
    if (layoutElements.length === 0) return;

    const scrollTop = scrollArea.scrollTop;
    const viewportHeight = scrollArea.clientHeight || window.innerHeight;
    const visibleRangeStart = Math.max(0, scrollTop - V_CONFIG.overscan);
    const visibleRangeEnd = scrollTop + viewportHeight + V_CONFIG.overscan;
    const viewportCenter = scrollTop + viewportHeight / 2;

    const currentlyVisibleIds = new Set();
    const startIdx = findFirstVisibleIndex(layoutElements, visibleRangeStart);

    for (let i = startIdx; i < layoutElements.length; i++) {
      const el = layoutElements[i];
      if (el.hidden) continue;
      if (el.y > visibleRangeEnd) break; // Reached bottom of visible region!

      currentlyVisibleIds.add(el.id);
      try {
        if (!renderedDOM.has(el.id)) {
          // Priority based on distance to viewport center (closest loads first)
          const dist = Math.abs((el.y + el.height / 2) - viewportCenter);
          const priority = 10000 - dist;
          mountElement(el, priority);
        } else {
          updateElement(el, renderedDOM.get(el.id));
        }
      } catch (err) {
        console.error("Failed to render virtual element:", el, err);
      }
    }

    // Unmount elements that are beyond unmountBuffer
    const unmountStart = scrollTop - V_CONFIG.unmountBuffer;
    const unmountEnd = scrollTop + viewportHeight + V_CONFIG.unmountBuffer;

    for (const [id, domNode] of renderedDOM.entries()) {
      if (!currentlyVisibleIds.has(id)) {
        const topY = parseFloat(domNode.style.top) || 0;
        const height = parseFloat(domNode.style.height) || 0;
        if (topY + height < unmountStart || topY > unmountEnd) {
          thumbQueue.cancel(id);
          domNode.remove();
          renderedDOM.delete(id);
        }
      }
    }

    // Cleanup ObjectURLs for heavy media items that are far out of view
    const activeDataIds = Array.from(renderedDOM.keys())
      .filter(id => !id.startsWith('group_'))
      .concat(state.lightboxIndex >= 0 ? [filteredItems[state.lightboxIndex].id] : []);
    
    cleanupObjectUrls(activeDataIds);
  }

  function mountElement(el, priority = 0) {
    let domNode;
    if (el.type === 'header') {
      domNode = document.createElement('div');
      domNode.className = `v-header ${el.isCollapsed ? 'collapsed' : ''}`;
      domNode.style.top = `${el.y}px`;
      domNode.style.height = `${el.height}px`;
      
      const isHttpLink = typeof el.title === 'string' && (el.title.startsWith('http://') || el.title.startsWith('https://'));
      const linkHtml = isHttpLink 
        ? `<a href="${escapeHTML(el.title)}" target="_blank" rel="noopener noreferrer" class="v-header-link" title="Open ${escapeHTML(el.title)} in new tab" onclick="event.stopPropagation();">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
           </a>`
        : '';

      domNode.innerHTML = `
        <div class="v-header-left">
          <div class="v-header-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg></div>
          <div class="v-header-title" title="${escapeHTML(el.title)}">${escapeHTML(el.title)}</div>
          ${linkHtml}
          <div class="v-header-meta">${escapeHTML(el.meta)}</div>
        </div>
      `;
      domNode.addEventListener('click', () => {
        if (state.collapsedGroups.has(el.groupKey)) state.collapsedGroups.delete(el.groupKey);
        else state.collapsedGroups.add(el.groupKey);
        applyFiltersAndLayout();
      });

    } else if (el.type === 'card') {
      domNode = document.createElement('div');
      domNode.className = `v-card ${state.selectedIds.has(el.id) ? 'selected' : ''}`;
      domNode.style.top = `${el.y}px`;
      domNode.style.left = `${el.x}px`;
      domNode.style.width = `${el.width}px`;
      domNode.style.height = `${el.height}px`;

      const isVideo = el.data.type === 'video';
      const isFav = !!el.data.favorite;
      let domain = '';
      if (el.data.sourceUrl) {
        try {
          domain = new URL(el.data.sourceUrl).hostname.replace(/^www\./, '');
        } catch (e) {
          domain = el.data.sourceUrl;
        }
      }
      
      // Skeleton placeholder initially with media image inside
      domNode.innerHTML = `
        <div class="v-card-skeleton"></div>
        <img class="v-card-media" alt="Media preview">
        <div class="v-card-overlay">
          <div class="v-card-top">
            <div style="display:flex; align-items:center; gap:6px; max-width:80%; overflow:hidden;">
              ${isVideo ? '<div class="v-card-type"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Video</div>' : ''}
              ${el.data.sourceUrl ? `
                <a class="v-card-url-badge" href="${el.data.sourceUrl}" target="_blank" rel="noopener noreferrer" title="Click to visit: ${el.data.sourceUrl}">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                  <span>${domain || 'webpage'}</span>
                </a>
              ` : ''}
            </div>
            ${state.isSelectionMode ? '<div class="v-card-select"></div>' : '<div></div>'}
          </div>
          <div class="v-card-actions">
            ${el.data.sourceUrl ? `
              <a class="icon-btn btn-visit" href="${el.data.sourceUrl}" target="_blank" rel="noopener noreferrer" title="Open source page in new tab">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
              </a>
            ` : ''}
            <button class="icon-btn btn-fav ${isFav ? 'active' : ''}" title="${isFav ? 'Favorited' : 'Add to Favorites'}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            </button>
            <button class="icon-btn btn-dl" title="Download"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></button>
            <button class="icon-btn danger btn-del" title="Delete"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
          </div>
        </div>
      `;

      const mediaImg = domNode.querySelector('.v-card-media');

      // Sequential waterfall loading via prioritized queue
      thumbQueue.enqueue(el.id, el.data, priority, (thumbUrl) => {
        if (!domNode.isConnected) return;
        if (!thumbUrl) {
          domNode.classList.add('loaded');
          return;
        }
        mediaImg.src = thumbUrl;
        mediaImg.onload = () => {
          if (domNode.isConnected) domNode.classList.add('loaded');
        };
        mediaImg.onerror = () => {
          if (domNode.isConnected) domNode.classList.add('loaded');
        };
      });

      // Video preview on hover
      if (isVideo) {
        let activeVid = null;
        domNode.addEventListener('mouseenter', async () => {
          if (!activeVid) {
            const vidUrl = await resolveFullMediaUrl(el.data);
            if (!vidUrl || !domNode.isConnected) return;
            activeVid = document.createElement('video');
            activeVid.className = 'v-card-media';
            activeVid.style.opacity = '1';
            activeVid.style.zIndex = '2';
            activeVid.src = vidUrl;
            activeVid.muted = true;
            activeVid.autoplay = true;
            activeVid.loop = true;
            activeVid.playsInline = true;
            domNode.insertBefore(activeVid, domNode.querySelector('.v-card-overlay'));
            activeVid.play().catch(()=>{});
          } else {
            activeVid.play().catch(()=>{});
          }
        });

        domNode.addEventListener('mouseleave', () => {
          if (activeVid) {
            activeVid.pause();
            activeVid.currentTime = 0;
            activeVid.remove();
            activeVid = null;
          }
        });
      }

      // Prevent URL click from opening lightbox
      domNode.querySelector('.v-card-url-badge')?.addEventListener('click', (e) => e.stopPropagation());
      domNode.querySelector('.btn-visit')?.addEventListener('click', (e) => e.stopPropagation());

      // Favorite toggle
      domNode.querySelector('.btn-fav')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        el.data.favorite = !el.data.favorite;
        const btn = domNode.querySelector('.btn-fav');
        if (btn) {
          btn.classList.toggle('active', !!el.data.favorite);
          const starSvg = btn.querySelector('svg');
          if (starSvg) starSvg.setAttribute('fill', el.data.favorite ? 'currentColor' : 'none');
          btn.title = el.data.favorite ? 'Favorited' : 'Add to Favorites';
        }
        await CommandPaletteDB.put('screenshots', el.data);
      });

      // Events
      domNode.addEventListener('click', (e) => {
        if (e.target.closest('.icon-btn') || e.target.closest('.v-card-url-badge')) return; // ignore action clicks
        if (state.isSelectionMode) {
          if (state.selectedIds.has(el.id)) state.selectedIds.delete(el.id);
          else state.selectedIds.add(el.id);
          updateSelectionToolbar();
          applyFiltersAndLayout(); // quick re-render to update classes
        } else {
          openLightbox(el.data.id);
        }
      });

      domNode.querySelector('.btn-dl').addEventListener('click', () => downloadItem(el.data));
      domNode.querySelector('.btn-del').addEventListener('click', async () => {
        if (confirm("Delete this media?")) {
          await deleteMediaItem(el.id);
        }
      });
    }

    contentArea.appendChild(domNode);
    renderedDOM.set(el.id, domNode);
  }

  function updateElement(el, domNode) {
    domNode.style.top = `${el.y}px`;
    if (el.x !== undefined) domNode.style.left = `${el.x}px`;
    if (el.width !== undefined) domNode.style.width = `${el.width}px`;
    domNode.style.height = `${el.height}px`;
    
    if (el.type === 'card') {
      if (state.isSelectionMode) {
        let selIcon = domNode.querySelector('.v-card-select');
        if (!selIcon) {
          selIcon = document.createElement('div');
          selIcon.className = 'v-card-select';
          domNode.querySelector('.v-card-top').appendChild(selIcon);
        }
      } else {
        domNode.querySelector('.v-card-select')?.remove();
      }

      if (state.selectedIds.has(el.id)) domNode.classList.add('selected');
      else domNode.classList.remove('selected');
    }
  }

  // --- ACTIONS ---
  async function downloadItem(item) {
    const url = await resolveFullMediaUrl(item);
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    const ext = item.type === 'video' ? 'webm' : (item.mimeType === 'image/webp' ? 'webp' : 'png');
    const safeUrl = item.sourceUrl ? item.sourceUrl.replace(/^https?:\/\//, '').replace(/[^a-z0-9]/gi, '_').substring(0, 50) : 'capture';
    a.download = `${safeUrl}_${item.timestamp}.${ext}`;
    a.click();
  }

  // --- LIGHTBOX & MOUSE SCROLL ZOOM ENGINE ---
  const zoomState = {
    scale: 1,
    minScale: 1,
    maxScale: 6,
    posX: 0,
    posY: 0,
    isDragging: false,
    startX: 0,
    startY: 0,
  };

  const lbZoomControls = document.getElementById('lb-zoom-controls');
  const lbZoomLevel = document.getElementById('lb-zoom-level');
  const btnZoomIn = document.getElementById('btn-zoom-in');
  const btnZoomOut = document.getElementById('btn-zoom-out');
  const btnZoomReset = document.getElementById('btn-zoom-reset');

  function updateZoomUI() {
    if (lbZoomLevel) lbZoomLevel.textContent = `${Math.round(zoomState.scale * 100)}%`;

    if (lbImg) {
      if (zoomState.scale > 1.02) {
        lbImg.classList.add('zoomed');
        lbImg.style.transform = `translate(${zoomState.posX}px, ${zoomState.posY}px) scale(${zoomState.scale})`;
      } else {
        lbImg.classList.remove('zoomed');
        lbImg.style.transform = '';
      }
    }
  }

  function resetZoom() {
    zoomState.scale = 1;
    zoomState.posX = 0;
    zoomState.posY = 0;
    zoomState.isDragging = false;
    updateZoomUI();
  }

  function setZoom(newScale, clientX, clientY) {
    newScale = Math.min(zoomState.maxScale, Math.max(zoomState.minScale, newScale));
    if (Math.abs(newScale - zoomState.scale) < 0.01 && newScale === 1) return;

    if (newScale <= 1.02) {
      zoomState.scale = 1;
      zoomState.posX = 0;
      zoomState.posY = 0;
    } else {
      if (clientX !== undefined && clientY !== undefined && lbImg) {
        const factor = newScale / zoomState.scale;
        zoomState.posX = clientX - (clientX - zoomState.posX) * factor;
        zoomState.posY = clientY - (clientY - zoomState.posY) * factor;
      }
      zoomState.scale = newScale;
    }
    updateZoomUI();
  }

  // Mouse wheel zoom on fullscreen image
  lightbox.addEventListener('wheel', (e) => {
    if (state.lightboxIndex < 0) return;
    const item = filteredItems[state.lightboxIndex];
    if (!item || item.type === 'video') return;

    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.2 : 0.83;
    setZoom(zoomState.scale * factor, e.clientX, e.clientY);
  }, { passive: false });

  // Pan / Drag image when zoomed in
  lbImg.addEventListener('mousedown', (e) => {
    if (zoomState.scale <= 1) return;
    e.preventDefault();
    zoomState.isDragging = true;
    zoomState.startX = e.clientX - zoomState.posX;
    zoomState.startY = e.clientY - zoomState.posY;
    lbImg.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!zoomState.isDragging) return;
    zoomState.posX = e.clientX - zoomState.startX;
    zoomState.posY = e.clientY - zoomState.startY;
    updateZoomUI();
  });

  window.addEventListener('mouseup', () => {
    if (zoomState.isDragging) {
      zoomState.isDragging = false;
      if (lbImg) lbImg.style.cursor = zoomState.scale > 1 ? 'grab' : 'zoom-in';
    }
  });

  // Double click image to toggle zoom
  lbImg.addEventListener('dblclick', (e) => {
    if (zoomState.scale > 1.05) {
      resetZoom();
    } else {
      setZoom(2.5, e.clientX, e.clientY);
    }
  });

  btnZoomIn?.addEventListener('click', () => setZoom(zoomState.scale * 1.3));
  btnZoomOut?.addEventListener('click', () => setZoom(zoomState.scale * 0.77));
  btnZoomReset?.addEventListener('click', resetZoom);
  lbZoomLevel?.addEventListener('click', resetZoom);

  // --- OPEN / RENDER LIGHTBOX ---
  function openLightbox(id) {
    state.lightboxIndex = filteredItems.findIndex(i => i.id === id);
    if (state.lightboxIndex === -1) return;
    resetZoom();
    updateLightboxUI();
    lightbox.classList.add('active');
  }
  
  async function updateLightboxUI() {
    if (state.lightboxIndex < 0 || state.lightboxIndex >= filteredItems.length) return;
    const item = filteredItems[state.lightboxIndex];
    resetZoom();
    
    // Format source URL display
    let domain = '';
    if (item.sourceUrl) {
      try {
        domain = new URL(item.sourceUrl).hostname.replace(/^www\./, '');
      } catch (e) {
        domain = item.sourceUrl;
      }
    }

    const titleStr = item.title ? `<strong style="color:#fff;">${item.title}</strong> · ` : '';
    const sizeStr = item.size ? ` · ${(item.size / 1024).toFixed(0)} KB` : '';

    lbMeta.innerHTML = `
      <div class="lightbox-meta-row">
        <span><strong>${state.lightboxIndex + 1}</strong> of ${filteredItems.length}</span>
        <span>•</span>
        <span>${titleStr}${new Date(item.timestamp).toLocaleString()}${sizeStr}</span>
        ${item.sourceUrl ? `
          <span>•</span>
          <a class="lb-source-link" href="${item.sourceUrl}" target="_blank" rel="noopener noreferrer" title="Click to visit original page: ${item.sourceUrl}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            <span>${domain || item.sourceUrl}</span>
          </a>
        ` : ''}
      </div>
    `;
    
    const url = await resolveFullMediaUrl(item);

    if (item.type === 'video') {
      if (lbZoomControls) lbZoomControls.style.display = 'none';
      lbImg.style.display = 'none';
      lbImg.src = '';
      lbVid.style.display = 'block';
      lbVid.src = url;
      lbVid.play().catch(()=>{});
    } else {
      if (lbZoomControls) lbZoomControls.style.display = 'flex';
      lbVid.style.display = 'none';
      lbVid.pause();
      lbVid.src = '';
      lbImg.style.display = 'block';
      lbImg.src = url;
    }
  }

  function closeLightbox() {
    resetZoom();
    lightbox.classList.remove('active');
    lbVid.pause();
    lbVid.src = '';
    lbImg.src = '';
    state.lightboxIndex = -1;
    updateVirtualDOM(); // Allow object URL cleanup
  }

  btnLbClose.addEventListener('click', closeLightbox);
  btnLbPrev.addEventListener('click', () => { if(state.lightboxIndex > 0) { state.lightboxIndex--; updateLightboxUI(); }});
  btnLbNext.addEventListener('click', () => { if(state.lightboxIndex < filteredItems.length-1) { state.lightboxIndex++; updateLightboxUI(); }});
  
  btnLbDownload.addEventListener('click', () => {
    if(state.lightboxIndex >= 0) downloadItem(filteredItems[state.lightboxIndex]);
  });
  
  btnLbDelete.addEventListener('click', async () => {
    if (state.lightboxIndex >= 0 && confirm("Delete this media?")) {
      const id = filteredItems[state.lightboxIndex].id;
      await deleteMediaItem(id);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('active')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft' && state.lightboxIndex > 0) { state.lightboxIndex--; updateLightboxUI(); }
    if (e.key === 'ArrowRight' && state.lightboxIndex < filteredItems.length-1) { state.lightboxIndex++; updateLightboxUI(); }
  });

  // --- TOOLBAR BINDINGS ---
  filterPills.forEach(pill => {
    pill.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      filterPills.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.type || 'all';
      applyFiltersAndLayout();
      scrollArea.scrollTop = 0;
    });
  });

  searchInput.addEventListener('input', (e) => {
    state.search = e.target.value;
    applyFiltersAndLayout();
    scrollArea.scrollTop = 0;
  });

  selectGroup.addEventListener('change', (e) => {
    state.group = e.target.value;
    state.collapsedGroups.clear(); // expand all on group change
    applyFiltersAndLayout();
    scrollArea.scrollTop = 0;
  });

  selectSort.addEventListener('change', (e) => {
    state.sort = e.target.value;
    applyFiltersAndLayout();
  });

  btnClearAll.addEventListener('click', async () => {
    if (confirm("Are you sure you want to permanently delete ALL screenshots and videos? This cannot be undone.")) {
      await CommandPaletteDB.clear('screenshots');
      
      // Revoke all active object URLs
      for (const [id, url] of activeObjectUrls.entries()) {
        URL.revokeObjectURL(url);
      }
      activeObjectUrls.clear();

      // Wipe rendered DOM nodes
      for (const [id, node] of renderedDOM.entries()) {
        thumbQueue.cancel(id);
        node.remove();
      }
      renderedDOM.clear();

      allItems = [];
      state.selectedIds.clear();
      state.isSelectionMode = false;
      updateSelectionToolbar();
      applyFiltersAndLayout();
      updateStorageBadge();
    }
  });

  // --- SELECTION MODE ---
  function updateSelectionToolbar() {
    selectionCount.textContent = `${state.selectedIds.size} selected`;
    if (state.isSelectionMode) {
      selectionToolbar.classList.add('active');
    } else {
      selectionToolbar.classList.remove('active');
      state.selectedIds.clear();
    }
  }

  btnToggleSelect.addEventListener('click', () => {
    state.isSelectionMode = !state.isSelectionMode;
    btnToggleSelect.classList.toggle('active', state.isSelectionMode);
    updateSelectionToolbar();
    applyFiltersAndLayout();
  });

  btnCancelSelect.addEventListener('click', () => {
    state.isSelectionMode = false;
    btnToggleSelect.classList.remove('active');
    updateSelectionToolbar();
    applyFiltersAndLayout();
  });

  btnSelectAll.addEventListener('click', () => {
    filteredItems.forEach(item => state.selectedIds.add(item.id));
    updateSelectionToolbar();
    applyFiltersAndLayout();
  });

  btnDownloadSelected.addEventListener('click', async () => {
    const itemsToDl = filteredItems.filter(i => state.selectedIds.has(i.id));
    if (itemsToDl.length === 0) return;
    
    if (itemsToDl.length === 1) {
      downloadItem(itemsToDl[0]);
    } else {
      if (typeof JSZip !== 'undefined') {
        const overlay = document.getElementById('zip-progress-overlay');
        const statusEl = document.getElementById('zip-status');
        const barFill = document.getElementById('zip-bar-fill');
        const percentEl = document.getElementById('zip-percent');

        // Show overlay
        statusEl.textContent = `Packing ${itemsToDl.length} files…`;
        barFill.style.width = '0%';
        percentEl.textContent = '0%';
        overlay.classList.add('active');

        const zip = new JSZip();
        for (const item of itemsToDl) {
          const safeUrl = item.sourceUrl ? item.sourceUrl.replace(/^https?:\/\//, '').replace(/[^a-z0-9]/gi, '_').substring(0, 50) : 'capture';
          const ext = item.type === 'video' ? 'webm' : (item.mimeType === 'image/webp' ? 'webp' : 'png');
          let filename = `${safeUrl}_${item.timestamp}.${ext}`;
          
          // Ensure unique filenames if there are identical timestamps
          let counter = 1;
          while (zip.file(filename)) {
             filename = `${safeUrl}_${item.timestamp}_${counter}.${ext}`;
             counter++;
          }
          
          let blob = null;
          if (typeof MediaEngine !== 'undefined') {
            try {
              blob = await MediaEngine.getMediaBlob(item);
            } catch (e) {}
          }
          if (!blob && item.content instanceof Blob) {
            blob = item.content;
          } else if (!blob && typeof item.content === 'string') {
            blob = MediaEngine.dataUrlToBlob(item.content);
          }

          if (blob) {
            zip.file(filename, blob);
          }
        }
        
        zip.generateAsync({type: "blob"}, (metadata) => {
          const pct = Math.round(metadata.percent);
          barFill.style.width = pct + '%';
          percentEl.textContent = pct + '%';
          if (pct < 100) {
            statusEl.textContent = `Compressing… ${pct}%`;
          } else {
            statusEl.textContent = 'Finalizing…';
          }
        }).then(content => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(content);
          a.download = `gallery_download_${Date.now()}.zip`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);

          // Hide overlay
          barFill.style.width = '100%';
          percentEl.textContent = '100%';
          statusEl.textContent = 'Done!';
          setTimeout(() => overlay.classList.remove('active'), 600);
        }).catch(e => {
          console.error("Zip generation failed", e);
          overlay.classList.remove('active');
          alert("Failed to create zip file");
        });
      } else {
        // Fallback if JSZip is not loaded
        let i = 0;
        const interval = setInterval(() => {
          downloadItem(itemsToDl[i]);
          i++;
          if (i >= itemsToDl.length) clearInterval(interval);
        }, 300);
      }
    }
    
    state.isSelectionMode = false;
    btnToggleSelect.classList.remove('active');
    updateSelectionToolbar();
    applyFiltersAndLayout();
  });

  btnDeleteSelected.addEventListener('click', async () => {
    const size = state.selectedIds.size;
    if (size === 0) return;
    if (confirm(`Delete ${size} selected item${size > 1 ? 's' : ''}?`)) {
      const overlay = document.getElementById('zip-progress-overlay');
      const statusEl = document.getElementById('zip-status');
      const barFill = document.getElementById('zip-bar-fill');
      const percentEl = document.getElementById('zip-percent');
      const titleEl = overlay.querySelector('h3');

      titleEl.textContent = 'Deleting files';
      statusEl.textContent = `Deleting 0 of ${size}…`;
      barFill.style.width = '0%';
      percentEl.textContent = '0%';
      overlay.classList.add('active');

      const idsToDelete = new Set(state.selectedIds);
      let done = 0;
      for (const id of idsToDelete) {
        try {
          await CommandPaletteDB.delete('screenshots', id);
          thumbQueue.cancel(id);
          if (activeObjectUrls.has(id)) {
            URL.revokeObjectURL(activeObjectUrls.get(id));
            activeObjectUrls.delete(id);
          }
          if (renderedDOM.has(id)) {
            const node = renderedDOM.get(id);
            if (node) node.remove();
            renderedDOM.delete(id);
          }
        } catch (e) {
          console.error("Delete failed for item:", id, e);
        }
        done++;
        const pct = Math.round((done / size) * 100);
        barFill.style.width = pct + '%';
        percentEl.textContent = pct + '%';
        statusEl.textContent = `Deleting ${done} of ${size}…`;
      }

      // Remove all deleted items from in-memory allItems
      allItems = allItems.filter(item => !idsToDelete.has(item.id));

      statusEl.textContent = 'Done!';
      barFill.style.width = '100%';
      percentEl.textContent = '100%';
      titleEl.textContent = 'Creating ZIP file';

      setTimeout(() => {
        overlay.classList.remove('active');
        state.isSelectionMode = false;
        btnToggleSelect.classList.remove('active');
        updateSelectionToolbar();
        applyFiltersAndLayout();
        updateStorageBadge();
      }, 400);
    }
  });

  // BOOTSTRAP
  loadData();
});
