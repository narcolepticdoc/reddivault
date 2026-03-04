// background.js - handles alarms for scheduled sync (optional)
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'scheduled-sync') {
    // Could trigger a background sync here in future versions
    console.log('RedditVault: Scheduled sync alarm fired');
  }
});
