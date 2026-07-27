/* Bookmark Indicator v1.0.4
   - Uses require('obsidian') pattern
   - Guarantees bookmarkedPaths is a Set before any decoration
   - Never calls .has on undefined
   - Extra guards for missing data-path in themes
*/

const { Plugin } = require('obsidian');

const DEFAULT_POLL_MS = 2000;

class BookmarkIndicatorPlugin extends Plugin {
  async onload() {
    console.log("[Bookmark Indicator] loading v1.0.4");

    // Always initialize the set *first*
    this.bookmarkedPaths = new Set();
    this._lastBookmarksJson = "";
    this._pollHandle = null;
    this._mutationObserver = null;

    // Load once (non-fatal if missing) then wait for layout
    await this.safeLoadBookmarks();

    this.app.workspace.onLayoutReady(() => {
      this.observeExplorer();
      this.decorateAll();
    });

    // Periodic refresh of bookmarks.json
    this.startPolling();

    // Refresh decorations on relevant events
    this.registerEvent(this.app.vault.on("create", () => this.decorateAll()));
    this.registerEvent(this.app.vault.on("rename", () => this.decorateAll()));
    this.registerEvent(this.app.vault.on("delete", () => this.decorateAll()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.decorateAll()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.decorateAll()));
  }

  onunload() {
    console.log("[Bookmark Indicator] unloading");
    if (this._pollHandle) {
      window.clearInterval(this._pollHandle);
      this._pollHandle = null;
    }
    if (this._mutationObserver) {
      this._mutationObserver.disconnect();
      this._mutationObserver = null;
    }
    this.cleanAll();
  }

  getBookmarksJsonPath() {
    const cfgDir = this.app.vault.configDir || ".obsidian";
    return `${cfgDir}/bookmarks.json`;
    // Note: vault adapter paths are vault-relative
  }

  async safeLoadBookmarks() {
    try {
      await this.loadBookmarks();
    } catch (e) {
      console.warn("[Bookmark Indicator] safeLoadBookmarks error:", e);
      // Ensure it's still a Set
      if (!(this.bookmarkedPaths instanceof Set)) this.bookmarkedPaths = new Set();
    }
  }

  async loadBookmarks() {
    const path = this.getBookmarksJsonPath();
    try {
      const contents = await this.app.vault.adapter.read(path);
      if (typeof contents !== "string") {
        // keep set, nothing else to do
        return;
      }
      if (contents !== this._lastBookmarksJson) {
        this._lastBookmarksJson = contents;
        let parsed;
        try {
          parsed = JSON.parse(contents);
        } catch (e) {
          console.warn("[Bookmark Indicator] Invalid bookmarks.json JSON:", e);
          parsed = null;
        }
        const files = this.extractFilePathsFromBookmarks(parsed);
        // Normalize and enforce Set
        const normalized = new Set();
        for (const p of files) {
          if (!p || typeof p !== "string") continue;
          normalized.add(p.replace(/\\/g, "/"));
        }
        this.bookmarkedPaths = normalized;
        this.decorateAll();
      }
    } catch (e) {
      // bookmarks.json may not exist yet; ensure set exists
      if (!(this.bookmarkedPaths instanceof Set)) this.bookmarkedPaths = new Set();
    }
  }

  getPathFromFileNode(fileNode) {
    // Obsidian 1.11.x: data-path is usually on .nav-file-title, but themes/plugins can move it.
    const titleEl = fileNode.querySelector(".nav-file-title");
    const contentEl = fileNode.querySelector(".nav-file-title-content");
    const candidates = [
      titleEl,
      contentEl,
      fileNode,
      fileNode.querySelector("[data-path]"),
    ].filter(Boolean);

    for (const el of candidates) {
      const p = el.getAttribute && el.getAttribute("data-path");
      if (p) return p.replace(/\\/g, "/");
    }
    return null;
  }



  extractFilePathsFromBookmarks(root) {
    const out = new Set();
    function walk(node) {
      if (!node) return;
      if (Array.isArray(node)) {
        for (const n of node) walk(n);
        return;
      }
      const t = node.type || node["type"];
      if (t === "file" && node.path) {
        out.add(String(node.path));
      }
      if (node.items) walk(node.items);
      if (node.children) walk(node.children);
    }
    if (root && root.items) walk(root.items);
    else walk(root);
    return out;
  }

  startPolling() {
    if (this._pollHandle) return;
    this._pollHandle = window.setInterval(() => this.safeLoadBookmarks(), DEFAULT_POLL_MS);
  }

  getExplorerContainers() {
    // Support multiple File Explorer panes.
    const containers = [];
    try {
      const leaves = this.app.workspace.getLeavesOfType("file-explorer") || [];
      for (const leaf of leaves) {
        const view = leaf?.view;
        const el = view?.containerEl;
        if (el) containers.push(el);
      }
    } catch {}

    // Fallback DOM queries (covers unusual layouts/themes)
    const domFallback = Array.from(document.querySelectorAll(".nav-files-container, .file-explorer"));
    for (const el of domFallback) containers.push(el);

    // Deduplicate
    return Array.from(new Set(containers));
  }


  observeExplorer() {
    const containers = this.getExplorerContainers();
    if (!containers || containers.length === 0) return;

    if (this._mutationObserver) this._mutationObserver.disconnect();

    this._mutationObserver = new MutationObserver((_muts) => this.decorateAll());
    for (const container of containers) {
      this._mutationObserver.observe(container, { childList: true, subtree: true });
    }
  }

  cleanAll() {
    document.querySelectorAll(".nav-file .bh-bookmark-pill").forEach(el => el.remove());
    document.querySelectorAll(".nav-file.bh-bookmarked").forEach(el => el.classList.remove("bh-bookmarked"));
  }

  decorateAll() {
    try {
      // Always treat bookmarkedPaths as a Set
      const set = (this.bookmarkedPaths instanceof Set) ? this.bookmarkedPaths : new Set();

      const containers = this.getExplorerContainers();
      if (!containers || containers.length === 0) return;

      for (const explorer of containers) {
      const fileNodes = explorer.querySelectorAll(".nav-file");
      fileNodes.forEach((fileNode) => {
        const titleEl = fileNode.querySelector(".nav-file-title");
        if (!titleEl) return;

        const path = this.getPathFromFileNode(fileNode);
        if (!path) {
          // Some themes may not expose data-path; skip safely
          this.applyDecoration(fileNode, false);
          return;
        }

        const isBookmarked = set.has(path);
        this.applyDecoration(fileNode, isBookmarked);
      });
      }
    } catch (e) {
      console.warn("[Bookmark Indicator] decorateAll error:", e);
    }
  }

  applyDecoration(fileNode, isBookmarked) {
    const titleEl = fileNode.querySelector(".nav-file-title");
    if (!titleEl) return;

    if (isBookmarked) {
      fileNode.classList.add("bh-bookmarked");
      let pill = titleEl.querySelector(":scope > .bh-bookmark-pill");
      if (!pill) {
        pill = document.createElement("span");
        pill.className = "bh-bookmark-pill";
        titleEl.insertBefore(pill, titleEl.firstChild);
      }
    } else {
      fileNode.classList.remove("bh-bookmarked");
      const pill = titleEl.querySelector(":scope > .bh-bookmark-pill");
      if (pill) pill.remove();
    }
  }
}

module.exports = BookmarkIndicatorPlugin;

