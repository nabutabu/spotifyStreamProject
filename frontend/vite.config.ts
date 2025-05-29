import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// ✅ No tailwindcss() plugin here!
export default defineConfig({
  plugins: [react()],
})
