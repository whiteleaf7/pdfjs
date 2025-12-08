import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';

// pdf.js の Worker を設定
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// CMap と標準フォントの URL を設定（日本語などの CJK フォント対応）
const CMAP_URL = '/cmaps/';
const STANDARD_FONT_URL = '/standard_fonts/';

// ズームプリセット
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

export function PdfViewer() {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);

  // ページをレンダリング
  const renderPage = useCallback(
    async (doc: PDFDocumentProxy, pageNum: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      try {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale });

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        await page.render({
          canvasContext: ctx,
          canvas,
          viewport,
        }).promise;
      } catch (err) {
        setError(
          `ページのレンダリングに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [scale],
  );

  // ページが変更されたらレンダリング
  useEffect(() => {
    if (pdfDoc && currentPage > 0) {
      renderPage(pdfDoc, currentPage);
    }
  }, [pdfDoc, currentPage, renderPage]);

  // 全画面状態の監視
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // PDF ファイルを読み込む
  const loadPdf = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setPdfDoc(null);
    setCurrentPage(1);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const doc = await pdfjsLib.getDocument({
        data: arrayBuffer,
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: STANDARD_FONT_URL,
        useSystemFonts: true,
      }).promise;

      setPdfDoc(doc);
      setTotalPages(doc.numPages);
    } catch (err) {
      setError(
        `PDF の読み込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // ファイル選択ハンドラ
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      loadPdf(file);
    } else if (file) {
      setError('PDF ファイルを選択してください');
    }
  };

  // ドラッグ&ドロップハンドラ
  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      loadPdf(file);
    } else if (file) {
      setError('PDF ファイルを選択してください');
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  // ズーム操作
  const zoomIn = () => {
    setScale((s) => Math.min(MAX_ZOOM, s + ZOOM_STEP));
  };

  const zoomOut = () => {
    setScale((s) => Math.max(MIN_ZOOM, s - ZOOM_STEP));
  };

  const handleZoomChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setScale(Number(event.target.value));
  };

  // 全画面表示の切り替え
  const toggleFullscreen = async () => {
    if (!viewerRef.current) return;

    try {
      if (!document.fullscreenElement) {
        await viewerRef.current.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      setError(
        `全画面表示の切り替えに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return (
    <div
      ref={viewerRef}
      className={`pdf-viewer ${isFullscreen ? 'pdf-viewer--fullscreen' : ''}`}
    >
      <div
        className="pdf-dropzone"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
        <p>PDF ファイルをドラッグ&ドロップ、またはクリックして選択</p>
      </div>

      {error && <div className="pdf-error">{error}</div>}

      {loading && <div className="pdf-loading">PDF を読み込み中...</div>}

      {pdfDoc && (
        <>
          <div className="pdf-toolbar">
            <div className="pdf-navigation">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                ← 前
              </button>
              <span>
                {currentPage} / {totalPages}
              </span>
              <button
                onClick={() =>
                  setCurrentPage((p) => Math.min(totalPages, p + 1))
                }
                disabled={currentPage === totalPages}
              >
                次 →
              </button>
            </div>

            <div className="pdf-zoom-controls">
              <button onClick={zoomOut} disabled={scale <= MIN_ZOOM}>
                −
              </button>
              <select value={scale} onChange={handleZoomChange}>
                {ZOOM_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {Math.round(preset * 100)}%
                  </option>
                ))}
                {!ZOOM_PRESETS.includes(scale) && (
                  <option value={scale}>{Math.round(scale * 100)}%</option>
                )}
              </select>
              <button onClick={zoomIn} disabled={scale >= MAX_ZOOM}>
                +
              </button>
            </div>

            <div className="pdf-view-controls">
              <button onClick={toggleFullscreen} title="全画面表示">
                {isFullscreen ? '⛶' : '⛶'}
              </button>
            </div>
          </div>

          <div className="pdf-page-container">
            <canvas ref={canvasRef} className="pdf-page" />
          </div>
        </>
      )}
    </div>
  );
}
