import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';

const PDFIUM_WASM_URL =
  'https://cdn.jsdelivr.net/npm/@embedpdf/pdfium/dist/pdfium.wasm';

let pdfiumInstance: WrappedPdfiumModule | null = null;
let initPromise: Promise<WrappedPdfiumModule> | null = null;

// PDFiumを初期化（シングルトン）
export async function initPdfium(): Promise<WrappedPdfiumModule> {
  if (pdfiumInstance) {
    return pdfiumInstance;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const response = await fetch(PDFIUM_WASM_URL);
    const wasmBinary = await response.arrayBuffer();
    const pdfium = await init({ wasmBinary });
    pdfium.PDFiumExt_Init();
    pdfiumInstance = pdfium;
    return pdfium;
  })();

  return initPromise;
}

// PDFiumでページをレンダリング
export async function renderPageWithPdfium(
  pdfData: ArrayBuffer,
  pageNum: number, // 1-indexed
  scale: number,
  rotation: number, // 0, 90, 180, 270
  password?: string,
): Promise<ImageData> {
  const pdfium = await initPdfium();

  // PDFデータをWASMメモリにコピー
  const dataArray = new Uint8Array(pdfData);
  const filePtr = pdfium.pdfium.wasmExports.malloc(dataArray.length);
  pdfium.pdfium.HEAPU8.set(dataArray, filePtr);

  let docPtr = 0;
  let pagePtr = 0;
  let bitmapPtr = 0;

  try {
    // ドキュメントを開く
    docPtr = pdfium.FPDF_LoadMemDocument(
      filePtr,
      dataArray.length,
      password ? pdfium.pdfium.stringToUTF8(password) : 0,
    );

    if (!docPtr) {
      const error = pdfium.FPDF_GetLastError();
      throw new Error(`Failed to load PDF document (error code: ${error})`);
    }

    // ページを開く (0-indexed)
    pagePtr = pdfium.FPDF_LoadPage(docPtr, pageNum - 1);
    if (!pagePtr) {
      throw new Error(`Failed to load page ${pageNum}`);
    }

    // ページサイズを取得
    const pageWidth = pdfium.FPDF_GetPageWidthF(pagePtr);
    const pageHeight = pdfium.FPDF_GetPageHeightF(pagePtr);

    // 回転を考慮したサイズ計算
    const isRotated90or270 = rotation === 90 || rotation === 270;
    const renderWidth = Math.ceil(
      (isRotated90or270 ? pageHeight : pageWidth) * scale,
    );
    const renderHeight = Math.ceil(
      (isRotated90or270 ? pageWidth : pageHeight) * scale,
    );

    // ビットマップを作成 (BGRA形式)
    bitmapPtr = pdfium.FPDFBitmap_Create(renderWidth, renderHeight, 1);
    if (!bitmapPtr) {
      throw new Error('Failed to create bitmap');
    }

    // 白で塗りつぶし (0xFFFFFFFF = 白, ARGB形式)
    pdfium.FPDFBitmap_FillRect(
      bitmapPtr,
      0,
      0,
      renderWidth,
      renderHeight,
      0xffffffff,
    );

    // 回転フラグ (PDFiumの回転は時計回り)
    const rotationFlag = Math.floor(rotation / 90) % 4;

    // ページをレンダリング
    // FPDF_ANNOT = 0x01, FPDF_LCD_TEXT = 0x02
    const renderFlags = 0x01 | 0x02;
    pdfium.FPDF_RenderPageBitmap(
      bitmapPtr,
      pagePtr,
      0,
      0,
      renderWidth,
      renderHeight,
      rotationFlag,
      renderFlags,
    );

    // ビットマップバッファを取得
    const bufferPtr = pdfium.FPDFBitmap_GetBuffer(bitmapPtr);
    const stride = pdfium.FPDFBitmap_GetStride(bitmapPtr);

    // ピクセルデータをコピー (BGRA -> RGBA変換)
    const pixelData = new Uint8ClampedArray(renderWidth * renderHeight * 4);
    for (let y = 0; y < renderHeight; y++) {
      for (let x = 0; x < renderWidth; x++) {
        const srcOffset = bufferPtr + y * stride + x * 4;
        const dstOffset = (y * renderWidth + x) * 4;

        // BGRA to RGBA
        pixelData[dstOffset + 0] = pdfium.pdfium.HEAPU8[srcOffset + 2]; // R
        pixelData[dstOffset + 1] = pdfium.pdfium.HEAPU8[srcOffset + 1]; // G
        pixelData[dstOffset + 2] = pdfium.pdfium.HEAPU8[srcOffset + 0]; // B
        pixelData[dstOffset + 3] = pdfium.pdfium.HEAPU8[srcOffset + 3]; // A
      }
    }

    return new ImageData(pixelData, renderWidth, renderHeight);
  } finally {
    // リソースを解放
    if (bitmapPtr) {
      pdfium.FPDFBitmap_Destroy(bitmapPtr);
    }
    if (pagePtr) {
      pdfium.FPDF_ClosePage(pagePtr);
    }
    if (docPtr) {
      pdfium.FPDF_CloseDocument(docPtr);
    }
    pdfium.pdfium.wasmExports.free(filePtr);
  }
}

// PDFiumでサムネイルをレンダリング
export async function renderThumbnailWithPdfium(
  pdfData: ArrayBuffer,
  pageNum: number,
  scale: number,
  password?: string,
): Promise<string> {
  const imageData = await renderPageWithPdfium(
    pdfData,
    pageNum,
    scale,
    0,
    password,
  );

  // ImageDataをCanvasに描画してDataURLに変換
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  ctx.putImageData(imageData, 0, 0);

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
