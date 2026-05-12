import { Events } from "obsidian";
import TypstForObsidian from "./main";

// `data` is a Uint8Array of PDF bytes when the user's previewRenderer
// setting is "pdf", or an array of per-page SVG strings when "svg".
// Consumers should branch on `type` (or use the convenience pdfData
// alias for PDF-only call sites that haven't been updated yet).
export interface CompilationResult {
  type: "pdf" | "svg";
  data: Uint8Array | string[];
  pdfData?: Uint8Array; // legacy alias for PDF call sites; undefined when type === "svg"
  source: string;
  filePath: string;
}

export class CompilationManager extends Events {
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingSource: string | null = null;
  private pendingPath: string | null = null;
  private isCompiling: boolean = false;
  private plugin: TypstForObsidian;

  constructor(plugin: TypstForObsidian) {
    super();
    this.plugin = plugin;
  }

  scheduleCompile(source: string, filePath: string, delay: number): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.pendingSource = source;
    this.pendingPath = filePath;

    this.debounceTimer = setTimeout(() => {
      this.executeCompilation();
    }, delay);
  }

  cancelPending(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingSource = null;
    this.pendingPath = null;
  }

  async compileNow(
    source: string,
    filePath: string
  ): Promise<Uint8Array | string[] | null> {
    this.cancelPending();

    if (this.isCompiling) {
      return null;
    }

    return await this.performCompilation(source, filePath);
  }

  isCompilingNow(): boolean {
    return this.isCompiling;
  }

  private async executeCompilation(): Promise<void> {
    if (!this.pendingSource || !this.pendingPath) {
      return;
    }

    const source = this.pendingSource;
    const filePath = this.pendingPath;

    this.pendingSource = null;
    this.pendingPath = null;

    await this.performCompilation(source, filePath);
  }

  private async performCompilation(
    source: string,
    filePath: string
  ): Promise<Uint8Array | string[] | null> {
    if (this.isCompiling) {
      return null;
    }

    this.isCompiling = true;
    this.trigger("compilation-start", { source, filePath });

    try {
      const useSvg = this.plugin.settings.previewRenderer === "svg";
      const data = useSvg
        ? await this.plugin.compileToSvgs(source, filePath)
        : await this.plugin.compileToPdf(source, filePath);

      const result: CompilationResult = {
        type: useSvg ? "svg" : "pdf",
        data,
        pdfData: useSvg ? undefined : (data as Uint8Array),
        source,
        filePath,
      };

      this.trigger("compilation-complete", result);
      return data;
    } catch (error) {
      this.trigger("compilation-error", error);
      return null;
    } finally {
      this.isCompiling = false;
    }
  }

  destroy(): void {
    this.cancelPending();
  }
}
