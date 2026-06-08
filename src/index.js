import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const server = createServer(config);

server.listen(config.server.port, config.server.host, () => {
  console.log(`[doc-gateway] listening on ${config.server.host}:${config.server.port}`);
  console.log(`[doc-gateway] model=${config.gateway.model} accounts=${config.mineru.accounts.length}`);
});
