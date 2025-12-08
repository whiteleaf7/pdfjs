import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PasswordResponses } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

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

// 検索結果の型
interface SearchMatch {
  pageNum: number;
  itemIndex: number;
  text: string;
}

export function PdfViewer() {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [pendingPdfData, setPendingPdfData] = useState<ArrayBuffer | null>(
    null,
  );
  const [showThumbnails, setShowThumbnails] = useState(false);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [isGeneratingThumbnails, setIsGeneratingThumbnails] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const thumbnailPanelRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);

  // テキストレイヤーをレンダリング
  const renderTextLayer = useCallback(
    async (
      page: PDFPageProxy,
      viewport: pdfjsLib.PageViewport,
      query: string,
    ) => {
      const textLayer = textLayerRef.current;
      if (!textLayer) return;

      // 既存のテキストレイヤーをクリア
      textLayer.innerHTML = '';
      textLayer.style.width = `${viewport.width}px`;
      textLayer.style.height = `${viewport.height}px`;

      const textContent = await page.getTextContent();
      const lowerQuery = query.toLowerCase();

      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        const textItem = item as TextItem;
        if (!textItem.str) continue;

        const tx = pdfjsLib.Util.transform(
          viewport.transform,
          textItem.transform,
        );

        // フォントサイズを計算（回転を考慮）
        const fontHeight = Math.hypot(tx[0], tx[1]);
        const fontWidth = Math.hypot(tx[2], tx[3]);
        const fontSize = Math.min(fontHeight, fontWidth);

        // 回転角度を計算（ラジアン→度）
        const angle = Math.atan2(tx[1], tx[0]) * (180 / Math.PI);

        // 1文字あたりの幅を推定
        const charWidth = textItem.width
          ? (textItem.width * viewport.scale) / textItem.str.length
          : fontSize * 0.6;

        // ベースライン（テキスト下端）からフォントサイズ分を回転方向に合わせて調整
        const angleRad = (angle * Math.PI) / 180;
        const baseLeft = tx[4] + fontSize * Math.sin(angleRad);
        const baseTop = tx[5] - fontSize * Math.cos(angleRad);

        // span要素を作成するヘルパー関数
        const createSpan = (
          content: string,
          left: number,
          top: number,
          highlight = false,
        ) => {
          const span = document.createElement('span');
          span.textContent = content;
          span.style.position = 'absolute';
          span.style.left = `${left}px`;
          span.style.top = `${top}px`;
          span.style.fontSize = `${fontSize}px`;
          span.style.fontFamily = textItem.fontName || 'sans-serif';
          span.style.transformOrigin = 'left top';
          span.style.transform = `rotate(${angle}deg)`;
          if (highlight) {
            span.classList.add('pdf-search-highlight');
          }
          return span;
        };

        // 検索クエリがある場合、マッチ部分を分割してハイライト
        if (lowerQuery && textItem.str.toLowerCase().includes(lowerQuery)) {
          const text = textItem.str;
          const lowerText = text.toLowerCase();
          let lastIndex = 0;
          let offset = 0;
          let matchIndex: number;

          while (
            (matchIndex = lowerText.indexOf(lowerQuery, lastIndex)) !== -1
          ) {
            // マッチ前のテキスト
            if (matchIndex > lastIndex) {
              const beforeText = text.slice(lastIndex, matchIndex);
              const offsetX =
                offset * charWidth * Math.cos((angle * Math.PI) / 180);
              const offsetY =
                offset * charWidth * Math.sin((angle * Math.PI) / 180);
              textLayer.appendChild(
                createSpan(beforeText, baseLeft + offsetX, baseTop + offsetY),
              );
              offset += beforeText.length;
            }

            // マッチ部分（ハイライト）
            const matchText = text.slice(matchIndex, matchIndex + query.length);
            const offsetX =
              offset * charWidth * Math.cos((angle * Math.PI) / 180);
            const offsetY =
              offset * charWidth * Math.sin((angle * Math.PI) / 180);
            textLayer.appendChild(
              createSpan(
                matchText,
                baseLeft + offsetX,
                baseTop + offsetY,
                true,
              ),
            );
            offset += matchText.length;

            lastIndex = matchIndex + query.length;
          }

          // 残りのテキスト
          if (lastIndex < text.length) {
            const afterText = text.slice(lastIndex);
            const offsetX =
              offset * charWidth * Math.cos((angle * Math.PI) / 180);
            const offsetY =
              offset * charWidth * Math.sin((angle * Math.PI) / 180);
            textLayer.appendChild(
              createSpan(afterText, baseLeft + offsetX, baseTop + offsetY),
            );
          }
        } else {
          // 検索クエリがない、またはマッチしない場合は通常のレンダリング
          textLayer.appendChild(createSpan(textItem.str, baseLeft, baseTop));
        }
      }
    },
    [],
  );

  // ページをレンダリング
  const renderPage = useCallback(
    async (doc: PDFDocumentProxy, pageNum: number, query: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      try {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale, rotation });

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        await page.render({
          canvasContext: ctx,
          canvas,
          viewport,
        }).promise;

        // テキストレイヤーをレンダリング（検索クエリを渡してハイライト）
        await renderTextLayer(page, viewport, query);
      } catch (err) {
        setError(
          `ページのレンダリングに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [scale, rotation, renderTextLayer],
  );

  // 検索を実行
  const performSearch = useCallback(async () => {
    if (!pdfDoc || !searchQuery.trim()) {
      setSearchResults([]);
      setCurrentMatchIndex(-1);
      return;
    }

    setIsSearching(true);
    const results: SearchMatch[] = [];
    const query = searchQuery.toLowerCase();

    try {
      for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const textContent = await page.getTextContent();

        textContent.items.forEach((item, index) => {
          if ('str' in item) {
            const textItem = item as TextItem;
            if (textItem.str.toLowerCase().includes(query)) {
              results.push({
                pageNum,
                itemIndex: index,
                text: textItem.str,
              });
            }
          }
        });
      }

      setSearchResults(results);
      setCurrentMatchIndex(results.length > 0 ? 0 : -1);

      // 最初の結果のページに移動
      if (results.length > 0) {
        setCurrentPage(results[0].pageNum);
      }
    } finally {
      setIsSearching(false);
    }
  }, [pdfDoc, searchQuery]);

  // 次の検索結果に移動
  const goToNextMatch = () => {
    if (searchResults.length === 0) return;
    const nextIndex = (currentMatchIndex + 1) % searchResults.length;
    setCurrentMatchIndex(nextIndex);
    setCurrentPage(searchResults[nextIndex].pageNum);
  };

  // 前の検索結果に移動
  const goToPrevMatch = () => {
    if (searchResults.length === 0) return;
    const prevIndex =
      (currentMatchIndex - 1 + searchResults.length) % searchResults.length;
    setCurrentMatchIndex(prevIndex);
    setCurrentPage(searchResults[prevIndex].pageNum);
  };

  // 検索クエリが変更されたら検索を実行
  useEffect(() => {
    const timer = setTimeout(() => {
      performSearch();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, performSearch]);

  // ページが変更されたら、または検索クエリが変更されたらレンダリング
  useEffect(() => {
    if (pdfDoc && currentPage > 0) {
      renderPage(pdfDoc, currentPage, searchQuery);
    }
  }, [pdfDoc, currentPage, renderPage, searchQuery]);

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

  // サムネイルを生成
  useEffect(() => {
    if (!pdfDoc || !showThumbnails) return;
    if (thumbnails.length === pdfDoc.numPages) return;

    const generateThumbnails = async () => {
      setIsGeneratingThumbnails(true);
      const thumbs: string[] = [];
      const thumbScale = 0.2;

      try {
        for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
          const page = await pdfDoc.getPage(pageNum);
          const viewport = page.getViewport({ scale: thumbScale });

          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;

          const ctx = canvas.getContext('2d');
          if (ctx) {
            await page.render({
              canvasContext: ctx,
              canvas,
              viewport,
            }).promise;
            thumbs.push(canvas.toDataURL('image/jpeg', 0.7));
          }
        }
        setThumbnails(thumbs);
      } finally {
        setIsGeneratingThumbnails(false);
      }
    };

    generateThumbnails();
  }, [pdfDoc, showThumbnails, thumbnails.length]);

  // 現在のページのサムネイルをスクロールして表示
  useEffect(() => {
    if (!showThumbnails || !thumbnailPanelRef.current) return;
    const thumbElement = thumbnailPanelRef.current.querySelector(
      `[data-page="${currentPage}"]`,
    );
    if (thumbElement) {
      thumbElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [currentPage, showThumbnails]);

  // PDF ファイルを読み込む（パスワード対応）
  const loadPdfWithPassword = useCallback(
    async (data: ArrayBuffer, inputPassword?: string) => {
      setLoading(true);
      setError(null);

      // ArrayBufferはpdf.jsに渡すとdetachされるのでコピーを使用
      const dataCopy = data.slice(0);

      try {
        const doc = await pdfjsLib.getDocument({
          data: dataCopy,
          cMapUrl: CMAP_URL,
          cMapPacked: true,
          standardFontDataUrl: STANDARD_FONT_URL,
          useSystemFonts: true,
          password: inputPassword,
        }).promise;

        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        setShowPasswordDialog(false);
        setPassword('');
        setPasswordError(null);
        setPendingPdfData(null);
      } catch (err) {
        if (
          err instanceof Error &&
          'code' in err &&
          (err as { code: number }).code === PasswordResponses.NEED_PASSWORD
        ) {
          // パスワードが必要（元のdataを保存、まだdetachされていない）
          setPendingPdfData(data);
          setShowPasswordDialog(true);
          setPasswordError(null);
        } else if (
          err instanceof Error &&
          'code' in err &&
          (err as { code: number }).code ===
            PasswordResponses.INCORRECT_PASSWORD
        ) {
          // パスワードが間違っている
          setPasswordError('パスワードが正しくありません');
        } else {
          setError(
            `PDF の読み込みに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
          );
          setShowPasswordDialog(false);
          setPendingPdfData(null);
        }
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // PDF ファイルを読み込む
  const loadPdf = useCallback(
    async (file: File) => {
      setPdfDoc(null);
      setCurrentPage(1);
      setRotation(0);
      setSearchQuery('');
      setSearchResults([]);
      setCurrentMatchIndex(-1);
      setShowPasswordDialog(false);
      setPassword('');
      setPasswordError(null);
      setThumbnails([]);

      const arrayBuffer = await file.arrayBuffer();
      await loadPdfWithPassword(arrayBuffer);
    },
    [loadPdfWithPassword],
  );

  // サムネイルパネルの表示切り替え
  const toggleThumbnails = useCallback(() => {
    setShowThumbnails((prev) => !prev);
  }, []);

  // パスワード送信ハンドラ
  const handlePasswordSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!pendingPdfData || !password) return;
      await loadPdfWithPassword(pendingPdfData, password);
    },
    [pendingPdfData, password, loadPdfWithPassword],
  );

  // パスワードダイアログをキャンセル
  const handlePasswordCancel = useCallback(() => {
    setShowPasswordDialog(false);
    setPassword('');
    setPasswordError(null);
    setPendingPdfData(null);
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

  // 回転操作
  const rotateClockwise = () => {
    setRotation((r) => (r + 90) % 360);
  };

  const rotateCounterClockwise = () => {
    setRotation((r) => (r - 90 + 360) % 360);
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

  // 検索入力ハンドラ
  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
  };

  const handleSearchKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === 'Enter') {
      if (event.shiftKey) {
        goToPrevMatch();
      } else {
        goToNextMatch();
      }
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

      {showPasswordDialog && (
        <div className="pdf-password-overlay">
          <div className="pdf-password-dialog">
            <h3>パスワード保護された PDF</h3>
            <p>この PDF を開くにはパスワードが必要です。</p>
            <form onSubmit={handlePasswordSubmit}>
              <input
                type="password"
                placeholder="パスワードを入力..."
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              {passwordError && (
                <div className="pdf-password-error">{passwordError}</div>
              )}
              <div className="pdf-password-buttons">
                <button type="button" onClick={handlePasswordCancel}>
                  キャンセル
                </button>
                <button type="submit" disabled={!password}>
                  開く
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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
              <button
                onClick={toggleThumbnails}
                title="サムネイル"
                className={showThumbnails ? 'active' : ''}
              >
                ▤
              </button>
              <button onClick={rotateCounterClockwise} title="反時計回りに回転">
                ↺
              </button>
              <button onClick={rotateClockwise} title="時計回りに回転">
                ↻
              </button>
              <button onClick={toggleFullscreen} title="全画面表示">
                ⛶
              </button>
            </div>
          </div>

          <div className="pdf-search-bar">
            <input
              type="text"
              placeholder="検索..."
              value={searchQuery}
              onChange={handleSearchChange}
              onKeyDown={handleSearchKeyDown}
            />
            {searchResults.length > 0 && (
              <>
                <span className="pdf-search-count">
                  {currentMatchIndex + 1} / {searchResults.length}
                </span>
                <button onClick={goToPrevMatch} title="前の結果">
                  ↑
                </button>
                <button onClick={goToNextMatch} title="次の結果">
                  ↓
                </button>
              </>
            )}
            {isSearching && (
              <span className="pdf-search-status">検索中...</span>
            )}
            {searchQuery && searchResults.length === 0 && !isSearching && (
              <span className="pdf-search-status">見つかりません</span>
            )}
          </div>

          <div className="pdf-content-wrapper">
            {showThumbnails && (
              <div className="pdf-thumbnail-panel" ref={thumbnailPanelRef}>
                {isGeneratingThumbnails && thumbnails.length === 0 && (
                  <div className="pdf-thumbnail-loading">
                    サムネイル生成中...
                  </div>
                )}
                {thumbnails.map((thumb, index) => (
                  <button
                    key={index}
                    type="button"
                    className={`pdf-thumbnail ${currentPage === index + 1 ? 'pdf-thumbnail--active' : ''}`}
                    onClick={() => setCurrentPage(index + 1)}
                    data-page={index + 1}
                  >
                    <img src={thumb} alt={`ページ ${index + 1}`} />
                    <span className="pdf-thumbnail-label">{index + 1}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="pdf-page-container">
              <div className="pdf-page-wrapper">
                <canvas ref={canvasRef} className="pdf-page" />
                <div ref={textLayerRef} className="pdf-text-layer" />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
