import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';

export default defineConfig({
  output: 'hybrid',          // pages static by default; API routes are serverless
  adapter: vercel(),
  integrations: [tailwind()],
});
