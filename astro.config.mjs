import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';

export default defineConfig({
  output: 'static',          // pages static by default; API routes opt-in with prerender = false
  adapter: vercel(),
  integrations: [tailwind()],
});
