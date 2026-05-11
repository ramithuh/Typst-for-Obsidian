import typstInit, * as typst from "../pkg";

import { CompileImageCommand, CompilePdfCommand, Message } from "src/types";

// Error codes for SharedArrayBuffer
const ERROR_GENERIC = 1;
const ERROR_NOT_FOUND = 2;
const ERROR_NETWORK = 3;

let canUseSharedArrayBuffer = false;

let decoder = new TextDecoder();
let basePath: string;
let packagePath: string;
let packages: string[] = [];
const xhr = new XMLHttpRequest();

function requestData(path: string): string | Uint8Array {
  try {
    if (!canUseSharedArrayBuffer) {
      if (path.startsWith("@")) {
        if (packages.includes(path.slice(1))) {
          return packagePath + path.slice(1);
        }
        throw ERROR_NOT_FOUND;
      }
      path = "http://localhost/_capacitor_file_" + basePath + "/" + path;
      xhr.open("GET", path, false);
      try {
        xhr.send();
      } catch (e) {
        console.error(e);
        throw ERROR_NETWORK;
      }
      if (xhr.status == 404) {
        throw ERROR_NOT_FOUND;
      }
      return xhr.responseText;
    }
    // prettier-ignore
    // @ts-ignore
    let buffer = new Int32Array(new SharedArrayBuffer(4, { maxByteLength: 1e8 }));
    buffer[0] = 0;

    postMessage({ buffer, path });
    const res = Atomics.wait(buffer, 0, 0);

    if (buffer[0] == 0) {
      const byteLength = buffer[1];
      if (path.endsWith(":binary")) {
        const sharedView = new Uint8Array(buffer.buffer, 8, byteLength);
        return new Uint8Array(sharedView);
      } else {
        const sharedView = new Uint8Array(buffer.buffer, 8, byteLength);
        const regularArray = new Uint8Array(sharedView);
        return decoder.decode(regularArray);
      }
    }
    throw buffer[0];
  } catch (e) {
    if (typeof e != "number") {
      console.error(e);
      throw ERROR_GENERIC;
    }
    throw e;
  }
}

let compiler: typst.Compiler;

onmessage = (ev: MessageEvent<Message>) => {
  const message = ev.data;
  switch (message.type) {
    case "canUseSharedArrayBuffer":
      canUseSharedArrayBuffer = message.data;
      break;
    case "startup":
      typstInit(message.data.wasm)
        .then((_) => {
          compiler = new typst.Compiler("", requestData);
          postMessage({ type: "ready" });
        })
        .catch((error) => {
          postMessage({ type: "error", error: error.toString() });
        });
      basePath = message.data.basePath;
      packagePath = message.data.packagePath;
      break;
    case "fonts":
      if (!compiler) {
        break;
      }
      message.data.forEach((font: any) =>
        compiler.add_font(new Uint8Array(font))
      );
      break;
    case "reset_fonts":
      if (!compiler) {
        break;
      }
      compiler.reset_fonts();
      break;
    case "compile":
      if (!compiler) {
        postMessage({ error: "Compiler not initialized" });
        return;
      }
      try {
        if (message.data.format == "image") {
          const data: CompileImageCommand = message.data;
          const result = compiler.compile_image(
            data.source,
            data.path,
            data.pixel_per_pt,
            data.fill,
            data.size,
            data.display
          );
          postMessage(result);
        } else if (message.data.format == "svg") {
          const result = compiler.compile_svg(
            message.data.source,
            message.data.path
          );
          postMessage(result);
        } else if (message.data.format == "pdf") {
          const data: CompilePdfCommand = message.data;
          const result = compiler.compile_pdf(data.source, data.path);
          postMessage(result);
        }
      } catch (error) {
        postMessage({ error: error.toString() });
      }
      break;
    case "jump":
      if (!compiler) {
        postMessage({ type: "jumpResult", data: null });
        return;
      }
      try {
        const d = message.data;
        const result = compiler.jump_from_click(d.page, d.x, d.y);
        postMessage({ type: "jumpResult", data: result });
      } catch (error) {
        postMessage({
          type: "jumpResult",
          data: null,
          error: error.toString(),
        });
      }
      break;
    case "packages":
      packages = message.data;
      break;
    default:
      console.error("Worker: Unknown message type:", message);
      throw message;
  }
};
