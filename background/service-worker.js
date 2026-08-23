console.log("[NightWatch] service worker started");

chrome.runtime.onInstalled.addListener(() => {
  console.log("[NightWatch] extension installed");
});
