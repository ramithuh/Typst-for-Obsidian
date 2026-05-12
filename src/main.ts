import {
  Plugin,
  addIcon,
  Notice,
  Platform,
  requestUrl,
  TFolder,
  TFile,
  normalizePath,
} from "obsidian";
import { TypstView } from "./typstView";
import { registerCommands } from "./settings/commands";
import { TypstIcon, pluginId } from "./util/typstUtils";
import { ONIGURUMA_WASM_URL } from "./util/constants";
import { TypstSettingTab } from "./settings/settingsTab";
import { TypstSettings, DEFAULT_SETTINGS } from "./settings/settings";
import { TemplateVariableProvider } from "./templateVariableProvider";
import { BacklinkParser, BACKLINK_URI_PREFIX } from "./backlinkParser";
import { MetadataIndexer } from "./metadataIndexer";
import { GraphColoringPatch } from "./graphColoring";
import { BibView, BIB_VIEW_TYPE } from "./bibView";
import { PackageManager } from "./packageManager";
import { FontManager } from "./fontManager";
import { SnippetManager } from "./snippetManager";
// @ts-ignore
import CompilerWorker from "./compiler.worker.ts";
import { WorkerRequest } from "./types";
import {
  setPluginInstance,
  resetRegistry,
  ensureLanguageRegistered,
} from "./grammar/typstLanguage";
import { setThemeColors } from "./grammar/typstTheme";
import "monaco-editor/min/vs/editor/editor.main.css";

export default class TypstForObsidian extends Plugin {
  settings: TypstSettings;
  compilerWorker: Worker;
  templateProvider: TemplateVariableProvider;
  backlinkParser: BacklinkParser;
  metadataIndexer: MetadataIndexer;
  graphColoringPatch: GraphColoringPatch;
  packageManager: PackageManager;
  fontManager: FontManager;
  snippetManager: SnippetManager;
  textEncoder: TextEncoder;
  // Number of lines the most recent compile prepended (layout function +
  // newline separator) on top of the user's source.  Used to subtract
  // when interpreting jump_from_click results that land in the main file.
  lastCompilePrefixLines: number = 0;
  // Vault path of the most recent compile's main file.
  lastCompilePath: string = "";
  // Monotonic counter to tag compile requests so overlapping compiles
  // don't pick up each other's PDF bytes (the race we hit when rapid
  // edits triggered both live-preview and dependency-update compiles).
  private nextCompileRequestId: number = 0;
  fs: any;
  wasmPath: string;
  pluginPath: string;
  packagePath: string;
  private isWorkerReady: boolean = false;

