import { test } from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";
import { parse } from "espree";
import { embeddedUi } from "./embedded-ui.mjs";
import { formatEmbeddedUi } from "./format-ui.mjs";

const filename = "lib/ui-app.mjs";
const wrap = (text) => "// fixture\nexport const APP_JS = String.raw`\n" + text + "\n`;\n";

test("lint sees browser code inside APP_JS and reports its original line", async () => {
  const source = wrap("document.title = missingPanelValue;\nconsole.log(ICONS);");
  const [result] = await new ESLint().lintText(source, { filePath: filename });
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0].ruleId, "no-undef");
  assert.equal(result.messages[0].line, 3);
  assert.match(result.messages[0].message, /missingPanelValue/);
});

test("browser virtual block cannot accidentally use Node globals", async () => {
  const [result] = await new ESLint().lintText(wrap("console.log(process.pid);"), { filePath: filename });
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0].ruleId, "no-undef");
  assert.match(result.messages[0].message, /process/);
});

test("outer module and browser block are both checked, including CRLF offsets", async () => {
  const source = ("const unusedOuter = 1;\n" + wrap("missingBrowserCall();")).replaceAll("\n", "\r\n");
  const [result] = await new ESLint().lintText(source, { filePath: filename });
  assert.equal(result.errorCount, 2);
  assert.deepEqual(
    result.messages.map((message) => message.line),
    [1, 4],
  );
});

test("lint:fix maps embedded fixes into the template, leaving its wrapper intact", async () => {
  const source = wrap("if (!!document.title) console.log(ICONS);");
  const [result] = await new ESLint({ fix: true }).lintText(source, { filePath: filename });
  assert.equal(result.errorCount, 0);
  assert.ok(result.output.startsWith("// fixture\nexport const APP_JS = String.raw`"));
  assert.ok(!embeddedUi(result.output).text.includes("!!document"));
  assert.ok(result.output.endsWith("\n`;\n"));
});

test("embedded formatting preserves JavaScript meaning and is idempotent", async () => {
  const source = wrap('const value={path:"C:\\\\fixture",text:"第一行\\n第二行"};console.log(value,ICONS);');
  const options = { printWidth: 120, embeddedLanguageFormatting: "off" };
  const output = await formatEmbeddedUi(source, options);
  const ast = (text) =>
    JSON.parse(
      JSON.stringify(parse(embeddedUi(text).text, { ecmaVersion: "latest" }), (key, value) =>
        ["start", "end", "raw"].includes(key) ? undefined : value,
      ),
    );
  assert.deepEqual(ast(output), ast(source));
  assert.equal(await formatEmbeddedUi(output, options), output);
});

test("a changed APP_JS wrapper fails explicitly rather than silently skipping the UI", () => {
  assert.throws(() => embeddedUi('export const APP_JS = "hidden code";'), /static String.raw/);
});
