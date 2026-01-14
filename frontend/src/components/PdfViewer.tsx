import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PasswordResponses } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import {
  renderPageWithPdfium,
  renderThumbnailWithPdfium,
} from '../lib/pdfiumRenderer';

// pdf.js の Worker を設定
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// CMap と標準フォントの URL を設定（日本語などの CJK フォント対応）
const CMAP_URL = `${import.meta.env.BASE_URL}cmaps/`;
const STANDARD_FONT_URL = `${import.meta.env.BASE_URL}standard_fonts/`;

// ズームプリセット
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

// 重いページの閾値
const HEAVY_PAGE_THRESHOLD = 10000; // 総描画命令数
const HEAVY_TEXT_THRESHOLD = 1000; // テキスト描画数の閾値
const HEAVY_FONT_SWITCH_THRESHOLD = 200; // フォント切り替え数の閾値

// pdf.js のオペレーションコード
const OPS = pdfjsLib.OPS;

// フォント詳細情報
interface FontInfo {
  name: string;
  type: string;
  isEmbedded: boolean;
  isMonospace: boolean;
  isSerifFont: boolean;
  isType3: boolean;
}

// ページの複雑さ情報
interface PageComplexity {
  operationCount: number;
  fontCount: number;
  imageCount: number;
  textCount: number;
  pathCount: number;
  curveCount: number;
  fillCount: number;
  strokeCount: number;
  clipCount: number;
  saveRestoreCount: number;
  transformCount: number;
  shadingCount: number;
  dependencyCount: number;
  uniqueFonts: string[];
  fontDetails: FontInfo[];
  // Type3フォント関連
  hasType3Fonts: boolean;
  type3FontCount: number;
  estimatedType3Cost: number; // Type3フォントによる推定描画コスト
  isHeavy: boolean;
  heavyReason: string | null; // 重いと判定された理由
  // デバッグ用：オペレーション種類ごとのカウント
  opCounts: Record<string, number>;
  // 解析時間（ミリ秒）
  analysisTime: number;
}

// OPSコードから名前を取得するマップを作成
const opsNameMap: Record<number, string> = {};
for (const [name, code] of Object.entries(OPS)) {
  if (typeof code === 'number') {
    opsNameMap[code] = name;
  }
}

