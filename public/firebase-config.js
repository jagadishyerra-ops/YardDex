// Paste the config from Firebase console → Project settings → Your apps → Web app.
// These values are not secrets; access is controlled by firestore.rules and storage.rules.
export const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.firebasestorage.app",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};
// Must match the region in functions/index.js
export const functionsRegion = "us-east1";
