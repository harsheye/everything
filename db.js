// IndexedDB Storage Engine for Smart Command Palette
const DB_NAME = "SmartCommandPaletteDB";
const DB_VERSION = 2;

const isContentScript = typeof window !== "undefined" && window.location.protocol !== "chrome-extension:";

class CommandPaletteDB {
  static open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;

        // Create Object Stores
        if (!db.objectStoreNames.contains("bookmarks")) {
          db.createObjectStore("bookmarks", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("notes")) {
          db.createObjectStore("notes", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("history")) {
          db.createObjectStore("history", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("commands")) {
          db.createObjectStore("commands", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("favorites")) {
          db.createObjectStore("favorites", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("collections")) {
          db.createObjectStore("collections", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("clipboard")) {
          const store = db.createObjectStore("clipboard", { keyPath: "id", autoIncrement: true });
          store.createIndex("timestamp", "timestamp", { unique: false });
        }
        if (!db.objectStoreNames.contains("screenshots")) {
          const store = db.createObjectStore("screenshots", { keyPath: "id", autoIncrement: true });
          store.createIndex("timestamp", "timestamp", { unique: false });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("audioProfiles")) {
          db.createObjectStore("audioProfiles", { keyPath: "hostname" });
        }
        if (!db.objectStoreNames.contains("recentSearches")) {
          const store = db.createObjectStore("recentSearches", { keyPath: "id", autoIncrement: true });
          store.createIndex("timestamp", "timestamp", { unique: false });
        }
      };

      request.onsuccess = (e) => {
        const db = e.target.result;
        db.onversionchange = () => {
          db.close();
          console.warn("Database is outdated, please reload the page.");
        };
        resolve(db);
      };

      request.onblocked = (e) => {
        console.warn("Database upgrade blocked. Please close other tabs.");
        reject(new Error("Database upgrade blocked. Please close all other extension tabs (like the Dashboard or Editor) and refresh this page."));
      };

      request.onerror = (e) => {
        reject(e.target.error);
      };
    });
  }

  static async performTx(storeName, mode, callback) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = callback(store);

      tx.oncomplete = () => {
        resolve(result);
      };
      tx.onerror = (e) => {
        reject(tx.error || e.target.error);
      };
    });
  }

  // --- GENERAL CRUD WRAPPERS ---
  static async get(storeName, id) {
    if (isContentScript) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "db_op", op: "get", storeName, id }, resolve);
      });
    }
    return this.performTx(storeName, "readonly", (store) => {
      let request = store.get(id);
      return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
    }).then(p => p);
  }

  static async getAll(storeName) {
    if (isContentScript) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "db_op", op: "getAll", storeName }, resolve);
      });
    }
    return this.performTx(storeName, "readonly", (store) => {
      let request = store.getAll();
      return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result || []);
      });
    }).then(p => p);
  }

  static async put(storeName, data) {
    if (isContentScript) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "db_op", op: "put", storeName, data }, resolve);
      });
    }
    return this.performTx(storeName, "readwrite", (store) => {
      let request = store.put(data);
      return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
    }).then(p => p);
  }

  static async delete(storeName, id) {
    if (isContentScript) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "db_op", op: "delete", storeName, id }, resolve);
      });
    }
    // High-performance cleanup: remove associated OPFS/Cache files if deleting screenshot
    if (storeName === "screenshots" && typeof MediaEngine !== "undefined") {
      try {
        const item = await this.get("screenshots", id);
        if (item) {
          await MediaEngine.deleteMedia(item);
        }
      } catch (e) {
        console.warn("[CommandPaletteDB] Error deleting media from MediaEngine:", e);
      }
    }
    return this.performTx(storeName, "readwrite", (store) => {
      let request = store.delete(id);
      return new Promise((resolve) => {
        request.onsuccess = () => resolve(true);
      });
    }).then(p => p);
  }

  static async clear(storeName) {
    if (isContentScript) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "db_op", op: "clear", storeName }, resolve);
      });
    }
    // High-performance cleanup: purge all OPFS/Cache media
    if (storeName === "screenshots" && typeof MediaEngine !== "undefined") {
      try {
        await MediaEngine.clearAll();
      } catch (e) {
        console.warn("[CommandPaletteDB] Error clearing MediaEngine storage:", e);
      }
    }
    return this.performTx(storeName, "readwrite", (store) => {
      store.clear();
      return true;
    });
  }

  // --- SPECIFIC STORE HELPERS ---

  // Clipboard History
  static async addClipboardItem(content, type = "text") {
    const item = {
      content,
      type,
      timestamp: Date.now(),
      pinned: false,
      favorite: false
    };
    return this.put("clipboard", item);
  }

  static async getClipboardHistory(limit = 50) {
    if (isContentScript) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "db_op", op: "getClipboardHistory", limit }, resolve);
      });
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("clipboard", "readonly");
      const store = tx.objectStore("clipboard");
      const index = store.index("timestamp");
      const results = [];

      index.openCursor(null, "prev").onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  // Screenshots - High-performance storage via MediaEngine (OPFS/Cache) + metadata-only IDB
  static async addScreenshot(dataUrl, metadata = {}) {
    if (isContentScript) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "db_op", op: "addScreenshot", data: {
          content: dataUrl,
          timestamp: Date.now(),
          ...metadata
        } }, resolve);
      });
    }

    // Modern high-performance path: Store payload in OPFS/Cache and keep IDB ultra-light
    if (typeof MediaEngine !== "undefined") {
      try {
        const metaRecord = await MediaEngine.saveMedia(dataUrl, metadata);
        return this.put("screenshots", metaRecord);
      } catch (err) {
        console.warn("[CommandPaletteDB] MediaEngine failed to save screenshot, falling back:", err);
      }
    }

    const item = {
      content: dataUrl,
      timestamp: Date.now(),
      ...metadata
    };
    return this.put("screenshots", item);
  }

  /**
   * Save a large video Blob directly to IndexedDB WITHOUT going through the background
   * message bus (which has a ~64 MB serialization limit that causes recordings to silently fail).
   * Content scripts have direct IDB access, so we open it raw here.
   */
  static async saveVideoBlob(videoBlob, metadata = {}) {
    // Build a lightweight meta record – store the Blob object directly in IDB
    // (IDB can store Blob natively, no base64 needed)
    const id = Date.now();
    const record = {
      id,
      type: 'video',
      timestamp: id,
      title: metadata.title || 'Video Recording',
      sourceUrl: metadata.sourceUrl || '',
      width: metadata.width || 0,
      height: metadata.height || 0,
      size: videoBlob.size,
      mimeType: videoBlob.type || 'video/webm',
      // Store the raw Blob – IDB handles large binary objects efficiently
      content: videoBlob,
    };

    // Attach thumbnail dataUrl if available (small, safe to store inline)
    if (metadata.thumbDataUrl) {
      record.thumbDataUrl = metadata.thumbDataUrl;
    }

    // Open IDB directly (works in both content script and extension page contexts)
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('screenshots', 'readwrite');
      const store = tx.objectStore('screenshots');
      const req = store.put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
      req.onerror = () => reject(req.error);
    });
  }

  static async getScreenshots(limit = 100) {
    if (isContentScript) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "db_op", op: "getScreenshots", limit }, resolve);
      });
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("screenshots", "readonly");
      const store = tx.objectStore("screenshots");
      const index = store.index("timestamp");
      const results = [];

      index.openCursor(null, "prev").onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  // Notes Helper with migration
  static async getNotes() {
    if (isContentScript) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "db_op", op: "getNotes" }, resolve);
      });
    }
    const notes = await this.getAll("notes");
    if (notes.length === 0) {
      // Try migrating from storage.local
      return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(['bookmark_organizer_notes'], async (result) => {
            const legacyNotes = result.bookmark_organizer_notes || {};
            const names = Object.keys(legacyNotes);
            if (names.length > 0) {
               const migrated = [];
               for (const name of names) {
                 const noteVal = legacyNotes[name];
                 const content = typeof noteVal === 'string' ? noteVal : (noteVal.content || "");
                 const versions = noteVal.versions || [];
                 const note = {
                   id: name,
                   title: name,
                   content: content,
                   versions: versions,
                   tags: [],
                   pinned: false,
                   favorite: false,
                   lastModified: Date.now()
                 };
                 await this.put("notes", note);
                 migrated.push(note);
               }
               resolve(migrated);
            } else {
               resolve([]);
            }
          });
        } else {
          resolve([]);
        }
      });
    }
    return notes;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CommandPaletteDB;
}
