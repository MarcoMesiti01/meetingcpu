import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createTranscriptionClient } from "./transcriptionClient.js";

const config = loadConfig();
const app = createApp({
  dataRoot: config.dataRoot,
  transcriptionClient: createTranscriptionClient(config.transcriptionServiceUrl)
});

app.listen(config.port, config.host, () => {
  console.log(`meetingcpu API listening on http://${config.host}:${config.port}`);
});
