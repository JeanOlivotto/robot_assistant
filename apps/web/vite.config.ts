import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Em dev, o Vite (5173) repassa a API e o WebSocket para o gateway (8080).
// Em produção o próprio gateway serve o dist/.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/app': { target: 'ws://localhost:8080', ws: true },
      '/api': 'http://localhost:8080',
    },
  },
});
