use fast_image_resize as fr;
use serde::Serialize;
use typst::{
    layout::{Abs, PagedDocument, Point},
    World,
};
use wasm_bindgen::prelude::*;
use web_sys::ImageData;

mod diagnostic;
mod file_entry;
mod jump;
mod render;
mod world;

use crate::world::SystemWorld;

#[wasm_bindgen]
pub struct Compiler {
    resizer: fr::Resizer,
    world: SystemWorld,
    last_doc: Option<PagedDocument>,
}

#[derive(Serialize)]
struct JumpResult {
    file: String,
    line: usize,
    column: usize,
    byte_offset: usize,
}

#[derive(Serialize)]
struct CursorResult {
    page: usize,
    x: f64,
    y: f64,
}

#[wasm_bindgen]
impl Compiler {
    #[wasm_bindgen(constructor)]
    pub fn new(root: String, request_data: &js_sys::Function) -> Self {
        console_error_panic_hook::set_once();

        Self {
            world: SystemWorld::new(root, request_data),
            resizer: fr::Resizer::default(),
            last_doc: None,
        }
    }

    pub fn compile_image(
        &mut self,
        text: String,
        path: String,
        pixel_per_pt: f32,
        fill: String,
        size: u32,
        display: bool,
    ) -> Result<ImageData, JsValue> {
        let document = self.world.compile(text, path)?;
        let image = render::to_image(&mut self.resizer, &document, pixel_per_pt, fill, size, display);
        self.last_doc = Some(document);
        image
    }

    pub fn compile_svg(&mut self, text: String, path: String) -> Result<String, JsValue> {
        let document = self.world.compile(text, path)?;
        let svg = render::to_svg(&document);
        self.last_doc = Some(document);
        Ok(svg)
    }

    // Compile and return one SVG string per page, joined with a sentinel
    // separator. Caller splits on it. We use a multi-string return via
    // JSON-encoded array because wasm_bindgen's Vec<String> support is
    // less ergonomic than passing a single String the JS side parses.
    pub fn compile_svgs(&mut self, text: String, path: String) -> Result<JsValue, JsValue> {
        let document = self.world.compile(text, path)?;
        let svgs = render::to_svgs(&document);
        self.last_doc = Some(document);
        serde_wasm_bindgen::to_value(&svgs)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn compile_pdf(&mut self, text: String, path: String) -> Result<Vec<u8>, JsValue> {
        let document = self.world.compile(text, path)?;
        let pdf = render::to_pdf(&document)?;
        self.last_doc = Some(document);
        Ok(pdf)
    }

    /// Given a click at (x, y) in PDF user-space (points) on a 0-indexed
    /// page of the most recently compiled document, return the source
    /// location at that position, or null if none.  Adapted from
    /// `tinymist-query/src/jump.rs::jump_from_click` — see jump.rs.
    pub fn jump_from_click(
        &self,
        page: u32,
        x: f32,
        y: f32,
    ) -> Result<JsValue, JsValue> {
        let doc = self
            .last_doc
            .as_ref()
            .ok_or_else(|| JsValue::from_str("no document compiled yet"))?;
        let frame = doc
            .pages
            .get(page as usize)
            .map(|p| &p.frame)
            .ok_or_else(|| JsValue::from_str("page out of range"))?;

        let click = Point::new(Abs::pt(x as f64), Abs::pt(y as f64));

        let (span, offset) = match jump::jump_from_click(&self.world, frame, click) {
            Some(hit) => hit,
            None => return Ok(JsValue::NULL),
        };

        let id = match span.id() {
            Some(id) => id,
            None => return Ok(JsValue::NULL),
        };
        let source = self
            .world
            .source(id)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let span_range = match source.range(span) {
            Some(r) => r,
            None => return Ok(JsValue::NULL),
        };
        let byte = span_range.start + offset;
        let (line, column) = source
            .lines()
            .byte_to_line_column(byte)
            .unwrap_or((0, 0));
        let file = id.vpath().as_rooted_path().to_string_lossy().to_string();

        let result = JumpResult {
            file,
            line,
            column,
            byte_offset: byte,
        };
        serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Inverse of `jump_from_click`: given a cursor at (line, column)
    /// in the source file at `path` (both 0-indexed), find a point in
    /// the rendered document that corresponds to that cursor. Returns
    /// `{ page, x, y }` in PDF user-space pt, or null. Adapted from
    /// tinymist's `jump_from_cursor` — see jump.rs.
    pub fn cursor_to_preview(
        &self,
        path: String,
        line: u32,
        column: u32,
    ) -> Result<JsValue, JsValue> {
        let doc = self
            .last_doc
            .as_ref()
            .ok_or_else(|| JsValue::from_str("no document compiled yet"))?;

        let hit = match jump::cursor_to_preview(
            &self.world,
            doc,
            &path,
            line as usize,
            column as usize,
        ) {
            Some(h) => h,
            None => return Ok(JsValue::NULL),
        };

        let result = CursorResult {
            page: hit.0,
            x: hit.1,
            y: hit.2,
        };
        serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Drop the cached source/bytes for `path` so the next compile
    /// re-reads it. Call when the vault file at `path` is modified,
    /// renamed, or deleted. Idempotent; no-op if `path` was never read.
    pub fn invalidate_path(&mut self, path: String) {
        self.world.invalidate_path(&path);
    }

    pub fn add_font(&mut self, data: Vec<u8>) {
        self.world.add_font(data);
    }

    pub fn reset_fonts(&mut self) {
        self.world.reset_fonts();
    }
}
