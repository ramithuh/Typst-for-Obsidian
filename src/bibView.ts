import { TextFileView, WorkspaceLeaf } from "obsidian";

// Minimal plain-text editor for .bib files. Lets you see and edit
// BibTeX entries inside Obsidian without switching to an external app,
// without depending on Monaco. Future work: parse @key{...} entries
// and surface each entry as a separate graph-view node.

export const BIB_VIEW_TYPE = "typst-bib-view";

export class BibView extends TextFileView {
  private textarea: HTMLTextAreaElement | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return BIB_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.basename || "BibTeX File";
  }

  getIcon(): string {
    return "file-text";
  }

  // Obsidian polls these to read/write the file content.
  getViewData(): string {
    return this.textarea?.value ?? "";
  }

  setViewData(data: string, _clear: boolean): void {
    if (!this.textarea) this.ensureTextarea();
    if (this.textarea && this.textarea.value !== data) {
      this.textarea.value = data;
    }
  }

  clear(): void {
    if (this.textarea) this.textarea.value = "";
  }

  async onOpen(): Promise<void> {
    this.ensureTextarea();
  }

  async onClose(): Promise<void> {
    this.textarea = null;
  }

  private ensureTextarea(): void {
    if (this.textarea) return;
    this.contentEl.empty();
    this.contentEl.addClass("typst-bib-view-container");

    const ta = this.contentEl.createEl("textarea", {
      cls: "typst-bib-view-textarea",
    });
    ta.spellcheck = false;
    ta.autocomplete = "off";
    ta.style.width = "100%";
    ta.style.height = "100%";
    ta.style.boxSizing = "border-box";
    ta.style.padding = "1rem";
    ta.style.fontFamily =
      'ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", monospace';
    ta.style.fontSize = "13px";
    ta.style.lineHeight = "1.5";
    ta.style.border = "none";
    ta.style.outline = "none";
    ta.style.resize = "none";
    ta.style.background = "var(--background-primary)";
    ta.style.color = "var(--text-normal)";
    ta.style.tabSize = "2";

    // Obsidian's TextFileView debounces saves via requestSave().
    ta.addEventListener("input", () => {
      this.requestSave();
    });

    this.textarea = ta;
  }
}
