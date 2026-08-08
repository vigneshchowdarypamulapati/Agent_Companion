import '@testing-library/jest-dom/vitest';

// Ensure localStorage is available and has the clear method
if (typeof localStorage === 'undefined' || !localStorage.clear) {
  const storage: Record<string, string> = {};

  const mockStorage = {
    getItem: (key: string) => storage[key] || null,
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
    clear: () => {
      Object.keys(storage).forEach(key => {
        delete storage[key];
      });
    },
    key: (index: number) => {
      const keys = Object.keys(storage);
      return keys[index] || null;
    },
    get length() {
      return Object.keys(storage).length;
    },
  };

  Object.defineProperty(window, 'localStorage', {
    value: mockStorage,
    writable: true,
  });
}