// ページの複雑さを事前に判定（Workerで処理されるのでブロックしない）
async function analyzePageComplexity(
  page: PDFPageProxy,
): Promise<PageComplexity> {
  const startTime = performance.now();

  const operatorList = await page.getOperatorList();
  const operationCount = operatorList.fnArray.length;

  // オペレーションの種類をカウント
  let fontCount = 0;
  let imageCount = 0;
  let textCount = 0;
  let pathCount = 0;
  let curveCount = 0;
  let fillCount = 0;
  let strokeCount = 0;
  let clipCount = 0;
  let saveRestoreCount = 0;
  let transformCount = 0;
  let shadingCount = 0;
  let dependencyCount = 0;
  const fontNames = new Set<string>();

  // デバッグ用：全オペレーションをカウント
  const opCounts: Record<string, number> = {};

  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const op = operatorList.fnArray[i];
    const args = operatorList.argsArray[i];

    // デバッグ用：オペレーション名でカウント
    const opName = opsNameMap[op] || `unknown_${op}`;
    opCounts[opName] = (opCounts[opName] || 0) + 1;

    switch (op) {
      // フォント
      case OPS.setFont:
        fontCount++;
        if (args && args[0]) {
          fontNames.add(String(args[0]));
        }
        break;
      // 画像
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
        imageCount++;
        break;
      // テキスト
      case OPS.showText:
      case OPS.showSpacedText:
        textCount++;
        break;
      // パス構築
      case OPS.moveTo:
      case OPS.lineTo:
      case OPS.rectangle:
      case OPS.constructPath:
        pathCount++;
        break;
      // 曲線
      case OPS.curveTo:
      case OPS.curveTo2:
      case OPS.curveTo3:
        curveCount++;
        break;
      // 塗りつぶし
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
        fillCount++;
        break;
      // ストローク
      case OPS.stroke:
        strokeCount++;
        break;
      // クリップ
      case OPS.clip:
      case OPS.eoClip:
        clipCount++;
        break;
      // 状態保存/復元
      case OPS.save:
      case OPS.restore:
        saveRestoreCount++;
        break;
      // 変換
      case OPS.transform:
        transformCount++;
        break;
      // シェーディング/グラデーション
      case OPS.shadingFill:
        shadingCount++;
        break;
      // 依存関係（フォントなど外部リソース）
      case OPS.dependency:
        dependencyCount++;
        break;
    }
  }

  // フォントの詳細情報を取得
  const fontDetails: FontInfo[] = [];
  let type3FontCount = 0;
  try {
    const textContent = await page.getTextContent();
    const seenFonts = new Set<string>();

    for (const item of textContent.items) {
      if (
        'fontName' in item &&
        item.fontName &&
        !seenFonts.has(item.fontName)
      ) {
        seenFonts.add(item.fontName);
        // commonObjsからフォント情報を取得を試みる
        try {
          const fontObj = await new Promise<{
            name: string;
            type: string;
            isMonospace?: boolean;
            isSerifFont?: boolean;
          } | null>((resolve) => {
            page.commonObjs.get(item.fontName, (font: unknown) => {
              resolve(font as typeof fontObj);
            });
            // タイムアウト
            setTimeout(() => resolve(null), 100);
          });

          if (fontObj) {
            const isType3 =
              fontObj.type === 'Type3' ||
              fontObj.name === 'Type3' ||
              item.fontName.includes('Type3');
            if (isType3) {
              type3FontCount++;
            }
            fontDetails.push({
              name: fontObj.name || item.fontName,
              type: fontObj.type || 'unknown',
              isEmbedded: item.fontName.startsWith('g_'),
              isMonospace: fontObj.isMonospace || false,
              isSerifFont: fontObj.isSerifFont || false,
              isType3,
            });
          } else {
            // フォント情報が取れない場合、名前でType3をチェック
            const isType3 = item.fontName.includes('Type3');
            if (isType3) {
              type3FontCount++;
            }
            fontDetails.push({
              name: item.fontName,
              type: 'unknown',
              isEmbedded: item.fontName.startsWith('g_'),
              isMonospace: false,
              isSerifFont: false,
              isType3,
            });
          }
        } catch {
          fontDetails.push({
            name: item.fontName,
            type: 'error',
            isEmbedded: item.fontName.startsWith('g_'),
            isMonospace: false,
            isSerifFont: false,
            isType3: false,
          });
        }
      }
    }
  } catch (err) {
    console.warn('フォント情報取得エラー:', err);
  }

  const analysisTime = performance.now() - startTime;
  const hasType3Fonts = type3FontCount > 0;

  // Type3フォントによる推定描画コスト
  // Type3は各グリフがPDF描画命令で定義されているため、
  // showText 1回あたり数百〜数千の描画命令が内部的に実行される
  // 控えめに見積もって、Type3フォントでの showText 1回 = 約100命令相当とする
  const TYPE3_COST_MULTIPLIER = 100;
  const estimatedType3Cost = hasType3Fonts
    ? textCount * TYPE3_COST_MULTIPLIER
    : 0;

  // 重いページかどうかを判定
  let isHeavy = false;
  const heavyReasons: string[] = [];

  // Type3フォント検出
  if (hasType3Fonts && textCount > 10) {
    isHeavy = true;
    heavyReasons.push(
      `Type3フォント検出 (${type3FontCount}個) - 推定${estimatedType3Cost.toLocaleString()}命令相当`,
    );
  }

  // テキスト描画数が多い
  if (textCount > HEAVY_TEXT_THRESHOLD) {
    isHeavy = true;
    heavyReasons.push(
      `テキスト描画数が多い (${textCount.toLocaleString()} > ${HEAVY_TEXT_THRESHOLD})`,
    );
  }

  // フォント切り替えが多い（多いとCanvas状態変更のオーバーヘッドが増える）
  if (fontCount > HEAVY_FONT_SWITCH_THRESHOLD) {
    isHeavy = true;
    heavyReasons.push(
      `フォント切り替えが多い (${fontCount.toLocaleString()} > ${HEAVY_FONT_SWITCH_THRESHOLD})`,
    );
  }

  // 総描画命令数
  if (operationCount > HEAVY_PAGE_THRESHOLD) {
    isHeavy = true;
    heavyReasons.push(
      `総描画命令数 (${operationCount.toLocaleString()} > ${HEAVY_PAGE_THRESHOLD})`,
    );
  }

  const heavyReason = heavyReasons.length > 0 ? heavyReasons.join('\n') : null;

  return {
    operationCount,
    fontCount,
    imageCount,
    textCount,
    pathCount,
    curveCount,
    fillCount,
    strokeCount,
    clipCount,
    saveRestoreCount,
    transformCount,
    shadingCount,
    dependencyCount,
    uniqueFonts: Array.from(fontNames),
    fontDetails,
    hasType3Fonts,
    type3FontCount,
    estimatedType3Cost,
    isHeavy,
    heavyReason,
    opCounts,
    analysisTime,
  };
}

// 検索結果の型
interface SearchMatch {
  pageNum: number;
  itemIndex: number;
  text: string;
}

// UIの更新を許可するためのヘルパー関数
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

