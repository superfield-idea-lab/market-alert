/**
 * @file overview
 * This is the main entrypoint for the Calypso Bun server.
 * It is responsible for handling all incoming HTTP requests, routing them
 * to the appropriate integration or business logic modules, and serving
 * the compiled frontend React application from `apps/web/dist`.
 */

export default {
    port: 31415,

    /**
     * The core fetch handler for the Bun native HTTP server.
     * Currently, it serves the initial HTML stub to verify E2E testing.
     * 
     * @returns {Response} A unified response object containing the HTML document or API payload.
     */
    fetch() {
        return new Response(Bun.file("../web/dist/index.html"));
    },
};

console.log("Listening on http://localhost:31415");
