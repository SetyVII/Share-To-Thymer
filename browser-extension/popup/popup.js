class ImageProcessor {
  /**
   * Fetch image as Blob using browser extension privileges
   */
  static async fetchImage(url) {
    if (!url) return null;
    if (url.startsWith("data:")) {
      const res = await fetch(url);
      return await res.blob();
    }
    const res = await fetch(url, { mode: "cors" }).catch(() => fetch(url));
    if (!res.ok) {
      throw new Error(`Failed to fetch image: ${res.statusText}`);
    }
    return await res.blob();
  }

  /**
   * Convert Blob to Data URL
   */
  static blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Format bytes to human readable string (e.g. 54 KB, 1.8 MB)
   */
  static formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  /**
   * Process image: optimize (downscale + WebP compress) or keep original
   */
  static async processImage(blobOrUrl, options = {}) {
    const {
      mode = "optimized", // 'optimized' | 'original'
      maxWidth = 800,
      quality = 0.82,
    } = options;

    let blob =
      typeof blobOrUrl === "string"
        ? await this.fetchImage(blobOrUrl)
        : blobOrUrl;
    if (!blob) return null;

    const originalSize = blob.size;
    let originalWidth = null;
    let originalHeight = null;

    let imgBitmap = null;
    try {
      imgBitmap = await createImageBitmap(blob);
      originalWidth = imgBitmap.width;
      originalHeight = imgBitmap.height;
    } catch (e) {
      console.warn("[SaveToThymer] createImageBitmap failed", e);
    }

    if (mode === "original" || !imgBitmap) {
      const dataUrl = await this.blobToDataUrl(blob);
      return {
        dataUrl,
        size: originalSize,
        originalSize,
        width: originalWidth,
        height: originalHeight,
        mimeType: blob.type || "image/jpeg",
        mode: "original",
      };
    }

    // Optimization: downscale to maxWidth maintaining aspect ratio
    let targetWidth = originalWidth;
    let targetHeight = originalHeight;
    const maxDim = maxWidth || 800;

    if (targetWidth > maxDim || targetHeight > maxDim) {
      if (targetWidth >= targetHeight) {
        targetHeight = Math.round((targetHeight * maxDim) / targetWidth);
        targetWidth = maxDim;
      } else {
        targetWidth = Math.round((targetWidth * maxDim) / targetHeight);
        targetHeight = maxDim;
      }
    }

    let optimizedBlob = null;
    let outputMime = "image/webp";

    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(targetWidth, targetHeight);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(imgBitmap, 0, 0, targetWidth, targetHeight);
      try {
        optimizedBlob = await canvas.convertToBlob({
          type: outputMime,
          quality,
        });
      } catch (err) {
        outputMime = "image/jpeg";
        optimizedBlob = await canvas.convertToBlob({
          type: outputMime,
          quality,
        });
      }
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(imgBitmap, 0, 0, targetWidth, targetHeight);
      optimizedBlob = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), outputMime, quality);
      });
      if (!optimizedBlob) {
        outputMime = "image/jpeg";
        optimizedBlob = await new Promise((resolve) => {
          canvas.toBlob((b) => resolve(b), outputMime, quality);
        });
      }
    }

    if (imgBitmap && typeof imgBitmap.close === "function") {
      imgBitmap.close();
    }

    if (
      optimizedBlob &&
      optimizedBlob.size > originalSize &&
      blob.type?.startsWith("image/")
    ) {
      const dataUrl = await this.blobToDataUrl(blob);
      return {
        dataUrl,
        size: originalSize,
        originalSize,
        width: originalWidth,
        height: originalHeight,
        mimeType: blob.type,
        mode: "original",
      };
    }

    const dataUrl = await this.blobToDataUrl(optimizedBlob || blob);
    return {
      dataUrl,
      size: (optimizedBlob || blob).size,
      originalSize,
      width: targetWidth,
      height: targetHeight,
      mimeType: outputMime,
      mode: "optimized",
    };
  }
}

class SaveToThymer {
  static MSG = {
    PING: "PING",
    GET_PAGE_DATA: "GET_PAGE_DATA",
    THYMER_PING: "THYMER_PING",
    THYMER_GET_COLLECTIONS: "THYMER_GET_COLLECTIONS",
    THYMER_GET_COLLECTION_FIELDS: "THYMER_GET_COLLECTION_FIELDS",
    THYMER_SAVE_RECORD: "THYMER_SAVE_RECORD",
    THYMER_GET_TEMPLATES: "THYMER_GET_TEMPLATES",
    THYMER_SAVE_TEMPLATES: "THYMER_SAVE_TEMPLATES",
    THYMER_GET_PLUGIN_CONFIG: "THYMER_GET_PLUGIN_CONFIG",
    THYMER_SAVE_PLUGIN_CONFIG: "THYMER_SAVE_PLUGIN_CONFIG",
    THYMER_CHECK_DUPLICATE: "THYMER_CHECK_DUPLICATE",
  };

  static QUEUE = {
    STORAGE_KEY: "saveQueue",
    MAX_SIZE: 20,
    EXPIRY_MS: 24 * 60 * 60 * 1000,
  };

  constructor() {
    this.connected = false;
    this.pageData = null;
    this.templates = [];
    this.currentTemplate = null;
    this.collections = [];
    this.fieldCache = new Map();
    this.tagOptionsByField = new Map();
    this.selectedTemplateIndex = -1;
    this.recentSaves = [];
    this.confirmResolve = null;
    this.bannerMode = "optimized";
    this.processedBanner = null;
    this.isDuplicateDetected = false;
    this.pluginConfig = {
      autoTagRules: {},
      urlFieldMap: { collectionGuid: null, fieldId: null },
    };
    this.init();
  }

  async init() {
    this.showSkeleton("templates-list", 3);
    const { bannerMode } = await chrome.storage.sync.get("bannerMode");
    if (bannerMode) this.bannerMode = bannerMode;

    await Promise.all([
      this.loadRecentSaves(),
      this.getPageData(),
      this.connect().then(() => this.loadTemplatesFromThymer()),
    ]);

    this.bindEvents();
    this.initDragAndDrop();
    this.initKeyboardNavigation();
    this.renderTemplates();
    this.renderRecentSaves();
    this.checkPendingQueue();
  }

  async loadTemplatesFromThymer() {
    if (!this.connected) {
      // Fallback to local if not connected (view-only)
      const { templates } = await chrome.storage.sync.get("templates");
      this.templates = templates || [];
      return;
    }

    try {
      // Check for local templates to migrate
      const { templates: localTemplates } =
        await chrome.storage.sync.get("templates");

      // Fetch from Thymer
      const res = await this.send({
        type: SaveToThymer.MSG.THYMER_GET_TEMPLATES,
      });
      const thymerTemplates = res?.templates || [];

      // Migrate if needed (one-time)
      if (localTemplates?.length && !thymerTemplates.length) {
        this.templates = localTemplates;
        await this.saveTemplatesToThymer();
        // Clear local storage after successful migration
        await chrome.storage.sync.remove("templates");
      } else {
        this.templates = thymerTemplates;
      }
    } catch (e) {
      console.error("Failed to load templates", e);
    }
  }

  async saveTemplatesToThymer() {
    if (!this.connected) return;
    await this.send({
      type: SaveToThymer.MSG.THYMER_SAVE_TEMPLATES,
      payload: { templates: this.templates },
    });
  }

  async getPageData() {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id) return this.setDefaultPageData();
      this.sourceTabId = tab.id;
      this.sourceWindowId = tab.windowId;

