import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";
import type { SymbolSkeletonItem } from "./skeleton.ts";

type SupportedLanguage = "python" | "go" | "rust";
type SyntaxNode = Parser.SyntaxNode;

const EXTENSION_LANGUAGE: Readonly<Record<string, SupportedLanguage>> = {
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

let parserInitPromise: Promise<void> | null = null;

/**
 * Languages are memoized by grammar path (one path per language in normal use).
 * Keying on the path keeps NYXOWL_GRAMMARS_DIR overrides isolated instead of
 * serving a grammar loaded from a previous directory.
 */
const languageCache = new Map<string, Promise<Parser.Language | null>>();

function findPackageRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveGrammarPath(language: SupportedLanguage): string | null {
  const envDir = process.env["NYXOWL_GRAMMARS_DIR"];
  if (envDir && envDir.trim().length > 0) {
    return path.join(envDir.trim(), `tree-sitter-${language}.wasm`);
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = findPackageRoot(moduleDir);
  if (!packageRoot) return null;
  return path.join(packageRoot, "data", "grammars", `tree-sitter-${language}.wasm`);
}

async function ensureParserInit(): Promise<void> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init();
  }
  await parserInitPromise;
}

function loadLanguage(grammarPath: string): Promise<Parser.Language | null> {
  const cached = languageCache.get(grammarPath);
  if (cached) return cached;

  const loading = Parser.Language.load(grammarPath).catch(() => null);
  languageCache.set(grammarPath, loading);
  return loading;
}

function compactSignature(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

function sourceSignature(
  sourceText: string,
  node: SyntaxNode,
  bodyStartIndex: number,
): string {
  return compactSignature(sourceText.slice(node.startIndex, bodyStartIndex));
}

function bodyStart(node: SyntaxNode, fallbackIndex = node.endIndex): number {
  return node.childForFieldName("body")?.startIndex ?? fallbackIndex;
}

function lineRange(node: SyntaxNode): { startLine: number; endLine: number } {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function unwrapPythonDefinition(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "class_definition" || node.type === "function_definition") {
    return node;
  }
  if (node.type !== "decorated_definition") return null;
  const explicit = node.childForFieldName("definition");
  if (explicit) return explicit;
  return (
    node.namedChildren.find(
      (child) =>
        child.type === "class_definition" || child.type === "function_definition",
    ) ?? null
  );
}

function extractPython(root: SyntaxNode, sourceText: string): SymbolSkeletonItem[] {
  const symbols: SymbolSkeletonItem[] = [];

  const visit = (node: SyntaxNode, enclosingClass: string | null): void => {
    const definition = unwrapPythonDefinition(node);
    if (definition) {
      const nameNode = definition.childForFieldName("name");
      if (!nameNode) {
        for (const child of definition.namedChildren) visit(child, null);
        return;
      }

      const simpleName = nameNode.text;
      const range = lineRange(definition);
      const signature = sourceSignature(sourceText, definition, bodyStart(definition));

      if (definition.type === "class_definition") {
        symbols.push({
          name: simpleName,
          kind: "class",
          signature,
          ...range,
          exported: !simpleName.startsWith("_"),
        });
        const body = definition.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) visit(child, simpleName);
        }
        return;
      }

      const isMethod = enclosingClass !== null;
      symbols.push({
        name: isMethod ? `${enclosingClass}.${simpleName}` : simpleName,
        kind: isMethod ? "method" : "function",
        signature,
        ...range,
        exported: !simpleName.startsWith("_"),
      });

      // Nested functions are not methods of the enclosing class, so descend
      // without an enclosing-class context.
      const body = definition.childForFieldName("body");
      if (body) {
        for (const child of body.namedChildren) visit(child, null);
      }
      return;
    }

    for (const child of node.namedChildren) visit(child, enclosingClass);
  };

  for (const child of root.namedChildren) visit(child, null);
  return symbols;
}

function goReceiverTypeName(receiver: SyntaxNode): string {
  const declaration = receiver.namedChildren.find(
    (child) => child.type === "parameter_declaration",
  );
  const typeNode = declaration?.childForFieldName("type");
  let name = (typeNode?.text ?? receiver.text).trim();

  if (name.startsWith("*")) name = name.slice(1);
  if (name.startsWith("(") && name.endsWith(")")) name = name.slice(1, -1);
  const genericStart = name.indexOf("[");
  if (genericStart >= 0) name = name.slice(0, genericStart);
  const pathSeparator = name.lastIndexOf("/");
  if (pathSeparator >= 0) name = name.slice(pathSeparator + 1);
  const packageSeparator = name.lastIndexOf(".");
  if (packageSeparator >= 0) name = name.slice(packageSeparator + 1);
  return name.trim();
}

