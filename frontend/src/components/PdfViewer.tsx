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
const HEAVY_PAGE_THRESHOLD = 10000;
const HEAVY_TEXT_THRESHOLD = 1000;
const HEAVY_FONT_SWITCH_THRESHOLD = 200;

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
  hasType3Fonts: boolean;
  type3FontCount: number;
  estimatedType3Cost: number;
  isHeavy: boolean;
  heavyReason: string | null;
  opCounts: Record<string, number>;
  analysisTime: number;
}

// ページのレンダリング状態
interface PageRenderState {
  rendered: boolean;
  rendering: boolean;
  usedPdfium: boolean;
}

// OPSコードから名前を取得するマップを作成
const opsNameMap: Record<number, string> = {};
for (const [name, code] of Object.entries(OPS)) {
  if (typeof code === 'number') {
    opsNameMap[code] = name;
  }
}

// ページの複雑さを事前に判定
async function analyzePageComplexity(
  page: PDFPageProxy,
): Promise<PageComplexity> {
  const startTime = performance.now();
  const operatorList = await page.getOperatorList();
  const operationCount = operatorList.fnArray.length;

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
  const opCounts: Record<string, number> = {};

  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const op = operatorList.fnArray[i];
    const args = operatorList.argsArray[i];
    const opName = opsNameMap[op] || `unknown_${op}`;
    opCounts[opName] = (opCounts[opName] || 0) + 1;

    switch (op) {
      case OPS.setFont:
        fontCount++;
        if (args && args[0]) fontNames.add(String(args[0]));
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
        imageCount++;
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        textCount++;
        break;
      case OPS.moveTo:
      case OPS.lineTo:
      case OPS.rectangle:
      case OPS.constructPath:
        pathCount++;
        break;
      case OPS.curveTo:
      case OPS.curveTo2:
      case OPS.curveTo3:
        curveCount++;
        break;
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
        fillCount++;
        break;
      case OPS.stroke:
        strokeCount++;
        break;
      case OPS.clip:
      case OPS.eoClip:
        clipCount++;
        break;
      case OPS.save:
      case OPS.restore:
        saveRestoreCount++;
        break;
      case OPS.transform:
        transformCount++;
        break;
      case OPS.shadingFill:
        shadingCount++;
        break;
      case OPS.dependency:
        dependencyCount++;
        break;
    }
  }

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
            setTimeout(() => resolve(null), 100);
          });

          if (fontObj) {
            const isType3 =
              fontObj.type === 'Type3' ||
              fontObj.name === 'Type3' ||
              item.fontName.includes('Type3');
            if (isType3) type3FontCount++;
            fontDetails.push({
              name: fontObj.name || item.fontName,
              type: fontObj.type || 'unknown',
              isEmbedded: item.fontName.startsWith('g_'),
              isMonospace: fontObj.isMonospace || false,
              isSerifFont: fontObj.isSerifFont || false,
              isType3,
            });
          } else {
            const isType3 = item.fontName.includes('Type3');
            if (isType3) type3FontCount++;
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
  const TYPE3_COST_MULTIPLIER = 100;
  const estimatedType3Cost = hasType3Fonts
    ? textCount * TYPE3_COST_MULTIPLIER
    : 0;

  let isHeavy = false;
  const heavyReasons: string[] = [];

  if (hasType3Fonts && textCount > 10) {
    isHeavy = true;
    heavyReasons.push(
      `Type3フォント検出 (${type3FontCount}個) - 推定${estimatedType3Cost.toLocaleString()}命令相当`,
    );
  }
  if (textCount > HEAVY_TEXT_THRESHOLD) {
    isHeavy = true;
    heavyReasons.push(
      `テキスト描画数が多い (${textCount.toLocaleString()} > ${HEAVY_TEXT_THRESHOLD})`,
    );
  }
  if (fontCount > HEAVY_FONT_SWITCH_THRESHOLD) {
    isHeavy = true;
    heavyReasons.push(
      `フォント切り替えが多い (${fontCount.toLocaleString()} > ${HEAVY_FONT_SWITCH_THRESHOLD})`,
    );
  }
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

  // ページごとのレンダリング状態
  const [pageRenderStates, setPageRenderStates] = useState<
    Map<number, PageRenderState>
  >(new Map());

  const thumbnailPanelRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageRefsMap = useRef<Map<number, HTMLDivElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);

  // ページの参照を設定
  const setPageRef = useCallback(
    (pageNum: number, element: HTMLDivElement | null) => {
      if (element) {
        pageRefsMap.current.set(pageNum, element);
      } else {
        pageRefsMap.current.delete(pageNum);
      }
    },
    [],
  );

  // テキストレイヤーをレンダリング
  const renderTextLayerToElement = useCallback(
    async (
      page: PDFPageProxy,
      viewport: pdfjsLib.PageViewport,
      query: string,
      textLayerElement: HTMLDivElement,
    ) => {
      textLayerElement.innerHTML = '';
      textLayerElement.style.width = `${viewport.width}px`;
      textLayerElement.style.height = `${viewport.height}px`;

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
        const fontHeight = Math.hypot(tx[0], tx[1]);
        const fontWidth = Math.hypot(tx[2], tx[3]);
        const fontSize = Math.min(fontHeight, fontWidth);
        const angle = Math.atan2(tx[1], tx[0]) * (180 / Math.PI);
        const charWidth = textItem.width
          ? (textItem.width * viewport.scale) / textItem.str.length
          : fontSize * 0.6;
        const angleRad = (angle * Math.PI) / 180;
        const baseLeft = tx[4] + fontSize * Math.sin(angleRad);
        const baseTop = tx[5] - fontSize * Math.cos(angleRad);

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
          if (highlight) span.classList.add('pdf-search-highlight');
          return span;
        };

        if (lowerQuery && textItem.str.toLowerCase().includes(lowerQuery)) {
          const text = textItem.str;
          const lowerText = text.toLowerCase();
          let lastIndex = 0;
          let offset = 0;
          let matchIndex: number;

          while (
            (matchIndex = lowerText.indexOf(lowerQuery, lastIndex)) !== -1
          ) {
            if (matchIndex > lastIndex) {
              const beforeText = text.slice(lastIndex, matchIndex);
              const offsetX =
                offset * charWidth * Math.cos((angle * Math.PI) / 180);
              const offsetY =
                offset * charWidth * Math.sin((angle * Math.PI) / 180);
              textLayerElement.appendChild(
                createSpan(beforeText, baseLeft + offsetX, baseTop + offsetY),
              );
              offset += beforeText.length;
            }
            const matchText = text.slice(matchIndex, matchIndex + query.length);
            const offsetX =
              offset * charWidth * Math.cos((angle * Math.PI) / 180);
            const offsetY =
              offset * charWidth * Math.sin((angle * Math.PI) / 180);
            textLayerElement.appendChild(
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
          if (lastIndex < text.length) {
            const afterText = text.slice(lastIndex);
            const offsetX =
              offset * charWidth * Math.cos((angle * Math.PI) / 180);
            const offsetY =
              offset * charWidth * Math.sin((angle * Math.PI) / 180);
            textLayerElement.appendChild(
              createSpan(afterText, baseLeft + offsetX, baseTop + offsetY),
            );
          }
        } else {
          textLayerElement.appendChild(
            createSpan(textItem.str, baseLeft, baseTop),
          );
        }
      }
    },
    [],
  );

  // 単一ページをレンダリング
  const renderSinglePage = useCallback(
    async (pageNum: number) => {
      if (!pdfDoc || !pdfArrayBuffer) return;

      const pageContainer = pageRefsMap.current.get(pageNum);
      if (!pageContainer) return;

      // 既にレンダリング中または完了している場合はスキップ
      const currentState = pageRenderStates.get(pageNum);
      if (currentState?.rendered || currentState?.rendering) return;

      // レンダリング中フラグを設定
      setPageRenderStates((prev) => {
        const newMap = new Map(prev);
        newMap.set(pageNum, {
          rendered: false,
          rendering: true,
          usedPdfium: false,
        });
        return newMap;
      });

      try {
        const page = await pdfDoc.getPage(pageNum);
        const complexity = await analyzePageComplexity(page);

        await yieldToMain();

        const canvas = pageContainer.querySelector('canvas');
        const textLayer = pageContainer.querySelector(
          '.pdf-text-layer',
        ) as HTMLDivElement;
        if (!canvas || !textLayer) return;

        const outputScale = window.devicePixelRatio || 1;
        let usedPdfium = false;

        // 重いページはPDFiumを使用
        if (complexity.isHeavy) {
          try {
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

            // PDFiumでもテキストレイヤーを追加（検索ハイライト用）
            const displayViewport = page.getViewport({ scale, rotation });
            await renderTextLayerToElement(
              page,
              displayViewport,
              searchQuery,
              textLayer,
            );

            usedPdfium = true;
          } catch (err) {
            console.warn(`PDFiumレンダリング失敗 (ページ${pageNum}):`, err);
            // pdf.jsにフォールバック
          }
        }

        // pdf.jsでレンダリング
        if (!usedPdfium) {
          const displayViewport = page.getViewport({ scale, rotation });
          const renderViewport = page.getViewport({
            scale: scale * outputScale,
            rotation,
          });

          canvas.width = renderViewport.width;
          canvas.height = renderViewport.height;
          canvas.style.width = `${displayViewport.width}px`;
          canvas.style.height = `${displayViewport.height}px`;

          const ctx = canvas.getContext('2d');
          if (ctx) {
            await page.render({
              canvasContext: ctx,
              viewport: renderViewport,
              canvas,
            }).promise;
          }

          await renderTextLayerToElement(
            page,
            displayViewport,
            searchQuery,
            textLayer,
          );
        }

        // レンダリング完了
        setPageRenderStates((prev) => {
          const newMap = new Map(prev);
          newMap.set(pageNum, { rendered: true, rendering: false, usedPdfium });
          return newMap;
        });
      } catch (err) {
        console.error(`ページ${pageNum}のレンダリングエラー:`, err);
        setPageRenderStates((prev) => {
          const newMap = new Map(prev);
          newMap.set(pageNum, {
            rendered: false,
            rendering: false,
            usedPdfium: false,
          });
          return newMap;
        });
      }
    },
    [
      pdfDoc,
      pdfArrayBuffer,
      scale,
      rotation,
      currentPassword,
      searchQuery,
      pageRenderStates,
      renderTextLayerToElement,
    ],
  );

  // IntersectionObserverのセットアップ
  useEffect(() => {
    if (!pdfDoc) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const pageNum = parseInt(
              entry.target.getAttribute('data-page') || '0',
              10,
            );
            if (pageNum > 0) {
              renderSinglePage(pageNum);
            }
          }
        });
      },
      {
        root: scrollContainerRef.current,
        rootMargin: '200px 0px',
        threshold: 0,
      },
    );

    // 既存のページ要素を監視
    pageRefsMap.current.forEach((element) => {
      observerRef.current?.observe(element);
    });

    return () => {
      observerRef.current?.disconnect();
    };
  }, [pdfDoc, renderSinglePage]);

  // スケールや回転が変更されたら全ページを再レンダリング
  useEffect(() => {
    if (!pdfDoc) return;
    // レンダリング状態をリセット
    setPageRenderStates(new Map());
  }, [pdfDoc, scale, rotation]);

  // 検索クエリが変更されたらテキストレイヤーを更新
  useEffect(() => {
    if (!pdfDoc) return;

    const updateTextLayers = async () => {
      for (const [pageNum, state] of pageRenderStates.entries()) {
        if (!state.rendered) continue;

        const pageContainer = pageRefsMap.current.get(pageNum);
        if (!pageContainer) continue;

        const textLayer = pageContainer.querySelector(
          '.pdf-text-layer',
        ) as HTMLDivElement;
        if (!textLayer) continue;

        try {
          const page = await pdfDoc.getPage(pageNum);
          const viewport = page.getViewport({ scale, rotation });
          await renderTextLayerToElement(page, viewport, searchQuery, textLayer);
        } catch (err) {
          console.warn(`テキストレイヤー更新エラー (ページ${pageNum}):`, err);
        }
      }
    };

    updateTextLayers();
  }, [pdfDoc, searchQuery, scale, rotation, pageRenderStates, renderTextLayerToElement]);

  // スクロール位置から現在のページを検出
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !pdfDoc) return;

    const handleScroll = () => {
      const containerRect = container.getBoundingClientRect();
      const containerCenter = containerRect.top + containerRect.height / 2;

      let closestPage = 1;
      let closestDistance = Infinity;

      pageRefsMap.current.forEach((element, pageNum) => {
        const rect = element.getBoundingClientRect();
        const pageCenter = rect.top + rect.height / 2;
        const distance = Math.abs(pageCenter - containerCenter);

        if (distance < closestDistance) {
          closestDistance = distance;
          closestPage = pageNum;
        }
      });

      setCurrentPage(closestPage);
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [pdfDoc]);

  // ページにスクロール
  const scrollToPage = useCallback((pageNum: number) => {
    const pageElement = pageRefsMap.current.get(pageNum);
    if (pageElement && scrollContainerRef.current) {
      pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

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

      if (results.length > 0) {
        scrollToPage(results[0].pageNum);
      }
    } finally {
      setIsSearching(false);
    }
  }, [pdfDoc, searchQuery, scrollToPage]);

  // 次の検索結果に移動
  const goToNextMatch = () => {
    if (searchResults.length === 0) return;
    const nextIndex = (currentMatchIndex + 1) % searchResults.length;
    setCurrentMatchIndex(nextIndex);
    scrollToPage(searchResults[nextIndex].pageNum);
  };

  // 前の検索結果に移動
  const goToPrevMatch = () => {
    if (searchResults.length === 0) return;
    const prevIndex =
      (currentMatchIndex - 1 + searchResults.length) % searchResults.length;
    setCurrentMatchIndex(prevIndex);
    scrollToPage(searchResults[prevIndex].pageNum);
  };

  // 検索クエリが変更されたら検索を実行
  useEffect(() => {
    const timer = setTimeout(() => {
      performSearch();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, performSearch]);

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
    const startPage = thumbnails.length + 1;
    const pdfDataForPdfium = pdfArrayBuffer;
    const passwordForPdfium = currentPassword;

    const generateThumbnails = async () => {
      setIsGeneratingThumbnails(true);
      const thumbScale = 0.2;

      try {
        for (let pageNum = startPage; pageNum <= pdfDoc.numPages; pageNum++) {
          if (cancelled) break;
          await yieldToMain();

          const page = await pdfDoc.getPage(pageNum);
          const complexity = await analyzePageComplexity(page);

          if (complexity.isHeavy) {
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
              }
            }
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

            const blob = await offscreen.convertToBlob({
              type: 'image/jpeg',
              quality: 0.7,
            });
            const dataUrl = await blobToDataUrl(blob);

            if (!cancelled) {
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
        setPdfArrayBuffer(data);
        setCurrentPassword(inputPassword);
        setPageRenderStates(new Map());
      } catch (err) {
        if (
          err instanceof Error &&
          'code' in err &&
          (err as { code: number }).code === PasswordResponses.NEED_PASSWORD
        ) {
          setPendingPdfData(data);
          setShowPasswordDialog(true);
          setPasswordError(null);
        } else if (
          err instanceof Error &&
          'code' in err &&
          (err as { code: number }).code ===
            PasswordResponses.INCORRECT_PASSWORD
        ) {
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
      setPageRenderStates(new Map());

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

  // ページ配列を生成
  const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);

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
            <div className="pdf-page-indicator">
              <span>
                {currentPage} / {totalPages}
              </span>
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
                    onClick={() => scrollToPage(index + 1)}
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

            <div className="pdf-scroll-container" ref={scrollContainerRef}>
              {pageNumbers.map((pageNum) => {
                const renderState = pageRenderStates.get(pageNum);
                return (
                  <div
                    key={pageNum}
                    ref={(el) => setPageRef(pageNum, el)}
                    className="pdf-page-item"
                    data-page={pageNum}
                  >
                    <div className="pdf-page-wrapper">
                      {renderState?.rendering && (
                        <div className="pdf-page-loading">
                          <div className="pdf-spinner pdf-spinner--small" />
                        </div>
                      )}
                      <canvas className="pdf-page" />
                      <div className="pdf-text-layer" />
                    </div>
                    <div className="pdf-page-number">ページ {pageNum}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