// BlobをDataURLに変換するヘルパー関数
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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
  // PDFium用：元のPDFデータとパスワードを保持
  const [pdfArrayBuffer, setPdfArrayBuffer] = useState<ArrayBuffer | null>(
    null,
  );
  const [currentPassword, setCurrentPassword] = useState<string | undefined>(
    undefined,
  );
  const [showThumbnails, setShowThumbnails] = useState(true);
  const [thumbnails, setThumbnails] = useState<
    (string | { isHeavy: true; reason: string })[]
  >([]);
  const [isGeneratingThumbnails, setIsGeneratingThumbnails] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const thumbnailPanelRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const currentRenderTaskRef = useRef<ReturnType<
    PDFPageProxy['render']
  > | null>(null);

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

  // PDFiumでページをレンダリング（内部用）
  const renderWithPdfiumInternal = useCallback(
    async (pageNum: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !pdfArrayBuffer) return false;

      try {
        const outputScale = window.devicePixelRatio || 1;
        const renderScale = scale * outputScale;

        const imageData = await renderPageWithPdfium(
          pdfArrayBuffer.slice(0),
          pageNum,
          renderScale,
          rotation,
          currentPassword,
        );

        canvas.width = imageData.width;
        canvas.height = imageData.height;
        canvas.style.width = `${imageData.width / outputScale}px`;
        canvas.style.height = `${imageData.height / outputScale}px`;

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.putImageData(imageData, 0, 0);
        }

        // テキストレイヤーはクリア
        const textLayer = textLayerRef.current;
        if (textLayer) {
          textLayer.innerHTML = '';
          textLayer.style.width = `${imageData.width / outputScale}px`;
          textLayer.style.height = `${imageData.height / outputScale}px`;
        }

        return true;
      } catch (err) {
        console.warn('PDFiumレンダリング失敗:', err);
        return false;
      }
    },
    [pdfArrayBuffer, scale, rotation, currentPassword],
  );

  // ページをレンダリング（実際の描画処理）
  const executeRender = useCallback(
    async (doc: PDFDocumentProxy, pageNum: number, query: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // 前のレンダリングをキャンセル
      if (currentRenderTaskRef.current) {
        currentRenderTaskRef.current.cancel();
        currentRenderTaskRef.current = null;
      }

      setIsAnalyzing(true);

      try {
        const page = await doc.getPage(pageNum);

        // 事前に複雑さを判定（Workerで処理されるのでブロックしない）
        const complexity = await analyzePageComplexity(page);

        setIsAnalyzing(false);
        setIsRendering(true);

        // UIの更新を許可（スピナーを表示するため）
        await yieldToMain();

        // 重いページの場合はPDFiumで自動レンダリング
        if (complexity.isHeavy && pdfArrayBuffer) {
          const success = await renderWithPdfiumInternal(pageNum);
          if (success) {
            return;
          }
          // PDFiumが失敗した場合はpdf.jsにフォールバック
          console.warn('PDFiumが失敗、pdf.jsにフォールバック');
        }

        // 表示用のviewport
        const displayViewport = page.getViewport({ scale, rotation });

        // 高解像度レンダリング用のスケール（デバイスピクセル比を考慮）
        const outputScale = window.devicePixelRatio || 1;
        const renderViewport = page.getViewport({
          scale: scale * outputScale,
          rotation,
        });

        // キャンバスの実際のピクセルサイズ（高解像度）
        canvas.width = renderViewport.width;
        canvas.height = renderViewport.height;

        // CSSでの表示サイズ（論理サイズ）
        canvas.style.width = `${displayViewport.width}px`;
        canvas.style.height = `${displayViewport.height}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // レンダリングタスクを開始
        const renderTask = page.render({
          canvasContext: ctx,
          viewport: renderViewport,
          canvas,
        });
        currentRenderTaskRef.current = renderTask;

        try {
          await renderTask.promise;
        } catch (err) {
          // キャンセルされた場合はエラーを無視
          if (
            err instanceof Error &&
            err.name === 'RenderingCancelledException'
          ) {
            return;
          }
          throw err;
        } finally {
          currentRenderTaskRef.current = null;
        }

        // テキストレイヤーをレンダリング（表示用のviewportを使用）
        await renderTextLayer(page, displayViewport, query);
      } catch (err) {
        // キャンセル例外は無視
        if (
          err instanceof Error &&
          err.name === 'RenderingCancelledException'
        ) {
          return;
        }
        setError(
          `ページのレンダリングに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setIsAnalyzing(false);
        setIsRendering(false);
      }
    },
    [
      scale,
      rotation,
      renderTextLayer,
      pdfArrayBuffer,
      renderWithPdfiumInternal,
    ],
  );

  // ページをレンダリング（公開API）
  const renderPage = useCallback(
    (doc: PDFDocumentProxy, pageNum: number, query: string) => {
      executeRender(doc, pageNum, query);
    },
    [executeRender],
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

    let cancelled = false;
    // 現在の長さを保存（エフェクト再実行時に続きから始めるため）
    const startPage = thumbnails.length + 1;
    // PDFium用にArrayBufferをキャプチャ
    const pdfDataForPdfium = pdfArrayBuffer;
    const passwordForPdfium = currentPassword;

    const generateThumbnails = async () => {
      setIsGeneratingThumbnails(true);
      const thumbScale = 0.2;

      try {
        for (let pageNum = startPage; pageNum <= pdfDoc.numPages; pageNum++) {
          if (cancelled) break;

          // UIの更新を許可
          await yieldToMain();

          const page = await pdfDoc.getPage(pageNum);

          // 重いページかどうかを事前にチェック
          const complexity = await analyzePageComplexity(page);
          if (complexity.isHeavy) {
            // 重いページはPDFiumでレンダリングを試みる
            if (pdfDataForPdfium) {
              try {
                const dataUrl = await renderThumbnailWithPdfium(
                  pdfDataForPdfium.slice(0),
                  pageNum,
                  thumbScale,
                  passwordForPdfium,
                );
                if (!cancelled) {
                  setThumbnails((prev) => [...prev, dataUrl]);
                }
                continue;
              } catch (err) {
                console.warn(
                  `PDFiumサムネイル生成失敗 (ページ${pageNum}):`,
                  err,
                );
                // PDFiumが失敗した場合はプレースホルダーを表示
              }
            }
            // PDFiumが使えない/失敗した場合はプレースホルダー
            if (!cancelled) {
              setThumbnails((prev) => [
                ...prev,
                {
                  isHeavy: true,
                  reason: complexity.heavyReason || '重いページ',
                },
              ]);
            }
            continue;
          }

          const viewport = page.getViewport({ scale: thumbScale });

          // OffscreenCanvasを使用してレンダリング
          const offscreen = new OffscreenCanvas(
            viewport.width,
            viewport.height,
          );
          const offscreenCtx = offscreen.getContext('2d');
          if (offscreenCtx) {
            await page.render({
              canvasContext:
                offscreenCtx as unknown as CanvasRenderingContext2D,
              viewport,
              canvas: offscreen as unknown as HTMLCanvasElement,
            }).promise;

            // OffscreenCanvasからBlobを取得してDataURLに変換
            const blob = await offscreen.convertToBlob({
              type: 'image/jpeg',
              quality: 0.7,
            });
            const dataUrl = await blobToDataUrl(blob);

            if (!cancelled) {
              // 1ページごとにUIを更新（プログレッシブに表示）
              setThumbnails((prev) => [...prev, dataUrl]);
            }
          }
        }
      } finally {
        if (!cancelled) {
          setIsGeneratingThumbnails(false);
        }
      }
    };

    generateThumbnails();

    return () => {
      cancelled = true;
    };
  }, [
    pdfDoc,
    showThumbnails,
    thumbnails.length,
    pdfArrayBuffer,
    currentPassword,
  ]);

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
        // PDFium用にデータとパスワードを保持
        setPdfArrayBuffer(data);
        setCurrentPassword(inputPassword);
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
      setPdfArrayBuffer(null);
      setCurrentPassword(undefined);

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
                  <div className="pdf-thumbnail-spinner">
                    <div className="pdf-spinner pdf-spinner--small" />
                    <span>サムネイル生成中...</span>
                  </div>
                )}
                {thumbnails.map((thumb, index) => (
                  <button
                    key={index}
                    type="button"
                    className={`pdf-thumbnail ${currentPage === index + 1 ? 'pdf-thumbnail--active' : ''} ${typeof thumb === 'object' ? 'pdf-thumbnail--heavy' : ''}`}
                    onClick={() => setCurrentPage(index + 1)}
                    data-page={index + 1}
                    title={typeof thumb === 'object' ? thumb.reason : undefined}
                  >
                    {typeof thumb === 'string' ? (
                      <img src={thumb} alt={`ページ ${index + 1}`} />
                    ) : (
                      <div className="pdf-thumbnail-heavy-placeholder">
                        <span className="pdf-thumbnail-heavy-icon">⚠️</span>
                        <span className="pdf-thumbnail-heavy-text">重い</span>
                      </div>
                    )}
                    <span className="pdf-thumbnail-label">{index + 1}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="pdf-page-container">
              {(isRendering || isAnalyzing) && (
                <div className="pdf-rendering-overlay">
                  <div className="pdf-spinner" />
                  {isAnalyzing && (
                    <span className="pdf-analyzing-text">解析中...</span>
                  )}
                </div>
              )}
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
