(function () {
  if (window.__saveToThymerBridge) return;
  window.__saveToThymerBridge = true;

  const pending = new Map();
  let msgId = 0;

  const VALID_TYPES = [
    "THYMER_PING",
    "THYMER_GET_COLLECTIONS",
    "THYMER_GET_COLLECTION_FIELDS",
    "THYMER_SAVE_RECORD",
    "THYMER_GET_TEMPLATES",
    "THYMER_SAVE_TEMPLATES",
    "THYMER_GET_PLUGIN_CONFIG",
    "THYMER_SAVE_PLUGIN_CONFIG",
  ];

  const targetOrigin = window.location.origin;

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.source !== "save-to-thymer") return;
    if (!VALID_TYPES.includes(msg.type)) {
      respond({ error: "Unknown message type" });
      return true;
    }
    const id = `stt-${++msgId}`;
    const timeout = msg.type === "THYMER_PING" ? 2000 : 5000;
    pending.set(id, {
      respond,
      timer: setTimeout(() => {
        pending.delete(id);
        respond({ error: "Timeout" });
      }, timeout),
    });
    window.postMessage(
      {
        type: msg.type,
        messageId: id,
        payload: msg.payload,
        collectionGuid: msg.collectionGuid,
        source: "save-to-thymer-bridge",
      },
      targetOrigin,
    );
    return true;
  });

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "thymer-plugin-stt") return;
    const req = pending.get(e.data.messageId);
    if (req) {
      clearTimeout(req.timer);
      req.respond(e.data.response);
      pending.delete(e.data.messageId);
    }
  });
})();