  async onload() {
    this.textEncoder = new TextEncoder();
    this.templateProvider = new TemplateVariableProvider();
    this.backlinkParser = new BacklinkParser(this.app);
    this.metadataIndexer = new MetadataIndexer(this);
    this.metadataIndexer.register();
    this.app.workspace.onLayoutReady(() => {
      this.metadataIndexer.indexAll();
    });

    // Monkey-patch Obsidian's graph view so color groups also apply to
    // .typ files (Obsidian core treats them as attachments and skips
    // group queries — see graphColoring.ts). Always register; the
    // setting is checked at runtime inside the patch.
    this.graphColoringPatch = new GraphColoringPatch(this);
    this.graphColoringPatch.register();

    // Tell the WASM compiler to drop its cached source whenever a .typ
    // file in the vault changes, so the next compile re-reads it.
    const invalidate = (path: string) => {
      if (!path.endsWith(".typ")) return;
      this.compilerWorker?.postMessage({
        type: "invalidate",
        data: { path },
      });
    };
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (!f.path.endsWith(".typ")) return;
        invalidate(f.path);
        if (!this.settings.autoRecompileOnDependencyChange) return;
        // Recompile every open typst-view in reading mode. This is
        // the same strategy tinymist uses (Myriad-Dreamin/tinymist,
        // crates/tinymist-project/src/compiler.rs ProjectCompiler's
        // Interrupt::Fs handler): on any file change, notify the VFS
        // and re-trigger compile of the project entry point.
        // `comemo` (which typst memoizes through) detects which work
        // actually depends on the changed file and reruns only that;
        // unrelated work is a microsecond memo-hit. So there's no
        // need for a reverse-include graph walk on our side — let
        // comemo do it.
        this.recompileAllReadingViews();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => invalidate(f.path)),
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        invalidate(oldPath);
        invalidate(f.path);
      }),
    );
    this.snippetManager = new SnippetManager();
    await this.loadSettings();

    this.pluginPath = this.app.vault.configDir + `/plugins/${pluginId}/`;
    this.packagePath = this.pluginPath + "packages/";
    this.wasmPath = this.pluginPath + "obsidian_typst_bg.wasm";

    setPluginInstance(this);

    this.packageManager = new PackageManager(this);
    this.compilerWorker = new CompilerWorker() as Worker;
    this.fontManager = new FontManager(
      this.compilerWorker,
      this.settings.fontFamilies,
    );

    if (!(await this.app.vault.adapter.exists(this.wasmPath))) {
      try {
        await this.fetchWasm();
      } catch (error) {
        new Notice("Failed to fetch component: " + error, 0);
        console.error("Failed to fetch component: " + error);
      }
    }

    await this.fetchOnigWasm();

    this.compilerWorker.postMessage({
      type: "startup",
      data: {
        wasm: URL.createObjectURL(
          new Blob([await this.app.vault.adapter.readBinary(this.wasmPath)], {
            type: "application/wasm",
          }),
        ),
        // @ts-ignore
        basePath: this.app.vault.adapter.basePath,
        packagePath: this.packagePath,
      },
    });

    if (Platform.isDesktopApp) {
      this.compilerWorker.postMessage({
        type: "canUseSharedArrayBuffer",
        data: true,
      });
      this.fs = require("fs");

      this.compilerWorker.addEventListener("message", (event) => {
        if (event.data?.type === "ready") {
          this.isWorkerReady = true;
          this.fontManager.loadFonts(this.isWorkerReady);
        }
      });
    } else {
      await this.app.vault.adapter.mkdir(this.packagePath);
      const packages = await this.getPackageList();
      this.compilerWorker.postMessage({ type: "packages", data: packages });
    }

    addIcon("typst-file", TypstIcon);
    this.registerExtensions(["typ"], "typst-view");
    this.registerView("typst-view", (leaf) => new TypstView(leaf, this));
    // .bib files open in a plain-text editor view (BibTeX without the
    // heavy Monaco setup). Lets you see and edit them inside Obsidian.
    this.registerExtensions(["bib"], BIB_VIEW_TYPE);
    this.registerView(BIB_VIEW_TYPE, (leaf) => new BibView(leaf));
    registerCommands(this);
    this.addSettingTab(new TypstSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("css-change", async () => {
        await this.onThemeChange();
      }),
    );

    this.registerDomEvent(document, "click", (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href") || anchor.dataset?.href || "";
      if (!href.startsWith(BACKLINK_URI_PREFIX)) return;
      e.preventDefault();
      e.stopPropagation();
      const params = new URLSearchParams(href.slice(BACKLINK_URI_PREFIX.length));
      const filePath = params.get("file") || "";
      const subpath = params.get("subpath") || "";
      const linkTarget = filePath + subpath;
      const newTab = e.ctrlKey || e.metaKey;
      this.app.workspace.openLinkText(linkTarget, "", newTab ? "tab" : false);
    }, true);

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, source) => {
        if (
          source === "file-explorer-context-menu" ||
          source === "more-options"
        ) {
          menu.addItem((item) => {
            item
              .setTitle("New Typst file")
              .setIcon("typst-file")
              .setSection("action-primary")
              .onClick(async () => {
                const folder =
                  file instanceof TFolder
                    ? file
                    : file instanceof TFile
                      ? file.parent
                      : this.app.vault.getRoot();
                if (!folder) return;

                const baseName = "Untitled";
                let fileName = `${baseName}.typ`;
                let counter = 1;
                while (
                  this.app.vault.getAbstractFileByPath(
                    normalizePath(`${folder.path}/${fileName}`),
                  )
                ) {
                  fileName = `${baseName} ${counter}.typ`;
                  counter++;
                }

                const fullPath = normalizePath(`${folder.path}/${fileName}`);
                const newFile = await this.app.vault.create(fullPath, "");
                const leaf = this.app.workspace.getLeaf(false);
                await leaf.openFile(newFile);
              });
          });
        }
      }),
    );
  }

  async reloadFonts(): Promise<void> {
    this.fontManager = new FontManager(
      this.compilerWorker,
      this.settings.fontFamilies,
    );
    await this.fontManager.loadFonts(this.isWorkerReady);
  }

  private async resetSyntaxHighlighting() {
    const isDark = document.body.classList.contains("theme-dark");
    resetRegistry();
    await ensureLanguageRegistered(isDark);
  }

  private async onThemeChange() {
    await this.resetSyntaxHighlighting();

    const updatePromises: Promise<void>[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof TypstView) {
        const typstView = leaf.view as TypstView;
        updatePromises.push(typstView.updateEditorTheme());
        updatePromises.push(typstView.recompileIfInReadingMode());
      }
    });
    await Promise.all(updatePromises);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    setThemeColors(this.settings.syntaxHighlightColors);

    if (!this.snippetManager.parseSnippets(this.settings.customSnippets)) {
      const error = this.snippetManager.getLastError();
      new Notice(`Snippet configuration error: ${error}`);
      console.error("Snippet parsing failed:", error);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);

    setThemeColors(this.settings.syntaxHighlightColors);
    await this.resetSyntaxHighlighting();

    if (!this.snippetManager.parseSnippets(this.settings.customSnippets)) {
      const error = this.snippetManager.getLastError();
      new Notice(`Snippet configuration error: ${error}`);
      console.error("Snippet parsing failed:", error);
    }

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof TypstView) {
        const typstView = leaf.view as TypstView;
        typstView.updateActionBar();
        typstView.rebuildHotkeys();
      }
    });
  }

  private async fetchWasm() {
    try {
      const wasmSourcePath = this.pluginPath + "pkg/obsidian_typst_bg.wasm";
      const wasmData = await this.app.vault.adapter.readBinary(wasmSourcePath);
      await this.app.vault.adapter.mkdir(this.pluginPath);
      await this.app.vault.adapter.writeBinary(this.wasmPath, wasmData);
    } catch (error) {
      console.error("Failed to fetch WASM:", error);
      throw error;
    }
  }

  private async fetchOnigWasm() {
    try {
      const onigWasmPath = this.pluginPath + "onig.wasm";
      if (await this.app.vault.adapter.exists(onigWasmPath)) {
        return;
      }

      const onigSourcePath =
        this.pluginPath + "vscode-oniguruma/release/onig.wasm";
      if (await this.app.vault.adapter.exists(onigSourcePath)) {
        const wasmData =
          await this.app.vault.adapter.readBinary(onigSourcePath);
        await this.app.vault.adapter.writeBinary(onigWasmPath, wasmData);
        return;
      }

      const response = await requestUrl({ url: ONIGURUMA_WASM_URL });
      const wasmData = response.arrayBuffer;
      await this.app.vault.adapter.writeBinary(onigWasmPath, wasmData);
    } catch (error) {
      console.error("Failed to fetch onig.wasm:", error);
      throw error;
    }
  }

  private async getPackageList(): Promise<string[]> {
    const packages: string[] = [];
    try {
      if (await this.app.vault.adapter.exists(this.packagePath)) {
        const entries = await this.app.vault.adapter.list(this.packagePath);
        for (const entry of entries.folders) {
          packages.push(entry.split("/").slice(-3).join("/"));
        }
      }
    } catch (error) {
      console.error("Failed to get package list:", error);
    }
    return packages;
  }

  async compileToPdf(
    source: string,
    path: string = "/main.typ",
    compileType: "internal" | "export" = "internal",
  ): Promise<Uint8Array> {
    let finalSource = source;
    let prefix = "";

    if (
      compileType === "export" &&
      this.settings.usePdfLayoutFunctions &&
      this.settings.pdfLayoutFunctions.trim()
    ) {
      prefix = this.settings.pdfLayoutFunctions;
    } else if (this.settings.useDefaultLayoutFunctions) {
      prefix = this.settings.customLayoutFunctions;
    } else {
      prefix = "#set page(margin: (x: 0.25em, y: 0.25em))";
    }
    finalSource = prefix + "\n" + source;
    this.lastCompilePrefixLines = (prefix.match(/\n/g)?.length ?? 0) + 1;
    this.lastCompilePath = path;

    if (compileType === "internal") {
      finalSource = finalSource + "\n#linebreak()\n#linebreak()";
    }

    finalSource = this.templateProvider.replaceVariables(finalSource);
    finalSource = this.backlinkParser.replaceBacklinks(finalSource, path);

    const requestId = ++this.nextCompileRequestId;
    const message = {
      type: "compile",
      data: {
        format: "pdf",
        path,
        source: finalSource,
        requestId,
      },
    };

    this.compilerWorker.postMessage(message);

    while (true) {
      const result = await new Promise<any>((resolve, reject) => {
        const listener = (ev: MessageEvent) => {
          if (!ev.data) return;
          if (ev.data.type === "ready") return;
          // File-fetch requests have buffer+path and no requestId
          // tag; let those pass through to the upstream handler.
          if (ev.data.buffer && ev.data.path) {
            remove();
            resolve(ev.data);
            return;
          }
          // Only resolve when the response carries OUR requestId.
          // Anything else is a sibling compile's reply — ignore it
          // and let the sibling's listener pick it up.
          if (
            ev.data.type === "pdfResult" &&
            ev.data.requestId === requestId
          ) {
            remove();
            resolve(ev.data);
          }
        };

        const errorListener = (error: ErrorEvent) => {
          console.error("Worker error during PDF compile:", error);
          remove();
          reject(error);
        };

        const remove = () => {
          this.compilerWorker.removeEventListener("message", listener);
          this.compilerWorker.removeEventListener("error", errorListener);
        };

        this.compilerWorker.addEventListener("message", listener);
        this.compilerWorker.addEventListener("error", errorListener);
      });

      if (result && result.type === "pdfResult") {
        if (result.error) throw new Error(result.error);
        return result.data;
      } else if (result && result.error) {
        throw new Error(result.error);
      } else if (result && result.buffer && result.path) {
        await this.handleWorkerRequest(result);
        continue;
      } else {
        console.error("Unexpected PDF response format:", result);
        throw new Error("Invalid PDF response format");
      }
    }
  }

  // Resolve a click in the rendered PDF preview back to its source
  // location, using the WASM compiler's stored last document.
  // Returns null if no span was found under the click.
  async jumpFromClick(
    page: number,
    x: number,
    y: number,
  ): Promise<{
    file: string;
    line: number;
    column: number;
    byte_offset: number;
  } | null> {
    return new Promise((resolve) => {
      const listener = (ev: MessageEvent) => {
        if (!ev.data || ev.data.type !== "jumpResult") return;
        this.compilerWorker.removeEventListener("message", listener);
        if (ev.data.error) {
          console.error("jump_from_click failed:", ev.data.error);
          resolve(null);
          return;
        }
        resolve(ev.data.data || null);
      };
      this.compilerWorker.addEventListener("message", listener);
      this.compilerWorker.postMessage({
        type: "jump",
        data: { page, x, y },
      });
    });
  }

  // Iterate every open typst-view and recompile any that are in
  // reading mode. Driven by vault file-change events. See the comment
  // in onload's vault.on("modify") handler for the rationale.
  private recompileAllReadingViews(): void {
    const leaves = this.app.workspace.getLeavesOfType("typst-view");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof TypstView) {
        // recompileIfInReadingMode is a no-op when the view is in
        // source mode, so we can call it unconditionally.
        void view.recompileIfInReadingMode();
      }
    }
  }

  // Inverse of jumpFromClick: given a cursor at (line, column) in the
  // source file at `path` (0-indexed), find the (page, x, y) in PDF
  // user-space pt that corresponds to that cursor in the rendered
  // document. For the main compile file, the caller is responsible
  // for shifting `line` by `lastCompilePrefixLines` so the cursor
  // hits the right offset inside the combined source the WASM sees.
  async cursorToPreview(
    path: string,
    line: number,
    column: number,
  ): Promise<{ page: number; x: number; y: number } | null> {
    return new Promise((resolve) => {
      const listener = (ev: MessageEvent) => {
        if (!ev.data || ev.data.type !== "cursorResult") return;
        this.compilerWorker.removeEventListener("message", listener);
        if (ev.data.error) {
          // "no document compiled yet" is expected when the cursor
          // moves before a preview has rendered; silently no-op.
          if (
            typeof ev.data.error === "string" &&
            !ev.data.error.includes("no document")
          ) {
            console.error("cursor_to_preview failed:", ev.data.error);
          }
          resolve(null);
          return;
        }
        resolve(ev.data.data || null);
      };
      // Register before posting so a synchronous reply can't be missed.
      this.compilerWorker.addEventListener("message", listener);
      this.compilerWorker.postMessage({
        type: "cursor",
        data: { path, line, column },
      });
    });
  }

  async handleWorkerRequest({ buffer: wbuffer, path }: WorkerRequest) {
    try {
      const isBinary = path.endsWith(":binary");
      const actualPath = isBinary ? path.slice(0, -7) : path;

      if (actualPath.startsWith("@")) {
        const text = await this.packageManager.preparePackage(
          actualPath.slice(1),
        );
        if (text) {
          const encoded = this.textEncoder.encode(text);
          const numInt32s = Math.ceil((encoded.byteLength + 8) / 4);

          if (wbuffer.byteLength < numInt32s * 4) {
            // @ts-ignore
            wbuffer.buffer.grow(numInt32s * 4);
          }

          wbuffer[1] = encoded.byteLength;
          const dataView = new Uint8Array(
            wbuffer.buffer,
            8,
            encoded.byteLength,
          );
          dataView.set(encoded);

          wbuffer[0] = 0;
        }
      } else if (isBinary) {
        const binaryData = await this.packageManager.getFileBinary(actualPath);
        if (binaryData) {
          const byteLength = binaryData.byteLength;
          const numInt32s = Math.ceil((byteLength + 8) / 4);

          if (wbuffer.byteLength < numInt32s * 4) {
            // @ts-ignore
            wbuffer.buffer.grow(numInt32s * 4);
          }

          wbuffer[1] = byteLength;
          const dataView = new Uint8Array(wbuffer.buffer, 8, byteLength);
          dataView.set(new Uint8Array(binaryData));

          wbuffer[0] = 0;
        }
      } else {
        const text = await this.packageManager.getFileString(actualPath);
        if (text) {
          const encoded = this.textEncoder.encode(text);
          const numInt32s = Math.ceil((encoded.byteLength + 8) / 4);

          if (wbuffer.byteLength < numInt32s * 4) {
            // @ts-ignore
            wbuffer.buffer.grow(numInt32s * 4);
          }

          wbuffer[1] = encoded.byteLength;
          const dataView = new Uint8Array(
            wbuffer.buffer,
            8,
            encoded.byteLength,
          );
          dataView.set(encoded);

          wbuffer[0] = 0;
        }
      }
    } catch (error) {
      if (typeof error === "number") {
        wbuffer[0] = error;
      } else {
        wbuffer[0] = 1;
        console.error(error);
      }
    } finally {
      Atomics.notify(wbuffer, 0);
    }
  }
}
