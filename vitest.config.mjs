import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Chaque test démarre un vrai serveur et de vrais process enfants :
    // on laisse de la marge et on évite que deux fichiers se marchent dessus.
    testTimeout: process.env.CI ? 45000 : 20000,
    hookTimeout: process.env.CI ? 45000 : 20000,
    fileParallelism: false,
    include: ["tests/**/*.test.js"],
  },
});