      // Always inject the latest content script
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content/content.js"],
        });
      } catch (e) {
        console.error("[SaveToThymer] Failed to inject content script", e);
      }
      await this.wait(200);

      this.pageData =
        (await chrome.tabs.sendMessage(tab.id, {
          type: SaveToThymer.MSG.GET_PAGE_DATA,
        })) || this.setDefaultPageData(tab);
    } catch {
      this.setDefaultPageData();
    }
  }

  setDefaultPageData(tab = {}) {
    this.pageData = {
      title: this.sanitizePageTitle(tab.title) || "Untitled",
      url: tab.url || "",
      images: [],
      ogImage: null,
      description: "",
      bodyMarkdown: "",
    };
    return this.pageData;
  }

  sanitizePageTitle(title) {
    if (!title) return "";
    return String(title)
      .replace(/^(?:\s*(?:\(\d+\)|\[\d+\]))+\s*/, "")
      .trim();
  }

  wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── Toast notification system ──
  showToast(message, level = "info", timeoutMs = 3000) {
    const container = document.querySelector(".toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast ${level}`;
    toast.innerHTML = `<span>${this.escapeHtml(message)}</span><button class="toast-close">&times;</button>`;
    toast.querySelector(".toast-close").onclick = () =>
      this._removeToast(toast);
    container.appendChild(toast);

    if (timeoutMs > 0) {
      toast._timer = setTimeout(() => this._removeToast(toast), timeoutMs);
    }
  }

  _removeToast(toast) {
    if (toast._removing) return;
    toast._removing = true;
    if (toast._timer) clearTimeout(toast._timer);
    toast.classList.add("removing");
    setTimeout(() => toast.remove(), 200);
  }

  // ── Confirm dialog ──
  showConfirm(message) {
    return new Promise((resolve) => {
      const backdrop = document.getElementById("confirm-dialog");
      const msgEl = document.getElementById("confirm-message");
      const cancelBtn = document.getElementById("confirm-cancel-btn");
      const okBtn = document.getElementById("confirm-ok-btn");
      if (!backdrop || !msgEl) return resolve(false);

      msgEl.textContent = message;
      backdrop.style.display = "flex";

      const cleanup = (result) => {
        backdrop.style.display = "none";
        resolve(result);
      };

      cancelBtn.onclick = () => cleanup(false);
      okBtn.onclick = () => cleanup(true);
      backdrop.onclick = (e) => {
        if (e.target === backdrop) cleanup(false);
      };
    });
  }

  // ── Skeleton loading ──
  showSkeleton(containerId, count) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = Array.from(
      { length: count },
      () => `<div class="skeleton skeleton-item"></div>`,
    ).join("");
  }

  // ── Recent saves ──
  async loadRecentSaves() {
    try {
      const { recentSaves } = await chrome.storage.local.get("recentSaves");
      this.recentSaves = recentSaves || [];
    } catch {
      this.recentSaves = [];
    }
  }

  async addRecentSave(title, collectionName, url = "") {
    this.recentSaves.unshift({
      title,
      collectionName,
      url,
      time: Date.now(),
    });
    this.recentSaves = this.recentSaves.slice(0, 20);
    try {
      await chrome.storage.local.set({ recentSaves: this.recentSaves });
    } catch {}
    this.renderRecentSaves();
  }

  renderRecentSaves() {
    const container = document.getElementById("recent-saves");
    const list = document.getElementById("recent-saves-list");
    if (!container || !list) return;

    if (this.recentSaves.length) {
      container.classList.add("has-items");
      list.innerHTML = this.recentSaves
        .slice(0, 5)
        .map(
          (s) => `
            <div class="recent-save-item" title="${this.escapeHtml(s.title)} — ${this.escapeHtml(s.collectionName)}">
              <svg class="recent-save-icon" viewBox="0 0 256 256" fill="currentColor"><path d="M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z"/></svg>
              <span>${this.escapeHtml(s.title)}</span>
            </div>`,
        )
        .join("");
    } else {
      container.classList.remove("has-items");
    }
  }

  // ── Proactive duplicate check ──
  cleanUrl(url) {
    if (!url) return "";
    try {
      const u = new URL(url);
      u.hash = "";
      const trackingParams = [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "ref",
        "fbclid",
        "gclid",
        "si",
        "igshid",
        "feature",
      ];
      trackingParams.forEach((p) => u.searchParams.delete(p));
      if (u.hostname === "youtu.be") {
        const vid = u.pathname.replace(/^\//, "");
        return `youtube.com/watch?v=${vid}`;
      }
      const host = u.hostname.replace(/^www\./, "");
      const path = u.pathname.replace(/\/+$/, "");
      const search = u.search;
      return `${host}${path}${search}`.toLowerCase();
    } catch {
      return String(url).trim().toLowerCase().replace(/\/+$/, "");
    }
  }

  isDuplicateUrl(url1, url2) {
    if (!url1 || !url2) return false;
    if (url1 === url2) return true;
    const clean1 = this.cleanUrl(url1);
    const clean2 = this.cleanUrl(url2);
    return Boolean(clean1 && clean2 && clean1 === clean2);
  }

  async checkIfAlreadySaved(template) {
    const banner = this.$("duplicate-warning-banner");
    const details = this.$("duplicate-details");
    const saveBtn = this.$("save-btn");
    if (!banner) return;

    const url = this.pageData?.url || this.$("preview-url")?.value || "";
    const title = this.$("preview-title")?.value || this.pageData?.title || "";

    if (!url && !title) {
      banner.style.display = "none";
      this.isDuplicateDetected = false;
      if (saveBtn) {
        saveBtn.textContent = "Save";
        saveBtn.classList.remove("save-again");
      }
      return;
    }

    const showDuplicateState = (matchDetails) => {
      this.isDuplicateDetected = true;
      if (details) details.textContent = matchDetails;
      banner.style.display = "flex";
      this.setOperationStatus("Already saved", "warning", 6000);
      if (saveBtn && !saveBtn.classList.contains("saving")) {
        saveBtn.textContent = "Save Again";
        saveBtn.classList.add("save-again");
      }
    };

    const clearDuplicateState = () => {
      this.isDuplicateDetected = false;
      banner.style.display = "none";
      if (saveBtn && !saveBtn.classList.contains("saving")) {
        saveBtn.textContent = "Save";
        saveBtn.classList.remove("save-again");
      }
    };

    // 1. Fast local check against recent saves
    const localMatch = this.recentSaves.find((s) => {
      if (url && s.url && this.isDuplicateUrl(s.url, url)) return true;
      if (
        title &&
        s.title &&
        s.title.trim().toLowerCase() === title.trim().toLowerCase()
      )
        return true;
      return false;
    });

    if (localMatch) {
      showDuplicateState(
        `Saved previously in "${localMatch.collectionName || "Thymer"}"`,
      );
    } else {
      clearDuplicateState();
    }

    // 2. Deep collection check via Thymer workspace plugin
    if (this.connected && template?.collectionGuid) {
      try {
        const res = await this.send({
          type: SaveToThymer.MSG.THYMER_CHECK_DUPLICATE,
          payload: {
            collectionGuid: template.collectionGuid,
            pageUrl: url,
            title: title,
          },
        });

        if (res?.exists) {
          const matchSource =
            res.matchType === "url" ? "matching link" : "same title";
          showDuplicateState(
            `Already in "${res.collectionName}" (${matchSource})`,
          );
        } else if (!localMatch) {
          clearDuplicateState();
        }
      } catch (err) {
        console.warn("[SaveToThymer] Live duplicate check failed", err);
      }
    }
  }

  // ── Template search ──
  filterTemplates(query) {
    const q = query.toLowerCase().trim();
    const items = document.querySelectorAll(".template-item");
    let visible = 0;
    items.forEach((item) => {
      const name = item.querySelector(".template-item-name")?.textContent || "";
      const collection =
        item.querySelector(".template-item-collection")?.textContent || "";
      const match =
        !q ||
        name.toLowerCase().includes(q) ||
        collection.toLowerCase().includes(q);
      item.style.display = match ? "flex" : "none";
      if (match) visible++;
    });
    const noResults = document.getElementById("templates-no-results");
    if (!q) {
      const nr = document.getElementById("templates-no-results");
      if (nr) nr.remove();
      return;
    }
    if (visible === 0) {
      if (!noResults) {
        const el = document.createElement("div");
        el.id = "templates-no-results";
        el.className = "no-results";
        el.textContent = "No matching templates";
        document.getElementById("templates-list").after(el);
      }
    } else {
      if (noResults) noResults.remove();
    }
  }

  async connect(retries = 5) {
    const status = document.getElementById("connection-status");
    const text = status.querySelector(".status-text");
    let delay = 200;

    for (let i = 1; i <= retries; i++) {
      text.textContent = `Connecting...`;
      try {
        const tabs = await chrome.tabs.query({ url: "https://*.thymer.com/*" });
        if (!tabs.length) throw new Error("No Thymer tab");
        this.thymerTabId = tabs[0].id;

        // Inject bridge if needed
        try {
          await chrome.scripting.executeScript({
            target: { tabId: this.thymerTabId },
            files: ["content/thymer-bridge.js"],
          });
        } catch (e) {
          console.error("[SaveToThymer] Failed to inject bridge", e);
        }

        const res = await chrome.tabs.sendMessage(this.thymerTabId, {
          type: SaveToThymer.MSG.THYMER_PING,
          source: "save-to-thymer",
        });

        if (res?.connected) {
          status.className = "header-status connected";
          text.textContent = "Connected";
          this.connected = true;

          // Flush offline queue if any
          await this.flushQueue();

          // Fetch collections only if not already cached or empty
          if (!this.collections.length) {
            this.collections =
              (
                await this.send({
                  type: SaveToThymer.MSG.THYMER_GET_COLLECTIONS,
                })
              )?.collections || [];
          }
          return;
        }
      } catch (e) {
        console.error("[SaveToThymer] Connection attempt failed", e);
      }

      // Exponential backoff
      if (i < retries) {
        await this.wait(delay);
        delay = Math.min(delay * 1.5, 2000);
      }
    }
    status.className = "header-status error";
    text.textContent = "Not connected";
    this.connected = false;
  }

  async send(msg) {
    if (!this.thymerTabId) throw new Error("Not connected");
    return chrome.tabs.sendMessage(this.thymerTabId, {
      ...msg,
      source: "save-to-thymer",
    });
  }

  async getFields(guid, forceRefresh = false) {
    if (!forceRefresh && this.fieldCache.has(guid))
      return this.fieldCache.get(guid);

    const res = await this.send({
      type: SaveToThymer.MSG.THYMER_GET_COLLECTION_FIELDS,
      collectionGuid: guid,
    });
    const fields = (res?.fields || []).filter(
      (f) =>
        f.type !== "icon" &&
        f.id !== "icon" &&
        f.label?.toLowerCase() !== "icon",
    );

    this.fieldCache.set(guid, fields);
    return fields;
  }

  escapeHtml(text) {
    if (text == null) return "";
    return String(text).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  isSafeUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return ["http:", "https:", "data:"].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  $(id) {
    return document.getElementById(id);
  }

  setOperationStatus(message = "", level = "", timeoutMs = 0) {
    const el = this.$("operation-status");
    if (!el) return;

    if (!message) {
      el.textContent = "";
      el.className = "header-inline-status";
      return;
    }

    const normalized = ["success", "error", "warning"].includes(level)
      ? level
      : "";
    el.textContent = message;
    el.className = `header-inline-status visible${normalized ? ` ${normalized}` : ""}`;

    if (this._operationStatusTimer) clearTimeout(this._operationStatusTimer);
    if (timeoutMs > 0) {
      this._operationStatusTimer = setTimeout(
        () => this.setOperationStatus(""),
        timeoutMs,
      );
    }
  }

  bindEvents() {
    this.$("reconnect-btn").onclick = () => {
      this.connected = false;
      this.thymerTabId = null;
      this.connect();
    };
    this.$("settings-btn").onclick = async () => {
      await this.loadPluginConfig();
      const bannerModeSelect = this.$("setting-banner-mode");
      if (bannerModeSelect) {
        bannerModeSelect.value = this.bannerMode || "optimized";
      }
      this.showView("settings-view");
    };
    const bannerModeSelect = this.$("setting-banner-mode");
    if (bannerModeSelect) {
      bannerModeSelect.onchange = async (e) => {
        this.bannerMode = e.target.value;
        await chrome.storage.sync.set({ bannerMode: this.bannerMode });
        this.showToast("Cover storage setting updated", "success", 1500);
      };
    }
    this.$("settings-back-btn").onclick = () =>
      this.showView("template-selector");
    this.$("export-btn").onclick = () => {
      this.exportTemplates();
      this.showToast("Templates exported", "success", 2000);
    };
    this.$("import-btn").onclick = () => this.$("import-file").click();
    this.$("import-file").onchange = (e) => this.importTemplates(e);
    this.$("back-btn").onclick = () => {
      const banner = this.$("duplicate-warning-banner");
      if (banner) banner.style.display = "none";
      this.showView("template-selector");
    };
    const dismissDupBtn = this.$("dismiss-duplicate-btn");
    if (dismissDupBtn) {
      dismissDupBtn.onclick = () => {
        const banner = this.$("duplicate-warning-banner");
        if (banner) banner.style.display = "none";
      };
    }
    const previewTitleInput = this.$("preview-title");
    if (previewTitleInput) {
      previewTitleInput.addEventListener("input", () => {
        if (this.isDuplicateDetected && this.currentTemplate) {
          this.checkIfAlreadySaved(this.currentTemplate);
        }
      });
    }
    this.$("save-btn").onclick = () => this.save();
    this.$("editor-back-btn").onclick = () =>
      this.showView("template-selector");
    this.$("delete-template-btn").onclick = async () => {
      if (await this.showConfirm("Delete this template?"))
        this.deleteTemplate();
    };
    this.$("save-template-btn").onclick = () => this.saveTemplate();
    this.$("edit-template-btn").onclick = () =>
      this.editTemplate(this.currentTemplate);
    this.$("editor-collection").onchange = async (e) => {
      this.fields = e.target.value ? await this.getFields(e.target.value) : [];
      this.renderMappings();
    };
    // Template search
    const searchInput = this.$("template-search");
    if (searchInput) {
      searchInput.oninput = () => this.filterTemplates(searchInput.value);
    }
    // Auto-tag rules
    const addRuleBtn = this.$("add-rule-btn");
    if (addRuleBtn) addRuleBtn.onclick = () => this.addAutoTagRule();
    const saveRulesBtn = this.$("save-rules-btn");
    if (saveRulesBtn) saveRulesBtn.onclick = () => this.saveAutoTagRules();
    // URL field map
    const urlmapCol = this.$("urlmap-collection");
    if (urlmapCol)
      urlmapCol.onchange = (e) => {
        if (e.target.value) this.populateUrlFieldDropdown(e.target.value);
        else
          this.$("urlmap-field").innerHTML =
            '<option value="">Select field...</option>';
      };
    const saveUrlmap = this.$("save-urlmap-btn");
    if (saveUrlmap) saveUrlmap.onclick = () => this.saveUrlFieldMap();
    // Screenshot
    const captureBtn = this.$("capture-screenshot-btn");
    if (captureBtn) captureBtn.onclick = () => this.captureScreenshot();
    // Escape key for image selector and confirm dialog
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const backdrop = document.querySelector(".image-selector-backdrop");
        if (backdrop) {
          backdrop.remove();
          return;
        }
        const confirm = document.getElementById("confirm-dialog");
        if (confirm && confirm.style.display === "flex") {
          confirm.style.display = "none";
          if (this.confirmResolve) {
            this.confirmResolve(false);
            this.confirmResolve = null;
          }
        }
      }
    });
  }

  showView(id) {
    document
      .querySelectorAll(".view")
      .forEach((v) => v.classList.toggle("active", v.id === id));
    // Clear search when switching views
    const searchInput = this.$("template-search");
    if (searchInput && id !== "template-selector") {
      searchInput.value = "";
      this.filterTemplates("");
    }
  }

  initDragAndDrop() {
    const container = this.$("templates-list");

    container.addEventListener("dragstart", (e) => {
      const item = e.target.closest(".template-item");
      if (!item) return;
      this.draggedIndex = parseInt(item.dataset.i, 10);
      setTimeout(() => item.classList.add("dragging"), 0);
      e.dataTransfer.effectAllowed = "move";
    });

    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      const dragging = container.querySelector(".dragging");
      if (!dragging) return;
      const siblings = [
        ...container.querySelectorAll(".template-item:not(.dragging)"),
      ];
      const next = siblings.find(
        (s) =>
          e.clientY <
          s.getBoundingClientRect().top + s.getBoundingClientRect().height / 2,
      );
      next
        ? container.insertBefore(dragging, next)
        : container.appendChild(dragging);
    });

    container.addEventListener("dragend", async (e) => {
      const item = e.target.closest(".template-item");
      if (!item) return;
      item.classList.remove("dragging");
      const items = [...container.querySelectorAll(".template-item")];
      const newIdx = items.indexOf(item);
      if (this.draggedIndex !== null && newIdx !== this.draggedIndex) {
        const moved = this.templates.splice(this.draggedIndex, 1)[0];
        this.templates.splice(newIdx, 0, moved);
        await this.saveTemplatesToThymer();
        this.renderTemplates();
      }
      this.draggedIndex = null;
    });
  }

  initKeyboardNavigation() {
    document.addEventListener("keydown", (e) => {
      const currentView = document.querySelector(".view.active")?.id;

      // Template selector navigation
      if (currentView === "template-selector") {
        if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          e.preventDefault();
          this.navigateTemplates(1);
        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
          e.preventDefault();
          this.navigateTemplates(-1);
        } else if (e.key === "Enter" && this.selectedTemplateIndex >= 0) {
          e.preventDefault();
          this.selectTemplate(this.templates[this.selectedTemplateIndex]);
        }
      }

      // Save view shortcuts
      else if (currentView === "save-view") {
        // Check if currently focused on an input/select/button
        const activeElement = document.activeElement;
        const isFocusedOnField =
          activeElement &&
          (activeElement.tagName === "INPUT" ||
            activeElement.tagName === "SELECT" ||
            activeElement.tagName === "BUTTON");
        const isSelectFocused =
          activeElement && activeElement.tagName === "SELECT";
        const wantsSaveWithEnter =
          e.key === "Enter" &&
          (e.shiftKey || e.ctrlKey || e.metaKey || !isSelectFocused);

        // Arrow navigation between fields (only if not typing in a field)
        if (e.key === "ArrowDown" && !isFocusedOnField) {
          e.preventDefault();
          this.navigateSaveFields(1);
        } else if (e.key === "ArrowUp" && !isFocusedOnField) {
          e.preventDefault();
          this.navigateSaveFields(-1);
        }
        // Tab navigation (natural browser behavior, but we can enhance it)
        else if (e.key === "Tab") {
          // Let browser handle Tab naturally
        }
        // Quick save shortcuts
        else if (e.key === "Escape") {
          e.preventDefault();
          this.showView("template-selector");
        } else if (wantsSaveWithEnter) {
          e.preventDefault();
          this.save();
        } else if (e.key === "Ç" || e.key === "ç") {
          e.preventDefault();
          this.save();
        }
      }

      // Template editor shortcuts
      else if (currentView === "template-editor") {
        const activeElement = document.activeElement;
        const isSelectFocused =
          activeElement && activeElement.tagName === "SELECT";
        const wantsSaveTemplate =
          e.key === "Enter" &&
          (e.shiftKey || e.ctrlKey || e.metaKey || !isSelectFocused);
        if (e.key === "Escape") {
          e.preventDefault();
          this.showView("template-selector");
        } else if (wantsSaveTemplate) {
          e.preventDefault();
          this.saveTemplate();
        }
      }

      // Settings view shortcuts
      else if (currentView === "settings-view") {
        if (e.key === "Escape") {
          e.preventDefault();
          this.showView("template-selector");
        }
      }
    });
  }

  navigateSaveFields(direction) {
    // Get all focusable text/select elements in save view (excluding images and buttons)
    const focusableElements = Array.from(
      document.querySelectorAll(
        '#save-view input:not([type="hidden"]):not([readonly]), ' +
          "#save-view select:not([disabled])",
      ),
    );

    if (!focusableElements.length) return;

    const currentIndex = focusableElements.indexOf(document.activeElement);
    let nextIndex;

    if (currentIndex === -1) {
      // Nothing focused, start at first or last depending on direction
      nextIndex = direction > 0 ? 0 : focusableElements.length - 1;
    } else {
      // Move to next/previous element (with wrapping)
      nextIndex =
        (currentIndex + direction + focusableElements.length) %
        focusableElements.length;
    }

    const nextElement = focusableElements[nextIndex];
    nextElement.focus();
    nextElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  navigateTemplates(direction) {
    if (!this.templates.length) return;

    // Initialize or update selection
    if (this.selectedTemplateIndex < 0) {
      this.selectedTemplateIndex =
        direction > 0 ? 0 : this.templates.length - 1;
    } else {
      this.selectedTemplateIndex =
        (this.selectedTemplateIndex + direction + this.templates.length) %
        this.templates.length;
    }

    this.highlightTemplate(this.selectedTemplateIndex);
  }

  highlightTemplate(index) {
    const items = document.querySelectorAll(".template-item");
    items.forEach((item, i) => {
      item.classList.toggle("keyboard-selected", i === index);
      if (i === index) {
        item.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  }

  renderTemplates() {
    const el = this.$("templates-list");
    this.selectedTemplateIndex = -1; // Reset keyboard selection
    if (!this.templates.length) {
      el.innerHTML =
        '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><p>No templates yet</p></div>';
      return;
    }
    el.innerHTML = this.templates
      .map(
        (t, i) => `
            <div class="template-item" data-i="${i}" draggable="true">
                <div class="template-item-handle"><svg viewBox="0 0 256 256" fill="currentColor"><path d="M108,60A16,16,0,1,1,92,44,16,16,0,0,1,108,60Zm56,16a16,16,0,1,0-16-16A16,16,0,0,0,164,76ZM92,112a16,16,0,1,0,16,16A16,16,0,0,0,92,112Zm72,0a16,16,0,1,0,16,16A16,16,0,0,0,164,112ZM92,180a16,16,0,1,0,16,16A16,16,0,0,0,92,180Zm72,0a16,16,0,1,0,16,16A16,16,0,0,0,164,180Z"/></svg></div>
                <div class="template-item-content">
                    <div class="template-item-info"><span class="template-item-name">${this.escapeHtml(t.name)}</span><span class="template-item-collection">${this.escapeHtml(t.collectionName || "")}</span></div>
                    <div class="template-item-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
                </div>
            </div>`,
      )
      .join("");
    el.querySelectorAll(".template-item").forEach((item) => {
      item.onclick = (e) => {
        if (!e.target.closest(".template-item-handle"))
          this.selectTemplate(this.templates[+item.dataset.i]);
      };
    });
    // Re-apply search filter
    const searchInput = this.$("template-search");
    if (searchInput?.value) this.filterTemplates(searchInput.value);
  }

  async selectTemplate(template) {
    this.currentTemplate = template;
    // Use ogImage, or fall back to first image from the page
    this.selectedBanner =
      this.pageData?.ogImage || this.pageData?.images?.[0] || null;
    this.processedBanner = null;
    this.$("template-name").textContent = template.name;
    this.$("preview-title").value = this.pageData?.title || "";
    this.$("preview-url").value = this.pageData?.url || "";
    this.showSkeleton("property-fields", 3);
    this.showView("save-view");
    const liveFields = template?.collectionGuid
      ? await this.getFields(template.collectionGuid, true)
      : [];
    this.renderPropertyFields(template, liveFields);
    this.checkIfAlreadySaved(template);

    // Auto-focus first editable field after a short delay
    setTimeout(() => {
      const firstField = document.querySelector(
        '#save-view input:not([type="hidden"]):not([readonly]), #save-view select:not([disabled])',
      );
      if (firstField) firstField.focus();
    }, 100);
  }

  renderPropertyFields(template, liveFields = []) {
    const el = this.$("property-fields");
    const editable = (template.mappings || []).filter(
      (m) =>
        !["page-title", "page-url", "page-image", "page-description"].includes(
          m.source,
        ),
    );
    const hasBanner = (template.mappings || []).some(
      (m) => m.source === "page-image",
    );
    const bannerUrl = this.selectedBanner;
    const liveFieldById = new Map(liveFields.map((f) => [f.id, f]));
    this.tagOptionsByField = new Map();

    let html = "";

    if (hasBanner && bannerUrl && this.isSafeUrl(bannerUrl)) {
      const mode = this.bannerMode || "optimized";
      html += `<div class="field-group">
                <label class="field-label">Banner Image</label>
                <div class="image-preview-wrapper" data-target="banner">
                    <img src="${this.escapeHtml(bannerUrl)}" class="banner-preview" id="banner-preview-img" alt="Banner">
                    <div class="image-overlay"><svg viewBox="0 0 256 256" fill="currentColor"><path d="M232.49,55.51l-32-32a12,12,0,0,0-17,0l-96,96A12,12,0,0,0,84,128v32a12,12,0,0,0,12,12h32a12,12,0,0,0,8.49-3.51l96-96A12,12,0,0,0,232.49,55.51ZM192,49l15,15L196,75,181,60Zm-69,99H108V133l56-56,15,15Zm105-7.43V208a20,20,0,0,1-20,20H48a20,20,0,0,1-20-20V48A20,20,0,0,1,48,28h67.43a12,12,0,0,1,0,24H52V204H204V140.57a12,12,0,0,1,24,0Z"/></svg></div>
                </div>
                <div class="banner-meta-bar" id="banner-meta-bar">
                    <div class="banner-size-badge ${mode === 'optimized' ? 'optimized' : ''}" id="banner-size-badge">
                        <span class="banner-badge-icon">${mode === 'optimized' ? '⚡' : '🎨'}</span>
                        <span class="banner-badge-text" id="banner-badge-text">Processing image...</span>
                    </div>
                    <div class="banner-mode-toggle" id="banner-mode-toggle">
                        <button type="button" class="banner-mode-btn ${mode === 'optimized' ? 'active' : ''}" data-mode="optimized" title="Compressed WebP for fast preview and low storage">⚡ Preview</button>
                        <button type="button" class="banner-mode-btn ${mode === 'original' ? 'active' : ''}" data-mode="original" title="Full original quality">🎨 Original</button>
                    </div>
                </div>
            </div>`;
    }

    if (template.clipContent) {
      html +=
        '<div class="field-group"><label class="field-label">Body Content</label><input type="text" id="preview-body" class="field-input body-preview" readonly></div>';
    }

    if (!editable.length && !template.clipContent && !hasBanner) {
      el.innerHTML = "";
      return;
    }

    html += editable
      .map((m) => {
        const liveField = liveFieldById.get(m.fieldId);
        const fieldChoices = this.getFieldChoices(m, liveField);
        const isTag = this.isTagField(
          m.fieldType || liveField?.type,
          m.fieldLabel || liveField?.label,
          m.fieldMany ?? liveField?.many,
        );

        if (m.source === "static") {
          const val =
            m.fieldType === "choice" && fieldChoices.length
              ? fieldChoices.find((c) => c.id === m.staticValue)?.label ||
                m.staticValue
              : m.staticValue || "";
          return `<div class="field-group"><label class="field-label">${this.escapeHtml(m.fieldLabel)}</label><input class="field-input" value="${this.escapeHtml(val)}" readonly style="color:#666"></div>`;
        }
        if (m.source === "custom") {
          if (isTag) {
            const tagOptions = [
              ...new Set(fieldChoices.map((c) => c.label).filter(Boolean)),
            ];
            this.tagOptionsByField.set(m.fieldId, tagOptions);
            const optionsHtml = tagOptions.length
              ? `<option value="">Select tag...</option>${tagOptions.map((tag) => `<option value="${this.escapeHtml(tag)}">${this.escapeHtml(tag)}</option>`).join("")}`
              : '<option value="">No tags found</option>';
            return `<div class="field-group"><label class="field-label">${this.escapeHtml(m.fieldLabel)}</label><input class="field-input tag-autocomplete-input" data-field-id="${m.fieldId}" placeholder="tag-1, tag-2"><select class="field-select tag-options-select" data-field-id="${m.fieldId}">${optionsHtml}</select></div>`;
          }
          if (
            (m.fieldType === "choice" || liveField?.type === "choice") &&
            fieldChoices.length
          ) {
            return `<div class="field-group"><label class="field-label">${this.escapeHtml(m.fieldLabel)}</label><select class="field-select" data-field-id="${m.fieldId}"><option value="">Select...</option>${fieldChoices.map((c) => `<option value="${c.id}">${this.escapeHtml(c.label)}</option>`).join("")}</select></div>`;
          }
          return `<div class="field-group"><label class="field-label">${this.escapeHtml(m.fieldLabel)}</label><input class="field-input" data-field-id="${m.fieldId}" placeholder="Enter..."></div>`;
        }
        return "";
      })
      .join("");

    el.innerHTML = html;
    if (template.clipContent) {
      const bodyInput = this.$("preview-body");
      if (bodyInput) bodyInput.value = this.pageData?.bodyMarkdown || "";
    }

    el.querySelectorAll(".image-preview-wrapper").forEach((wrapper) => {
      wrapper.onclick = () => this.showImageSelector(wrapper.dataset.target);
    });

    if (hasBanner && bannerUrl) {
      this.bindBannerControls();
      this.updateBannerProcessing();
    }

    this.initTagAutocomplete(el);
  }

  bindBannerControls() {
    const toggle = this.$("banner-mode-toggle");
    if (!toggle) return;
    toggle.querySelectorAll(".banner-mode-btn").forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const mode = btn.dataset.mode;
        if (this.bannerMode === mode) return;
        this.bannerMode = mode;
        toggle.querySelectorAll(".banner-mode-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.mode === mode);
        });
        const badge = this.$("banner-size-badge");
        if (badge) {
          badge.classList.toggle("optimized", mode === "optimized");
        }
        await this.updateBannerProcessing();
      };
    });
  }

  async updateBannerProcessing() {
    if (!this.selectedBanner) return;
    const badgeText = this.$("banner-badge-text");
    const badgeIcon = document.querySelector(".banner-badge-icon");
    if (badgeText) badgeText.textContent = "Processing image...";

    try {
      const mode = this.bannerMode || "optimized";
      const processed = await ImageProcessor.processImage(this.selectedBanner, {
        mode,
        maxWidth: 800,
        quality: 0.82,
      });
      this.processedBanner = processed;

      if (badgeText && processed) {
        const sizeStr = ImageProcessor.formatBytes(processed.size);
        const dimStr =
          processed.width && processed.height
            ? `${processed.width}×${processed.height}`
            : "";
        const typeStr =
          processed.mimeType === "image/webp" ? "WebP" : "Image";

        if (mode === "optimized") {
          if (badgeIcon) badgeIcon.textContent = "⚡";
          badgeText.textContent = `${sizeStr} · ${dimStr} ${typeStr} (Stored in Thymer)`;
        } else {
          if (badgeIcon) badgeIcon.textContent = "🎨";
          badgeText.textContent = `${sizeStr} · ${dimStr || "Original"} (Stored in Thymer)`;
        }
      }
    } catch (err) {
      console.warn("[SaveToThymer] Failed to process banner image", err);
      if (badgeText) badgeText.textContent = "External link (Download failed)";
      if (badgeIcon) badgeIcon.textContent = "🔗";
      this.processedBanner = null;
    }
  }

  generateBannerFilename(title, mimeType = "image/webp") {
    const ext =
      mimeType === "image/png"
        ? "png"
        : mimeType === "image/jpeg"
          ? "jpg"
          : "webp";
    const cleanTitle =
      (title || "cover")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30) || "cover";
    return `${cleanTitle}-cover.${ext}`;
  }

  getFieldChoices(mapping, liveField) {
    const source = liveField?.choices?.length
      ? liveField.choices
      : mapping.choices || [];
    return source
      .map((choice) => ({
        id: String(choice?.id ?? choice?.label ?? ""),
        label: String(choice?.label ?? choice?.id ?? ""),
      }))
      .filter((choice) => choice.id && choice.label);
  }

  isTagField(type, label = "", many = false) {
    const normalized = String(type || "").toLowerCase();
    return (
      normalized === "hashtag" ||
      normalized === "tag" ||
      normalized === "tags" ||
      (normalized === "choice" && !!many) ||
      /\btags?\b/i.test(String(label || ""))
    );
  }

  isYouTubeUrl(url) {
    if (!url) return false;
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host.includes("youtube.com") || host.includes("youtu.be");
    } catch {
      return false;
    }
  }

  appendTagValue(existingValue, tagToAdd) {
    const target = String(tagToAdd || "")
      .replace(/^#+/, "")
      .trim()
      .toLowerCase();
    if (!target) return existingValue || "";

    // Support both comma and space separated tags (e.g., "ai, video" or "#ai #video")
    const tags = String(existingValue || "")
      .replace(/#+/g, "")
      .split(/[,\s]+/)
      .map((v) => String(v).trim())
      .filter(Boolean);

    const seen = new Set(tags.map((t) => t.toLowerCase()));
    if (!seen.has(target)) tags.push(target);
    return tags.join(", ");
  }

  initTagAutocomplete(container) {
    container.querySelectorAll(".tag-autocomplete-input").forEach((input) => {
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const suggestion = this.getTagSuggestion(input);
        if (!suggestion) return;
        e.preventDefault();
        this.applyTagSuggestion(input, suggestion);
      });
    });

    container.querySelectorAll(".tag-options-select").forEach((select) => {
      select.addEventListener("change", () => {
        const selectedTag = select.value;
        if (!selectedTag) return;
        const input = container.querySelector(
          `.tag-autocomplete-input[data-field-id="${select.dataset.fieldId}"]`,
        );
        if (!input) return;
        this.applyTagSuggestion(input, selectedTag);
        select.value = "";
        input.focus();
      });
    });
  }

  getTagSuggestion(input) {
    const fieldId = input.dataset.fieldId;
    const options = this.tagOptionsByField.get(fieldId) || [];
    if (!options.length) return null;

    // Support both comma and space separated tags
    const parts = input.value.replace(/#+/g, "").split(/[,\s]+/);
    const current = (parts.pop() || "").trim().toLowerCase();
    const used = new Set(
      parts.map((p) => p.trim().toLowerCase()).filter(Boolean),
    );

    return (
      options.find((tag) => {
        const normalized = tag.toLowerCase();
        if (used.has(normalized)) return false;
        return !current || normalized.startsWith(current);
      }) || null
    );
  }

  applyTagSuggestion(input, tag) {
    // Support both comma and space separated tags
    const parts = input.value.replace(/#+/g, "").split(/[,\s]+/);
    parts.pop();
    const committed = parts.map((p) => p.trim()).filter(Boolean);
    committed.push(tag);
    input.value = `${committed.join(", ")}, `;
    input.setSelectionRange(input.value.length, input.value.length);
  }

  showImageSelector(target) {
    const allImages = this.pageData?.images || [];
    const images = allImages.filter(
      (img) =>
        !/loading|placeholder|spinner|lazy|transparent|blank|spacer/i.test(img),
    );
    if (images.length <= 1) return;

    const existing = document.querySelector(".image-selector-backdrop");
    if (existing) existing.remove();

    const backdrop = document.createElement("div");
    backdrop.className = "image-selector-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", "Select image");

    const popup = document.createElement("div");
    popup.className = "image-selector-popup";
    popup.innerHTML = `
            <div class="image-selector-header">
                <span>Select Image</span>
                <button class="image-selector-close" aria-label="Close">&times;</button>
            </div>
            <div class="image-selector-grid">
                ${images
                  .filter((img) => this.isSafeUrl(img))
                  .map(
                    (img, i) =>
                      `<img src="${this.escapeHtml(img)}" class="image-selector-item" data-url="${this.escapeHtml(img)}" alt="Image ${i + 1}" tabindex="0">`,
                  )
                  .join("")}
            </div>
        `;

    backdrop.appendChild(popup);
    document.body.appendChild(backdrop);

    const focusable = () =>
      popup.querySelectorAll(".image-selector-close, .image-selector-item");

    const close = () => {
      backdrop.remove();
    };

    backdrop.onclick = (e) => {
      if (e.target === backdrop) close();
    };
    popup.querySelector(".image-selector-close").onclick = close;

    // Focus trap
    backdrop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key === "Tab") {
        const items = [...focusable()];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    });

    popup.querySelectorAll(".image-selector-item").forEach((img) => {
      img.onclick = () => {
        const url = img.dataset.url;
        if (target === "banner") {
          this.selectedBanner = url;
          this.processedBanner = null;
          const preview = this.$("banner-preview-img");
          if (preview) preview.src = url;
          this.updateBannerProcessing();
        }
        close();
      };
    });

    // Focus first image on open
    const firstImage = popup.querySelector(".image-selector-item");
    if (firstImage) firstImage.focus();
  }

  async editTemplate(template) {
    this.currentTemplate = template;
    this.$("editor-title").textContent = template
      ? "Edit Template"
      : "New Template";
    this.$("delete-template-btn").style.display = template ? "flex" : "none";
    this.$("editor-template-name").value = template?.name || "";
    this.$("editor-body-source").value = template?.clipContent
      ? "page-content"
      : "";

    const sel = this.$("editor-collection");
    sel.innerHTML =
      '<option value="">Select...</option>' +
      this.collections
        .map(
          (c) =>
            `<option value="${c.guid}" ${template?.collectionGuid === c.guid ? "selected" : ""}>${this.escapeHtml(c.name)}</option>`,
        )
        .join("");

    if (template?.collectionGuid) {
      this.fields = await this.getFields(template.collectionGuid);
      this.renderMappings(template.mappings);
    } else {
      this.fields = [];
      this.renderMappings();
    }

    this.showView("template-editor");
  }

  getOptions(field) {
    const opts = [{ v: "", l: "Don't map" }];
    if (field.type === "text")
      opts.push(
        { v: "page-title", l: "Page Title" },
        { v: "page-description", l: "Description" },
        { v: "custom", l: "Custom" },
        { v: "static", l: "Static" },
      );
    else if (field.type === "url")
      opts.push({ v: "page-url", l: "Page URL" }, { v: "custom", l: "Custom" });
    else if (field.type === "banner")
      opts.push({ v: "page-image", l: "Page Image" });
    else if (field.type === "choice") {
      opts.push({ v: "custom", l: "Select at Save" });
      field.choices?.forEach((c) =>
        opts.push({ v: `choice:${c.id}`, l: c.label }),
      );
    } else if (field.type === "hashtag")
      opts.push({ v: "custom", l: "Custom" });
    else if (field.type === "checkbox")
      opts.push(
        { v: "static:true", l: "True" },
        { v: "static:false", l: "False" },
      );
    else opts.push({ v: "custom", l: "Custom" }, { v: "static", l: "Static" });
    return opts;
  }

  renderMappings(existing = []) {
    const el = this.$("mappings-list");
    if (!this.fields.length) {
      el.innerHTML =
        '<p style="color:#666;font-size:11px">Select a collection</p>';
      return;
    }
    const typeLabels = {
      text: "Text",
      url: "URL",
      banner: "Image",
      choice: "Choice",
      hashtag: "Tags",
      checkbox: "Check",
      number: "Number",
    };

    el.innerHTML = this.fields
      .filter((f) => !["created_at", "updated_at"].includes(f.id))
      .map((f) => {
        const e = existing.find((m) => m.fieldId === f.id);
        let val = e?.source || "";
        if (e?.source === "static" && f.type === "choice")
          val = `choice:${e.staticValue}`;
        else if (e?.source === "static" && f.type === "checkbox")
          val = `static:${e.staticValue}`;

        const opts = this.getOptions(f)
          .map(
            (o) =>
              `<option value="${o.v}" ${val === o.v ? "selected" : ""}>${o.l}</option>`,
          )
          .join("");
        const safeLabel = this.escapeHtml(f.label);
        const extra =
          e?.source === "static" && !["choice", "checkbox"].includes(f.type)
            ? `<input class="mapping-static-value" data-field-id="${f.id}" value="${this.escapeHtml(e.staticValue || "")}" placeholder="Value">`
            : "";
        return `<div class="mapping-row"><div class="mapping-field-info"><span class="mapping-field-name">${safeLabel}</span><span class="mapping-field-type">${typeLabels[f.type] || f.type}</span></div><span class="mapping-arrow">→</span><div class="mapping-config"><select class="mapping-source" data-field-id="${f.id}" data-field-type="${f.type}" data-field-many="${f.many ? "true" : "false"}" data-field-label="${safeLabel}">${opts}</select>${extra}</div></div>`;
      })
      .join("");

    el.querySelectorAll(".mapping-source").forEach(
      (s) => (s.onchange = () => this.renderMappings(this.collectMappings())),
    );
  }

  collectMappings() {
    const mappings = [];
    document
      .querySelectorAll("#mappings-list .mapping-source")
      .forEach((sel) => {
        const src = sel.value;
        if (!src) return;
        const m = {
          fieldId: sel.dataset.fieldId,
          fieldType: sel.dataset.fieldType,
          fieldMany: sel.dataset.fieldMany === "true",
          fieldLabel: sel.dataset.fieldLabel,
        };
        if (src.startsWith("choice:")) {
          m.source = "static";
          m.staticValue = src.slice(7);
        } else if (src.startsWith("static:")) {
          m.source = "static";
          m.staticValue = src.slice(7);
        } else if (src === "static") {
          m.source = "static";
          m.staticValue =
            document.querySelector(
              `.mapping-static-value[data-field-id="${m.fieldId}"]`,
            )?.value || "";
        } else m.source = src;
        const f = this.fields.find((x) => x.id === m.fieldId);
        if (f?.choices?.length) m.choices = f.choices;
        mappings.push(m);
      });
    return mappings;
  }

  async saveTemplate() {
    const name = this.$("editor-template-name").value.trim();
    const guid = this.$("editor-collection").value;
    if (!name || !guid) {
      this.showToast("Please fill all fields", "warning", 3000);
      return;
    }

    const col = this.collections.find((c) => c.guid === guid);
    const bodySource = this.$("editor-body-source").value;
    const clipContent = bodySource === "page-content";
    const data = {
      id: this.currentTemplate?.id || Date.now().toString(),
      name,
      collectionGuid: guid,
      collectionName: col?.name,
      mappings: this.collectMappings(),
      clipContent,
    };
    const idx = this.templates.findIndex(
      (t) => t.id === this.currentTemplate?.id,
    );
    idx >= 0 ? (this.templates[idx] = data) : this.templates.push(data);

    await this.saveTemplatesToThymer();
    this.renderTemplates();
    this.showView("template-selector");
  }

  async deleteTemplate() {
    if (!this.currentTemplate) return;
    this.templates = this.templates.filter(
      (t) => t.id !== this.currentTemplate.id,
    );
    this.currentTemplate = null;
    await this.saveTemplatesToThymer();
    this.renderTemplates();
    this.showView("template-selector");
    this.showToast("Template deleted", "info", 2000);
  }

  async save() {
    if (!this.currentTemplate) return;

    // Ensure banner image is processed before saving if needed
    const hasBannerCheck = this.currentTemplate.mappings?.some(
      (m) => m.source === "page-image",
    );
    if (
      hasBannerCheck &&
      this.selectedBanner &&
      !this.processedBanner &&
      this.bannerMode !== "link"
    ) {
      try {
        this.processedBanner = await ImageProcessor.processImage(
          this.selectedBanner,
          {
            mode: this.bannerMode || "optimized",
            maxWidth: 800,
            quality: 0.82,
          },
        );
      } catch (err) {
        console.warn("[SaveToThymer] Banner processing before save failed", err);
      }
    }

    // Offline queue: intercept if not connected
    if (!this.connected) {
      const payload = this.buildSavePayload();
      await this.queueSave(payload);
      return;
    }

    const btn = this.$("save-btn");
    btn.disabled = true;
    btn.classList.add("saving");
    btn.innerHTML = '<span class="spinner"></span>Saving...';
    this.setOperationStatus("");

    try {
      const payload = this.buildSavePayload();
      const res = await this.send({
        type: SaveToThymer.MSG.THYMER_SAVE_RECORD,
        payload,
      });

      if (res?.success) {
        this.showToast("Saved", "success", 2000);
        this.addRecentSave(
          payload.title,
          this.currentTemplate.collectionName || "",
          payload.pageUrl || "",
        );
        // New domain suggestion
        if (res.isNewDomain) {
          this.showNewDomainToast(res.isNewDomain);
        }
        try {
          if (this.sourceWindowId)
            await chrome.windows.update(this.sourceWindowId, { focused: true });
          if (this.sourceTabId)
            await chrome.tabs.update(this.sourceTabId, { active: true });
        } catch (e) {
          console.error("[SaveToThymer] Failed to refocus source tab", e);
        }
        setTimeout(() => window.close(), 100);
      } else throw new Error(res?.error || "Failed");
    } catch (err) {
      btn.disabled = false;
      btn.classList.remove("saving");
      btn.textContent = "Save";
      const rawMessage = err?.message || "Failed to save";
      const isDuplicate = /ya está guardado|already saved|duplicate/i.test(
        rawMessage,
      );
      this.showToast(rawMessage, isDuplicate ? "warning" : "error", 4000);
    }
  }

  buildSavePayload() {
    const props = {};
    const title = this.$("preview-title").value;
    const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"];
    const safeSet = (obj, key, value) => {
      if (!DANGEROUS_KEYS.includes(key)) obj[key] = value;
    };

    this.currentTemplate.mappings.forEach((m) => {
      if (m.source === "page-title") safeSet(props, m.fieldId, title);
      else if (m.source === "page-url")
        safeSet(props, m.fieldId, this.pageData?.url);
      else if (m.source === "page-description")
        safeSet(props, m.fieldId, this.pageData?.description);
      else if (m.source === "static") safeSet(props, m.fieldId, m.staticValue);
      else if (m.source === "custom")
        safeSet(
          props,
          m.fieldId,
          document.querySelector(`[data-field-id="${m.fieldId}"]`)?.value || "",
        );
    });

    const pageUrl = this.pageData?.url || this.$("preview-url")?.value || "";
    if (this.isYouTubeUrl(pageUrl)) {
      this.currentTemplate.mappings.forEach((m) => {
        if (!this.isTagField(m.fieldType, m.fieldLabel, m.fieldMany)) return;
        const current = Object.prototype.hasOwnProperty.call(props, m.fieldId)
          ? props[m.fieldId]
          : "";
        safeSet(props, m.fieldId, this.appendTagValue(current, "video"));
      });
    }

    const hasBanner = this.currentTemplate.mappings?.some(
      (m) => m.source === "page-image",
    );

    const bannerPayload =
      hasBanner && this.processedBanner && this.bannerMode !== "link"
        ? {
            dataUrl: this.processedBanner.dataUrl,
            filename: this.generateBannerFilename(
              title,
              this.processedBanner.mimeType,
            ),
            mimeType: this.processedBanner.mimeType,
            size: this.processedBanner.size,
            storeAsBlob: true,
          }
        : null;

    return {
      collectionGuid: this.currentTemplate.collectionGuid,
      title,
      properties: props,
      banner: bannerPayload,
      bannerUrl: hasBanner ? this.selectedBanner : null,
      bodyMarkdown: this.currentTemplate.clipContent
        ? this.pageData?.bodyMarkdown || ""
        : null,
      pageUrl: this.pageData?.url || "",
      forceSave: Boolean(this.isDuplicateDetected),
    };
  }

  exportTemplates() {
    const blob = new Blob([JSON.stringify(this.templates, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "thymer-templates.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async importTemplates(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!this.isValidTemplateArray(imported))
        throw new Error("Invalid schema");
      if (
        this.templates.length > 0 &&
        !(await this.showConfirm(
          `Import will replace all ${this.templates.length} existing templates. Continue?`,
        ))
      ) {
        e.target.value = "";
        return;
      }
      this.templates = imported;
      await this.saveTemplatesToThymer();
      this.renderTemplates();
      this.showView("template-selector");
      this.showToast("Templates imported", "success", 2000);
    } catch {
      this.showToast("Invalid file format", "error", 3000);
    }
    e.target.value = "";
  }

  isValidTemplateArray(arr) {
    if (!Array.isArray(arr)) return false;
    return arr.every(
      (t) =>
        typeof t?.id === "string" &&
        typeof t?.name === "string" &&
        (t?.collectionGuid == null || typeof t.collectionGuid === "string") &&
        Array.isArray(t?.mappings),
    );
  }

  // ── Plugin config sync ──
  async loadPluginConfig() {
    if (!this.connected) return;
    try {
      const res = await this.send({
        type: SaveToThymer.MSG.THYMER_GET_PLUGIN_CONFIG,
      });
      if (res) {
        this.pluginConfig.autoTagRules = res.autoTagRules || {};
        this.pluginConfig.urlFieldMap = res.urlFieldMap || {
          collectionGuid: null,
          fieldId: null,
        };
      }
    } catch (e) {
      console.error("[SaveToThymer] Failed to load plugin config", e);
      this.showToast("Failed to load settings", "error", 3000);
    }
    this.renderAutoTagRules();
    this.renderUrlFieldMap();
  }

  // ── Auto-tag rules UI ──
  renderAutoTagRules() {
    const container = this.$("auto-tag-rules-list");
    if (!container) return;
    const rules = this.pluginConfig.autoTagRules || {};
    const entries = Object.entries(rules);
    if (!entries.length) {
      container.innerHTML =
        '<p class="auto-tag-empty">No rules yet. Add rules to auto-tag pages by domain.</p>';
      return;
    }
    container.innerHTML = entries
      .map(
        ([domain, tag], i) => `
        <div class="auto-tag-rule-row">
          <input class="field-input rule-domain-input" value="${this.escapeHtml(domain)}" placeholder="e.g., github.com">
          <span class="rule-arrow">→</span>
          <input class="field-input rule-tag-input" value="${this.escapeHtml(tag)}" placeholder="e.g., dev">
          <button class="rule-delete-btn" data-rule-index="${i}" title="Remove rule">
            <svg viewBox="0 0 256 256" fill="currentColor" style="width:12px;height:12px"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a12,12,0,0,0,0,24h8V208a20,20,0,0,0,20,20H188a20,20,0,0,0,20-20V72h8a12,12,0,0,0,0-24ZM112,168a12,12,0,0,1-24,0V112a12,12,0,0,1,24,0Zm56,0a12,12,0,0,1-24,0V112a12,12,0,0,1,24,0ZM104,40a8,8,0,0,1,8-8h32a8,8,0,0,1,8,8v8H104Z"/></svg>
          </button>
        </div>`,
      )
      .join("");
    container.querySelectorAll(".rule-delete-btn").forEach((btn) => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.ruleIndex, 10);
        const e = Object.entries(this.pluginConfig.autoTagRules || {});
        if (idx >= 0 && idx < e.length) {
          delete this.pluginConfig.autoTagRules[e[idx][0]];
          this.renderAutoTagRules();
        }
      };
    });
  }

  addAutoTagRule() {
    const rules = this.pluginConfig.autoTagRules || {};
    let key = "";
    let n = 1;
    do {
      key = `domain-${n}`;
      n++;
    } while (key in rules);
    rules[key] = "tag";
    this.renderAutoTagRules();
  }

  async saveAutoTagRules() {
    if (!this.connected) {
      this.showToast("Not connected to Thymer", "error", 3000);
      return;
    }
    const container = this.$("auto-tag-rules-list");
    if (!container) return;
    const newRules = {};
    container.querySelectorAll(".auto-tag-rule-row").forEach((row) => {
      const domain = row.querySelector(".rule-domain-input")?.value?.trim();
      const tag = row.querySelector(".rule-tag-input")?.value?.trim();
      if (domain && tag) newRules[domain] = tag;
    });
    this.pluginConfig.autoTagRules = newRules;
    try {
      await this.send({
        type: SaveToThymer.MSG.THYMER_SAVE_PLUGIN_CONFIG,
        payload: {
          autoTagRules: newRules,
          urlFieldMap: this.pluginConfig.urlFieldMap,
        },
      });
      this.showToast("Auto-tag rules saved", "success", 2000);
    } catch (e) {
      console.error("[SaveToThymer] Failed to save auto-tag rules", e);
      this.showToast("Failed to save rules", "error", 3000);
    }
  }

  // ── URL field map UI ──
  renderUrlFieldMap() {
    const colSelect = this.$("urlmap-collection");
    if (!colSelect) return;
    colSelect.innerHTML =
      '<option value="">Select collection...</option>' +
      this.collections
        .map(
          (c) =>
            `<option value="${this.escapeHtml(c.guid)}" ${this.pluginConfig.urlFieldMap?.collectionGuid === c.guid ? "selected" : ""}>${this.escapeHtml(c.name)}</option>`,
        )
        .join("");
    if (this.pluginConfig.urlFieldMap?.collectionGuid) {
      this.populateUrlFieldDropdown(
        this.pluginConfig.urlFieldMap.collectionGuid,
        this.pluginConfig.urlFieldMap.fieldId,
      );
    }
  }

  async populateUrlFieldDropdown(collectionGuid, selectedId) {
    const fieldSelect = this.$("urlmap-field");
    if (!fieldSelect) return;
    try {
      const fields = await this.getFields(collectionGuid);
      const urlFields = fields.filter(
        (f) =>
          f.type === "url" ||
          String(f.label || "")
            .toLowerCase()
            .includes("url"),
      );
      fieldSelect.innerHTML =
        '<option value="">Select field...</option>' +
        urlFields
          .map(
            (f) =>
              `<option value="${this.escapeHtml(f.id)}" ${f.id === selectedId ? "selected" : ""}>${this.escapeHtml(f.label)}</option>`,
          )
          .join("");
    } catch (e) {
      console.error("[SaveToThymer] Failed to load URL fields", e);
      fieldSelect.innerHTML = '<option value="">Error loading fields</option>';
    }
  }

  async saveUrlFieldMap() {
    if (!this.connected) {
      this.showToast("Not connected to Thymer", "error", 3000);
      return;
    }
    const colGuid = this.$("urlmap-collection")?.value || null;
    const fieldId = this.$("urlmap-field")?.value || null;
    this.pluginConfig.urlFieldMap = {
      collectionGuid: colGuid,
      fieldId: fieldId,
    };
    try {
      await this.send({
        type: SaveToThymer.MSG.THYMER_SAVE_PLUGIN_CONFIG,
        payload: {
          autoTagRules: this.pluginConfig.autoTagRules,
          urlFieldMap: { collectionGuid: colGuid, fieldId },
        },
      });
      this.showToast("URL field map saved", "success", 2000);
    } catch (e) {
      console.error("[SaveToThymer] Failed to save URL field map", e);
      this.showToast("Failed to save URL map", "error", 3000);
    }
  }

  // ── Screenshot capture ──
  async captureScreenshot() {
    const btn = this.$("capture-screenshot-btn");
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Capturing...';
    try {
      const dataUri = await chrome.tabs.captureVisibleTab(null, {
        format: "png",
      });
      if (!dataUri || !dataUri.startsWith("data:image")) {
        throw new Error("Invalid screenshot");
      }
      this.selectedBanner = dataUri;
      const preview = this.$("banner-preview-img");
      if (preview) preview.src = dataUri;
      // Create preview if it doesn't exist yet
      if (!preview) {
        const wrapper = document.querySelector(".image-preview-wrapper");
        if (wrapper) {
          const img = wrapper.querySelector("img");
          if (img) img.src = dataUri;
        }
      }
      this.showToast("Screenshot captured", "success", 2000);
    } catch (err) {
      console.error("[SaveToThymer] Screenshot failed", err);
      this.showToast(
        "Screenshot failed: " + (err.message || "unknown error"),
        "error",
        3000,
      );
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }

  // ── Offline save queue ──
  async queueSave(payload) {
    const { [SaveToThymer.QUEUE.STORAGE_KEY]: queue = [] } =
      await chrome.storage.local.get(SaveToThymer.QUEUE.STORAGE_KEY);
    const now = Date.now();
    const valid = queue.filter(
      (item) => now - item.queuedAt < SaveToThymer.QUEUE.EXPIRY_MS,
    );
    valid.push({ ...payload, queuedAt: now });
    const trimmed = valid.slice(-SaveToThymer.QUEUE.MAX_SIZE);
    await chrome.storage.local.set({
      [SaveToThymer.QUEUE.STORAGE_KEY]: trimmed,
    });
    this.updateQueueStatus();
    const msg =
      trimmed.length === 1
        ? "Queued 1 item for sync"
        : `Queued ${trimmed.length} items for sync`;
    this.showToast(msg, "info", 3000);
  }

  async flushQueue() {
    if (!this.connected) return;
    const { [SaveToThymer.QUEUE.STORAGE_KEY]: queue = [] } =
      await chrome.storage.local.get(SaveToThymer.QUEUE.STORAGE_KEY);
    if (!queue.length) return;

    this.showToast(`Syncing ${queue.length} item(s)...`, "info", 4000);
    const failed = [];
    for (const item of queue) {
      try {
        const res = await this.send({
          type: SaveToThymer.MSG.THYMER_SAVE_RECORD,
          payload: {
            collectionGuid: item.collectionGuid,
            title: item.title,
            properties: item.properties,
            bannerUrl: item.bannerUrl || null,
            bodyMarkdown: item.bodyMarkdown || null,
            pageUrl: item.pageUrl || "",
          },
        });
        if (!res?.success) {
          if (res?.error && /already saved|duplicate/i.test(res.error)) {
            continue;
          }
          failed.push(item);
        }
      } catch (err) {
        console.error("[SaveToThymer] Queue flush item failed", err);
        failed.push(item);
      }
    }

    if (failed.length) {
      await chrome.storage.local.set({
        [SaveToThymer.QUEUE.STORAGE_KEY]: failed,
      });
      this.showToast(
        `${failed.length} item(s) failed to sync`,
        "warning",
        4000,
      );
    } else {
      await chrome.storage.local.remove(SaveToThymer.QUEUE.STORAGE_KEY);
      this.showToast("All queued items saved!", "success", 3000);
    }
    this.updateQueueStatus();
  }

  async updateQueueStatus() {
    const { [SaveToThymer.QUEUE.STORAGE_KEY]: queue = [] } =
      await chrome.storage.local.get(SaveToThymer.QUEUE.STORAGE_KEY);
    if (queue.length > 0) {
      this.setOperationStatus(
        `${queue.length} item(s) queued for sync`,
        "warning",
        0,
      );
    } else {
      this.setOperationStatus("", "", 0);
    }
  }

  async checkPendingQueue() {
    const { [SaveToThymer.QUEUE.STORAGE_KEY]: queue = [] } =
      await chrome.storage.local.get(SaveToThymer.QUEUE.STORAGE_KEY);
    if (queue.length > 0) {
      if (this.connected) {
        await this.flushQueue();
      } else {
        this.updateQueueStatus();
      }
    }
  }

  // ── New domain toast ──
  showNewDomainToast(domain) {
    const container = document.querySelector(".toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = "toast info";
    toast.style.cssText =
      "display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
    toast.innerHTML = `
      <span style="flex:1;min-width:0">New domain: <strong>${this.escapeHtml(domain)}</strong> — auto-tag?</span>
      <input class="new-domain-tag-input" placeholder="tag" style="width:80px;padding:4px 6px;border-radius:3px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.05);color:var(--text);font-size:11px;outline:none">
      <button class="new-domain-save-btn" style="padding:4px 8px;border-radius:3px;border:none;background:var(--accent-soft);color:var(--accent);font-size:11px;cursor:pointer;font-weight:500">Save</button>
      <button class="toast-close">&times;</button>
    `;

    const closeBtn = toast.querySelector(".toast-close");
    const saveBtn = toast.querySelector(".new-domain-save-btn");
    const tagInput = toast.querySelector(".new-domain-tag-input");

    closeBtn.onclick = () => this._removeToast(toast);
    saveBtn.onclick = async () => {
      const tag = tagInput?.value?.trim();
      if (!tag) return;
      saveBtn.disabled = true;
      saveBtn.textContent = "...";
      await this.saveSingleTagRule(domain, tag);
      this._removeToast(toast);
      this.showToast(`Rule saved: ${domain} → ${tag}`, "success", 2000);
    };
    // Enter key in input triggers save
    tagInput.onkeydown = (e) => {
      if (e.key === "Enter") saveBtn.click();
    };

    container.appendChild(toast);
    setTimeout(() => tagInput.focus(), 100);
  }

  async saveSingleTagRule(domain, tag) {
    if (!this.connected) return;
    const rules = { ...(this.pluginConfig.autoTagRules || {}), [domain]: tag };
    this.pluginConfig.autoTagRules = rules;
    try {
      await this.send({
        type: SaveToThymer.MSG.THYMER_SAVE_PLUGIN_CONFIG,
        payload: {
          autoTagRules: rules,
          urlFieldMap: this.pluginConfig.urlFieldMap,
        },
      });
    } catch (e) {
      console.error("[SaveToThymer] Failed to save tag rule", e);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => new SaveToThymer());
