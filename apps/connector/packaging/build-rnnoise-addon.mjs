import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRnnoiseNativeAddon } from "./rnnoiseNative.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const connectorDir = path.resolve(__dirname, "..");

buildRnnoiseNativeAddon(connectorDir);
