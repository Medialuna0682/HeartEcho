/** Static extraction only: never import or execute the application while linting. */
import { parse } from "espree";

export function embeddedUi(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", range: true });
  const declaration = ast.body
    .filter((node) => node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration")
    .flatMap((node) => node.declaration.declarations)
    .find((node) => node.id.name === "APP_JS");
  const init = declaration?.init;
  if (
    init?.type !== "TaggedTemplateExpression" ||
    init.tag.type !== "MemberExpression" ||
    init.tag.object.name !== "String" ||
    init.tag.property.name !== "raw" ||
    init.quasi.expressions.length
  ) {
    throw new Error(
      "APP_JS must be a static String.raw template; update the embedded UI tooling if its layout changes",
    );
  }
  const start = init.quasi.range[0] + 1;
  const end = init.quasi.range[1] - 1;
  const prefix = source.slice(0, start);
  return {
    text: source.slice(start, end),
    start,
    end,
    lineOffset: prefix.split("\n").length - 1,
    columnOffset: start - prefix.lastIndexOf("\n") - 1,
  };
}

const blocks = new Map();
export const panelProcessor = {
  meta: { name: "heartecho-embedded-panel", version: "1.0.0" },
  supportsAutofix: true,
  preprocess(source, filename) {
    const block = embeddedUi(source);
    blocks.set(filename, block);
    return [source, { text: block.text, filename: "panel.browser.js" }];
  },
  postprocess([outer = [], browser = []], filename) {
    const block = blocks.get(filename);
    blocks.delete(filename);
    const fix = (item) => {
      if (!item || /`|\$\{/.test(item.text)) return undefined;
      return { ...item, range: item.range.map((offset) => offset + block.start) };
    };
    return [
      ...outer,
      ...browser.map((message) => ({
        ...message,
        line: message.line + block.lineOffset,
        column: message.column + (message.line === 1 ? block.columnOffset : 0),
        ...(message.endLine
          ? {
              endLine: message.endLine + block.lineOffset,
              endColumn: message.endColumn + (message.endLine === 1 ? block.columnOffset : 0),
            }
          : {}),
        fix: fix(message.fix),
        suggestions: message.suggestions
          ?.map((suggestion) => ({ ...suggestion, fix: fix(suggestion.fix) }))
          .filter((suggestion) => suggestion.fix),
      })),
    ];
  },
};
