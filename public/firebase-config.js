// Paste the config from Firebase console → Project settings → Your apps → Web app.
// These values are not secrets; access is controlled by firestore.rules and storage.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyBL1NsArz0K-1lQUAQjgPNAw31HmA-2ijs",
  authDomain: "yarddex-6150d.firebaseapp.com",
  projectId: "yarddex-6150d",
  storageBucket: "yarddex-6150d.firebasestorage.app",
  messagingSenderId: "146622436381",
  appId: "1:146622436381:web:191df5576717ab75a4a2f4",
};
// Must match the region in functions/index.js
export const functionsRegion = "us-east1";
// Leave false. Only for testing on your own computer with `firebase emulators:start`.
export const useEmulators = false;
