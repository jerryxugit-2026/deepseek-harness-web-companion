/**
 * Spike service worker: open the panel page once so the CDP driver can find it
 * without having to predict the unpacked extension id from the directory path.
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log(`[spike] installed id=${chrome.runtime.id}`)
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html'), active: true })
})

chrome.runtime.onStartup.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html'), active: true })
})
