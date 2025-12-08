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

interface PdfViewerProps {
  scale?: number;
}

export function PdfViewer({ scale = 1.5 }: PdfViewerProps) {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className="pdf-viewer">
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
          <div className="pdf-navigation">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              ← 前のページ
            </button>
            <span>
              {currentPage} / {totalPages} ページ
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              次のページ →
            </button>
          </div>

          <div className="pdf-page-container">
            <canvas ref={canvasRef} className="pdf-page" />
          </div>
        </>
      )}
    </div>
  );
}
