import {
  TextFileView,
  WorkspaceLeaf,
  Notice,
  normalizePath,
  TFile,
  Scope,
} from "obsidian";
import { TypstEditor } from "./typstEditor";
import TypstForObsidian from "./main";
import { PdfRenderer, PDF_RENDER_SCALE } from "./pdfRenderer";
import { SvgRenderer } from "./svgRenderer";
import { ViewActionBar } from "./ui/viewActionBar";
import { EditorStateManager } from "./editorStateManager";
import { CompilationManager, CompilationResult } from "./compilationManager";
import { ErrorsDropdown, TypstError, parseTypstError } from "./ui/errorsPane";
import { EditorHotkeyManager } from "./editorHotkeyManager";

export class TypstView extends TextFileView {
  private static _suppressAutoSplit = false;

  private currentMode: "source" | "reading" = "source";
  private typstEditor: TypstEditor | null = null;
  private fileContent: string = "";
  private plugin: TypstForObsidian;
  private pdfRenderer: PdfRenderer;
  private svgRenderer: SvgRenderer;
  private actionBar: ViewActionBar | null = null;
  private stateManager: EditorStateManager;
  private livePreviewActive: boolean = false;
  private compilationManager: CompilationManager;
  private pairedView: TypstView | null = null;
  private currentErrors: TypstError[] = [];
  private errorsDropdown: ErrorsDropdown | null = null;
  private pendingSplitMode: "split-live-preview" | "split-pdf" | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TypstForObsidian) {
    super(leaf);
    this.plugin = plugin;

    if (TypstView._suppressAutoSplit) {
      this.currentMode = "source";
    } else {
      const defaultMode = plugin.settings.defaultMode;
      if (defaultMode === "split-live-preview" || defaultMode === "split-pdf") {
        this.currentMode = "source";
        this.pendingSplitMode = defaultMode;
      } else if (defaultMode === "last") {
        this.currentMode = "source";
      } else {
        this.currentMode = defaultMode;
      }
    }

    this.pdfRenderer = new PdfRenderer();
    this.svgRenderer = new SvgRenderer();
    this.stateManager = new EditorStateManager();
    this.compilationManager = new CompilationManager(plugin);
    this.scope = new Scope(this.app.scope);
  }

  getViewType(): string {
    return "typst-view";
  }

  getDisplayText(): string {
    return this.file?.basename || "Typst File";
  }

  getIcon(): string {
    return "typst-file";
  }

  async onOpen(): Promise<void> {
    await super.onOpen();
    this.initializeActionBar();
    this.registerHotkeys();

    const viewContent = this.getContentElement();
    if (viewContent) {
      viewContent.dataset.mode = this.currentMode;
    }
  }

  onResize(): void {
    super.onResize();
    if (this.typstEditor) {
      this.typstEditor.onResize();
    }
  }

  onClose(): Promise<void> {
    this.cleanupEditor();
    this.actionBar?.destroy();
    this.stateManager.clear();
    this.compilationManager.destroy();

    if (this.cursorSyncTimer != null) {
      window.clearTimeout(this.cursorSyncTimer);
      this.cursorSyncTimer = null;
    }

    if (this.pairedView) {
      this.pairedView.clearPairedView();
      this.pairedView = null;
    }

    return super.onClose();
  }

  private initializeActionBar(): void {
    const viewActions = this.containerEl.querySelector(".view-actions");
    if (viewActions) {
      this.actionBar = new ViewActionBar(
        viewActions,
        () => this.toggleMode(),
        () => this.exportToPdf(),
        () => this.openSplitPreview(),
        (anchorEl: HTMLElement) => this.showErrorsPane(anchorEl),
      );
      this.actionBar.initialize(
        this.currentMode,
        this.plugin.settings.enableLivePreview,
      );
      this.actionBar.updateErrorCount(this.currentErrors.length);
    }
  }

  public toggleBold(): void {
    if (!this.typstEditor) {
      console.warn("Editor not available");
      return;
    }
    this.typstEditor.toggleFormatting("*", "*");
  }

  public toggleItalic(): void {
    if (!this.typstEditor) {
      console.warn("Editor not available");
      return;
    }
    this.typstEditor.toggleFormatting("_", "_");
  }

  public toggleUnderline(): void {
    if (!this.typstEditor) {
      console.warn("Editor not available");
      return;
    }
    this.typstEditor.toggleFormatting("#underline[", "]");
  }

  public increaseHeadingLevel(): void {
    if (!this.typstEditor) {
      console.warn("Editor not available");
      return;
    }
    this.typstEditor.increaseHeadingLevel();
  }

  public decreaseHeadingLevel(): void {
    if (!this.typstEditor) {
      console.warn("Editor not available");
      return;
    }
    this.typstEditor.decreaseHeadingLevel();
  }

  public showErrorsPane(anchorEl: HTMLElement): void {
    if (this.errorsDropdown) {
      this.errorsDropdown.close();
      this.errorsDropdown = null;
      return;
    }

    this.errorsDropdown = new ErrorsDropdown(
      anchorEl,
      this.currentErrors,
      (line: number, column: number) => {
        if (this.currentMode !== "source") {
          this.toggleMode();
        }
        setTimeout(() => {
          if (this.typstEditor) {
            this.typstEditor.goToLine(line, column);
          }
        }, 100);
      },
      () => {
        this.errorsDropdown = null;
      },
    );
  }

  public async exportToPdf(): Promise<string | null> {
    if (!this.file) {
      console.error("No file available for export");
      return null;
    }

    try {
      const content = this.getViewData();
      const filePath = this.file.path;
      const pdfData = await this.plugin.compileToPdf(
        content,
        filePath,
        "export",
      );
      if (!pdfData) {
        console.error("PDF compilation failed");
        return null;
      }

      const baseName = this.file.basename.replace(/\.typ$/, "");
      const pdfFileName = `${baseName}.pdf`;

      let pdfPath: string;
      const exportPath = this.plugin.settings.pdfExportPath;
      if (exportPath) {
        const normalizedExportPath = normalizePath(exportPath);
        if (!(await this.app.vault.adapter.exists(normalizedExportPath))) {
          await this.app.vault.adapter.mkdir(normalizedExportPath);
        }
        pdfPath = normalizePath(`${normalizedExportPath}/${pdfFileName}`);
      } else {
        const folderPath = filePath.substring(0, filePath.lastIndexOf("/"));
        pdfPath = folderPath ? `${folderPath}/${pdfFileName}` : pdfFileName;
      }

      const arrayBuffer = pdfData.buffer.slice(
        pdfData.byteOffset,
        pdfData.byteOffset + pdfData.byteLength,
      ) as ArrayBuffer;
      const existingFile = this.app.vault.getAbstractFileByPath(pdfPath);
      if (existingFile) {
        await this.app.vault.modifyBinary(existingFile as any, arrayBuffer);
      } else {
        await this.app.vault.createBinary(pdfPath, arrayBuffer);
      }

      if (!this.plugin.settings.suppressPdfExportNotice) {
        new Notice(`PDF exported to: ${pdfPath}`);
      }

      if (this.plugin.settings.openPdfOnExport) {
        await this.openPdfInSplitPane(pdfPath);
      }

      return pdfPath;
    } catch (error) {
      new Notice("Failed to export PDF. See console for details.");
      console.error("Failed to export PDF:", error);
      return null;
    }
  }

  public async exportAndOpenPdf(): Promise<void> {
    const pdfPath = await this.exportToPdf();
    if (pdfPath && !this.plugin.settings.openPdfOnExport) {
      await this.openPdfInSplitPane(pdfPath);
    }
  }

  private async openPdfInSplitPane(pdfPath: string): Promise<void> {
    const pdfFile = this.app.vault.getAbstractFileByPath(pdfPath);
    if (!(pdfFile instanceof TFile)) return;

    const activeLeaf = this.app.workspace.getLeaf(false);
    const activeParent = activeLeaf.parent;

    let pdfLeafInOtherGroup: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        leaf.parent !== activeParent &&
        (leaf.view as any)?.file instanceof TFile &&
        (leaf.view as any).file.path === pdfPath
      ) {
        pdfLeafInOtherGroup = leaf;
      }
    });

    if (pdfLeafInOtherGroup) {
      this.app.workspace.setActiveLeaf(pdfLeafInOtherGroup, { focus: false });
    } else {
      const newLeaf = this.app.workspace.getLeaf("split");
      await newLeaf.openFile(pdfFile);
    }
  }

  public async openSplitPreview(): Promise<void> {
    if (!this.file) {
      new Notice("No file to preview");
      return;
    }

    if (this.pairedView) {
      this.app.workspace.setActiveLeaf(this.pairedView.leaf, { focus: true });
      return;
    }

    const newLeaf = this.app.workspace.getLeaf("split");
    await newLeaf.openFile(this.file);

    const newView = newLeaf.view;
    if (newView instanceof TypstView) {
      this.pairedView = newView;
      newView.pairedView = this;

      this.setLivePreviewActive(true);
      newView.setLivePreviewActive(true);

      if (newView.getCurrentMode() === "source") {
        await newView.toggleMode();
      }

      if (this.getCurrentMode() === "reading") {
        await this.toggleMode();
      }
    }
  }

  public setLivePreviewActive(active: boolean): void {
    this.livePreviewActive = active;

    if (active) {
      this.compilationManager.on(
        "compilation-complete",
        this.handleCompilationComplete.bind(this),
      );
      this.compilationManager.on(
        "compilation-error",
        this.handleCompilationError.bind(this),
      );
    } else {
      this.compilationManager.off(
        "compilation-complete",
        this.handleCompilationComplete.bind(this),
      );
      this.compilationManager.off(
        "compilation-error",
        this.handleCompilationError.bind(this),
      );
    }
  }

  public clearPairedView(): void {
    this.pairedView = null;
    this.setLivePreviewActive(false);
  }

  private async handleCompilationComplete(
    result: CompilationResult,
  ): Promise<void> {
    if (this.currentMode === "reading" && this.pairedView) {
      await this.showReadingMode(result.data);
    }
    if (this.currentMode === "source" && this.pairedView) {
      this.clearErrors();
    }
  }

  private handleCompilationError(error: any): void {
    if (this.currentMode === "source") {
      const errorMsg = error instanceof Error ? error.message : String(error);

      let lineOffset = 0;
      if (this.plugin.settings.useDefaultLayoutFunctions) {
        lineOffset =
          (this.plugin.settings.customLayoutFunctions.match(/\n/g) || [])
            .length + 1;
      } else {
        lineOffset = 1;
      }

      const parsedError = parseTypstError(errorMsg);
      if (parsedError) {
        parsedError.line = Math.max(1, parsedError.line - lineOffset);
        this.currentErrors = [parsedError];
      } else {
        this.currentErrors = [
          {
            file: this.file?.path || "unknown",
            line: 0,
            column: 0,
            errorLine: "",
            message: errorMsg,
          },
        ];
      }

      this.actionBar?.updateErrorCount(this.currentErrors.length);
    }
  }

  public async toggleMode(): Promise<void> {
    if (this.currentMode === "source") {
      await this.switchToReadingMode();
    } else {
      this.switchToSourceMode();
    }
  }

  public getCurrentMode(): string {
    return this.currentMode;
  }

  // Scroll the Monaco editor in this view to (line, column). No-op
  // if the view is not in source mode or the editor is not mounted.
  // Returns true on success.
  public jumpToSourcePosition(line: number, column: number): boolean {
    if (this.currentMode !== "source" || !this.typstEditor) return false;
    this.typstEditor.goToLine(line, column);
    return true;
  }

  public async recompileIfInReadingMode(): Promise<void> {
    if (this.currentMode === "reading") {
      const pdfData = await this.compile();
      if (pdfData) {
        await this.showReadingMode(pdfData);
      }
    }
  }

  public async updateEditorTheme(): Promise<void> {
    if (this.typstEditor && this.currentMode === "source") {
      await this.typstEditor.updateTheme();
    }
  }

  public updateActionBar(): void {
    this.actionBar?.setLivePreviewEnabled(
      this.plugin.settings.enableLivePreview,
    );
  }

  private registerHotkeys(): void {
    new EditorHotkeyManager(this.scope!, {
      getCurrentMode: () => this.currentMode,
      getEditor: () => this.typstEditor,
      toggleBold: () => this.toggleBold(),
      toggleItalic: () => this.toggleItalic(),
      toggleUnderline: () => this.toggleUnderline(),
      increaseHeadingLevel: () => this.increaseHeadingLevel(),
      decreaseHeadingLevel: () => this.decreaseHeadingLevel(),
    }).registerAll(this.plugin.settings.editorHotkeys);
  }

  public rebuildHotkeys(): void {
    this.scope = new Scope(this.app.scope);
    this.registerHotkeys();
  }

  private async switchToReadingMode(): Promise<void> {
    this.saveEditorState();

    const pdfData = await this.compile();
    if (!pdfData) return;

    this.setMode("reading");
    await this.showReadingMode(pdfData);
  }

  private switchToSourceMode(): void {
    this.saveEditorState();

    this.setMode("source");
    this.showSourceMode();
    this.restoreEditorState();
  }

  private setMode(mode: "source" | "reading"): void {
    this.currentMode = mode;
    this.actionBar?.setMode(mode);

    const viewContent = this.getContentElement();
    if (viewContent) {
      viewContent.dataset.mode = mode;
    }

    if (this.file) {
      this.plugin.settings.lastFileModes[this.file.path] = mode;
      this.plugin.saveData(this.plugin.settings);
    }
  }

  private async compile(): Promise<Uint8Array | string[] | null> {
    const content = this.getViewData();
    try {
      const filePath = this.file?.path || "/main.typ";
      const useSvg = this.plugin.settings.previewRenderer === "svg";
      const result = useSvg
        ? await this.plugin.compileToSvgs(content, filePath)
        : await this.plugin.compileToPdf(content, filePath);
      this.clearErrors();
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("Compilation error:", errorMsg);

      let lineOffset = 0;
      if (this.plugin.settings.useDefaultLayoutFunctions) {
        lineOffset =
          (this.plugin.settings.customLayoutFunctions.match(/\n/g) || [])
            .length + 1;
      } else {
        lineOffset = 1;
      }

      const parsedError = parseTypstError(errorMsg);
      if (parsedError) {
        parsedError.line = Math.max(1, parsedError.line - lineOffset);
        this.currentErrors = [parsedError];
      } else {
        this.currentErrors = [
          {
            file: this.file?.path || "unknown",
            line: 0,
            column: 0,
            errorLine: "",
            message: errorMsg,
          },
        ];
      }

      this.actionBar?.updateErrorCount(this.currentErrors.length);
      return null;
    }
  }

  private clearErrors(): void {
    this.currentErrors = [];
    this.actionBar?.updateErrorCount(0);
  }

  async setViewData(data: string, clear: boolean): Promise<void> {
    this.fileContent = data;

    if (
      this.plugin.settings.defaultMode === "last" &&
      this.file &&
      !this.pairedView
    ) {
      const lastMode = this.plugin.settings.lastFileModes[this.file.path];
      if (lastMode === "reading" && data.trim().length > 0) {
        this.currentMode = "reading";
      }
    }

    if (this.currentMode === "source") {
      this.showSourceMode();
    } else {
      await this.loadReadingMode(data);
    }

    if (this.pendingSplitMode && data.trim().length > 0) {
      const mode = this.pendingSplitMode;
      this.pendingSplitMode = null;
      TypstView._suppressAutoSplit = true;
      try {
        if (mode === "split-live-preview") {
          await this.openSplitPreview();
        } else if (mode === "split-pdf") {
          await this.exportAndOpenPdf();
        }
      } finally {
        TypstView._suppressAutoSplit = false;
      }
    } else {
      this.pendingSplitMode = null;
    }
  }

  private async loadReadingMode(data: string): Promise<void> {
    const pdfData = await this.compile();

    if (!pdfData) {
      if (!this.livePreviewActive) {
        this.setMode("source");
        this.showSourceMode();
      }
    } else {
      await this.showReadingMode(pdfData);
    }
  }

  getViewData(): string {
    if (this.currentMode === "source" && this.typstEditor) {
      return this.typstEditor.getContent();
    }
    return this.fileContent;
  }

  public getContentElement(): HTMLElement | null {
    return this.containerEl.querySelector(".view-content") as HTMLElement;
  }

  private cleanupEditor(): void {
    if (this.typstEditor) {
      this.typstEditor.destroy();
      this.typstEditor = null;
    }
  }

  public updateEditorFontSize(size: number): void {
    this.typstEditor?.updateFontSize(size);
  }

  public insertSnippet(snippetText: string): void {
    this.typstEditor?.insertSnippet(snippetText);
  }

  public showSourceMode(): void {
    const contentEl = this.getContentElement();
    if (!contentEl) return;

    contentEl.empty();
    this.cleanupEditor();

    this.typstEditor = new TypstEditor(
      contentEl,
      this.plugin,
      (content: string) => {
        this.fileContent = content;
        this.handleContentChange(content);
      },
      (line: number, column: number) => {
        this.handleCursorChange(line, column);
      },
    );

    this.typstEditor.initialize(this.fileContent).catch((err) => {
      console.error("Failed to initialize Typst editor:", err);
    });
  }

  // Pinch-to-zoom and Ctrl/Cmd+scroll-to-zoom on the preview pane.
  //
  // The trick to making this feel like Safari's native PDF zoom is to
  // *not* touch any layout properties during the gesture. During the
  // pinch we only update an inner wrapper's `transform: translate(tx,
  // ty) scale(z)`, which the browser composites on the GPU with zero
  // reflow. readingDiv's CSS width/height stays untouched (so the
  // scrollbar doesn't jiggle), and the scroller's scrollTop/Left
  // stays untouched (so the scroll thumb doesn't move).
  //
  // Only ~150ms after the gesture finishes (no wheel event has fired
  // in that window) do we *commit*: set readingDiv's dimensions to
  // the final natural × scale, reset the transform back to pure
  // scale (no translate), and adjust the scroller's scroll position
  // so the visible content stays exactly where the user left it.
  //
  // Layout:
  //   readingDiv (outer; explicit width/height after commit)
  //     └── zoomInner (transform: translate(tx, ty) scale(z))
  //         └── per-page divs (rendered by PdfRenderer / SvgRenderer)
  private attachPreviewZoom(readingDiv: HTMLElement): void {
    const MIN_ZOOM = 0.25;
    const MAX_ZOOM = 4;
    const WHEEL_TO_ZOOM = 0.0035;
    const COMMIT_DELAY_MS = 150;

    const zoomInner = this.ensureZoomInner(readingDiv);
    zoomInner.style.transformOrigin = "0 0";
    zoomInner.style.willChange = "transform";
    // display:inline-block makes zoomInner shrink-to-fit its content
    // instead of expanding to readingDiv's full width. That makes
    // `scrollWidth` reflect the actual page width rather than the
    // viewport width, so readingDiv's width-after-zoom doesn't leave
    // an empty band of background to the right of the content.
    zoomInner.style.display = "inline-block";
    zoomInner.style.padding = "24px";
    zoomInner.style.boxSizing = "border-box";
    // Strip readingDiv's padding/margin so zoomInner sits at (0,0)
    // of readingDiv (the scroll-content frame's origin).
    readingDiv.style.padding = "0";
    readingDiv.style.margin = "0";
    // Vertical-only overflow on readingDiv lets the horizontal scroll
    // bar live on the outer scroller (contentEl) rather than appearing
    // unnecessarily here.
    readingDiv.style.overflow = "visible";

    let committedScale = 1;
    let pendingScale = 1;
    let pendingTx = 0;
    let pendingTy = 0;
    let naturalW = 0;
    let naturalH = 0;
    const measureNatural = () => {
      // In SVG mode the per-page SVGs are sized at base × committedScale
      // after a commit; divide back out so naturalW/H always represent
      // the "size at zoom 1" needed by readingDiv.width = natural × scale.
      // In PDF mode canvases don't change size with zoom, so scrollWidth
      // already equals the 1× natural size.
      const factor =
        this.plugin.settings.previewRenderer === "svg"
          ? committedScale || 1
          : 1;
      naturalW = zoomInner.scrollWidth / factor;
      naturalH = zoomInner.scrollHeight / factor;
    };

    const findScroller = (): HTMLElement => {
      let el: HTMLElement | null = readingDiv;
      while (el) {
        const oy = window.getComputedStyle(el).overflowY;
        if (
          (oy === "auto" || oy === "scroll") &&
          el.scrollHeight > el.clientHeight + 1
        ) {
          return el;
        }
        el = el.parentElement;
      }
      return readingDiv;
    };

    const applyTransform = () => {
      zoomInner.style.transform = `translate(${pendingTx}px, ${pendingTy}px) scale(${pendingScale})`;
    };

    const stepZoom = (newScale: number, clientX: number, clientY: number) => {
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newScale));
      // Use the live bounding rect (post-transform position of
      // zoomInner's pre-transform origin = rect.left - pendingTx).
      // The world point (zoomInner-local, pre-transform) under the
      // cursor is (clientX - rect.left) / pendingScale.
      const rect = zoomInner.getBoundingClientRect();
      const worldX = (clientX - rect.left) / pendingScale;
      const worldY = (clientY - rect.top) / pendingScale;
      // Goal: at the new scale, the same world point should sit under
      // the cursor again ⇒ new rect.left = clientX − worldX × newScale.
      // newTx = pendingTx + (newRectLeft − rect.left), since
      // newRectLeft − rect.left = newTx − pendingTx (translate is in
      // viewport units in the `translate(tx) scale(s)` form we use).
      pendingTx += clientX - worldX * clamped - rect.left;
      pendingTy += clientY - worldY * clamped - rect.top;
      pendingScale = clamped;
      applyTransform();
    };

    let commitTimer: number | null = null;
    const scheduleCommit = () => {
      if (commitTimer != null) window.clearTimeout(commitTimer);
      commitTimer = window.setTimeout(commit, COMMIT_DELAY_MS);
    };

    // Convert the live transform state into a clean (no-translate)
    // representation. Two modes:
    //
    // - SVG: re-size each per-page <svg> so the browser re-rasterizes
    //   the vector primitives at the new resolution (crisp at any
    //   zoom). zoomInner's transform resets to identity.
    // - PDF (bitmap canvases that can't be cheaply re-rasterized):
    //   keep transform: scale on zoomInner. Image stays bitmap-
    //   stretched (still blurry at non-1× zoom). A proper PDF crisp
    //   path would re-rasterize PDFium at the new scale — TODO.
    //
    // Scroll math is the same in either mode: pre-commit visual
    // position is preserved by setting scroll_after = scroll_before
    // − pendingTx, since pendingTx is in unscaled viewport units in
    // the `translate(tx) scale(s)` transform form we use.
    const isSvgMode = () =>
      this.plugin.settings.previewRenderer === "svg";
    const commit = () => {
      commitTimer = null;
      if (!naturalW || !naturalH) measureNatural();
      if (!naturalW || !naturalH) return;
      if (pendingTx === 0 && pendingTy === 0 && pendingScale === committedScale) return;

      const scroller = findScroller();
      const newScrollLeft = scroller.scrollLeft - pendingTx;
      const newScrollTop = scroller.scrollTop - pendingTy;

      readingDiv.style.width = naturalW * pendingScale + "px";
      readingDiv.style.height = naturalH * pendingScale + "px";
      pendingTx = 0;
      pendingTy = 0;
      if (isSvgMode()) {
        // Bake the new zoom into each SVG's CSS dimensions so the
        // browser re-paints vector primitives at the new resolution.
        const svgs = zoomInner.querySelectorAll(
          ":scope > .typst-pdf-page > svg",
        ) as NodeListOf<SVGSVGElement>;
        svgs.forEach((svg) => {
          const bW = parseFloat(svg.dataset.baseW || "0");
          const bH = parseFloat(svg.dataset.baseH || "0");
          if (bW > 0 && bH > 0) {
            svg.style.width = `${bW * pendingScale}px`;
            svg.style.height = `${bH * pendingScale}px`;
          }
        });
        zoomInner.style.transform = "";
      } else {
        zoomInner.style.transform = `scale(${pendingScale})`;
      }
      scroller.scrollLeft = newScrollLeft;
      scroller.scrollTop = newScrollTop;
      committedScale = pendingScale;
    };

    // Re-measure naturals on content change. If a recompile happens
    // outside a gesture, also rewrite readingDiv dimensions so the
    // scrollbar stays in sync. In SVG mode, also re-apply the current
    // committedScale to any freshly inserted SVGs (renderers insert
    // them at base size, so without this they'd briefly show at 1×
    // before being corrected on the next user zoom).
    const mo = new MutationObserver(() => {
      requestAnimationFrame(() => {
        if (isSvgMode() && committedScale !== 1) {
          const svgs = zoomInner.querySelectorAll(
            ":scope > .typst-pdf-page > svg",
          ) as NodeListOf<SVGSVGElement>;
          svgs.forEach((svg) => {
            const bW = parseFloat(svg.dataset.baseW || "0");
            const bH = parseFloat(svg.dataset.baseH || "0");
            if (bW <= 0 || bH <= 0) return;
            const wantW = bW * committedScale;
            const curW = parseFloat(svg.style.width || "0");
            if (Math.abs(curW - wantW) > 0.5) {
              svg.style.width = `${wantW}px`;
              svg.style.height = `${bH * committedScale}px`;
            }
          });
        }
        measureNatural();
        if (!naturalW || !naturalH) return;
        if (pendingTx === 0 && pendingTy === 0) {
          readingDiv.style.width = naturalW * committedScale + "px";
          readingDiv.style.height = naturalH * committedScale + "px";
        }
      });
    });
    mo.observe(zoomInner, { childList: true, subtree: true });

    readingDiv.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const factor = 1 - e.deltaY * WHEEL_TO_ZOOM;
        stepZoom(pendingScale * factor, e.clientX, e.clientY);
        scheduleCommit();
      },
      { passive: false },
    );
  }

  // Ensure a `.typst-zoom-inner` child exists inside readingDiv and
  // that any pre-existing per-page divs are moved into it. The
  // renderers target this inner element so transform-based zoom can
  // apply cleanly without affecting readingDiv's layout box.
  private ensureZoomInner(readingDiv: HTMLElement): HTMLElement {
    let inner = readingDiv.querySelector(
      ":scope > .typst-zoom-inner",
    ) as HTMLElement | null;
    if (inner) return inner;
    inner = document.createElement("div");
    inner.classList.add("typst-zoom-inner");
    // Move any existing page children into the new inner wrapper.
    const existing = Array.from(
      readingDiv.querySelectorAll(":scope > .typst-pdf-page"),
    );
    for (const child of existing) inner.appendChild(child);
    readingDiv.appendChild(inner);
    return inner;
  }

  // Choose where a click-to-source jump should open a not-yet-open
  // file. Mirrors the user's crossFileJumpTarget setting.
  private pickCrossFileJumpTarget(): WorkspaceLeaf {
    const mode = this.plugin.settings.crossFileJumpTarget;
    switch (mode) {
      case "new-tab":
        return this.app.workspace.getLeaf("tab");
      case "new-split-right":
        return this.app.workspace.getLeaf("split", "vertical");
      case "new-split-down":
        return this.app.workspace.getLeaf("split", "horizontal");
      case "current-pane":
        return this.leaf;
      case "sibling-pane-or-tab":
      default: {
        let sibling: WorkspaceLeaf | null = null;
        const root = this.leaf.getRoot();
        this.app.workspace.iterateAllLeaves((other) => {
          if (sibling) return;
          if (other === this.leaf) return;
          if (other.getRoot() !== root) return;
          sibling = other;
        });
        return sibling ?? this.app.workspace.getLeaf("tab");
      }
    }
  }

  // Debounced source→preview sync: when the editor cursor moves,
  // find a sibling typst-view that's previewing the same file and
  // scroll it to the corresponding rendered position. Mirrors
  // click-to-source in the other direction.
  private cursorSyncTimer: number | null = null;
  private handleCursorChange(line: number, column: number): void {
    if (!this.plugin.settings.enableSourceToPreviewSync) return;
    if (this.cursorSyncTimer != null) {
      window.clearTimeout(this.cursorSyncTimer);
    }
    const delay = this.plugin.settings.sourceToPreviewSyncDebounce;
    this.cursorSyncTimer = window.setTimeout(() => {
      this.cursorSyncTimer = null;
      void this.scrollPreviewToCursor(line, column);
    }, delay);
  }

  // Scroll a `readingDiv` so the point (yPx in CSS px) within the
  // page at index `pageIdx` lands roughly centered in the viewport.
  private scrollReadingDivToPageY(
    readingDiv: HTMLElement,
    pageIdx: number,
    yPx: number,
  ): void {
    const pageContainers = readingDiv.querySelectorAll(
      ":scope > .typst-pdf-page",
    );
    const pageContainer = pageContainers[pageIdx] as HTMLElement | undefined;
    if (!pageContainer) return;

    // Walk up to find the first ancestor that actually scrolls. The
    // CSS sets overflow on .typst-reading-mode but in practice the
    // view's contentEl is what scrolls.
    let scroller: HTMLElement | null = readingDiv;
    let depth = 0;
    while (scroller) {
      const overflowY = window.getComputedStyle(scroller).overflowY;
      const scrollable = scroller.scrollHeight > scroller.clientHeight + 1;
      if (scrollable && (overflowY === "auto" || overflowY === "scroll")) {
        break;
      }
      scroller = scroller.parentElement;
      depth++;
      if (depth > 10) break;
    }
    if (!scroller) return;

    const pageRect = pageContainer.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const targetViewportY = pageRect.top + yPx;
    const delta =
      targetViewportY - scrollerRect.top - scroller.clientHeight / 2;
    scroller.scrollTop += delta;
  }

  private async scrollPreviewToCursor(
    line: number,
    column: number,
  ): Promise<void> {
    const filePath = this.file?.path;
    if (!filePath) return;

    let previewReadingDiv: HTMLElement | null = null;
    const leaves = this.app.workspace.getLeavesOfType("typst-view");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view instanceof TypstView)) continue;
      if (view === this) continue;
      if (view.getCurrentMode() !== "reading") continue;
      const contentEl = view.getContentElement();
      if (!contentEl) continue;
      previewReadingDiv =
        (contentEl.querySelector(
          ":scope > .typst-reading-mode",
        ) as HTMLElement | null) ??
        (contentEl.querySelector(
          ".typst-reading-mode",
        ) as HTMLElement | null);
      if (previewReadingDiv) break;
    }
    if (!previewReadingDiv) return;

    let queryLine = line;
    if (filePath === this.plugin.lastCompilePath) {
      queryLine += this.plugin.lastCompilePrefixLines;
    }

    const result = await this.plugin.cursorToPreview(
      filePath,
      queryLine,
      column,
    );
    if (!result) return;
    // The view (or the preview's DOM) may have been torn down during
    // the async round-trip — bail before touching a detached element.
    if (!previewReadingDiv.isConnected) return;
    if (!this.file) return;

    const yPx = result.y * PDF_RENDER_SCALE;
    this.scrollReadingDivToPageY(previewReadingDiv, result.page, yPx);
  }

  private handleContentChange(content: string): void {
    this.requestSave();

    if (
      this.livePreviewActive &&
      this.plugin.settings.enableLivePreview &&
      this.file
    ) {
      const debounceDelay = this.plugin.settings.livePreviewDebounce;
      this.compilationManager.scheduleCompile(
        content,
        this.file.path,
        debounceDelay,
      );
    }
  }

  private saveEditorState(): void {
    if (this.currentMode === "source") {
      this.stateManager.saveEditorState(this.typstEditor);
    } else if (this.currentMode === "reading") {
      const contentEl = this.getContentElement();
      this.stateManager.saveReadingScrollTop(contentEl);
    }
  }

  private restoreEditorState(): void {
    this.stateManager.restoreEditorState(this.typstEditor);
  }

  private async showReadingMode(
    compiled: Uint8Array | string[],
  ): Promise<void> {
    const contentEl = this.getContentElement();
    if (!contentEl) return;

    // Reuse the existing reading-mode div if one is already there from a
    // previous compile — keeps the prior preview visible while we
    // re-rasterize, avoiding an empty-flash on every recompile. The
    // editor is only torn down on a fresh entry (from source mode).
    let readingDiv = contentEl.querySelector(
      ":scope > .typst-reading-mode",
    ) as HTMLElement | null;
    if (!readingDiv) {
      contentEl.empty();
      this.cleanupEditor();
      readingDiv = contentEl.createDiv("typst-reading-mode");
      this.attachPreviewZoom(readingDiv);
    }
    // Renderers insert per-page divs as children of the zoom-inner
    // wrapper. attachPreviewZoom (called on first creation) ensured
    // the wrapper exists; ensureZoomInner is idempotent on reuse.
    const renderTarget = this.ensureZoomInner(readingDiv);

    const onBacklink = (linkTarget: string, newTab: boolean) => {
      if (this.file) {
        this.app.workspace.openLinkText(
          linkTarget,
          this.file.path,
          newTab ? "tab" : false,
        );
      }
    };
    const onJump = async (page: number, x: number, y: number) => {
      const result = await this.plugin.jumpFromClick(page, x, y);
      if (!result) return;
      const vaultPath = result.file.replace(/^\//, "");
      let zeroLine = result.line;
      if (vaultPath === this.plugin.lastCompilePath) {
        zeroLine -= this.plugin.lastCompilePrefixLines;
      }
      if (zeroLine < 0) return;
      const line = zeroLine + 1;
      const col = result.column + 1;

      // 1. Paired source view
      if (
        this.pairedView &&
        this.pairedView.file?.path === vaultPath &&
        this.pairedView.jumpToSourcePosition(line, col)
      ) {
        this.app.workspace.setActiveLeaf(this.pairedView.leaf, {
          focus: true,
        });
        return;
      }
      // 2. Open source-mode leaf for target
      const leaves = this.app.workspace.getLeavesOfType("typst-view");
      for (const leaf of leaves) {
        const view = leaf.view;
        if (
          view instanceof TypstView &&
          view !== this &&
          view.file?.path === vaultPath &&
          view.jumpToSourcePosition(line, col)
        ) {
          this.app.workspace.setActiveLeaf(leaf, { focus: true });
          return;
        }
      }
      // 3. Reading-mode leaf for target → toggle then jump
      for (const leaf of leaves) {
        const view = leaf.view;
        if (
          view instanceof TypstView &&
          view !== this &&
          view.file?.path === vaultPath
        ) {
          await view.toggleMode();
          await new Promise((r) => setTimeout(r, 100));
          if (view.jumpToSourcePosition(line, col)) {
            this.app.workspace.setActiveLeaf(leaf, { focus: true });
          }
          return;
        }
      }
      // 4. Not open anywhere — pick destination per setting
      const targetFile = this.app.vault.getAbstractFileByPath(vaultPath);
      if (!(targetFile instanceof TFile)) {
        new Notice(`Could not find ${vaultPath}`, 3000);
        return;
      }
      const targetLeaf = this.pickCrossFileJumpTarget();
      await targetLeaf.openFile(targetFile);
      this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
      for (let i = 0; i < 30; i++) {
        const view = targetLeaf.view;
        if (view instanceof TypstView) {
          if (view.getCurrentMode() !== "source") {
            await view.toggleMode();
            await new Promise((r) => setTimeout(r, 100));
          }
          if (view.jumpToSourcePosition(line, col)) return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    try {
      if (Array.isArray(compiled)) {
        // SVG path — vector rendering, native smooth zoom.
        this.svgRenderer.renderSvgs(
          compiled,
          renderTarget,
          onBacklink,
          onJump,
        );
      } else {
      await this.pdfRenderer.renderPdf(
        compiled,
        renderTarget,
        this.plugin.settings.enableTextLayer,
        (linkTarget: string, newTab: boolean) => {
          if (this.file) {
            this.app.workspace.openLinkText(
              linkTarget,
              this.file.path,
              newTab ? "tab" : false,
            );
          }
        },
        async (page: number, x: number, y: number) => {
          const result = await this.plugin.jumpFromClick(page, x, y);
          if (!result) return;
          const vaultPath = result.file.replace(/^\//, "");

          // typst byte_to_line_column is 0-indexed; Monaco is 1-indexed.
          // Subtract the layout-function prefix the compile injected
          // *only* for the main file (the one that was prefixed).
          // Included files weren't prefixed, so their lines are correct.
          let zeroLine = result.line;
          if (vaultPath === this.plugin.lastCompilePath) {
            zeroLine -= this.plugin.lastCompilePrefixLines;
          }
          if (zeroLine < 0) return;
          const line = zeroLine + 1;
          const col = result.column + 1;

          // 1. Paired source view (split preview) — preferred target.
          if (
            this.pairedView &&
            this.pairedView.file?.path === vaultPath &&
            this.pairedView.jumpToSourcePosition(line, col)
          ) {
            this.app.workspace.setActiveLeaf(this.pairedView.leaf, {
              focus: true,
            });
            return;
          }

          // 2. Any other open typst-view leaf in source mode for the
          //    target file.
          const leaves = this.app.workspace.getLeavesOfType("typst-view");
          for (const leaf of leaves) {
            const view = leaf.view;
            if (
              view instanceof TypstView &&
              view !== this &&
              view.file?.path === vaultPath &&
              view.jumpToSourcePosition(line, col)
            ) {
              this.app.workspace.setActiveLeaf(leaf, { focus: true });
              return;
            }
          }

          // 3. Existing leaf shows the file in reading mode — toggle to
          //    source and jump.
          for (const leaf of leaves) {
            const view = leaf.view;
            if (
              view instanceof TypstView &&
              view !== this &&
              view.file?.path === vaultPath
            ) {
              await view.toggleMode();
              await new Promise((r) => setTimeout(r, 100));
              if (view.jumpToSourcePosition(line, col)) {
                this.app.workspace.setActiveLeaf(leaf, { focus: true });
              }
              return;
            }
          }

          // 4. File isn't open anywhere — pick a destination leaf per
          //    the crossFileJumpTarget setting.
          const targetFile = this.app.vault.getAbstractFileByPath(vaultPath);
          if (!(targetFile instanceof TFile)) {
            new Notice(`Could not find ${vaultPath}`, 3000);
            return;
          }
          const targetLeaf = this.pickCrossFileJumpTarget();
          await targetLeaf.openFile(targetFile);
          this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
          // Poll for the new view to mount and the editor to be ready.
          for (let i = 0; i < 30; i++) {
            const view = targetLeaf.view;
            if (view instanceof TypstView) {
              if (view.getCurrentMode() !== "source") {
                await view.toggleMode();
                await new Promise((r) => setTimeout(r, 100));
              }
              if (view.jumpToSourcePosition(line, col)) return;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
        },
      );
      } // end PDF branch
      const savedScroll = this.stateManager.getSavedReadingScrollTop();

      if (savedScroll > 0) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (contentEl) {
              contentEl.scrollTop = savedScroll;
            }
          });
        });
      }
    } catch (error) {
      console.error("PDF rendering failed:", error);
    }
  }

  clear(): void {
    this.fileContent = "";
    if (this.typstEditor) {
      this.typstEditor.setContent("");
    }
  }
}
