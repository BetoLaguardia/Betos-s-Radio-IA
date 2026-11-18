import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { AdminProvider } from './context/AdminContext';
import './index.css';

// Prevent third-party browser extensions from throwing TypeErrors when monkeypatching window.fetch
try {
  const originalFetch = window.fetch;
  if (originalFetch) {
    Object.defineProperty(window, 'fetch', {
      value: originalFetch,
      writable: true,
      configurable: true,
    });
  }
} catch (err) {
  // Ignore property descriptor redefinition errors
}

createRoot(document.getElementById('root')!).render(
  <AdminProvider>
    <App />
  </AdminProvider>
);
