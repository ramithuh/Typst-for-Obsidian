import { Plugin, TFile, TAbstractFile } from "obsidian";

// Parses `.typ` files for forward references and pushes them into
// `app.metadataCache.resolvedLinks` so graph view and the Backlinks
// pane include Typst files alongside Markdown notes.
//
// Recognized forward references:
//   #include "path.typ"
//   #import "path.typ": ...
//   #link("./path.typ")    (relative vault paths only)
export class MetadataIndexer {
  private plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  register(): void {
    const { vault } = this.plugin.app;

    this.plugin.registerEvent(
      vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "typ") {
          this.indexFile(file);
        }
      }),
    );
    this.plugin.registerEvent(
      vault.on("create", (file) => {
        if (file instanceof TFile && file.extension === "typ") {
          this.indexFile(file);
        }
      }),
    );
    this.plugin.registerEvent(
      vault.on("delete", (file) => {
        this.removeFile(file.path);
      }),
    );
    this.plugin.registerEvent(
      vault.on("rename", (file, oldPath) => {
        this.handleRename(file, oldPath);
      }),
    );
  }

  async indexAll(): Promise<void> {
    const files = this.plugin.app.vault
      .getFiles()
      .filter((f) => f.extension === "typ");
    for (const file of files) {
      await this.indexFile(file);
    }
    this.plugin.app.metadataCache.trigger("resolved");
  }

  async indexFile(file: TFile): Promise<void> {
    const content = await this.plugin.app.vault.cachedRead(file);
    const targets = this.extractLinks(content, file.path);

    const resolved: Record<string, number> = {};
    for (const t of targets) resolved[t] = (resolved[t] || 0) + 1;

    const cache = this.plugin.app.metadataCache as any;
    cache.resolvedLinks ??= {};
    if (Object.keys(resolved).length > 0) {
      cache.resolvedLinks[file.path] = resolved;
    } else {
      delete cache.resolvedLinks[file.path];
    }

    this.plugin.app.metadataCache.trigger("resolve", file);
  }

  removeFile(path: string): void {
    const cache = this.plugin.app.metadataCache as any;
    if (!cache.resolvedLinks) return;
    delete cache.resolvedLinks[path];
    for (const src of Object.keys(cache.resolvedLinks)) {
      if (cache.resolvedLinks[src][path]) {
        delete cache.resolvedLinks[src][path];
      }
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
