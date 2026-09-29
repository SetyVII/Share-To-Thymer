(function () {
  // Replace old listener if exists
  if (window.__saveToThymerListener) {
    chrome.runtime.onMessage.removeListener(window.__saveToThymerListener);
  }

  // Constants
  const PLACEHOLDER_PATTERN =
    /placeholder|spinner|spacer|pixel|1x1|avatar|icon|logo|badge|button|data:image/i;
  const YOUTUBE_PATTERN = /youtube\.com|youtu\.be/;
  const REMOVE_SELECTORS =
    'script,style,nav,footer,header,aside,noscript,[role="navigation"],[role="banner"],[role="contentinfo"],.nav,.navbar,.footer,.header,.sidebar,.menu,.ad,.ads,.advertisement,.social-share,.share-buttons,.comments,#comments,.related-posts,.recommended,form,iframe,svg,button,.button,[hidden],[aria-hidden="true"]';

  // Message handler
  window.__saveToThymerListener = (msg, sender, respond) => {
    if (msg.type === "PING") {
      respond({ pong: true });
      return true;
    }
    if (msg.type === "GET_PAGE_DATA") {
      respond(extractPageData());
      return true;
    }
  };
  chrome.runtime.onMessage.addListener(window.__saveToThymerListener);

  // ============================================================================
  // PAGE DATA EXTRACTION
  // ============================================================================

  function extractPageData() {
    const videoPoster = getVideoPoster();
    const ogImage =
      getMeta("og:image") ||
      getMeta("twitter:image") ||
      getMeta("og:image:secure_url") ||
      videoPoster;
    // For YouTube, prioritize document.title as it updates immediately during SPA navigation
    const title = isYouTube()
      ? document.title || getMeta("og:title") || getMeta("twitter:title") || ""
      : getMeta("og:title") || getMeta("twitter:title") || document.title || "";

    return {
      title: stripNotificationPrefix(title),
      url: location.href,
      description: getMeta("og:description") || getMeta("description") || "",
      ogImage: isYouTube() ? getYouTubeThumbnail() : ogImage,
      images: getPageImages(ogImage),
      bodyMarkdown: extractBodyMarkdown(),
    };
  }

  function getVideoPoster() {
    const video = document.querySelector(
      'article video[poster], div[role="dialog"] video[poster], main video[poster], video[poster]',
    );
    return video?.getAttribute("poster") || null;
  }

  function getMeta(name) {
    return (
      document
        .querySelector(`meta[property="${name}"], meta[name="${name}"]`)
        ?.getAttribute("content") || null
    );
  }

  function stripNotificationPrefix(title) {
    if (!title) return "";
    return String(title)
      .replace(/^(?:\s*(?:\(\d+\)|\[\d+\]))+\s*/, "")
      .trim();
  }

  // ============================================================================
  // IMAGE EXTRACTION
  // ============================================================================

  function getPageImages(ogImage) {
    const images = new Set();
    if (ogImage) images.add(ogImage);

    // Collect video posters (e.g. Instagram Reels, video posts)
    document.querySelectorAll("video[poster]").forEach((vid) => {
      const poster = vid.getAttribute("poster");
      if (poster && !isPlaceholder(poster)) {
        try {
          images.add(new URL(poster, location.href).href);
        } catch (e) {}
      }
    });

    document.querySelectorAll("img").forEach((img) => {
      const src = getBestImageSrc(img);
      if (!src || isPlaceholder(src)) return;

      // Skip small images unless they're lazy-loaded (placeholder dimensions)
      if (img.naturalWidth && img.naturalWidth < 100) {
        const isLazy =
          img.classList.contains("lazy") ||
          img.classList.contains("lazyload") ||
          img.classList.contains("lazyloaded") ||
          img.classList.contains("loaded") ||
          img.hasAttribute("data-src");
        if (!isLazy) return;
      }

      try {
        images.add(new URL(src, location.href).href);
      } catch (e) {
        console.error("[SaveToThymer] Failed to parse image URL", e);
      }
    });

    return [...images].slice(0, 20);
  }

  function getBestImageSrc(img) {
    // Priority order:
    // 1. srcset/data-srcset (parse for largest)
    // 2. data-* attributes (lazy loading)
    // 3. src attribute

    // 1. Check srcset first - get the largest image
    const srcset =
      img.getAttribute("srcset") || img.getAttribute("data-srcset");
    if (srcset) {
      const largest = parseSrcset(srcset);
      if (largest) return largest;
    }

    // 2. Check lazy-loading data attributes
    const lazyAttrs = [
      "data-src",
      "data-lazy-src",
      "data-original",
      "data-lazy",
      "data-ll-src",
      "data-large_image",
      "data-full-url",
      "data-zoom-image",
    ];
    for (const attr of lazyAttrs) {
      const val = img.getAttribute(attr);
      if (val && !val.startsWith("data:")) return val;
    }

    // 3. Fall back to src
    if (img.src && !img.src.startsWith("data:")) return img.src;

    return null;
  }

  function parseSrcset(srcset) {
    // Parse srcset and return the URL of the largest image
    let best = null;
    let bestWidth = 0;

    srcset.split(",").forEach((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (parts.length < 1) return;

      const url = parts[0];
      if (!url || url.startsWith("data:")) return;

      // Parse descriptor (e.g., "1024w" or "2x")
      let width = 0;
      if (parts[1]) {
        const wMatch = parts[1].match(/(\d+)w/);
        const xMatch = parts[1].match(/(\d+(?:\.\d+)?)x/);
        if (wMatch) width = parseInt(wMatch[1], 10);
        else if (xMatch) width = parseFloat(xMatch[1]) * 1000; // treat 2x as 2000
      }

      if (width > bestWidth || (!best && url)) {
        best = url;
        bestWidth = width;
      }
    });

    return best;
  }

  function isPlaceholder(src) {
    if (!src || src.startsWith("data:")) return true;
    return PLACEHOLDER_PATTERN.test(src);
  }

  // ============================================================================
  // YOUTUBE HANDLING
  // ============================================================================

  function isYouTube() {
    return YOUTUBE_PATTERN.test(location.hostname);
  }

  function getYouTubeThumbnail() {
    const videoId =
      new URLSearchParams(location.search).get("v") ||
      location.pathname.match(/^\/([a-zA-Z0-9_-]{11})/)?.[1] ||
      location.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/)?.[1];
    return videoId
      ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
      : getMeta("og:image");
  }

  // ============================================================================
  // MARKDOWN EXTRACTION
  // ============================================================================

  function findMainContent() {
    const selectors = [
      "article",
      '[role="main"]',
      '[itemprop="articleBody"]',
      "main",
      ".post-content",
      ".entry-content",
      ".article-content",
      ".article-body",
      ".post-body",
      ".content-body",
      "#content",
      ".content",
      ".post",
      ".entry",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 200) return el;
    }

    return findByTextDensity() || document.body;
  }

  function findByTextDensity() {
    let best = null,
      bestScore = 0;

    document.querySelectorAll("div, section").forEach((el) => {
      if (el.closest("nav, header, footer, aside, .sidebar, .menu, .nav"))
        return;
      const text = el.textContent || "";
      const links = el.querySelectorAll("a").length;
      const paragraphs = el.querySelectorAll("p").length;
      if (paragraphs < 2) return;

      const score = (text.length / (links + 1)) * paragraphs;
      if (score > bestScore && text.length > 500) {
        bestScore = score;
        best = el;
      }
    });
    return best;
  }

  function extractBodyMarkdown() {
    const content = findMainContent();
    const clone = content.cloneNode(true);

    // Remove non-content elements
    clone.querySelectorAll(REMOVE_SELECTORS).forEach((el) => el.remove());

    // Remove hidden elements
    clone.querySelectorAll("*").forEach((el) => {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden")
          el.remove();
      } catch {}
    });

    return convertToMarkdown(clone);
  }

  function convertToMarkdown(element) {
    function process(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.replace(/\s+/g, " ").trim();
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";

      const tag = node.tagName.toLowerCase();
      const children = [...node.childNodes]
        .map(process)
        .filter(Boolean)
        .join("");
      if (!children && !["img", "br", "hr"].includes(tag)) return "";

      switch (tag) {
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6":
          return (
            "\n" +
            "#".repeat(parseInt(tag[1], 10)) +
            " " +
            children.trim() +
            "\n\n"
          );
        case "p":
          return children.trim() + "\n\n";
        case "br":
          return "\n";
        case "hr":
          return "\n---\n\n";
        case "strong":
        case "b":
          return `**${children}**`;
        case "em":
        case "i":
          return `*${children}*`;
        case "code":
          return `\`${children}\``;
        case "pre":
          const lang =
            node
              .querySelector("code")
              ?.className?.match(/language-(\w+)/)?.[1] || "";
          return "\n```" + lang + "\n" + node.textContent.trim() + "\n```\n\n";
        case "blockquote":
          return "\n> " + children.trim().replace(/\n/g, "\n> ") + "\n\n";
        case "a":
          const href = node.getAttribute("href");
          if (
            href &&
            !href.startsWith("#") &&
            !href.startsWith("javascript:")
          ) {
            try {
              return `[${children}](${new URL(href, location.href).href})`;
            } catch {}
          }
          return children;
        case "img":
          const src = getBestImageSrc(node);
          if (!src || isPlaceholder(src)) return "";
          try {
            return `![${node.getAttribute("alt") || ""}](${new URL(src, location.href).href})\n\n`;
          } catch {}
          return "";
        case "ul":
          return (
            "\n" +
            [...node.children]
              .map(
                (li) =>
                  "- " +
                  [...li.childNodes]
                    .map(process)
                    .filter(Boolean)
                    .join("")
                    .trim(),
              )
              .join("\n") +
            "\n\n"
          );
        case "ol":
          return (
            "\n" +
            [...node.children]
              .map(
                (li, i) =>
                  `${i + 1}. ` +
                  [...li.childNodes]
                    .map(process)
                    .filter(Boolean)
                    .join("")
                    .trim(),
              )
              .join("\n") +
            "\n\n"
          );
        case "li":
          return children;
        case "figure":
          return [...node.childNodes].map(process).filter(Boolean).join("");
        case "figcaption":
          return "*" + children.trim() + "*\n\n";
        default:
          return children;
      }
    }

    return process(element)
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s+|\s+$/g, "")
      .slice(0, 50000);
  }
})();
