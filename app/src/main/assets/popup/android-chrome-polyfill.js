// Polyfill for Chrome Extension API inside Android WebView
(function() {
  if (window.chrome && window.chrome.storage) return;

  window.chrome = {
    runtime: {
      onMessage: {
        addListener: function(listener) {
          window.__runtimeMessageListener = listener;
        },
        removeListener: function(listener) {
          window.__runtimeMessageListener = null;
        }
      },
      sendMessage: function(message, responseCallback) {
        // No-op for runtime messaging in Android
        if (responseCallback) responseCallback();
        return Promise.resolve();
      }
    },

    storage: {
      local: {
        get: function(keys, callback) {
          return new Promise((resolve) => {
            const result = {};
            if (!window.AndroidStorageBridge) {
              if (callback) callback(result);
              resolve(result);
              return;
            }

            if (typeof keys === 'string') {
              const val = window.AndroidStorageBridge.getLocal(keys);
              result[keys] = val ? JSON.parse(val) : undefined;
            } else if (Array.isArray(keys)) {
              keys.forEach(key => {
                const val = window.AndroidStorageBridge.getLocal(key);
                result[key] = val ? JSON.parse(val) : undefined;
              });
            } else if (typeof keys === 'object' && keys !== null) {
              for (const [key, defaultVal] of Object.entries(keys)) {
                const val = window.AndroidStorageBridge.getLocal(key);
                result[key] = val ? JSON.parse(val) : defaultVal;
              }
            }
            if (callback) callback(result);
            resolve(result);
          });
        },
        set: function(items, callback) {
          return new Promise((resolve) => {
            if (window.AndroidStorageBridge) {
              for (const [key, val] of Object.entries(items)) {
                window.AndroidStorageBridge.setLocal(key, JSON.stringify(val));
              }
            }
            if (callback) callback();
            resolve();
          });
        },
        remove: function(keys, callback) {
          return new Promise((resolve) => {
            if (window.AndroidStorageBridge) {
              const keysArr = Array.isArray(keys) ? keys : [keys];
              keysArr.forEach(key => {
                window.AndroidStorageBridge.removeLocal(key);
              });
            }
            if (callback) callback();
            resolve();
          });
        }
      },
      sync: {
        get: function(keys, callback) {
          return window.chrome.storage.local.get(keys, callback);
        },
        set: function(items, callback) {
          return window.chrome.storage.local.set(items, callback);
        },
        remove: function(keys, callback) {
          return window.chrome.storage.local.remove(keys, callback);
        }
      }
    },

    tabs: {
      query: function(queryInfo, callback) {
        return new Promise((resolve) => {
          const url = window.AndroidPageBridge ? window.AndroidPageBridge.getSharedUrl() : '';
          const title = window.AndroidPageBridge ? window.AndroidPageBridge.getSharedTitle() : 'Untitled';
          const tab = {
            id: 1,
            url: url,
            title: title,
            windowId: 1
          };
          const tabs = [tab];
          if (callback) callback(tabs);
          resolve(tabs);
        });
      },

      sendMessage: function(tabId, message, responseCallback) {
        // Intercept GET_PAGE_DATA to perform client-side scraping of the shared URL
        if (message.type === "GET_PAGE_DATA") {
          return new Promise(async (resolve) => {
            const url = window.AndroidPageBridge ? window.AndroidPageBridge.getSharedUrl() : '';
            const title = window.AndroidPageBridge ? window.AndroidPageBridge.getSharedTitle() : 'Untitled';
            
            const files = window.AndroidPageBridge && window.AndroidPageBridge.getSharedFilesJson 
              ? JSON.parse(window.AndroidPageBridge.getSharedFilesJson()) 
              : [];

            function getFriendlyTitle(urlStr, currentTitle) {
              if (!currentTitle || currentTitle === "Shared Link" || currentTitle === "Untitled") {
                try {
                  const u = new URL(urlStr);
                  if (u.hostname.includes("facebook.com") || u.hostname.includes("fb.watch") || u.hostname.includes("fb.com")) return "Facebook Post";
                  if (u.hostname.includes("instagram.com")) return "Instagram Post";
                  if (u.hostname.includes("twitter.com") || u.hostname.includes("x.com")) return "Tweet";
                  if (u.hostname.includes("linkedin.com")) return "LinkedIn Post";
                  if (u.hostname.includes("tiktok.com")) return "TikTok Video";
                  if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) return "YouTube Video";
                } catch (e) {}
              }
              return currentTitle;
            }

            const isBlockedDomain = url.includes("instagram.com") || 
                                    url.includes("facebook.com") || 
                                    url.includes("fb.watch") || 
                                    url.includes("fb.com") || 
                                    url.includes("twitter.com") || 
                                    url.includes("x.com") || 
                                    url.includes("linkedin.com") || 
                                    url.includes("tiktok.com");

            if (!url || url.startsWith("file://") || isBlockedDomain) {
              const friendlyTitle = getFriendlyTitle(url || '', title);
              const defaultData = { title: friendlyTitle, url: url || '', description: '', ogImage: '', images: [], bodyMarkdown: '', files: files };
              if (responseCallback) responseCallback(defaultData);
              resolve(defaultData);
              return;
            }

            try {
              let fetchUrl = url;
              let canonicalUrl = url;
              const isReddit = url.includes("reddit.com");
              if (isReddit) {
                // Resolve Reddit's short /s links first, then ask vxreddit for the canonical post.
                try {
                  const resolveResponse = await fetch(url);
                  canonicalUrl = resolveResponse.url || url;
                } catch (e) {
                  console.warn("[SaveToThymerAndroid] Reddit canonical URL resolve failed, using shared URL", e);
                }
                fetchUrl = canonicalUrl.replace("reddit.com", "vxreddit.com");
              }
              console.log("[SaveToThymerAndroid] Fetching shared page HTML: " + fetchUrl);
              let response = await fetch(fetchUrl);
              
              if (isReddit && !response.ok) {
                console.warn("[SaveToThymerAndroid] vxreddit proxy failed (status " + response.status + "), falling back to canonical URL: " + canonicalUrl);
                fetchUrl = canonicalUrl;
                response = await fetch(fetchUrl);
              }
              
              const finalUrl = isReddit ? canonicalUrl : (response.url || url);
              const buffer = await response.arrayBuffer();
              const decoder = new TextDecoder("utf-8");
              const htmlText = decoder.decode(buffer);
 
              function getTitleFromUrlSlug(urlStr) {
                try {
                  const u = new URL(urlStr);
                  const segments = u.pathname.split('/').filter(Boolean);
                  if (segments.length === 0) return null;
                  
                  // Specific parser for Reddit posts
                  if (u.hostname.includes("reddit.com")) {
                    const idx = segments.indexOf("comments");
                    if (idx !== -1 && segments[idx + 2]) {
                      let t = segments[idx + 2].replace(/[-_]+/g, ' ').trim();
                      if (t.length > 0) {
                        t = t.charAt(0).toUpperCase() + t.slice(1);
                      }
                      return t;
                    }
                  }

                  let slug = segments[segments.length - 1];
                  for (let i = segments.length - 1; i >= 0; i--) {
                    const seg = segments[i];
                    if (seg.includes('-') || seg.includes('_') || (seg.length > 8 && !/^[0-9]+$/.test(seg))) {
                      slug = seg;
                      break;
                    }
                  }
                  if (!slug) return null;
                  let t = slug.replace(/[-_]+/g, ' ').trim();
                  if (t.length > 0) {
                    t = t.charAt(0).toUpperCase() + t.slice(1);
                  }
                  return t;
                } catch (e) {
                  return null;
                }
              }

              if (window.extractPageDataFromHtml) {
                const data = window.extractPageDataFromHtml(htmlText, finalUrl);
                
                // Ensure we never return a vxreddit proxy URL to the user
                if (data.url && data.url.includes("vxreddit.com")) {
                  data.url = data.url.replace("vxreddit.com", "reddit.com");
                }
                
                const titleLower = data.title ? data.title.toLowerCase() : "";
                const isBlockedTitle = !data.title ||
                  titleLower.includes("please wait for verification") ||
                  titleLower.includes("cloudflare") ||
                  titleLower.includes("attention required") ||
                  titleLower.includes("internal server error") ||
                  titleLower.includes("500 internal") ||
                  titleLower.includes("404 not found") ||
                  titleLower === "instagram" ||
                  titleLower === "facebook" ||
                  titleLower === "reddit" ||
                  titleLower.includes("login") ||
                  titleLower.includes("log in") ||
                  titleLower.includes("error");
                
                if (isBlockedTitle) {
                  let fallbackTitle = "";
                  if (title && title !== "Shared Link" && title.trim().length > 0) {
                    // Clean up common app share prefixes/suffixes if present
                    let cleanTitle = title.replace(/^Check out this post on Reddit:\s*/i, "");
                    cleanTitle = cleanTitle.replace(/^Check out this post on Facebook:\s*/i, "");
                    cleanTitle = cleanTitle.replace(/\s*-\s*$/, "").trim();
                    fallbackTitle = cleanTitle;
                  } else {
                    const slugTitle = getTitleFromUrlSlug(finalUrl);
                    fallbackTitle = slugTitle || title || "Shared Link";
                  }
                  data.title = getFriendlyTitle(finalUrl, fallbackTitle);
                }

                data.files = files;
                console.log("[SaveToThymerAndroid] Scrape successful!", JSON.stringify(data));
                if (responseCallback) responseCallback(data);
                resolve(data);
              } else {
                throw new Error("extractPageDataFromHtml not defined");
              }
            } catch (e) {
              console.error("[SaveToThymerAndroid] Scrape failed, returning basic info", e);
              const defaultData = { title, url, description: '', ogImage: '', images: [], bodyMarkdown: '', files: files };
              if (responseCallback) responseCallback(defaultData);
              resolve(defaultData);
            }
          });
        }

        // Handle messaging to Thymer page (PING, SAVE_RECORD, GET_COLLECTIONS, etc.)
        if (message.source === "save-to-thymer") {
          return new Promise((resolve) => {
            const msgId = "msg-" + Math.random().toString(36).substr(2, 9);
            window.__pendingCallbacks = window.__pendingCallbacks || {};

            // Replicate extension timeouts (2s for PING, 15s for SAVE_RECORD to upload blobs, 5s for other operations)
            const timeoutMs =
              message.type === "THYMER_PING"
                ? 2000
                : message.type === "THYMER_SAVE_RECORD"
                  ? 15000
                  : 5000;
            const timer = setTimeout(() => {
              if (window.__pendingCallbacks?.[msgId]) {
                delete window.__pendingCallbacks[msgId];
                console.warn("[SaveToThymerAndroid] Message timeout:", message.type, msgId);
                const err = { error: "Timeout" };
                if (responseCallback) responseCallback(err);
                resolve(err);
              }
            }, timeoutMs);

            window.__pendingCallbacks[msgId] = (response) => {
              clearTimeout(timer);
              if (responseCallback) responseCallback(response);
              resolve(response);
            };

            if (window.AndroidThymerBridge) {
              window.AndroidThymerBridge.sendMessageToThymer(msgId, JSON.stringify(message));
            } else {
              clearTimeout(timer);
              delete window.__pendingCallbacks[msgId];
              console.error("[SaveToThymerAndroid] AndroidThymerBridge not available!");
              const err = { error: "Thymer bridge not available" };
              if (responseCallback) responseCallback(err);
              resolve(err);
            }
          });
        }

        return Promise.resolve();
      },

      captureVisibleTab: function(windowId, options, callback) {
        return new Promise(async (resolve) => {
          const url = window.AndroidPageBridge ? window.AndroidPageBridge.getSharedUrl() : '';
          
          let cb = callback;
          if (typeof options === 'function') {
            cb = options;
          }

          if (!url) {
            if (cb) cb("");
            resolve("");
            return;
          }

          const screenshotUrl = "https://image.thum.io/get/width/1024/crop/600/maxAge/24/" + encodeURIComponent(url);
          console.log("[SaveToThymerAndroid] captureVisibleTab fetching image: " + screenshotUrl);
          
          try {
            const response = await fetch(screenshotUrl);
            const blob = await response.blob();
            const reader = new FileReader();
            reader.onloadend = function() {
              const dataUri = reader.result;
              console.log("[SaveToThymerAndroid] captureVisibleTab converted to dataUri successfully");
              if (cb) cb(dataUri);
              resolve(dataUri);
            };
            reader.readAsDataURL(blob);
          } catch (e) {
            console.error("[SaveToThymerAndroid] captureVisibleTab failed to fetch/convert image", e);
            if (cb) cb("");
            resolve("");
          }
        });
      }
    },

    scripting: {
      executeScript: function(details, callback) {
        if (callback) callback();
        return Promise.resolve();
      }
    },

    windows: {
      update: function(windowId, updateInfo, callback) {
        // Triggers closing the share sheet or returning to previous app
        if (window.AndroidPageBridge) {
          if (window.AndroidPageBridge.triggerHapticFeedback) {
            window.AndroidPageBridge.triggerHapticFeedback();
          }
          window.AndroidPageBridge.closeApp();
        }
        if (callback) callback();
        return Promise.resolve();
      }
    }
  };

  // Called by Kotlin code when the background Thymer WebView receives a response
  window.receiveResponseFromThymer = function(msgId, responseJson) {
    console.log("[SaveToThymerAndroid] receiveResponseFromThymer", msgId, responseJson);
    const cb = window.__pendingCallbacks?.[msgId];
    if (cb) {
      cb(JSON.parse(responseJson));
      delete window.__pendingCallbacks[msgId];
    }
  };

  // Polyfill window.close to close the Android activity
  window.close = function() {
    console.log("[SaveToThymerAndroid] window.close called");
    if (window.AndroidPageBridge && window.AndroidPageBridge.closeApp) {
      if (window.AndroidPageBridge.triggerHapticFeedback) {
        window.AndroidPageBridge.triggerHapticFeedback();
      }
      window.AndroidPageBridge.closeApp();
    }
  };

  // Setup dynamic height reporting using ResizeObserver
  window.addEventListener('DOMContentLoaded', () => {
    if (window.AndroidPageBridge && window.AndroidPageBridge.updateHeight && typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
          const totalHeight = entry.target.offsetHeight;
          if (totalHeight > 0) {
            window.AndroidPageBridge.updateHeight(totalHeight);
          }
        }
      });
      // Observe the popup-container, or fallback to body
      const container = document.querySelector('.popup-container') || document.body;
      resizeObserver.observe(container);
    }
  });
})();
