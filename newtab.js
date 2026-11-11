// newtab.js - Dashboard launcher script complying with MV3 CSP

// clock update
function updateClock() {
  const now = new Date();
  let h = now.getHours();
  let m = now.getMinutes();
  h = h < 10 ? "0" + h : h;
  m = m < 10 ? "0" + m : m;
  document.getElementById("clock").textContent = `${h}:${m}`;
  
  const options = { weekday: 'long', month: 'long', day: 'numeric' };
  document.getElementById("date").textContent = now.toLocaleDateString('en-US', options);
}
setInterval(updateClock, 1000);
updateClock();

// load custom background
async function loadBackground() {
  const customBg = await CommandPaletteDB.get("settings", "newtab_bg");
  if (customBg && customBg.value) {
    document.body.style.backgroundImage = `url(${customBg.value})`;
  } else {
    document.body.style.backgroundImage = "";
  }
}
loadBackground();

// bg settings modal trigger
const trigger = document.getElementById("bg-settings-trigger");
const modal = document.getElementById("bg-modal");
trigger.addEventListener("click", () => modal.classList.toggle("active"));

// save bg URL
document.getElementById("bg-save-btn").addEventListener("click", async () => {
  const url = document.getElementById("bg-url-input").value.trim();
  if (url) {
    await CommandPaletteDB.put("settings", { key: "newtab_bg", value: url });
    loadBackground();
    modal.classList.remove("active");
    document.getElementById("bg-url-input").value = "";
  }
});

// upload bg file
const fileInput = document.getElementById("bg-file-input");
document.getElementById("bg-upload-btn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = event.target.result;
      await CommandPaletteDB.put("settings", { key: "newtab_bg", value: base64 });
      loadBackground();
      modal.classList.remove("active");
    };
    reader.readAsDataURL(file);
  }
});

// reset bg to default
document.getElementById("bg-reset-btn").addEventListener("click", async () => {
  await CommandPaletteDB.delete("settings", "newtab_bg");
  loadBackground();
  modal.classList.remove("active");
});

// top 5 visited sites
function loadTopSites() {
  if (typeof chrome !== "undefined" && chrome.history) {
    chrome.history.search({ text: "", maxResults: 120 }, (items) => {
      if (!items) return;
      const hosts = {};
      items.forEach(item => {
        try {
          const url = new URL(item.url);
          const host = url.hostname;
          if (host && host !== "newtab" && !hosts[host]) {
            hosts[host] = {
              title: item.title || host.replace("www.", ""),
              url: item.url,
              visitCount: item.visitCount || 1,
              domain: host
            };
          } else if (host && hosts[host]) {
            hosts[host].visitCount += (item.visitCount || 1);
          }
        } catch (e) {}
      });

      const sorted = Object.values(hosts).sort((a, b) => b.visitCount - a.visitCount).slice(0, 5);
      const container = document.getElementById("visited-sites");
      container.innerHTML = "";

      sorted.forEach(site => {
        const card = document.createElement("a");
        card.className = "site-card";
        card.href = site.url;
        card.innerHTML = `
          <img class="site-icon" src="https://www.google.com/s2/favicons?sz=32&domain=${site.domain}" onerror="this.src='https://www.google.com/s2/favicons?sz=32&domain=google.com'">
          <span class="site-title">${site.title}</span>
        `;
        container.appendChild(card);
      });
    });
  }
}
loadTopSites();

// load notes
async function loadNotes() {
  const notes = await CommandPaletteDB.getNotes();
  const list = document.getElementById("notes-list");
  list.innerHTML = "";
  
  const recent = notes.slice(0, 3);
  recent.forEach(note => {
    const item = document.createElement("div");
    item.className = "note-item";
    item.textContent = note.title || "(Untitled)";
    item.addEventListener("click", () => {
      if (typeof enterCommandMode === "function") {
        enterCommandMode("note_tools", { selectedNote: note.id, step: "view_content" });
      }
    });
    list.appendChild(item);
  });
}
loadNotes();

// Create New Note
document.getElementById("btn-create-note").addEventListener("click", async () => {
  const title = prompt("Enter note title:");
  if (title) {
    const newNote = {
      id: title,
      title: title,
      content: "",
      versions: [],
      tags: [],
      pinned: false,
      favorite: false,
      lastModified: Date.now()
    };
    await CommandPaletteDB.put("notes", newNote);
    loadNotes();
    if (typeof enterCommandMode === "function") {
      enterCommandMode("note_tools");
      if (typeof renderSearchResults === "function") {
        renderSearchResults("");
      }
    }
  }
});

// Quick Tools Click
document.getElementById("tool-image").addEventListener("click", () => {
  chrome.tabs.create({ url: "image.html" });
});
document.getElementById("tool-pdf").addEventListener("click", () => {
  chrome.tabs.create({ url: "pdf.html" });
});

// Automatically open the palette on tab load and secure search bar focus
function initNewTabPalette() {
  if (typeof toggleCommandPalette === "function") {
    toggleCommandPalette();
    
    const rootEl = document.getElementById("smart-command-palette-root");
    if (rootEl && rootEl.shadowRoot) {
      const closeBtn = rootEl.shadowRoot.querySelector(".cc-close");
      if (closeBtn) closeBtn.style.display = "none";
      
      const input = rootEl.shadowRoot.querySelector(".cc-search-input");
      if (input) {
        input.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
          }
        });

        const focusInput = () => {
          if (document.activeElement !== input) {
            input.focus();
          }
        };

        // Aggressively capture cursor in the extension search bar across frame renders
        focusInput();
        requestAnimationFrame(focusInput);
        setTimeout(focusInput, 20);
        setTimeout(focusInput, 60);
        setTimeout(focusInput, 150);
        setTimeout(focusInput, 300);
      }
    }
  }
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initNewTabPalette);
} else {
  initNewTabPalette();
}

// When tab gains focus, return cursor to the search bar
window.addEventListener("focus", () => {
  const rootEl = document.getElementById("smart-command-palette-root");
  if (rootEl && rootEl.shadowRoot) {
    const input = rootEl.shadowRoot.querySelector(".cc-search-input");
    if (input) input.focus();
  }
});

// Click anywhere on wallpaper/neutral area focuses the search bar
document.body.addEventListener("click", (e) => {
  if (e.target.closest("button, a, input, textarea, .glass-panel, .bg-settings-btn, .bg-modal, .site-card")) {
    return;
  }
  const rootEl = document.getElementById("smart-command-palette-root");
  if (rootEl && rootEl.shadowRoot) {
    const input = rootEl.shadowRoot.querySelector(".cc-search-input");
    if (input) input.focus();
  }
});

// Any typing on empty dashboard space instantly redirects to the command palette search input
window.addEventListener("keydown", (e) => {
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length > 1 && e.key !== "Backspace") return;

  const rootEl = document.getElementById("smart-command-palette-root");
  if (rootEl && rootEl.shadowRoot) {
    const input = rootEl.shadowRoot.querySelector(".cc-search-input");
    if (input && document.activeElement !== input) {
      input.focus();
    }
  }
});
