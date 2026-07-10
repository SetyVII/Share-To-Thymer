class Plugin extends AppPlugin {
  onLoad() {
    this.collectionCache = null;
    this.collectionCacheTime = 0;
    this.tagSuggestionsCache = new Map();
    this.tagCacheTTL = 5 * 60 * 1000;
    this.statusBarItem = null;
    this.sidebarWidget = null;
    this.commandPaletteCommand = null;
    this.configPaletteCommand = null;
    this.setupMessageListener();
    this.setupCustomPanel();
    this.setupCommandPalette();
    this.setupStatusBarItem();
    this.setupSidebarWidget();
  }

  onUnload() {
    if (this.messageHandler)
      window.removeEventListener("message", this.messageHandler);
    if (this.statusBarItem) this.statusBarItem.remove();
    if (this.sidebarWidget) this.sidebarWidget.remove();
    if (this.commandPaletteCommand) this.commandPaletteCommand.remove();
    if (this.configPaletteCommand) this.configPaletteCommand.remove();
  }

  setupMessageListener() {
    this.messageHandler = async (e) => {
      if (e.source !== window || e.data?.source !== "save-to-thymer-bridge")
        return;
      const { type, messageId, payload, collectionGuid } = e.data;
      let response = { error: "Unknown message type" };

      try {
        if (type === "THYMER_PING") response = { connected: true };
        else if (type === "THYMER_GET_COLLECTIONS")
          response = await this.getCollections();
        else if (type === "THYMER_GET_COLLECTION_FIELDS")
          response = await this.getFields(collectionGuid);
        else if (type === "THYMER_SAVE_RECORD")
          response = await this.saveRecord(payload);
        else if (type === "THYMER_GET_TEMPLATES")
          response = this.getTemplates();
        else if (type === "THYMER_SAVE_TEMPLATES")
          response = await this.saveTemplates(payload);
        else if (type === "THYMER_GET_PLUGIN_CONFIG")
          response = this.getPluginConfig();
        else if (type === "THYMER_SAVE_PLUGIN_CONFIG")
          response = await this.savePluginConfig(payload);
      } catch (err) {
        response = { error: err.message };
      }

      window.postMessage(
        { messageId, response, source: "thymer-plugin-stt" },
        "*",
      );
    };
    window.addEventListener("message", this.messageHandler);
  }

  async getCollections() {
    // Cache collections for 5 seconds to speed up consecutive calls
    if (!this.collectionCache || Date.now() - this.collectionCacheTime > 5000) {
      this.collectionCache = await this.data.getAllCollections();
      this.collectionCacheTime = Date.now();
    }
    return {
      collections: this.collectionCache.map((c) => ({
        guid: c.getGuid(),
        name: c.getConfiguration().name,
      })),
    };
  }

  async findCollection(guid) {
    if (!this.collectionCache) await this.getCollections();
    return this.collectionCache.find((c) => c.getGuid() === guid);
  }

  isTagField(field) {
    const type = String(field?.type || "").toLowerCase();
    const label = String(field?.label || "").toLowerCase();
    const many = field?.many || false;
    return (
      type === "hashtag" ||
      type === "tag" ||
      type === "tags" ||
      (type === "choice" && !!many) ||
      /\btags?\b/i.test(label)
    );
  }

  extractFieldBaseChoices(field) {
    return (field?.choices || [])
      .filter((c) => c && c.active)
      .map((c) => ({
        id: String(c.id || c.label || ""),
        label: String(c.label || c.id || ""),
      }))
      .filter((c) => c.id && c.label);
  }

  mergeChoices(primary, secondary) {
    const merged = [];
    const seen = new Set();
    [...(primary || []), ...(secondary || [])].forEach((choice) => {
      const label = String(choice?.label || "").trim();
      const id = String(choice?.id || label).trim();
      if (!label || !id) return;
      const key = label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push({ id, label });
    });
    return merged;
  }

  getCachedTagSuggestions(collectionGuid, tagFieldIds) {
    const cacheKey = this.getTagCacheKey(collectionGuid, tagFieldIds);
    const cached = this.tagSuggestionsCache.get(cacheKey);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > this.tagCacheTTL) {
      this.tagSuggestionsCache.delete(cacheKey);
      return null;
    }
    return cached.suggestions;
  }

  cacheTagSuggestions(collectionGuid, tagFieldIds, suggestions) {
    const cacheKey = this.getTagCacheKey(collectionGuid, tagFieldIds);
    this.tagSuggestionsCache.set(cacheKey, {
      timestamp: Date.now(),
      suggestions: suggestions,
    });
  }

  getTagCacheKey(collectionGuid, tagFieldIds) {
    const fieldKey = tagFieldIds.slice().sort().join("|");
    return `${collectionGuid}:${fieldKey}`;
  }

  invalidateTagCache(collectionGuid) {
    for (const [key] of this.tagSuggestionsCache) {
      if (key.startsWith(`${collectionGuid}:`)) {
        this.tagSuggestionsCache.delete(key);
      }
    }
  }

  normalizeTag(value) {
    if (!value) return "";
    const raw = String(value).trim();
    if (!raw) return "";
    const clean = raw.replace(/^#+/, "").trim();
    return clean;
  }

  dedupeTagValues(values) {
    const seen = new Set();
    return (values || []).reduce((tags, value) => {
      const tag = this.normalizeTag(value).trim();
      const key = tag.toLowerCase();
      if (tag && !seen.has(key)) {
        seen.add(key);
        tags.push(tag);
      }
      return tags;
    }, []);
  }

  extractTagValuesFromProp(prop) {
    const values = [];
    const isMulti =
      typeof prop.isMultiValue === "function" && prop.isMultiValue();
    try {
      if (typeof prop.texts === "function") {
        values.push(...(prop.texts() || []));
      }
    } catch (e) {
      console.error("[SaveToThymer] Failed to extract tag texts prop", e);
    }
    if (!isMulti) {
      try {
        if (typeof prop.text === "function") {
          const text = prop.text();
          if (text) values.push(text);
        }
      } catch (e) {
        console.error("[SaveToThymer] Failed to extract tag text prop", e);
      }
    }
    try {
      if (typeof prop.values === "function") {
        values.push(...(prop.values() || []));
      }
    } catch (e) {
      console.error("[SaveToThymer] Failed to extract tag values prop", e);
    }
    return values;
  }

  collectTagSuggestions(records, fields, out) {
    const tagFields = fields.filter((f) => this.isTagField(f));
    if (!tagFields.length) return;

    tagFields.forEach((field) => {
      out[field.id] = out[field.id] || [];
    });

    const seenByField = {};
    tagFields.forEach((field) => {
      seenByField[field.id] = new Set(
        (out[field.id] || []).map((c) => c.label.toLowerCase()),
      );
    });

    for (const record of records || []) {
      for (const field of tagFields) {
        const prop = record.prop(field.label) || record.prop(field.id);
        if (!prop) continue;
        const values = this.extractTagValuesFromProp(prop);
        for (const value of values) {
          const normalized = this.normalizeTag(value);
          if (!normalized) continue;
          const key = normalized.toLowerCase();
          if (seenByField[field.id].has(key)) continue;
          seenByField[field.id].add(key);
          out[field.id].push({ id: normalized, label: normalized });
        }
      }
    }
  }

  getTemplates() {
    const config = this.getConfiguration();
    return { templates: config.custom?.templates || [] };
  }

  async saveTemplates({ templates }) {
    const config = this.getConfiguration();
    config.custom = config.custom || {};
    config.custom.templates = templates;
    await this.data.getPluginByGuid(this.getGuid()).saveConfiguration(config);
    return { success: true };
  }

  async getFields(collectionGuid) {
    const col = await this.findCollection(collectionGuid);
    if (!col) return { fields: [] };

    const config = col.getConfiguration();
    const rawFields = (config.fields || []).filter(
      (f) =>
        f.active &&
        !["created_at", "updated_at", "icon"].includes(f.id) &&
        f.type !== "icon" &&
        f.label?.toLowerCase() !== "icon",
    );

    const tagFieldIds = rawFields
      .filter((f) => this.isTagField(f))
      .map((f) => f.id);
    const tagSuggestionsByFieldId = {};

    if (tagFieldIds.length) {
      const cachedTags = this.getCachedTagSuggestions(
        collectionGuid,
        tagFieldIds,
      );
      if (cachedTags) {
        tagFieldIds.forEach((fieldId) => {
          tagSuggestionsByFieldId[fieldId] = cachedTags[fieldId] || [];
        });
      } else {
        try {
          const records = await col.getAllRecords();
          this.collectTagSuggestions(
            records,
            rawFields,
            tagSuggestionsByFieldId,
          );
          this.cacheTagSuggestions(
            collectionGuid,
            tagFieldIds,
            tagSuggestionsByFieldId,
          );
        } catch (err) {
          console.error(
            "[SaveToThymer] Failed to collect hashtag suggestions",
            err,
          );
        }
      }
    }

    const pluginConfig = this.getConfiguration();
    const restrictions = pluginConfig.custom?.tagRestrictions || {};
    const restrictedTagsForCol = restrictions[collectionGuid];
    let allowedTags = null;
    if (restrictedTagsForCol) {
      allowedTags = (typeof restrictedTagsForCol === "string" ? restrictedTagsForCol.split(",") : restrictedTagsForCol)
        .map((t) => this.normalizeTag(t).trim().toLowerCase())
        .filter(Boolean);
    }

    return {
      fields: rawFields.map((f) => {
        let choices = this.mergeChoices(
          this.extractFieldBaseChoices(f),
          this.isTagField(f) ? tagSuggestionsByFieldId[f.id] || [] : [],
        );
        if (this.isTagField(f) && allowedTags) {
          // Keep only allowed tags
          choices = choices.filter((c) => allowedTags.includes(c.label.toLowerCase()));
          // Ensure allowed tags are present in choices so the user can select them
          const existingLabels = new Set(choices.map((c) => c.label.toLowerCase()));
          const parsedTags = (typeof restrictedTagsForCol === "string" ? restrictedTagsForCol.split(",") : restrictedTagsForCol)
            .map((t) => this.normalizeTag(t).trim())
            .filter(Boolean);
          parsedTags.forEach((tag) => {
            if (!existingLabels.has(tag.toLowerCase())) {
              choices.push({ id: tag, label: tag });
            }
          });
        }
        return {
          id: f.id,
          label: f.label,
          type: f.type,
          many: !!f.many,
          choices,
        };
      }),
    };
  }

  normalizeTitle(title) {
    if (!title) return "";
    // Remove browser notification counters like (2), [3], etc.
    const clean = String(title)
      .replace(/^[\[(]\d+[\])]\s*/, "")
      .trim();
    return clean;
  }

  isDuplicateTitle(existingTitle, newTitle) {
    const normExisting = this.normalizeTitle(existingTitle);
    const normNew = this.normalizeTitle(newTitle);

    // Strict match
    if (normExisting === normNew) return true;

    // Flexible match - normalize whitespace and case
    const flexExisting = normExisting.toLowerCase().replace(/\s+/g, " ").trim();
    const flexNew = normNew.toLowerCase().replace(/\s+/g, " ").trim();

    return flexExisting === flexNew;
  }

  async saveRecord({
    collectionGuid,
    title,
    properties,
    bannerUrl,
    bodyMarkdown,
    pageUrl,
    files,
  }) {
    const col = await this.findCollection(collectionGuid);
    if (!col) return { error: "Collection not found" };

    const config = col.getConfiguration();

    // URL duplicate detection
    const urlFieldMap = this.getUrlFieldMap();
    if (
      urlFieldMap.collectionGuid === collectionGuid &&
      urlFieldMap.fieldId &&
      pageUrl
    ) {
      try {
        const urlRecords = await col.getAllRecords();
        for (const r of urlRecords) {
          const urlProp = r.prop(urlFieldMap.fieldId);
          if (!urlProp) continue;
          let recordUrl = "";
          try {
            recordUrl = urlProp.text?.() || "";
          } catch {}
          if (recordUrl && recordUrl === pageUrl) {
            this.ui.addToaster({
              title: "Already saved",
              message: `URL already exists in ${config.name}`,
              dismissible: true,
              autoDestroyTime: 2500,
            });
            return { error: "Already saved (URL)" };
          }
        }
      } catch (err) {
        console.error("[SaveToThymer] URL duplicate check failed", err);
      }
    }

    // Check for duplicates before creating record
    try {
      const existingRecords = await col.getAllRecords();
      for (const record of existingRecords) {
        // Try to get title from the record
        let recordTitle = "";
        const titleProp = record.prop("title") || record.prop("Title");
        if (titleProp) {
          try {
            recordTitle =
              titleProp.text?.() ||
              titleProp.value?.() ||
              titleProp.get?.() ||
              "";
          } catch (e) {
            console.error("[SaveToThymer] Failed to read record title", e);
          }
          try {
            if (!recordTitle && titleProp.texts?.().length)
              recordTitle = titleProp.texts()[0] || "";
          } catch (e) {
            console.error("[SaveToThymer] Failed to read record titles", e);
          }
          try {
            if (!recordTitle && titleProp.values?.().length)
              recordTitle = titleProp.values()[0] || "";
          } catch (e) {
            console.error("[SaveToThymer] Failed to read record values", e);
          }
        }

        if (recordTitle && this.isDuplicateTitle(recordTitle, title)) {
          console.log("[SaveToThymer] Duplicate detected", {
            existingTitle: recordTitle,
            newTitle: title,
          });
          this.ui.addToaster({
            title: "Already saved",
            message: `"${title}" already exists in ${config.name}`,
            dismissible: true,
            autoDestroyTime: 2500,
          });
          return { error: "Already saved" };
        }
      }
    } catch (err) {
      console.error("[SaveToThymer] Failed to check for duplicates", err);
    }

    const fieldsById = new Map((config.fields || []).map((f) => [f.id, f]));
    const newGuid = col.createRecord(title);
    if (!newGuid) return { error: "Failed to create record" };

    const records = await col.getAllRecords();
    const record = records.find((r) => r.guid === newGuid);
    if (!record) return { error: "Record not found" };

    if (bannerUrl) {
      try {
        new URL(bannerUrl);
      } catch {
        console.error("[SaveToThymer] Invalid bannerUrl", bannerUrl);
        bannerUrl = null;
      }
      if (bannerUrl) {
        const bannerField = (config.fields || []).find(
          (f) => f.type === "banner" && f.active,
        );
        if (bannerField) {
          const prop =
            record.prop(bannerField.label) || record.prop(bannerField.id);
          if (prop) prop.set({ name: `${title} Cover`, imgUrl: bannerUrl });
        }
      }
    }

    // Build a map of user-set tag values so applyAutoTags can merge correctly
    // without relying on prop.texts() (which may not reflect in-memory changes
    // on a freshly created record).
    const userTagsByFieldId = {};
    for (const [fieldId, value] of Object.entries(properties || {})) {
      if (!value || fieldId === "title") continue;
      const field = fieldsById.get(fieldId);
      if (!field) continue;
      const prop = record.prop(field.label) || record.prop(fieldId);
      if (!prop) continue;
      if (field.type === "number") {
        const num = parseFloat(value);
        if (!isNaN(num)) prop.set(num);
      } else if (this.isTagField(field)) {
        let tags = this.dedupeTagValues(String(value).split(","));

        // Enforce tag restrictions if configured
        const pluginConfig = this.getConfiguration();
        const restrictions = pluginConfig.custom?.tagRestrictions || {};
        const restrictedTagsForCol = restrictions[collectionGuid];
        if (restrictedTagsForCol) {
          const allowedTags = (typeof restrictedTagsForCol === "string" ? restrictedTagsForCol.split(",") : restrictedTagsForCol)
            .map((t) => this.normalizeTag(t).trim().toLowerCase())
            .filter(Boolean);
          tags = tags.filter((t) => allowedTags.includes(t.toLowerCase()));
        }

        if (tags.length > 0) {
          prop.set(tags);
          userTagsByFieldId[fieldId] = tags;
        }
      } else if (field.type !== "banner") {
        prop.set(String(value));
      }
    }

    if (bodyMarkdown && typeof record.createLineItem === "function") {
      await this.insertMarkdown(record, bodyMarkdown);
    }
    if (files && files.length) {
      for (const f of files) {
        try {
          const arr = f.dataUrl.split(",");
          const mime = arr[0].match(/:(.*?);/)[1];
          const bstr = atob(arr[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
          }
          const fileObj = new File([u8arr], f.name, { type: mime });
          const blob = await this.data.uploadBlob(fileObj);
          if (blob) {
            const isImage = mime.startsWith("image/");
            const type = isImage ? "image" : "file";
            const lineItem = await record.createLineItem(
              null,
              null,
              type,
              null,
              null,
            );
            if (lineItem) {
              await lineItem.setBlob(blob);
            }
          }
        } catch (err) {
          console.error("[SaveToThymer] Error subiendo archivo adjunto", err);
        }
      }
    }

    // Auto-tagging by domain
    let isNewDomain = null;
    if (pageUrl) {
      isNewDomain = this.detectNewDomain(pageUrl);
      await this.applyAutoTags(record, pageUrl, config, userTagsByFieldId);
    }

    this.ui.addToaster({
      title: "Saved!",
      message: `"${title}" added to ${config.name}`,
      dismissible: true,
      autoDestroyTime: 2500,
    });

    // Persist recent save and update status bar
    await this.addRecentSave({
      title,
      url: pageUrl || "",
      collectionName: config.name || "",
      collectionGuid,
      timestamp: Date.now(),
    });
    this.updateStatusBar({
      title,
      url: pageUrl || "",
      collectionName: config.name || "",
    });
    if (this.sidebarWidget) this.sidebarWidget.refresh();

    this.invalidateTagCache(collectionGuid);

    const result = { success: true, recordGuid: newGuid };
    if (isNewDomain) result.isNewDomain = isNewDomain;
    return result;
  }

  async insertMarkdown(record, markdown) {
    const blocks = this.parseMarkdown(markdown);
    let lastItem = null;

    for (const block of blocks) {
      try {
        const item = await record.createLineItem(null, lastItem, block.type);
        if (item) {
          if (block.type === "heading" && block.hsize)
            item.setHeadingSize(block.hsize);
          if (block.type === "block" && block.codeLines) {
            if (block.language) item.setHighlightLanguage(block.language);
            item.setSegments([]);
            let lastChild = null;
            for (const line of block.codeLines) {
              const child = await record.createLineItem(
                item,
                lastChild,
                "text",
              );
              if (child) {
                child.setSegments([{ type: "text", text: line }]);
                lastChild = child;
              }
            }
          } else if (block.segments?.length) {
            item.setSegments(block.segments);
          } else {
            item.setSegments([]);
          }
          lastItem = item;
        }
      } catch (err) {
        console.error("[SaveToThymer] Failed to create line item", err);
      }
    }
  }

  parseMarkdown(markdown) {
    const lines = markdown.split("\n");
    const blocks = [];
    let inCode = false,
      codeLines = [],
      codeLang = "";

    for (const line of lines) {
      if (line.startsWith("```")) {
        if (!inCode) {
          inCode = true;
          codeLang = line.slice(3).trim();
          codeLines = [];
        } else {
          inCode = false;
          if (codeLines.length)
            blocks.push({
              type: "block",
              language: codeLang || "plaintext",
              codeLines,
            });
          codeLines = [];
          codeLang = "";
        }
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }
      const parsed = this.parseLine(line);
      if (parsed) blocks.push(parsed);
    }
    if (inCode && codeLines.length)
      blocks.push({
        type: "block",
        language: codeLang || "plaintext",
        codeLines,
      });
    return blocks;
  }

  parseLine(line) {
    if (!line.trim())
      return { type: "text", segments: [{ type: "text", text: " " }] };
    if (/^(\*\s*\*\s*\*|\-\s*\-\s*\-|_\s*_\s*_)[\s\*\-_]*$/.test(line.trim()))
      return { type: "br", segments: [] };

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading)
      return {
        type: "heading",
        hsize: heading[1].length,
        segments: this.parseInline(heading[2]),
      };

    const task = line.match(/^[\-\*]\s+\[([ xX])\]\s+(.+)$/);
    if (task) return { type: "task", segments: this.parseInline(task[2]) };

    const ul = line.match(/^[\-\*]\s+(.+)$/);
    if (ul) return { type: "ulist", segments: this.parseInline(ul[1]) };

    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ol) return { type: "olist", segments: this.parseInline(ol[1]) };

    if (line.startsWith("> "))
      return { type: "quote", segments: this.parseInline(line.slice(2)) };

    return { type: "text", segments: this.parseInline(line) };
  }

  parseInline(text) {
    const segments = [];
    const patterns = [
      { r: /`([^`]+)`/, t: "code" },
      { r: /\[([^\]]+)\]\(([^)]+)\)/, t: "link" },
      { r: /\*\*([^*]+)\*\*/, t: "bold" },
      { r: /__([^_]+)__/, t: "bold" },
      { r: /\*([^*]+)\*/, t: "italic" },
      { r: /_([^_]+)_/, t: "italic" },
    ];
    let remaining = text;

    while (remaining.length) {
      let earliest = null,
        idx = remaining.length,
        pattern = null;
      for (const p of patterns) {
        const m = remaining.match(p.r);
        if (m && m.index < idx) {
          earliest = m;
          idx = m.index;
          pattern = p;
        }
      }
      if (earliest && pattern) {
        if (idx > 0)
          segments.push({ type: "text", text: remaining.slice(0, idx) });
        segments.push({
          type: pattern.t === "link" ? "text" : pattern.t,
          text: earliest[1],
        });
        remaining = remaining.slice(idx + earliest[0].length);
      } else {
        segments.push({ type: "text", text: remaining });
        break;
      }
    }
    return segments.length ? segments : [{ type: "text", text }];
  }

  // ── Plugin config sync ──
  getDefaultAutoTagRules() {
    return {
      "github.com": "dev",
      "medium.com": "article",
      "youtube.com": "video",
      "youtu.be": "video",
      "news.ycombinator.com": "hn",
      "reddit.com": "reddit",
      "twitter.com": "social",
      "x.com": "social",
    };
  }

  getAutoTagRules() {
    const config = this.getConfiguration();
    const rules = config.custom?.autoTagRules;
    if (rules && Object.keys(rules).length) return rules;
    if (config.custom?.autoTagRulesCleared) return {};
    return this.getDefaultAutoTagRules();
  }

  getPluginConfig() {
    const config = this.getConfiguration();
    return {
      autoTagRules: this.getAutoTagRules(),
      urlFieldMap: config.custom?.urlFieldMap || {
        collectionGuid: null,
        fieldId: null,
      },
      tagRestrictions: config.custom?.tagRestrictions || {},
    };
  }

  async savePluginConfig({ autoTagRules, urlFieldMap, tagRestrictions }) {
    const config = this.getConfiguration();
    config.custom = config.custom || {};
    if (autoTagRules !== undefined) {
      config.custom.autoTagRules = autoTagRules;
      config.custom.autoTagRulesCleared = !Object.keys(autoTagRules).length;
    }
    if (urlFieldMap !== undefined) config.custom.urlFieldMap = urlFieldMap;
    if (tagRestrictions !== undefined) config.custom.tagRestrictions = tagRestrictions;
    await this.data.getPluginByGuid(this.getGuid()).saveConfiguration(config);
    return { success: true };
  }

  // ── URL field mapping ──
  getUrlFieldMap() {
    const config = this.getConfiguration();
    return (
      config.custom?.urlFieldMap || { collectionGuid: null, fieldId: null }
    );
  }

  // ── Auto-tagging by domain ──
  async applyAutoTags(record, pageUrl, colConfig, userTagsByFieldId = {}) {
    const rules = this.getAutoTagRules();
    if (!Object.keys(rules).length) return;

    let domain = "";
    try {
      domain = new URL(pageUrl).hostname.replace(/^www\./, "");
    } catch {
      return;
    }

    let tagToAdd = rules[domain];
    if (!tagToAdd) {
      for (const [key, tag] of Object.entries(rules)) {
        if (domain.includes(key) || domain.endsWith(key)) {
          tagToAdd = tag;
          break;
        }
      }
    }
    if (!tagToAdd) return;

    const tagFields = (colConfig.fields || []).filter(
      (f) => this.isTagField(f) && f.active,
    );
    for (const tagField of tagFields) {
      const prop = record.prop(tagField.label) || record.prop(tagField.id);
      if (!prop) continue;
      try {
        // Primary source: tags the user just entered via the properties payload
        let existing = this.dedupeTagValues(userTagsByFieldId[tagField.id] || []);
        // Fallback: read persisted tags from the prop (covers fields mapped as static/auto)
        if (!existing.length) {
          try {
            if (typeof prop.texts === "function") {
              existing = this.dedupeTagValues(prop.texts() || []);
            }
          } catch {}
          if (!existing.length && typeof prop.values === "function") {
            try {
              existing = (prop.values() || [])
                .map((t) => String(t).trim())
                .filter(Boolean);
              existing = this.dedupeTagValues(existing);
            } catch {}
          }
        }
        const normalized = this.normalizeTag(tagToAdd);
        if (!normalized) continue;
        const alreadyPresent = existing.some(
          (t) =>
            this.normalizeTag(t).toLowerCase() === normalized.toLowerCase(),
        );
        if (!alreadyPresent) {
          prop.set([...existing, normalized]);
        }
      } catch (err) {
        console.error("[SaveToThymer] Failed to auto-tag", err);
      }
    }
  }

  detectNewDomain(pageUrl) {
    const rules = this.getAutoTagRules();
    let domain = "";
    try {
      domain = new URL(pageUrl).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
    if (rules[domain]) return null;
    for (const key of Object.keys(rules)) {
      if (domain.includes(key) || domain.endsWith(key)) return null;
    }
    return domain;
  }

  // ── Recent saves persistence ──
  getRecentSaves(limit) {
    const config = this.getConfiguration();
    const max = limit ?? config.custom?.sidebarRecentCount ?? 3;
    return (config.custom?.recentSaves || []).slice(0, max);
  }

  getSidebarRecentCount() {
    const raw = this.getConfiguration().custom?.sidebarRecentCount;
    if (raw === undefined || raw === null || raw === "") return 3;
    const count = Number.parseInt(raw, 10);
    if (Number.isNaN(count)) return 3;
    return Math.min(10, Math.max(0, count));
  }

  async addRecentSave({
    title,
    url,
    collectionName,
    collectionGuid,
    timestamp,
  }) {
    const config = this.getConfiguration();
    config.custom = config.custom || {};
    const saves = config.custom.recentSaves || [];
    let favicon = "";
    try {
      favicon = new URL(url).origin + "/favicon.ico";
    } catch {}
    saves.unshift({
      title: title || "Untitled",
      url: url || "",
      favicon,
      collectionName: collectionName || "",
      collectionGuid: collectionGuid || "",
      timestamp: timestamp || Date.now(),
    });
    config.custom.recentSaves = saves.slice(0, 10);
    config.custom.lastSaveInfo = {
      title,
      url,
      collectionName,
      timestamp: Date.now(),
    };
    await this.data
      .getPluginByGuid(this.getGuid())
      .saveConfiguration(config)
      .catch((err) => {
        console.error("[SaveToThymer] Failed to persist recentSaves", err);
      });
  }

  // ── Status bar item ──
  setupStatusBarItem() {
    const config = this.getConfiguration();
    const last = config.custom?.lastSaveInfo;
    this.statusBarItem = this.ui.addStatusBarItem({
      label: last ? `Last: ${last.title.slice(0, 30)}` : "Share To Thymer",
      icon: "ti-bookmark",
      tooltip: last ? `Saved: ${last.title}` : "Ready to save pages",
      onClick: () => this.openConfigPanel(),
    });
  }

  updateStatusBar(info) {
    if (!this.statusBarItem) return;
    this.statusBarItem.setLabel(`Saved: ${info.title.slice(0, 30)}`);
    this.statusBarItem.setIcon("ti-check");
    this.statusBarItem.setTooltip(
      `Last save: ${info.title} at ${new Date().toLocaleTimeString()}`,
    );
  }

  // ── Sidebar widget ──
  setupSidebarWidget() {
    this.sidebarWidget = this.ui.addSidebarWidget((container, { refresh }) => {
      const recentCount = this.getSidebarRecentCount();
      if (recentCount === 0) {
        container.innerHTML = "";
        return;
      }
      const saves = this.getRecentSaves();
      if (!saves.length) {
        container.innerHTML =
          '<div style="padding:12px 16px;font-size:12px;color:var(--text-dim)">No recent saves</div>';
        return;
      }
      container.innerHTML = `
        <div style="padding:8px 0">
          <div style="padding:4px 16px 8px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-dim)">Recently Saved</div>
          ${saves
            .map(
              (s, i) => `
            <div class="stt-recent-item" data-i="${i}"
                 style="display:flex;align-items:center;gap:8px;padding:6px 16px;cursor:pointer;border-radius:4px;font-size:12px;color:var(--text-muted);transition:background 0.1s"
                 onmouseenter="this.style.background='var(--surface-hover)'"
                 onmouseleave="this.style.background='transparent'"
                 title="${this.escapeHtml(s.title)}">
              <img src="${this.escapeHtml(s.favicon)}" style="width:14px;height:14px;border-radius:2px;flex-shrink:0" onerror="this.style.display='none'" alt="">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.escapeHtml(s.title)}</span>
              <span style="font-size:10px;color:var(--text-dim);flex-shrink:0">${this.formatTimeAgo(s.timestamp)}</span>
            </div>`,
            )
            .join("")}
        </div>`;
      const clickHandler = (e) => {
        const item = e.target.closest(".stt-recent-item");
        if (!item) return;
        const s = saves[parseInt(item.dataset.i, 10)];
        if (s?.url) window.open(s.url, "_blank");
      };
      container.addEventListener("click", clickHandler);
      return () => container.removeEventListener("click", clickHandler);
    });
  }

  formatTimeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h`;
    return `${Math.floor(mins / 1440)}d`;
  }

  // ── Command palette ──
  setupCommandPalette() {
    this.commandPaletteCommand = this.ui.addCommandPaletteCommand({
      label: "Save current page to Thymer",
      icon: "ti-bookmark",
      onSelected: () => {
        this.ui.addToaster({
          title: "Share To Thymer",
          message:
            "Click the extension icon (Ctrl+O) or use the browser popup to save the current page.",
          dismissible: true,
          autoDestroyTime: 5000,
        });
      },
    });
    this.configPaletteCommand = this.ui.addCommandPaletteCommand({
      label: "Share To Thymer Configuration",
      icon: "ti-settings",
      onSelected: () => this.openConfigPanel(),
    });
  }

  // ── Custom configuration panel ──
  setupCustomPanel() {
    const plugin = this;

    this.ui.injectCSS(`
      .stt-panel {
        --stt-surface: var(--theme-background-primary, var(--color-background-primary, var(--bg-default, Canvas)));
        --stt-surface-elevated: var(--theme-background-secondary, var(--color-background-secondary, var(--bg-default, Canvas)));
        --stt-border: var(--theme-border, var(--color-border, var(--border-default, color-mix(in srgb, CanvasText 16%, transparent))));
        --stt-text: var(--theme-text-primary, var(--color-text-primary, var(--text-default, CanvasText)));
        --stt-text-muted: var(--theme-text-secondary, var(--color-text-secondary, var(--text-muted, color-mix(in srgb, CanvasText 62%, transparent))));
        --stt-text-dim: var(--theme-text-tertiary, var(--color-text-tertiary, var(--text-dim, color-mix(in srgb, CanvasText 42%, transparent))));
        --stt-accent: var(--theme-accent, var(--color-accent, var(--accent-color, #8b5cf6)));
        box-sizing: border-box;
        width: 100%;
        max-width: 640px;
        margin: 0 auto;
        padding: 14px 12px 22px;
        color: var(--stt-text);
        font-family: var(--font-m, var(--font-primary, inherit));
        font-size: 13px;
      }
      .stt-panel *,
      .stt-panel *::before,
      .stt-panel *::after {
        box-sizing: inherit;
      }
      .stt-panel button,
      .stt-panel input,
      .stt-panel select {
        font: inherit;
      }
      .stt-panel h3 {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 10px;
        color: var(--stt-text);
        font-size: 14px;
        font-weight: 600;
        line-height: 1.3;
      }
      .stt-panel .stt-section {
        padding: 0 0 18px;
        margin: 0 0 18px;
        border-bottom: 1px solid var(--stt-border);
      }
      .stt-panel .stt-section:last-child {
        padding-bottom: 0;
        margin-bottom: 0;
        border-bottom: 0;
      }
      .stt-panel .stt-desc {
        margin: 0 0 12px;
        color: var(--stt-text-muted);
        font-size: 11px;
        line-height: 1.45;
      }
      .stt-panel .stt-grid {
        display: grid;
        gap: 8px;
      }
      .stt-panel .stt-grid-2 {
        grid-template-columns: 1fr;
      }
      .stt-panel .stt-add-restriction-row {
        grid-template-columns: 1fr;
        align-items: center;
        margin-top: 10px;
      }
      .stt-panel .stt-row {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 8px;
      }
      .stt-panel .stt-rule-row {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
        align-items: center;
        margin-bottom: 8px;
      }
      .stt-panel .stt-restriction-row {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
        align-items: center;
        margin-bottom: 8px;
      }
      .stt-panel .stt-restriction-name {
        min-width: 0;
        overflow: hidden;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .stt-panel input,
      .stt-panel select {
        min-width: 0;
        min-height: 40px;
        padding: 8px 10px;
        border: 1px solid var(--stt-border);
        border-radius: 4px;
        outline: none;
        background: var(--input-bg-color, var(--stt-surface));
        color: var(--stt-text);
        font-size: 12px;
      }
      .stt-panel input:focus,
      .stt-panel select:focus {
        border-color: var(--stt-accent);
      }
      .stt-panel .stt-sidebar-count {
        width: 96px;
        flex: 0 0 96px;
      }
      .stt-panel .stt-meta {
        color: var(--stt-text-dim);
        font-size: 11px;
        white-space: nowrap;
      }
      .stt-panel .stt-arrow {
        justify-self: center;
        color: var(--stt-text-muted);
        flex-shrink: 0;
        transform: rotate(90deg);
      }
      .stt-panel .stt-empty {
        padding: 16px;
        color: var(--stt-text-dim);
        font-size: 11px;
        text-align: center;
      }
      .stt-panel .stt-save-row {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
        margin-top: 6px;
      }
      .stt-panel .stt-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        min-height: 40px;
        padding: 6px 10px;
        border: 1px solid var(--stt-border);
        border-radius: 4px;
        background: var(--button-secondary-bg-color, var(--stt-surface-elevated));
        color: var(--stt-text);
        font-size: 11px;
        cursor: pointer;
        transition:
          background 0.1s,
          border-color 0.1s;
      }
      .stt-panel .stt-button:hover {
        background: var(--surface-hover, var(--stt-surface-elevated));
        border-color: var(--stt-accent);
      }
      .stt-panel .stt-recent-item {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        padding: 5px 0;
        color: var(--stt-text-muted);
        font-size: 12px;
        white-space: nowrap;
        cursor: pointer;
      }
      .stt-panel .stt-recent-item img {
        width: 14px;
        height: 14px;
        border-radius: 2px;
        flex-shrink: 0;
      }
      .stt-panel .stt-recent-title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .stt-panel .stt-recent-time {
        color: var(--stt-text-dim);
        font-size: 10px;
        flex-shrink: 0;
      }
      @media (min-width: 720px) {
        .stt-panel {
          padding: 16px 20px 24px;
        }
        .stt-panel .stt-section {
          padding-bottom: 20px;
          margin-bottom: 20px;
        }
        .stt-panel .stt-grid-2 {
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        }
        .stt-panel .stt-add-restriction-row {
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
        }
        .stt-panel .stt-restriction-row {
          grid-template-columns: minmax(110px, auto) minmax(0, 1fr) auto;
        }
        .stt-panel .stt-row {
          flex-wrap: nowrap;
        }
        .stt-panel .stt-rule-row {
          grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
        }
        .stt-panel input,
        .stt-panel select,
        .stt-panel .stt-button {
          min-height: 32px;
        }
        .stt-panel .stt-arrow {
          transform: none;
        }
        .stt-panel .stt-save-row {
          display: flex;
          flex-wrap: wrap;
        }
        .stt-panel .stt-save-row .stt-button,
        .stt-panel .stt-add-restriction-row .stt-button {
          width: auto;
        }
        .stt-panel .stt-sidebar-count {
          width: 80px;
          flex: 0 0 auto;
        }
      }
    `);

    this.ui.registerCustomPanelType("stt-config", (panel) => {
      panel.setTitle("Share To Thymer Configuration");
      const el = panel.getElement();
      if (!el) return;
      el.innerHTML =
        '<div class="stt-panel" id="stt-config-root"><div style="padding:20px;text-align:center;color:var(--text-dim)">Loading...</div></div>';
      plugin.renderConfigPanel(el);
    });
  }

  async openConfigPanel() {
    const panel = await this.ui.createPanel();
    if (panel) panel.navigateToCustomType("stt-config");
  }

  async renderConfigPanel(el) {
    const config = this.getConfiguration();
    const rules = this.getAutoTagRules();
    const urlMap = config.custom?.urlFieldMap || {
      collectionGuid: null,
      fieldId: null,
    };
    const tagRestrictions = config.custom?.tagRestrictions || {};
    const sidebarRecentCount = this.getSidebarRecentCount();
    const recentSaves = this.getRecentSaves();
    const collections = this.collectionCache || [];
    if (!collections.length) {
      try {
        this.collectionCache = await this.data.getAllCollections();
      } catch {}
    }
    const colOptions = (this.collectionCache || [])
      .map(
        (c) =>
          `<option value="${c.getGuid()}" ${urlMap.collectionGuid === c.getGuid() ? "selected" : ""}>${this.escapeHtml(c.getConfiguration().name)}</option>`,
      )
      .join("");

    const ruleRows = Object.entries(rules)
      .map(
        ([domain, tag], i) => `
        <div class="stt-rule-row stt-row" data-rule-i="${i}">
          <input class="stt-domain" value="${this.escapeHtml(domain)}" placeholder="domain">
          <span class="stt-arrow">→</span>
          <input class="stt-tag" value="${this.escapeHtml(tag)}" placeholder="tag">
        </div>`,
      )
      .join("");

    const restrictionColOptions = (this.collectionCache || [])
      .map(
        (c) =>
          `<option value="${c.getGuid()}">${this.escapeHtml(c.getConfiguration().name)}</option>`,
      )
      .join("");

    const restrictionRows = Object.entries(tagRestrictions)
      .map(
        ([colGuid, tags], i) => {
          const colName = (this.collectionCache || []).find(c => c.getGuid() === colGuid)?.getConfiguration().name || "Unknown Collection";
          const tagsStr = Array.isArray(tags) ? tags.join(", ") : String(tags);
          return `
            <div class="stt-restriction-row" data-col-guid="${colGuid}">
              <span class="stt-restriction-name" title="${this.escapeHtml(colName)}">${this.escapeHtml(colName)}</span>
              <input class="stt-allowed-tags" value="${this.escapeHtml(tagsStr)}" placeholder="tag1, tag2, tag3">
              ${this.buildButtonHtml("Delete", `stt-del-restriction-${i}`)}
            </div>
          `;
        }
      )
      .join("");

    const recentHtml = recentSaves.length
      ? recentSaves
          .slice(0, 5)
          .map(
            (s) => `
            <div class="stt-recent-item" title="${this.escapeHtml(s.title)}" onclick="window.open('${this.escapeHtml(s.url)}','_blank')">
              <img src="${this.escapeHtml(s.favicon)}" onerror="this.style.display='none'" alt="">
              <span class="stt-recent-title">${this.escapeHtml(s.title)}</span>
              <span class="stt-recent-time">${this.formatTimeAgo(s.timestamp)}</span>
            </div>`,
          )
          .join("")
      : '<div class="stt-empty">No saves yet</div>';

    el.querySelector("#stt-config-root").innerHTML = `
      <section class="stt-section">
        <h3>URL Duplicate Detection</h3>
        <p class="stt-desc">Select which collection and field stores the URL for duplicate checking</p>
        <div class="stt-grid stt-grid-2">
          <select id="stt-url-collection">${colOptions}</select>
          <select id="stt-url-field"><option value="">Select field...</option></select>
        </div>
        <div class="stt-save-row">${this.buildButtonHtml("Save URL Map", "stt-save-urlmap")}</div>
      </section>

      <section class="stt-section">
        <h3>Auto-Tag Rules</h3>
        <p class="stt-desc">Automatically add tags based on page domain</p>
        <div id="stt-rules-list">${ruleRows || '<div class="stt-empty">No rules yet</div>'}</div>
        <div class="stt-save-row">
          ${this.buildButtonHtml("+ Add Rule", "stt-add-rule")}
          ${this.buildButtonHtml("Save Rules", "stt-save-rules")}
        </div>
      </section>

      <section class="stt-section">
        <h3>Allowed Tags per Collection</h3>
        <p class="stt-desc">Restrict which tags can be used for a specific collection (leave empty to allow all)</p>
        <div id="stt-restrictions-list">${restrictionRows || '<div class="stt-empty">No restrictions configured</div>'}</div>
        <div class="stt-grid stt-add-restriction-row">
          <select id="stt-new-restriction-col">${restrictionColOptions}</select>
          <input id="stt-new-restriction-tags" placeholder="tag1, tag2, tag3">
          ${this.buildButtonHtml("Add Restriction", "stt-add-restriction")}
        </div>
        <div class="stt-save-row">
          ${this.buildButtonHtml("Save Restrictions", "stt-save-restrictions")}
        </div>
      </section>

      <section class="stt-section">
        <h3>Sidebar Widget</h3>
        <p class="stt-desc">How many recent saves to show in the sidebar. Set to 0 to hide them.</p>
        <div class="stt-row">
          <input class="stt-sidebar-count" id="stt-sidebar-count" type="number" min="0" max="10" value="${sidebarRecentCount}" placeholder="3">
          <span class="stt-meta">items (0-10)</span>
          ${this.buildButtonHtml("Save", "stt-save-sidebar-count")}
        </div>
      </section>

      <section class="stt-section">
        <h3>Recently Saved</h3>
        <div id="stt-recent-list">${recentHtml}</div>
      </section>
    `;

    // Event handlers
    el.querySelector("#stt-save-urlmap")?.addEventListener(
      "click",
      async () => {
        const colGuid = el.querySelector("#stt-url-collection")?.value || null;
        const fieldId = el.querySelector("#stt-url-field")?.value || null;
        await this.savePluginConfig({
          urlFieldMap: { collectionGuid: colGuid, fieldId },
        });
        this.ui.addToaster({
          title: "URL map saved",
          dismissible: true,
          autoDestroyTime: 2000,
        });
      },
    );

    el.querySelector("#stt-url-collection")?.addEventListener(
      "change",
      async (e) => {
        const guid = e.target.value;
        if (!guid) return;
        try {
          const col = await this.findCollection(guid);
          if (!col) return;
          const cconfig = col.getConfiguration();
          const urlFields = (cconfig.fields || []).filter(
            (f) => f.type === "url" && f.active,
          );
          const fieldSelect = el.querySelector("#stt-url-field");
          if (fieldSelect) {
            fieldSelect.innerHTML =
              '<option value="">Select field...</option>' +
              urlFields
                .map(
                  (f) =>
                    `<option value="${f.id}" ${urlMap.fieldId === f.id ? "selected" : ""}>${this.escapeHtml(f.label)}</option>`,
                )
                .join("");
          }
        } catch {}
      },
    );

    // Pre-populate fields if URL map is configured
    if (urlMap.collectionGuid && urlMap.fieldId) {
      setTimeout(async () => {
        try {
          const col = await this.findCollection(urlMap.collectionGuid);
          if (!col) return;
          const cconfig = col.getConfiguration();
          const urlFields = (cconfig.fields || []).filter(
            (f) => f.type === "url" && f.active,
          );
          const fieldSelect = el.querySelector("#stt-url-field");
          if (fieldSelect) {
            fieldSelect.innerHTML =
              '<option value="">Select field...</option>' +
              urlFields
                .map(
                  (f) =>
                    `<option value="${f.id}" ${urlMap.fieldId === f.id ? "selected" : ""}>${this.escapeHtml(f.label)}</option>`,
                )
                .join("");
          }
        } catch {}
      }, 100);
    }

    el.querySelector("#stt-add-rule")?.addEventListener("click", () => {
      const container = el.querySelector("#stt-rules-list");
      if (!container) return;
      let n = Object.keys(rules).length + 1;
      rules[`domain-${n}`] = "tag";
      container.innerHTML = Object.entries(rules)
        .map(
          ([d, t], i) => `
          <div class="stt-rule-row stt-row" data-rule-i="${i}">
            <input class="stt-domain" value="${this.escapeHtml(d)}" placeholder="domain">
            <span class="stt-arrow">→</span>
            <input class="stt-tag" value="${this.escapeHtml(t)}" placeholder="tag">
          </div>`,
        )
        .join("");
    });

    el.querySelector("#stt-save-rules")?.addEventListener("click", async () => {
      const newRules = {};
      el.querySelectorAll("#stt-rules-list .stt-row").forEach((row) => {
        const d = row.querySelector(".stt-domain")?.value?.trim();
        const t = row.querySelector(".stt-tag")?.value?.trim();
        if (d && t) newRules[d] = t;
      });
      await this.savePluginConfig({
        autoTagRules: newRules,
      });
      this.ui.addToaster({
        title: "Rules saved",
        dismissible: true,
        autoDestroyTime: 2000,
      });
      // Re-render
      this.renderConfigPanel(el);
    });

    el.querySelector("#stt-add-restriction")?.addEventListener("click", async () => {
      const colGuid = el.querySelector("#stt-new-restriction-col")?.value;
      const tags = el.querySelector("#stt-new-restriction-tags")?.value?.trim();
      if (colGuid && tags) {
        tagRestrictions[colGuid] = tags;
        await this.savePluginConfig({
          tagRestrictions,
        });
        this.renderConfigPanel(el);
      }
    });

    Object.keys(tagRestrictions).forEach((colGuid, i) => {
      el.querySelector(`#stt-del-restriction-${i}`)?.addEventListener("click", async () => {
        delete tagRestrictions[colGuid];
        await this.savePluginConfig({
          tagRestrictions,
        });
        this.renderConfigPanel(el);
      });
    });

    el.querySelector("#stt-save-restrictions")?.addEventListener("click", async () => {
      const newRestrictions = {};
      el.querySelectorAll("#stt-restrictions-list .stt-restriction-row").forEach((row) => {
        const colGuid = row.dataset.colGuid;
        const tags = row.querySelector(".stt-allowed-tags")?.value?.trim();
        if (colGuid && tags) {
          newRestrictions[colGuid] = tags;
        }
      });
      await this.savePluginConfig({
        tagRestrictions: newRestrictions,
      });
      this.ui.addToaster({
        title: "Restrictions saved",
        dismissible: true,
        autoDestroyTime: 2000,
      });
      this.renderConfigPanel(el);
    });

    el.querySelector("#stt-save-sidebar-count")?.addEventListener(
      "click",
      async () => {
        const rawCount = el.querySelector("#stt-sidebar-count")?.value;
        const parsedCount = Number.parseInt(rawCount, 10);
        const count = Number.isNaN(parsedCount)
          ? 3
          : Math.min(10, Math.max(0, parsedCount));
        const config = this.getConfiguration();
        config.custom = config.custom || {};
        config.custom.sidebarRecentCount = count;
        await this.data
          .getPluginByGuid(this.getGuid())
          .saveConfiguration(config);
        if (this.sidebarWidget) this.sidebarWidget.refresh();
        this.ui.addToaster({
          title: "Sidebar count updated",
          dismissible: true,
          autoDestroyTime: 2000,
        });
      },
    );
  }

  buildButtonHtml(label, id) {
    return `<button class="stt-button" id="${id}" type="button">${label}</button>`;
  }

  // ── Helpers ──
  escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}
