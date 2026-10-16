import { defineConfig } from "vite";
import { drawdyExtension } from "./vite-plugin-drawdy";

export default defineConfig({
    appType: "custom",
    server: {
        port: 5183,
        strictPort: true,
        // Drawdy reloads the driver on every rebuild and drops a live hunt, so only driver sources may trigger one.
        watch: { ignored: ["**/docs/**", "**/test/**", "**/server/**", "**/scripts/**", "**/*.test.ts", "**/dist/**"] },
    },
    plugins: [drawdyExtension()],
});
