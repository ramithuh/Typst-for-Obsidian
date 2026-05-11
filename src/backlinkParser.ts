import { App, getLinkpath, parseLinktext } from "obsidian";

const BACKLINK_URI_PREFIX = "https://obsidian-backlink.invalid/open?";

export { BACKLINK_URI_PREFIX };

export class BacklinkParser {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  replaceBacklinks(source: string, sourcePath: string): string {
    source = this.rewriteNativeLinks(source, sourcePath);

    const vaultName = this.app.vault.getName();

    return source.replace(/\[\[([^\[\]]+)\]\]/g, (match, inner: string) => {
      const pipeIndex = inner.indexOf("|");
      let linkTarget: string;
      let displayText: string;

      if (pipeIndex !== -1) {
        linkTarget = inner.substring(0, pipeIndex).trim();
        displayText = inner.substring(pipeIndex + 1).trim();
      } else {
        linkTarget = inner.trim();
        displayText = inner.trim();
      }

      const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(
        getLinkpath(linkTarget),
        sourcePath,
      );

      if (!resolvedFile) return match;

      const { subpath } = parseLinktext(linkTarget);
      const filePath = resolvedFile.path;
      const params = new URLSearchParams({ vault: vaultName, file: filePath });
      if (subpath) {
        params.set("subpath", subpath);
      }
      const uri = BACKLINK_URI_PREFIX + params.toString();

      const escapedDisplay = this.escapeTypst(displayText);

      return `#link("${this.escapeString(uri)}")[${escapedDisplay}]`;
    });
  }

  // Rewrite native Typst `#link("./relative/path.typ")` calls whose URL
  // resolves to a vault file, so clicks open the target in Obsidian
  // instead of falling through to `window.open(url, "_blank")`.
  // External URLs (with a scheme) are left untouched, preserving
  // portability of the source file when compiled outside this plugin.
  private rewriteNativeLinks(source: string, sourcePath: string): string {
    const vaultName = this.app.vault.getName();
    const slashIdx = sourcePath.lastIndexOf("/");
    const sourceDir = slashIdx >= 0 ? sourcePath.slice(0, slashIdx) : "";

    return source.replace(
      /#link\(\s*"((?:[^"\\]|\\.)*)"/g,
      (match, rawUrl: string) => {
        const url = rawUrl.replace(/\\(.)/g, "$1");

        if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#")) {
          return match;
        }

        const hashIdx = url.indexOf("#");
        const path = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
        const subpath = hashIdx >= 0 ? url.slice(hashIdx) : "";

        let joined: string;
        if (path.startsWith("/")) {
          joined = path.slice(1);
        } else if (sourceDir) {
          joined = `${sourceDir}/${path}`;
        } else {
          joined = path;
        }
        const resolved = this.normalizeVaultPath(joined);
        if (!resolved) return match;

        const file = this.app.vault.getAbstractFileByPath(resolved);
        if (!file) return match;

        const params = new URLSearchParams({ vault: vaultName, file: resolved });
        if (subpath) params.set("subpath", subpath);
        const uri = BACKLINK_URI_PREFIX + params.toString();

        return `#link("${this.escapeString(uri)}"`;
      },
    );
  }

  private normalizeVaultPath(path: string): string {
    const parts = path.split("/");
    const result: string[] = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (result.length === 0) return "";
        result.pop();
      } else {
        result.push(part);
      }
    }
    return result.join("/");
  }

  private escapeTypst(text: string): string {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/#/g, "\\#")
      .replace(/\*/g, "\\*")
      .replace(/_/g, "\\_")
      .replace(/</g, "\\<")
      .replace(/>/g, "\\>")
      .replace(/@/g, "\\@")
      .replace(/\$/g, "\\$");
  }

  private escapeString(text: string): string {
    return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
}
