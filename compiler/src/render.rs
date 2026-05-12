use fast_image_resize::{ self as fr, images::Image };
use fr::Resizer;
use typst::layout::PagedDocument;
use wasm_bindgen::Clamped;
use web_sys::ImageData;

pub fn to_image(
    resizer: &mut Resizer,
    document: &PagedDocument,
    pixel_per_pt: f32,
    fill: String,
    size: u32,
    display: bool
) -> Result<ImageData, wasm_bindgen::JsValue> {
    let mut pixmap = typst_render::render(&document.pages[0], pixel_per_pt);
    if !fill.is_empty() {
        let fill_bytes = hex::decode(&fill[1..]).unwrap_or_default();
        if fill_bytes.len() >= 4 {
            let r = fill_bytes[0];
            let g = fill_bytes[1];
            let b = fill_bytes[2];
            let a = fill_bytes[3];

            if a > 0 {
                for pixel in pixmap.pixels_mut() {
                    if pixel.alpha() == 0 {
                        *pixel = tiny_skia::ColorU8::from_rgba(r, g, b, a).premultiply();
                    }
                }
            }
        }
    }

    let width = pixmap.width();
    let height = pixmap.height();

    let mut src_image = Image::from_slice_u8(
        width,
        height,
        pixmap.data_mut(),
        fr::PixelType::U8x4
    ).unwrap();

    let alpha_mul_div = fr::MulDiv::default();
    alpha_mul_div.multiply_alpha_inplace(&mut src_image).unwrap();

    let dst_width = if display {
        size
    } else {
        (((size as f32) / (height as f32)) * (width as f32)) as u32
    };
    let dst_height = if display {
        (((size as f32) / (width as f32)) * (height as f32)) as u32
    } else {
        size
    };

    let mut dst_image = Image::new(dst_width, dst_height, src_image.pixel_type());

    resizer.resize(&src_image, &mut dst_image, None).unwrap();

    alpha_mul_div.divide_alpha_inplace(&mut dst_image).unwrap();

    return ImageData::new_with_u8_clamped_array_and_sh(
        Clamped(dst_image.buffer()),
        dst_width,
        dst_height
    );
}

pub fn to_svg(document: &PagedDocument) -> String {
    typst_svg::svg(&document.pages[0])
}

// Render every page as a separate SVG. Caller is responsible for
// laying them out in the DOM (typically one page per scroll position
// mirroring the PDF preview). Each SVG is self-contained with its own
// viewBox so it scales independently in the browser.
pub fn to_svgs(document: &PagedDocument) -> Vec<String> {
    document.pages.iter().map(|p| typst_svg::svg(p)).collect()
}

pub fn to_pdf(document: &PagedDocument) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    let pdf_options = typst_pdf::PdfOptions::default();

    match typst_pdf::pdf(document, &pdf_options) {
        Ok(pdf_bytes) => Ok(pdf_bytes),
        Err(e) => Err(wasm_bindgen::JsValue::from_str(&format!("PDF compilation failed: {:?}", e))),
    }
}
