import { createServer } from "./server";

const server = createServer();

console.log("[PASS Server] Started successfully.");
console.log("[PASS Server] Press Ctrl+C to stop.");

export { server };