function extractGo(root: SyntaxNode, sourceText: string): SymbolSkeletonItem[] {
  const symbols: SymbolSkeletonItem[] = [];

  const visit = (node: SyntaxNode): void => {
    if (node.type === "function_declaration" || node.type === "method_declaration") {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;

      const simpleName = nameNode.text;
      const isMethod = node.type === "method_declaration";
      const receiver = isMethod ? node.childForFieldName("receiver") : null;
      const receiverType = receiver ? goReceiverTypeName(receiver) : "";
      symbols.push({
        name: isMethod && receiverType ? `${receiverType}.${simpleName}` : simpleName,
        kind: isMethod ? "method" : "function",
        signature: sourceSignature(sourceText, node, bodyStart(node)),
        ...lineRange(node),
        exported: /^[A-Z]/.test(simpleName),
      });
      return;
    }

    if (node.type === "type_declaration") {
      for (const declaration of node.namedChildren) {
        if (declaration.type !== "type_spec") continue;
        const typeNode = declaration.childForFieldName("type");
        if (!typeNode) continue;
        if (typeNode.type !== "struct_type" && typeNode.type !== "interface_type") {
          continue;
        }
        const nameNode = declaration.childForFieldName("name");
        if (!nameNode) continue;

        // A grouped `type (...)` declaration holds several specs; everything
        // below must come from this spec so each gets its own signature and
        // line range instead of the first spec / the whole group.
        const braceOffset = declaration.text.indexOf("{");
        const endIndex =
          braceOffset >= 0 ? declaration.startIndex + braceOffset : declaration.endIndex;
        const kindWord = typeNode.type === "interface_type" ? "interface" : "struct";
        const simpleName = nameNode.text;
        symbols.push({
          name: simpleName,
          kind: kindWord,
          signature: compactSignature(
            `type ${sourceSignature(sourceText, declaration, endIndex)}`,
          ),
          ...lineRange(declaration),
          exported: /^[A-Z]/.test(simpleName),
        });
      }
      return;
    }

    for (const child of node.namedChildren) visit(child);
  };

  for (const child of root.namedChildren) visit(child);
  return symbols;
}

function hasPubVisibility(node: SyntaxNode): boolean {
  return node.children.some(
    (child) =>
      child.type === "visibility_modifier" && child.text.trimStart().startsWith("pub"),
  );
}

function rustOwnerName(typeText: string): string {
  let owner = typeText.trim();
  const genericStart = owner.indexOf("<");
  if (genericStart >= 0) owner = owner.slice(0, genericStart);
  owner = owner.replace(/\s+/g, "");
  const pathSeparator = owner.lastIndexOf("::");
  if (pathSeparator >= 0) owner = owner.slice(pathSeparator + 2);
  return owner;
}

function extractRust(root: SyntaxNode, sourceText: string): SymbolSkeletonItem[] {
  const symbols: SymbolSkeletonItem[] = [];

  const visit = (node: SyntaxNode, implOwner: string | null): void => {
    if (node.type === "impl_item") {
      const typeNode = node.childForFieldName("type");
      const owner = typeNode ? rustOwnerName(typeNode.text) : null;
      const body = node.childForFieldName("body");
      if (body) {
        for (const child of body.namedChildren) visit(child, owner);
      }
      return;
    }

    if (node.type === "function_item") {
      const nameNode = node.childForFieldName("name");
      const simpleName = nameNode?.text;
      if (!simpleName) return;

      const isMethod = implOwner !== null && implOwner.length > 0;
      symbols.push({
        name: isMethod ? `${implOwner}.${simpleName}` : simpleName,
        kind: isMethod ? "method" : "function",
        signature: sourceSignature(sourceText, node, bodyStart(node)),
        ...lineRange(node),
        exported: hasPubVisibility(node),
      });

      const body = node.childForFieldName("body");
      if (body) {
        for (const child of body.namedChildren) visit(child, null);
      }
      return;
    }

    if (
      node.type === "struct_item" ||
      node.type === "enum_item" ||
      node.type === "trait_item" ||
      node.type === "type_item"
    ) {
      const nameNode = node.childForFieldName("name");
      const simpleName = nameNode?.text;
      if (!simpleName) return;

      const kind: SymbolSkeletonItem["kind"] =
        node.type === "struct_item"
          ? "struct"
          : node.type === "enum_item"
            ? "enum"
            : node.type === "trait_item"
              ? "interface"
              : "type";
      symbols.push({
        name: simpleName,
        kind,
        signature: sourceSignature(sourceText, node, bodyStart(node)),
        ...lineRange(node),
        exported: hasPubVisibility(node),
      });
      return;
    }

    for (const child of node.namedChildren) visit(child, implOwner);
  };

  for (const child of root.namedChildren) visit(child, null);
  return symbols;
}

/**
 * Extracts a symbol skeleton for Python, Go, and Rust using tree-sitter WASM
 * grammars. Returns null when the grammar is unavailable or parsing fails;
 * callers are expected to fall back to the legacy regex outline.
 */
export async function extractWasmSkeleton(
  filePath: string,
  sourceText: string,
): Promise<SymbolSkeletonItem[] | null> {
  const extension = path.extname(filePath).toLowerCase();
  const language = EXTENSION_LANGUAGE[extension];
  if (!language) return null;

  const grammarPath = resolveGrammarPath(language);
  if (!grammarPath || !fs.existsSync(grammarPath)) return null;

  let parser: Parser | null = null;
  let tree: Parser.Tree | null = null;
  try {
    await ensureParserInit();
    const loadedLanguage = await loadLanguage(grammarPath);
    if (!loadedLanguage) return null;

    parser = new Parser();
    parser.setLanguage(loadedLanguage);
    tree = parser.parse(sourceText);
    if (!tree) return null;

    if (language === "python") return extractPython(tree.rootNode, sourceText);
    if (language === "go") return extractGo(tree.rootNode, sourceText);
    return extractRust(tree.rootNode, sourceText);
  } catch {
    return null;
  } finally {
    tree?.delete();
    parser?.delete();
  }
}
