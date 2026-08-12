import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

// Firebaseコンソール > プロジェクト設定 > 全般 > マイアプリ に表示される値をここへ貼り付ける。
// これは公開クライアント向けの識別情報であり秘密鍵ではないため、リポジトリに含めてよい。
// アクセス制御はFirestoreのセキュリティルール側で行う。
const firebaseConfig = {
  apiKey: 'AIzaSyDJWV8pRr8jvbz3mZwMhB09xdppDm9Pk_8',
  authDomain: 'abyssal-watcher.firebaseapp.com',
  projectId: 'abyssal-watcher',
  storageBucket: 'abyssal-watcher.firebasestorage.app',
  messagingSenderId: '925104347027',
  appId: '1:925104347027:web:4f2ed30a63ffe49146ba66',
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
