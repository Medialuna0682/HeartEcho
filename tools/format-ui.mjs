import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { embeddedUi } from "./embedded-ui.mjs";

export async function formatEmbeddedUi(source, options = {}) {
  const block = embeddedUi(source);
  const formatted = "\n" + (await prettier.format(block.text, { ...options, parser: "babel" }));
  const output = source.slice(0, block.start) + formatted + source.slice(block.end);
  // Reject accidental template interpolation/backtick changes rather than emit broken source.
  embeddedUi(output);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL("../lib/ui-app.mjs", import.meta.url));
  const source = await fs.readFile(file, "utf8");
  const output = await formatEmbeddedUi(source, await prettier.resolveConfig(file));
  if (output !== source) {
    if (process.argv.includes("--write")) {
      await fs.writeFile(file, output);
      console.log("Formatted embedded panel JavaScript: lib/ui-app.mjs");
    } else {
      console.error("Embedded panel JavaScript needs formatting. Run npm run format.");
      process.exitCode = 1;
    }
  }
}
