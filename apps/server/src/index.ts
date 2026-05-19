import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createTranscriptionClient } from "./transcriptionClient.js";

const config = loadConfig();
const app = createApp({
  dataRoot: config.dataRoot,
  transcriptionClient: createTranscriptionClient(config.transcriptionServiceUrl)
});

app.listen(config.port, () => {
  console.log(`meetingcpu API listening on http://127.0.0.1:${config.port}`);
});
