// Bridge script injected into the Thymer web app WebView
(function () {
  if (window.__saveToThymerBridgeAndroid) return;
  window.__saveToThymerBridgeAndroid = true;

  console.log("[SaveToThymerAndroid] Injected thymer-bridge-android.js successfully");

  // Listen for custom events dispatched by the Android app
  window.addEventListener('message-from-android', function(e) {
    const msg = e.detail;
    console.log("[SaveToThymerAndroid] Received message from Android app: " + JSON.stringify(msg));

    // Use "*" to avoid early page-load origin checks matching issues
    window.postMessage({
      type: msg.type,
      messageId: msg.messageId,
      payload: msg.payload,
      collectionGuid: msg.collectionGuid,
      source: "save-to-thymer-bridge"
    }, window.location.origin);
  });

  // Listen for postMessages sent by the Thymer plugin
  window.addEventListener("message", function(e) {
    if (e.source !== window || e.data?.source !== "thymer-plugin-stt") return;

    console.log("[SaveToThymerAndroid] Received response from Thymer plugin: " + JSON.stringify(e.data));

    // Forward the response back to Android
    if (window.AndroidThymerBridge && window.AndroidThymerBridge.postResponseToApp) {
      window.AndroidThymerBridge.postResponseToApp(e.data.messageId, JSON.stringify(e.data.response));
    } else {
      console.error("[SaveToThymerAndroid] AndroidThymerBridge not found in window!");
    }
  });
})();
