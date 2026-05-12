import { Plugin, TFile, TAbstractFile } from "obsidian";

// Parses `.typ` files for forward references and pushes them into
// `app.metadataCache.resolvedLinks` so graph view and the Backlinks
// pane include Typst files alongside Markdown notes.
//
// Recognized forward references:
//   #include "path.typ"
//   #import "path.typ": ...
//   #link("./path.typ")    (relative vault paths only)
//   @citationKey           (mapped to the .bib file that defines it)
export class MetadataIndexer {
  private plugin: Plugin;
  // citation key -> vault path of the .bib file defining it. Populated
  // by indexBib() and refreshed when any .bib changes. Used so that a
  // `@key` in a .typ source can be wired to its bib's graph node.
  private bibKeyToPath: Map<string, string> = new Map();

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  register(): void {
    const { vault } = this.plugin.app;

    const onTouch = async (file: TAbstractFile) => {
      if (!(file instanceof TFile)) return;
      if (file.extension === "bib") {
        await this.rebuildBibIndex();
        await this.indexFile(file);
        await this.reindexAllTyp();
      } else if (file.extension === "typ") {
        await this.indexFile(file);
      }
    };

    this.plugin.registerEvent(vault.on("modify", onTouch));
    this.plugin.registerEvent(vault.on("create", onTouch));
    this.plugin.registerEvent(
      vault.on("delete", async (file) => {
        this.removeFile(file.path);
        if (file instanceof TFile && file.extension === "bib") {
          await this.rebuildBibIndex();
          await this.reindexAllTyp();
        }
      }),
    );
    this.plugin.registerEvent(
      vault.on("rename", (file, oldPath) => {
        this.handleRename(file, oldPath);
      }),
    );
  }

  async indexAll(): Promise<void> {
    await this.rebuildBibIndex();
    const files = this.plugin.app.vault
      .getFiles()
      .filter((f) => f.extension === "typ" || f.extension === "bib");
    for (const file of files) {
      await this.indexFile(file);
    }
    this.plugin.app.metadataCache.trigger("resolved");
  }

  private async reindexAllTyp(): Promise<void> {
    const files = this.plugin.app.vault
      .getFiles()
      .filter((f) => f.extension === "typ");
    for (const file of files) {
      await this.indexFile(file);
    }
    this.plugin.app.metadataCache.trigger("resolved");
  }

  // Walk every .bib file and rebuild bibKeyToPath. Each entry header
  // matches `@<type>{<key>,` (case-insensitive type, alphanumeric +
  // `:-_.` in the key — typical BibTeX). When the same key appears in
  // multiple .bib files, the last one wins; that's a vault-organization
  // problem more than a plugin one.
  private async rebuildBibIndex(): Promise<void> {
    this.bibKeyToPath.clear();
    const bibFiles = this.plugin.app.vault
      .getFiles()
      .filter((f) => f.extension === "bib");
    const entryRe = /@\w+\s*\{\s*([A-Za-z0-9_:.\-]+)\s*,/g;
    for (const file of bibFiles) {
      const content = await this.plugin.app.vault.cachedRead(file);
      let m;
      while ((m = entryRe.exec(content)) !== null) {
        this.bibKeyToPath.set(m[1], file.path);
      }
    }
  }

  async indexFile(file: TFile): Promise<void> {
    const content = await this.plugin.app.vault.cachedRead(file);

    const resolved: Record<string, number> = {};
    const unresolved: Record<string, number> = {};

    if (file.extension === "typ") {
      for (const t of this.extractLinks(content, file.path)) {
        resolved[t] = (resolved[t] || 0) + 1;
      }
      for (const key of this.extractCitedKeys(content)) {
        unresolved[key] = (unresolved[key] || 0) + 1;
      }
    } else if (file.extension === "bib") {
      // The bib file itself "links to" each entry it defines, so the
      // entry node and the bib hub appear connected in the graph.
      for (const key of this.extractDefinedKeys(content)) {
        unresolved[key] = (unresolved[key] || 0) + 1;
      }
    }

    const cache = this.plugin.app.metadataCache as any;
    cache.resolvedLinks ??= {};
    cache.unresolvedLinks ??= {};

    if (Object.keys(resolved).length > 0) {
      cache.resolvedLinks[file.path] = resolved;
    } else {
      delete cache.resolvedLinks[file.path];
    }
    if (Object.keys(unresolved).length > 0) {
      cache.unresolvedLinks[file.path] = unresolved;
    } else {
      delete cache.unresolvedLinks[file.path];
    }

    this.plugin.app.metadataCache.trigger("resolve", file);
  }

  removeFile(path: string): void {
    const cache = this.plugin.app.metadataCache as any;
    if (cache.resolvedLinks) {
      delete cache.resolvedLinks[path];
      for (const src of Object.keys(cache.resolvedLinks)) {
        if (cache.resolvedLinks[src][path]) {
          delete cache.resolvedLinks[src][path];
        }
      }
    }
    if (cache.unresolvedLinks) {
      delete cache.unresolvedLinks[path];
    }
    this.plugin.app.metadataCache.trigger("resolved");
  }

  private async handleRename(
    file: TAbstractFile,
    oldPath: string,
  ): Promise<void> {
    const cache = this.plugin.app.metadataCache as any;
    if (cache.resolvedLinks) {
      if (cache.resolvedLinks[oldPath]) {
        delete cache.resolvedLinks[oldPath];
      }
      for (const src of Object.keys(cache.resolvedLinks)) {
        const links = cache.resolvedLinks[src];
        if (links[oldPath]) {
          links[file.path] = (links[file.path] || 0) + links[oldPath];
          delete links[oldPath];
        }
      }
    }

    if (file instanceof TFile && file.extension === "typ") {
      await this.indexFile(file);
    } else {
      this.plugin.app.metadataCache.trigger("resolved");
    }
  }

  private extractLinks(content: string, sourcePath: string): string[] {
    const slashIdx = sourcePath.lastIndexOf("/");
    const sourceDir = slashIdx >= 0 ? sourcePath.slice(0, slashIdx) : "";
    const targets: string[] = [];

    const incRe = /#(?:include|import)\s+"([^"\\]*(?:\\.[^"\\]*)*)"/g;
    let m;
    while ((m = incRe.exec(content)) !== null) {
      const p = m[1].replace(/\\(.)/g, "$1");
      const resolved = this.tryResolve(p, sourceDir);
      if (resolved) targets.push(resolved);
    }

    const linkRe = /#link\(\s*"((?:[^"\\]|\\.)*)"/g;
    while ((m = linkRe.exec(content)) !== null) {
      const url = m[1].replace(/\\(.)/g, "$1");
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#")) continue;
      const hashIdx = url.indexOf("#");
      const path = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
      const resolved = this.tryResolve(path, sourceDir);
      if (resolved) targets.push(resolved);
    }

    return targets;
  }

  // Cited bib keys in a .typ file: every `@key` that matches a known
  // bib entry. Typst's @key syntax doesn't distinguish citation from
  // same-doc label reference, so we filter by membership in the
  // indexed bib keys to avoid drawing phantom citation nodes from
  // in-document labels that happen to share a key.
  private extractCitedKeys(content: string): string[] {
    if (this.bibKeyToPath.size === 0) return [];
    const out: string[] = [];
    const citeRe = /(?<![\w@])@([A-Za-z][A-Za-z0-9_:.\-]*)/g;
    let m;
    while ((m = citeRe.exec(content)) !== null) {
      if (this.bibKeyToPath.has(m[1])) out.push(m[1]);
    }
    return out;
  }

  // Defined bib keys in a .bib file: every `@<type>{<key>,` header.
  private extractDefinedKeys(content: string): string[] {
    const out: string[] = [];
    const entryRe = /@\w+\s*\{\s*([A-Za-z0-9_:.\-]+)\s*,/g;
    let m;
    while ((m = entryRe.exec(content)) !== null) {
      out.push(m[1]);
    }
    return out;
  }

  private tryResolve(rawPath: string, sourceDir: string): string | null {
    let joined: string;
    if (rawPath.startsWith("/")) {
      joined = rawPath.slice(1);
    } else if (sourceDir) {
      joined = `${sourceDir}/${rawPath}`;
    } else {
      joined = rawPath;
    }

    const parts = joined.split("/");
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (stack.length === 0) return null;
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    const normalized = stack.join("/");
    if (!normalized) return null;

    const file = this.plugin.app.vault.getAbstractFileByPath(normalized);
    return file ? normalized : null;
  }
}
