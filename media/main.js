(() => {
  const vscode =
    typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  const bootstrapNode = document.getElementById("bootstrap");
  if (!bootstrapNode?.textContent) {
    return;
  }

  const bootstrap = JSON.parse(bootstrapNode.textContent);
  const apiBase = `http://127.0.0.1:${bootstrap.port}`;
  const token = bootstrap.token;

  const canvas = document.getElementById("viewerCanvas");
  const viewerWrap = document.querySelector(".viewer-wrap");
  const statusBar = document.getElementById("statusBar");
  const layerList = document.getElementById("layerList");
  const cellSelect = document.getElementById("cellSelect");
  const fitBtn = document.getElementById("fitBtn");
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const backgroundModeSelect = document.getElementById("backgroundModeSelect");
  const labelBtn = document.getElementById("labelBtn");
  const measureBtn = document.getElementById("measureBtn");
  const clearMeasureBtn = document.getElementById("clearMeasureBtn");
  const labelFontRange = document.getElementById("labelFontRange");
  const labelFontInput = document.getElementById("labelFontInput");
  const layerFilterInput = document.getElementById("layerFilterInput");
  const layersAllOnBtn = document.getElementById("layersAllOnBtn");
  const layersAllOffBtn = document.getElementById("layersAllOffBtn");
  const layersInvertBtn = document.getElementById("layersInvertBtn");
  const importLypBtn = document.getElementById("importLypBtn");
  const clearLayerOverridesBtn = document.getElementById("clearLayerOverridesBtn");

  if (!(canvas instanceof HTMLCanvasElement) || !(cellSelect instanceof HTMLSelectElement)) {
    return;
  }

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    setStatus("无法初始化 Canvas 上下文");
    return;
  }

  const restoredState = sanitizePersistedState(vscode?.getState?.() || null);

  const state = {
    meta: null,
    cell: restoredState.cell || "",
    hiddenLayers: new Set(restoredState.hiddenLayerIds || []),
    restoredHiddenLayerIds: Array.isArray(restoredState.hiddenLayerIds)
      ? [...restoredState.hiddenLayerIds]
      : null,
    view: cloneView(restoredState.view),
    renderSeq: 0,
    renderTimer: null,
    renderInFlight: false,
    nextRenderMode: null,
    wheelActive: false,
    wheelStopTimer: null,
    isDragging: false,
    drag: null,
    lastPointerPx: null,
    lastImage: null,
    lastImageView: null,
    layerRows: [],
    layerFilterText: restoredState.layerFilterText || "",
    layerOverrides: {},
    layerBaseNameByKey: {},
    saveOverridesTimer: null,
    showLabels: restoredState.showLabels ?? true,
    labelFontSize: clampLabelFontSize(restoredState.labelFontSize ?? bootstrap.labelFontSize),
    backgroundMode: normalizeBackgroundMode(restoredState.backgroundMode),
    restoredCanvasCssSize: restoredState.canvasCssSize,
    canvasCssSize: null,
    persistTimer: null,
    viewerTheme: null,
    measure: {
      enabled: restoredState.measureEnabled ?? false,
      start: null,
      end: null,
      hover: null,
      startSnapped: false,
      endSnapped: false,
      hoverSnapped: false,
      hoverShiftLocked: false,
      hoverSnapTimer: null,
      hoverSnapReqSeq: 0,
    },
  };

  const resizeObserver = new ResizeObserver(() => {
    const resizeResult = resizeCanvas();
    if (resizeResult) {
      if (state.view) {
        const nextView = scaleViewForCanvasResize(
          state.view,
          resizeResult.previousCssSize,
          resizeResult.cssSize,
        );
        if (nextView) {
          state.view = nextView;
          refreshStatus();
        }
        schedulePersistState(120);
      }
      if (state.meta) {
        repaint();
        scheduleRender(20, "final");
      } else {
        repaint();
      }
    }
  });

  resizeObserver.observe(canvas);
  if (canvas.parentElement) {
    resizeObserver.observe(canvas.parentElement);
  }
  resizeCanvas();
  applyBackgroundMode(state.backgroundMode, { persist: false, repaintNow: false });

  if (layerFilterInput instanceof HTMLInputElement && state.layerFilterText) {
    layerFilterInput.value = state.layerFilterText;
  }

  fitBtn?.addEventListener("click", () => {
    fitToCurrentCell();
    scheduleRender(0, "final");
    schedulePersistState(0);
  });

  zoomInBtn?.addEventListener("click", () => {
    zoomAt(0.8, 0.5, 0.5);
    scheduleRender(0, state.wheelActive ? "interactive" : "final");
    schedulePersistState(0);
  });

  zoomOutBtn?.addEventListener("click", () => {
    zoomAt(1.25, 0.5, 0.5);
    scheduleRender(0, state.wheelActive ? "interactive" : "final");
    schedulePersistState(0);
  });

  if (backgroundModeSelect instanceof HTMLSelectElement) {
    backgroundModeSelect.addEventListener("change", () => {
      applyBackgroundMode(backgroundModeSelect.value, { persist: true, repaintNow: true });
    });
  }

  labelBtn?.addEventListener("click", () => {
    state.showLabels = !state.showLabels;
    updateToggleButtons();
    scheduleRender(0, "final");
    schedulePersistState(0);
  });

  if (labelFontRange instanceof HTMLInputElement) {
    labelFontRange.addEventListener("input", () => {
      setLabelFontSize(labelFontRange.value, true);
    });
  }

  if (labelFontInput instanceof HTMLInputElement) {
    labelFontInput.addEventListener("change", () => {
      setLabelFontSize(labelFontInput.value, true);
    });
  }

  measureBtn?.addEventListener("click", () => {
    state.measure.enabled = !state.measure.enabled;
    if (!state.measure.enabled) {
      state.measure.hover = null;
      state.measure.hoverSnapped = false;
      state.measure.hoverShiftLocked = false;
      if (state.measure.hoverSnapTimer !== null) {
        clearTimeout(state.measure.hoverSnapTimer);
        state.measure.hoverSnapTimer = null;
      }
      state.measure.hoverSnapReqSeq += 1;
    }
    updateToggleButtons();
    repaint();
    refreshStatus();
    schedulePersistState(0);
  });

  clearMeasureBtn?.addEventListener("click", () => {
    state.measure.start = null;
    state.measure.end = null;
    state.measure.hover = null;
    state.measure.startSnapped = false;
    state.measure.endSnapped = false;
    state.measure.hoverSnapped = false;
    state.measure.hoverShiftLocked = false;
    if (state.measure.hoverSnapTimer !== null) {
      clearTimeout(state.measure.hoverSnapTimer);
      state.measure.hoverSnapTimer = null;
    }
    state.measure.hoverSnapReqSeq += 1;
    repaint();
    refreshStatus();
    schedulePersistState(0);
  });

  cellSelect.addEventListener("change", () => {
    state.cell = cellSelect.value;
    fitToCurrentCell();
    scheduleRender(0, "final");
    schedulePersistState(0);
  });

  layerFilterInput?.addEventListener("input", () => {
    state.layerFilterText = layerFilterInput.value.trim().toLowerCase();
    applyLayerFilter();
    schedulePersistState(120);
  });

  layersAllOnBtn?.addEventListener("click", () => {
    batchSetLayers(true);
  });

  layersAllOffBtn?.addEventListener("click", () => {
    batchSetLayers(false);
  });

  layersInvertBtn?.addEventListener("click", () => {
    batchInvertLayers();
  });

  importLypBtn?.addEventListener("click", () => {
    if (vscode) {
      vscode.postMessage({ type: "pickLypFile" });
      setStatus("正在选择 LYP 文件...");
    } else {
      setStatus("当前环境不支持 LYP 导入");
    }
  });

  clearLayerOverridesBtn?.addEventListener("click", () => {
    state.layerOverrides = {};
    applyOverridesToAllRows();
    scheduleSaveLayerOverrides();
    scheduleRender(0, "final");
    schedulePersistState(0);
  });

  window.addEventListener("pagehide", () => {
    persistStateNow();
  });

  canvas.addEventListener("mousedown", (event) => {
    if (!state.view) {
      return;
    }

    const isPanMouse = event.button === 1 || (event.button === 0 && !state.measure.enabled);
    if (!isPanMouse) {
      return;
    }

    event.preventDefault();
    state.isDragging = true;
    canvas.classList.add("dragging");
    state.drag = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startView: { ...state.view },
    };
  });

  window.addEventListener("mouseup", () => {
    if (!state.isDragging) {
      return;
    }

    state.isDragging = false;
    canvas.classList.remove("dragging");
    state.drag = null;
    scheduleRender(0, "final");
    schedulePersistState(0);
  });

  canvas.addEventListener("click", async (event) => {
    if (!state.measure.enabled || event.button !== 0 || !state.view) {
      return;
    }

    const rawWorld = pointerToWorld(event.clientX, event.clientY);
    if (!rawWorld) {
      return;
    }

    const resolved = await resolveMeasurePoint(rawWorld, event.shiftKey);
    if (!resolved) {
      return;
    }

    if (!state.measure.start || state.measure.end) {
      state.measure.start = resolved.point;
      state.measure.end = null;
      state.measure.startSnapped = resolved.snapped;
      state.measure.endSnapped = false;
    } else {
      state.measure.end = resolved.point;
      state.measure.endSnapped = resolved.snapped;
    }

    state.measure.hover = null;
    state.measure.hoverSnapped = false;
    state.measure.hoverShiftLocked = false;
    state.measure.hoverSnapReqSeq += 1;
    repaint();
    refreshStatus();
    schedulePersistState(0);
  });

  canvas.addEventListener("mousemove", (event) => {
    if (!state.view) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    state.lastPointerPx = { x: px, y: py };

    if (state.isDragging && state.drag) {
      const dx = event.clientX - state.drag.startClientX;
      const dy = event.clientY - state.drag.startClientY;
      const viewW = state.drag.startView.x1 - state.drag.startView.x0;
      const viewH = state.drag.startView.y1 - state.drag.startView.y0;
      const invScaleX = viewW / Math.max(rect.width, 1);
      const invScaleY = viewH / Math.max(rect.height, 1);

      state.view = {
        x0: state.drag.startView.x0 - dx * invScaleX,
        x1: state.drag.startView.x1 - dx * invScaleX,
        y0: state.drag.startView.y0 + dy * invScaleY,
        y1: state.drag.startView.y1 + dy * invScaleY,
      };

      repaint();
      scheduleRender(48, "interactive");
      schedulePersistState(140);
    }

    if (state.measure.enabled && !state.measure.end) {
      const rawHover = pointerToWorld(event.clientX, event.clientY);
      if (rawHover) {
        state.measure.hover = applyAxisConstraint(rawHover, event.shiftKey);
        state.measure.hoverSnapped = false;
        state.measure.hoverShiftLocked = event.shiftKey;
        repaint();
        scheduleHoverSnap(rawHover, event.shiftKey);
      }
    }

    refreshStatus();
  });

  canvas.addEventListener("mouseleave", () => {
    state.lastPointerPx = null;
    if (state.measure.enabled && !state.measure.end) {
      state.measure.hover = null;
      state.measure.hoverSnapped = false;
      state.measure.hoverShiftLocked = false;
      if (state.measure.hoverSnapTimer !== null) {
        clearTimeout(state.measure.hoverSnapTimer);
        state.measure.hoverSnapTimer = null;
      }
      state.measure.hoverSnapReqSeq += 1;
      repaint();
    }
    refreshStatus();
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      if (!state.view) {
        return;
      }

      event.preventDefault();
      state.wheelActive = true;
      if (state.wheelStopTimer !== null) {
        clearTimeout(state.wheelStopTimer);
        state.wheelStopTimer = null;
      }
      state.wheelStopTimer = setTimeout(() => {
        state.wheelActive = false;
        state.wheelStopTimer = null;
        scheduleRender(0, "final");
        schedulePersistState(0);
      }, 120);
      const rect = canvas.getBoundingClientRect();
      const nx = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      const ny = clamp((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1);

      const factor = Math.exp(event.deltaY * 0.0011);
      zoomAt(factor, nx, ny);
      scheduleRender(20, "interactive");
      schedulePersistState(140);
    },
    { passive: false },
  );

  setLabelFontSize(state.labelFontSize, false);
  updateToggleButtons();
  repaint();

  window.addEventListener("message", (event) => {
    const message = event?.data || {};
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "layerOverrides") {
      state.layerOverrides = sanitizeLayerOverrides(message.overrides);
      applyOverridesToAllRows();
      if (state.layerRows.length > 0) {
        applyRestoredHiddenLayers(true);
      }
      return;
    }

    if (message.type === "lypImportContent") {
      try {
        const parsed = parseLypContent(String(message.content || ""));
        const merged = { ...state.layerOverrides };
        for (const [key, entry] of Object.entries(parsed.overrides)) {
          const base = merged[key] || {};
          merged[key] = {
            ...base,
            ...entry,
          };
        }
        state.layerOverrides = sanitizeLayerOverrides(merged);
        applyOverridesToAllRows();
        scheduleSaveLayerOverrides();
        scheduleRender(0, "final");
        schedulePersistState(0);
        setStatus(`LYP导入完成: ${parsed.matched} 层匹配 (${message.filePath || ""})`);
      } catch (error) {
        setStatus(`LYP导入失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (message.type === "lypImportCanceled") {
      refreshStatus();
      return;
    }

    if (message.type === "layerOverrideError") {
      setStatus(`图层映射失败: ${String(message.message || "")}`);
    }
  });
  requestLayerOverrides();

  loadMeta().catch((error) => {
    setStatus(`加载失败: ${error instanceof Error ? error.message : String(error)}`);
  });

  async function loadMeta() {
    setStatus("正在加载版图元数据...");
    const meta = await fetchJson("/meta", { token });

    state.meta = meta;

    populateCellList(meta);
    populateLayerList(meta);

    const initialCell = resolveInitialCell(meta, restoredState.cell);
    state.cell = initialCell;
    cellSelect.value = initialCell;

    const restoredView = restorePersistedView();
    if (restoredView) {
      state.view = restoredView;
      refreshStatus();
      repaint();
    } else {
      fitToCurrentCell();
    }

    schedulePersistState(0);
    scheduleRender(0, "final");
  }

  async function renderNow(mode = "final") {
    if (!state.meta || !state.view) {
      return;
    }

    const viewSnapshot = { ...state.view };
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const renderScale = mode === "interactive" ? 0.5 : 1.0;
    const width = Math.max(240, Math.round(rect.width * dpr * renderScale));
    const height = Math.max(180, Math.round(rect.height * dpr * renderScale));

    const seq = ++state.renderSeq;
    setStatus(mode === "interactive" ? "渲染中(预览)..." : "渲染中...");

    const hidden = Array.from(state.hiddenLayers).join(",");
    const useLabels = mode === "final" ? state.showLabels : false;
    const renderStyle = mode === "interactive" ? "fast" : "hatch";
    const query = {
      token,
      cell: state.cell,
      x0: Math.floor(viewSnapshot.x0),
      y0: Math.floor(viewSnapshot.y0),
      x1: Math.ceil(viewSnapshot.x1),
      y1: Math.ceil(viewSnapshot.y1),
      width,
      height,
      hidden_layers: hidden,
      show_labels: useLabels ? "1" : "0",
      label_font_size: state.labelFontSize,
      render_style: renderStyle,
      max_polygons: mode === "interactive" ? 14000 : 45000,
      max_labels: mode === "interactive" ? 0 : 12000,
    };

    const url = `${apiBase}/render.svg?${new URLSearchParams(query).toString()}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`渲染失败: HTTP ${response.status}`);
    }

    const svgText = await response.text();
    if (seq !== state.renderSeq) {
      return;
    }

    const blob = new Blob([svgText], { type: "image/svg+xml" });
    const blobUrl = URL.createObjectURL(blob);
    const img = new Image();

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = blobUrl;
    });

    URL.revokeObjectURL(blobUrl);
    if (seq !== state.renderSeq) {
      return;
    }

    state.lastImage = img;
    state.lastImageView = viewSnapshot;
    repaint();
    refreshStatus();
  }

  function repaint() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = getViewerTheme().canvasBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (state.lastImage) {
      const sourceView = state.lastImageView;
      if (sourceView && state.view) {
        const srcW = sourceView.x1 - sourceView.x0;
        const srcH = sourceView.y1 - sourceView.y0;
        const dstW = state.view.x1 - state.view.x0;
        const dstH = state.view.y1 - state.view.y0;

        const drawW = canvas.width * (srcW / Math.max(dstW, 1e-9));
        const drawH = canvas.height * (srcH / Math.max(dstH, 1e-9));
        const drawX = ((sourceView.x0 - state.view.x0) / Math.max(dstW, 1e-9)) * canvas.width;
        const drawY = ((state.view.y1 - sourceView.y1) / Math.max(dstH, 1e-9)) * canvas.height;

        if (
          Number.isFinite(drawX) &&
          Number.isFinite(drawY) &&
          Number.isFinite(drawW) &&
          Number.isFinite(drawH) &&
          drawW > 1 &&
          drawH > 1
        ) {
          ctx.drawImage(state.lastImage, drawX, drawY, drawW, drawH);
        } else {
          ctx.drawImage(state.lastImage, 0, 0, canvas.width, canvas.height);
        }
      } else {
        ctx.drawImage(state.lastImage, 0, 0, canvas.width, canvas.height);
      }
    }

    if (!state.view || !state.meta) {
      return;
    }

    drawGrid();
    drawScaleBar();
    drawMeasureOverlay();
  }

  function scheduleRender(delayMs, mode = null) {
    const requestedMode = mode || getCurrentRenderMode();
    state.nextRenderMode = selectHigherQualityMode(state.nextRenderMode, requestedMode);

    if (state.renderTimer !== null) {
      clearTimeout(state.renderTimer);
      state.renderTimer = null;
    }

    state.renderTimer = setTimeout(() => {
      state.renderTimer = null;
      triggerRenderLoop();
    }, delayMs);
  }

  function triggerRenderLoop() {
    if (state.renderInFlight) {
      return;
    }

    const queuedMode = state.nextRenderMode;
    if (!queuedMode) {
      return;
    }
    state.nextRenderMode = null;

    state.renderInFlight = true;
    renderNow(queuedMode)
      .catch((error) => {
        setStatus(`渲染错误: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        state.renderInFlight = false;
        if (state.nextRenderMode) {
          triggerRenderLoop();
        }
      });
  }

  function fitToCurrentCell() {
    if (!state.meta) {
      return;
    }

    const bbox = getCurrentCellBbox();
    const x0 = Number.isFinite(bbox[0]) ? bbox[0] : 0;
    const y0 = Number.isFinite(bbox[1]) ? bbox[1] : 0;
    const x1 = Number.isFinite(bbox[2]) ? bbox[2] : x0 + 1000;
    const y1 = Number.isFinite(bbox[3]) ? bbox[3] : y0 + 1000;

    const rect = canvas.getBoundingClientRect();
    const canvasRatio = Math.max(rect.width, 1) / Math.max(rect.height, 1);

    const margin = 1.06;
    let viewW = Math.max(1, (x1 - x0) * margin);
    let viewH = Math.max(1, (y1 - y0) * margin);

    if (viewW / viewH > canvasRatio) {
      viewH = viewW / canvasRatio;
    } else {
      viewW = viewH * canvasRatio;
    }

    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;

    state.view = {
      x0: cx - viewW / 2,
      y0: cy - viewH / 2,
      x1: cx + viewW / 2,
      y1: cy + viewH / 2,
    };

    refreshStatus();
    repaint();
  }

  function getCurrentCellBbox() {
    if (!state.meta) {
      return [0, 0, 1000, 1000];
    }

    const bboxes = state.meta.cell_bboxes || {};
    return bboxes[state.cell] || state.meta.bbox || [0, 0, 1000, 1000];
  }

  function zoomAt(factor, nx, ny) {
    if (!state.view) {
      return;
    }

    const clamped = clamp(factor, 0.2, 6.0);

    const viewW = state.view.x1 - state.view.x0;
    const viewH = state.view.y1 - state.view.y0;
    const worldX = state.view.x0 + nx * viewW;
    const worldY = state.view.y1 - ny * viewH;

    const newW = Math.max(10, viewW * clamped);
    const newH = Math.max(10, viewH * clamped);

    const x0 = worldX - nx * newW;
    const y1 = worldY + ny * newH;

    state.view = {
      x0,
      x1: x0 + newW,
      y1,
      y0: y1 - newH,
    };

    refreshStatus();
    repaint();
  }

  function refreshStatus() {
    if (!state.meta || !state.view) {
      return;
    }

    const dbu = Number(state.meta.dbu || 0.001);
    const rect = canvas.getBoundingClientRect();
    const spanUm = (state.view.x1 - state.view.x0) * dbu;
    const umPerPx = spanUm / Math.max(rect.width, 1);

    let pointerText = "";
    if (state.lastPointerPx) {
      const x = state.view.x0 + (state.lastPointerPx.x / Math.max(rect.width, 1)) * (state.view.x1 - state.view.x0);
      const y = state.view.y1 - (state.lastPointerPx.y / Math.max(rect.height, 1)) * (state.view.y1 - state.view.y0);
      pointerText = ` | x=${(x * dbu).toFixed(3)}um y=${(y * dbu).toFixed(3)}um`;
    }

    const measureDistanceUm = getMeasureDistanceUm();
    const isMeasureSnapped = state.measure.end
      ? state.measure.endSnapped
      : state.measure.hoverSnapped;
    const measureSuffix = isMeasureSnapped ? " 吸附" : "";
    const measureAxis = state.measure.hoverShiftLocked ? " 正交" : "";
    const measureText = Number.isFinite(measureDistanceUm)
      ? ` | d=${formatDistanceUm(measureDistanceUm)}${measureSuffix}${measureAxis}`
      : "";

    const labelText = state.showLabels ? `标签开(${state.labelFontSize}px)` : "标签关";
    setStatus(
      `Cell=${state.cell} | ${umPerPx.toExponential(2)} um/px | ${labelText}${pointerText}${measureText}`,
    );
  }

  function populateCellList(meta) {
    cellSelect.innerHTML = "";

    const raw = Array.isArray(meta.top_cells) ? meta.top_cells : [];
    const cells = Array.from(new Set(raw)).sort((a, b) =>
      String(a).localeCompare(String(b), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );

    for (const cellName of cells) {
      const option = document.createElement("option");
      option.value = cellName;
      option.textContent = cellName;
      if (cellName === meta.default_cell) {
        option.selected = true;
      }
      cellSelect.append(option);
    }

    if (cells.length > 0 && !cells.includes(meta.default_cell)) {
      cellSelect.value = cells[0];
    }
  }

  function populateLayerList(meta) {
    if (!layerList) {
      return;
    }

    layerList.innerHTML = "";
    state.hiddenLayers.clear();
    state.layerRows = [];
    state.layerBaseNameByKey = {};

    const layers = Array.isArray(meta.layers)
      ? [...meta.layers].sort((a, b) => {
        const ka = `L${a.layer}/${a.datatype} ${a.name || ""}`;
        const kb = `L${b.layer}/${b.datatype} ${b.name || ""}`;
        return ka.localeCompare(kb, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      })
      : [];

    for (const layer of layers) {
      const row = document.createElement("div");
      row.className = "layer-item";
      const layerId = String(layer.id);
      const layerKey = makeLayerKey(layer.layer, layer.datatype);
      state.layerBaseNameByKey[layerKey] = String(layer.name || "").trim();

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;

      checkbox.addEventListener("change", () => {
        state.restoredHiddenLayerIds = null;
        if (checkbox.checked) {
          state.hiddenLayers.delete(layerId);
        } else {
          state.hiddenLayers.add(layerId);
        }
        const current = state.layerOverrides[layerKey];
        if (current && typeof current === "object") {
          const updated = { ...current, visible: checkbox.checked };
          if (!updated.name) {
            delete updated.name;
          }
          if (!updated.color) {
            delete updated.color;
          }
          state.layerOverrides[layerKey] = updated;
          scheduleSaveLayerOverrides();
        }
        scheduleRender(0, "final");
        schedulePersistState(80);
      });

      const layerPrefix = document.createElement("span");
      layerPrefix.className = "layer-prefix";
      layerPrefix.textContent = `L${layer.layer}/${layer.datatype}`;

      const layerNameInput = document.createElement("input");
      layerNameInput.className = "layer-name-input";
      layerNameInput.type = "text";
      layerNameInput.placeholder = "未命名";
      layerNameInput.spellcheck = false;
      layerNameInput.addEventListener("change", () => {
        setLayerOverrideName(layerKey, layerNameInput.value);
      });
      layerNameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          layerNameInput.blur();
        }
      });
      layerNameInput.addEventListener("click", (event) => {
        event.stopPropagation();
      });

      const colorSwatch = document.createElement("span");
      colorSwatch.className = "layer-color";
      colorSwatch.style.backgroundColor = normalizeColor(layer.color) || "#aaaaaa";

      row.dataset.layerId = layerId;
      row.dataset.layerKey = layerKey;

      row.append(checkbox, layerPrefix, layerNameInput, colorSwatch);
      layerList.append(row);
      state.layerRows.push({
        row,
        checkbox,
        layerId,
        layerKey,
        baseColor: normalizeColor(layer.color) || "#aaaaaa",
        nameInput: layerNameInput,
        prefix: layerPrefix.textContent || "",
        colorSwatch,
      });
      applyOverrideToLayerRow(state.layerRows[state.layerRows.length - 1], true);
    }

    applyRestoredHiddenLayers(Object.keys(state.layerOverrides).length > 0);
    applyLayerFilter();
  }

  function applyLayerFilter() {
    const keyword = state.layerFilterText;

    for (const entry of state.layerRows) {
      const text = entry.row.dataset.searchText || "";
      const visible = !keyword || text.includes(keyword);
      entry.row.classList.toggle("is-filtered-out", !visible);
    }
  }

  function applyRestoredHiddenLayers(consume = false) {
    if (!Array.isArray(state.restoredHiddenLayerIds)) {
      return;
    }

    const restoredHidden = new Set(state.restoredHiddenLayerIds.map((value) => String(value)));
    state.hiddenLayers.clear();

    for (const entry of state.layerRows) {
      const visible = !restoredHidden.has(entry.layerId);
      entry.checkbox.checked = visible;
      if (!visible) {
        state.hiddenLayers.add(entry.layerId);
      }
    }

    if (consume) {
      state.restoredHiddenLayerIds = null;
    }
  }

  function batchSetLayers(visible) {
    const targets = getBatchTargetLayers();
    if (targets.length === 0) {
      return;
    }

    state.restoredHiddenLayerIds = null;
    for (const entry of targets) {
      entry.checkbox.checked = visible;
      if (visible) {
        state.hiddenLayers.delete(entry.layerId);
      } else {
        state.hiddenLayers.add(entry.layerId);
      }
    }

    scheduleRender(0, "final");
    schedulePersistState(0);
  }

  function batchInvertLayers() {
    const targets = getBatchTargetLayers();
    if (targets.length === 0) {
      return;
    }

    state.restoredHiddenLayerIds = null;
    for (const entry of targets) {
      entry.checkbox.checked = !entry.checkbox.checked;
      if (entry.checkbox.checked) {
        state.hiddenLayers.delete(entry.layerId);
      } else {
        state.hiddenLayers.add(entry.layerId);
      }
    }

    scheduleRender(0, "final");
    schedulePersistState(0);
  }

  function getBatchTargetLayers() {
    const hasFilter = Boolean(state.layerFilterText);
    if (!hasFilter) {
      return state.layerRows;
    }
    return state.layerRows.filter((entry) => !entry.row.classList.contains("is-filtered-out"));
  }

  function requestLayerOverrides() {
    if (!vscode) {
      return;
    }
    vscode.postMessage({ type: "requestLayerOverrides" });
  }

  function scheduleSaveLayerOverrides() {
    if (!vscode) {
      return;
    }
    if (state.saveOverridesTimer !== null) {
      clearTimeout(state.saveOverridesTimer);
      state.saveOverridesTimer = null;
    }
    state.saveOverridesTimer = setTimeout(() => {
      state.saveOverridesTimer = null;
      vscode.postMessage({
        type: "saveLayerOverrides",
        overrides: state.layerOverrides,
      });
    }, 180);
  }

  function makeLayerKey(layer, datatype) {
    return `${Number(layer)}/${Number(datatype)}`;
  }

  function setLayerOverrideName(layerKey, rawName) {
    const baseName = String(state.layerBaseNameByKey[layerKey] || "").trim();
    const next = String(rawName || "").trim();

    const current = state.layerOverrides[layerKey] || {};
    const updated = { ...current };

    if (!next || next === baseName) {
      delete updated.name;
    } else {
      updated.name = next;
    }

    if (!updated.color) {
      delete updated.color;
    }
    if (typeof updated.visible !== "boolean") {
      delete updated.visible;
    }

    if (updated.name || updated.color || typeof updated.visible === "boolean") {
      state.layerOverrides[layerKey] = updated;
    } else {
      delete state.layerOverrides[layerKey];
    }

    const entry = state.layerRows.find((item) => item.layerKey === layerKey);
    if (entry) {
      applyOverrideToLayerRow(entry, false);
      applyLayerFilter();
    }
    scheduleSaveLayerOverrides();
  }

  function applyOverridesToAllRows() {
    for (const entry of state.layerRows) {
      applyOverrideToLayerRow(entry, true);
    }
    applyLayerFilter();
    refreshStatus();
  }

  function applyOverrideToLayerRow(entry, allowVisibilitySync) {
    const override = state.layerOverrides[entry.layerKey] || {};
    const baseName = String(state.layerBaseNameByKey[entry.layerKey] || "").trim();
    const effectiveName = String(override.name || "").trim() || baseName;
    entry.nameInput.value = effectiveName;

    const color = normalizeColor(override.color) || entry.baseColor;
    entry.colorSwatch.style.backgroundColor = color;

    if (allowVisibilitySync && typeof override.visible === "boolean") {
      const visible = Boolean(override.visible);
      entry.checkbox.checked = visible;
      if (visible) {
        state.hiddenLayers.delete(entry.layerId);
      } else {
        state.hiddenLayers.add(entry.layerId);
      }
    }

    const tooltip = effectiveName
      ? `${entry.prefix} ${effectiveName}`
      : entry.prefix;
    entry.row.title = tooltip;
    entry.row.dataset.searchText = `${entry.prefix} ${effectiveName}`.toLowerCase();
  }

  function sanitizeLayerOverrides(raw) {
    if (!raw || typeof raw !== "object") {
      return {};
    }
    const result = {};
    for (const [rawKey, rawEntry] of Object.entries(raw)) {
      const key = String(rawKey || "").trim();
      if (!/^-?\d+\/-?\d+$/.test(key)) {
        continue;
      }
      if (!rawEntry || typeof rawEntry !== "object") {
        continue;
      }
      const item = rawEntry;
      const entry = {};
      if (typeof item.name === "string") {
        const name = item.name.trim();
        if (name) {
          entry.name = name;
        }
      }
      const color = normalizeColor(item.color);
      if (color) {
        entry.color = color;
      }
      if (typeof item.visible === "boolean") {
        entry.visible = item.visible;
      }
      if (entry.name || entry.color || typeof entry.visible === "boolean") {
        result[key] = entry;
      }
    }
    return result;
  }

  function parseLypContent(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(text || ""), "application/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("LYP XML 格式错误");
    }

    const props = Array.from(doc.getElementsByTagName("properties"));
    const overrides = {};
    let matched = 0;

    for (const node of props) {
      const source = childText(node, "source");
      if (!source) {
        continue;
      }
      const match = source.match(/(-?\d+)\s*\/\s*(-?\d+)/);
      if (!match) {
        continue;
      }
      const key = `${Number(match[1])}/${Number(match[2])}`;
      const current = overrides[key] || {};

      const name = childText(node, "name").trim();
      if (name) {
        current.name = name;
      }

      const fillColor = normalizeColor(childText(node, "fill-color"));
      const frameColor = normalizeColor(childText(node, "frame-color"));
      if (fillColor || frameColor) {
        current.color = fillColor || frameColor;
      }

      const visibleText = childText(node, "visible").trim();
      if (visibleText) {
        current.visible = !/^(0|false|no)$/i.test(visibleText);
      }

      if (current.name || current.color || typeof current.visible === "boolean") {
        overrides[key] = current;
        matched += 1;
      }
    }

    return { overrides, matched };
  }

  function childText(parent, tagName) {
    const nodeList = parent.getElementsByTagName(tagName);
    if (!nodeList || nodeList.length === 0) {
      return "";
    }
    const node = nodeList[0];
    return String(node?.textContent || "");
  }

  function normalizeColor(value) {
    if (typeof value !== "string") {
      return null;
    }
    const text = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(text)) {
      return text;
    }
    if (/^#[0-9a-f]{3}$/.test(text)) {
      return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
    }
    const hex = text.match(/^0x([0-9a-f]{6})$/);
    if (hex) {
      return `#${hex[1]}`;
    }
    return null;
  }

  function drawGrid() {
    if (!state.meta || !state.view) {
      return;
    }

    const dbu = Number(state.meta.dbu || 0.001);
    const viewW = state.view.x1 - state.view.x0;
    const viewH = state.view.y1 - state.view.y0;
    if (viewW <= 0 || viewH <= 0 || dbu <= 0) {
      return;
    }

    const worldPerPx = viewW / Math.max(canvas.width, 1);
    const targetPx = 90;
    const stepUm = niceStep(targetPx * worldPerPx * dbu);
    const stepDbu = stepUm / dbu;
    if (!Number.isFinite(stepDbu) || stepDbu <= 0) {
      return;
    }

    ctx.save();
    ctx.lineWidth = 1;
    const theme = getViewerTheme();

    const sxScale = canvas.width / viewW;
    const syScale = canvas.height / viewH;

    const xStart = Math.floor(state.view.x0 / stepDbu);
    const xEnd = Math.ceil(state.view.x1 / stepDbu);
    let xCount = 0;

    for (let i = xStart; i <= xEnd; i += 1) {
      if (xCount > 500) {
        break;
      }
      xCount += 1;
      const x = i * stepDbu;
      const sx = (x - state.view.x0) * sxScale;

      const major = i % 5 === 0;
      ctx.strokeStyle = major ? theme.gridMajor : theme.gridMinor;
      ctx.beginPath();
      ctx.moveTo(sx + 0.5, 0);
      ctx.lineTo(sx + 0.5, canvas.height);
      ctx.stroke();
    }

    const yStart = Math.floor(state.view.y0 / stepDbu);
    const yEnd = Math.ceil(state.view.y1 / stepDbu);
    let yCount = 0;

    for (let i = yStart; i <= yEnd; i += 1) {
      if (yCount > 500) {
        break;
      }
      yCount += 1;
      const y = i * stepDbu;
      const sy = (state.view.y1 - y) * syScale;

      const major = i % 5 === 0;
      ctx.strokeStyle = major ? theme.gridMajor : theme.gridMinor;
      ctx.beginPath();
      ctx.moveTo(0, sy + 0.5);
      ctx.lineTo(canvas.width, sy + 0.5);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawScaleBar() {
    if (!state.meta || !state.view) {
      return;
    }

    const dbu = Number(state.meta.dbu || 0.001);
    const viewW = state.view.x1 - state.view.x0;
    if (dbu <= 0 || viewW <= 0) {
      return;
    }

    const worldPerPx = viewW / Math.max(canvas.width, 1);
    const targetPx = 140;
    const targetUm = targetPx * worldPerPx * dbu;
    const barUm = niceStep(targetUm);
    const barPx = barUm / (dbu * worldPerPx);

    const margin = 20;
    const x2 = canvas.width - margin;
    const x1 = x2 - barPx;
    const y = canvas.height - margin;

    ctx.save();
    const theme = getViewerTheme();
    ctx.strokeStyle = theme.scaleFg;
    ctx.fillStyle = theme.scaleFg;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.moveTo(x1, y - 6);
    ctx.lineTo(x1, y + 6);
    ctx.moveTo(x2, y - 6);
    ctx.lineTo(x2, y + 6);
    ctx.stroke();

    ctx.font = "12px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(formatDistanceUm(barUm), x2, y - 8);
    ctx.restore();
  }

  function drawMeasureOverlay() {
    if (!state.meta || !state.view) {
      return;
    }

    if (!state.measure.start) {
      if (!state.measure.enabled || !state.measure.hover) {
        return;
      }

      const p = worldToScreen(state.measure.hover.x, state.measure.hover.y);
      if (!p) {
        return;
      }

      const color = state.measure.hoverSnapped ? "#51e5ff" : "#f7e36d";
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(p.x - 8, p.y);
      ctx.lineTo(p.x + 8, p.y);
      ctx.moveTo(p.x, p.y - 8);
      ctx.lineTo(p.x, p.y + 8);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const start = state.measure.start;
    const end = state.measure.end || state.measure.hover;
    const startColor = state.measure.startSnapped ? "#51e5ff" : "#f7e36d";
    const endColor = state.measure.end
      ? (state.measure.endSnapped ? "#51e5ff" : "#f7e36d")
      : (state.measure.hoverSnapped ? "#51e5ff" : "#f7e36d");

    const p0 = worldToScreen(start.x, start.y);
    if (!p0) {
      return;
    }

    ctx.save();

    ctx.fillStyle = startColor;
    ctx.beginPath();
    ctx.arc(p0.x, p0.y, 4, 0, Math.PI * 2);
    ctx.fill();

    if (!end) {
      ctx.restore();
      return;
    }

    const p1 = worldToScreen(end.x, end.y);
    if (!p1) {
      ctx.restore();
      return;
    }

    ctx.strokeStyle = endColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(p1.x, p1.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = endColor;
    ctx.fill();

    const dbu = Number(state.meta.dbu || 0.001);
    const dx = (end.x - start.x) * dbu;
    const dy = (end.y - start.y) * dbu;
    const distUm = Math.hypot(dx, dy);

    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;

    ctx.fillStyle = getViewerTheme().measureLabelBg;
    ctx.strokeStyle = `${endColor}88`;
    ctx.lineWidth = 1;
    const text = formatDistanceUm(distUm);
    ctx.font = "12px sans-serif";
    const metrics = ctx.measureText(text);
    const w = Math.ceil(metrics.width) + 12;
    const h = 20;
    const x = mx - w / 2;
    const y = my - h - 8;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = endColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, mx, y + h / 2);

    ctx.restore();
  }

  function scheduleHoverSnap(rawWorld, shiftPressed) {
    if (!state.measure.enabled || state.measure.end) {
      return;
    }

    if (state.measure.hoverSnapTimer !== null) {
      clearTimeout(state.measure.hoverSnapTimer);
      state.measure.hoverSnapTimer = null;
    }

    const reqSeq = ++state.measure.hoverSnapReqSeq;
    state.measure.hoverSnapTimer = setTimeout(() => {
      state.measure.hoverSnapTimer = null;
      querySnapPoint(rawWorld)
        .then((snapPoint) => {
          if (reqSeq !== state.measure.hoverSnapReqSeq) {
            return;
          }
          if (!state.measure.enabled || state.measure.end) {
            return;
          }
          if (!snapPoint) {
            return;
          }

          state.measure.hover = applyAxisConstraint(snapPoint, shiftPressed);
          state.measure.hoverSnapped = true;
          state.measure.hoverShiftLocked = shiftPressed;
          repaint();
          refreshStatus();
        })
        .catch(() => {
          // ignore hover snap errors to avoid noisy UI
        });
    }, 45);
  }

  async function resolveMeasurePoint(rawWorld, shiftPressed) {
    let snapPoint = null;
    try {
      snapPoint = await querySnapPoint(rawWorld);
    } catch {
      snapPoint = null;
    }
    const point = applyAxisConstraint(snapPoint || rawWorld, shiftPressed);
    return {
      point,
      snapped: Boolean(snapPoint),
    };
  }

  function applyAxisConstraint(point, shiftPressed) {
    if (!shiftPressed || !state.measure.start || state.measure.end) {
      return { x: point.x, y: point.y };
    }

    const dx = point.x - state.measure.start.x;
    const dy = point.y - state.measure.start.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return { x: point.x, y: state.measure.start.y };
    }
    return { x: state.measure.start.x, y: point.y };
  }

  async function querySnapPoint(rawWorld) {
    if (!state.meta || !state.view) {
      return null;
    }

    const radiusWorld = getSnapRadiusWorld(14);
    if (radiusWorld <= 0) {
      return null;
    }

    const hidden = Array.from(state.hiddenLayers).join(",");
    const payload = await fetchJson("/snap", {
      token,
      cell: state.cell,
      x: Math.round(rawWorld.x),
      y: Math.round(rawWorld.y),
      radius: Math.max(1, Math.round(radiusWorld)),
      hidden_layers: hidden,
      max_scan_polygons: 12000,
    });

    if (!payload || !payload.snapped) {
      return null;
    }

    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    return { x, y };
  }

  function getSnapRadiusWorld(radiusPx) {
    if (!state.view) {
      return 0;
    }

    const rect = canvas.getBoundingClientRect();
    const worldPerPxX = (state.view.x1 - state.view.x0) / Math.max(rect.width, 1);
    const worldPerPxY = (state.view.y1 - state.view.y0) / Math.max(rect.height, 1);
    const worldPerPx = Math.max(worldPerPxX, worldPerPxY);
    return worldPerPx * radiusPx;
  }

  function pointerToWorld(clientX, clientY) {
    if (!state.view) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const xPx = clientX - rect.left;
    const yPx = clientY - rect.top;

    const nx = xPx / Math.max(rect.width, 1);
    const ny = yPx / Math.max(rect.height, 1);

    return {
      x: state.view.x0 + nx * (state.view.x1 - state.view.x0),
      y: state.view.y1 - ny * (state.view.y1 - state.view.y0),
    };
  }

  function worldToScreen(x, y) {
    if (!state.view) {
      return null;
    }

    const viewW = state.view.x1 - state.view.x0;
    const viewH = state.view.y1 - state.view.y0;
    if (viewW <= 0 || viewH <= 0) {
      return null;
    }

    return {
      x: (x - state.view.x0) * (canvas.width / viewW),
      y: (state.view.y1 - y) * (canvas.height / viewH),
    };
  }

  function getMeasureDistanceUm() {
    if (!state.meta || !state.measure.start) {
      return Number.NaN;
    }

    const end = state.measure.end || state.measure.hover;
    if (!end) {
      return Number.NaN;
    }

    const dbu = Number(state.meta.dbu || 0.001);
    const dx = (end.x - state.measure.start.x) * dbu;
    const dy = (end.y - state.measure.start.y) * dbu;
    return Math.hypot(dx, dy);
  }

  function updateToggleButtons() {
    if (labelBtn instanceof HTMLButtonElement) {
      labelBtn.textContent = state.showLabels ? "标签: 开" : "标签: 关";
      labelBtn.classList.toggle("is-active", state.showLabels);
    }

    if (measureBtn instanceof HTMLButtonElement) {
      measureBtn.textContent = state.measure.enabled ? "测距: 开" : "测距: 关";
      measureBtn.classList.toggle("is-active", state.measure.enabled);
    }

    canvas.classList.toggle("measure-mode", state.measure.enabled);
  }

  function setLabelFontSize(rawValue, triggerRender) {
    const next = clampLabelFontSize(rawValue);
    const changed = next !== state.labelFontSize;
    state.labelFontSize = next;

    if (labelFontRange instanceof HTMLInputElement && labelFontRange.value !== String(next)) {
      labelFontRange.value = String(next);
    }
    if (labelFontInput instanceof HTMLInputElement && labelFontInput.value !== String(next)) {
      labelFontInput.value = String(next);
    }

    refreshStatus();
    if (changed && triggerRender && state.meta) {
      scheduleRender(0, "final");
    }
    if (changed) {
      schedulePersistState(0);
    }
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const cssSize = {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
    const previousCssSize = state.canvasCssSize ? { ...state.canvasCssSize } : null;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    if (
      canvas.width === width &&
      canvas.height === height &&
      previousCssSize &&
      previousCssSize.width === cssSize.width &&
      previousCssSize.height === cssSize.height
    ) {
      return null;
    }

    canvas.width = width;
    canvas.height = height;
    state.canvasCssSize = cssSize;
    return {
      previousCssSize,
      cssSize,
    };
  }

  function applyBackgroundMode(rawMode, options = {}) {
    const nextMode = normalizeBackgroundMode(rawMode);
    const persist = options.persist !== false;
    const repaintNow = options.repaintNow !== false;

    state.backgroundMode = nextMode;
    document.documentElement.dataset.viewerBgMode = nextMode;

    if (
      backgroundModeSelect instanceof HTMLSelectElement &&
      backgroundModeSelect.value !== nextMode
    ) {
      backgroundModeSelect.value = nextMode;
    }

    state.viewerTheme = readViewerTheme();

    if (repaintNow) {
      repaint();
      refreshStatus();
    }
    if (persist) {
      schedulePersistState(0);
    }
  }

  function getViewerTheme() {
    if (!state.viewerTheme) {
      state.viewerTheme = readViewerTheme();
    }
    return state.viewerTheme;
  }

  function readViewerTheme() {
    const styleSource = viewerWrap instanceof Element
      ? getComputedStyle(viewerWrap)
      : getComputedStyle(document.documentElement);
    return {
      canvasBg: readCssVar(styleSource, "--viewer-canvas-bg", "#0f141a"),
      gridMajor: readCssVar(styleSource, "--viewer-grid-major", "#ffffff20"),
      gridMinor: readCssVar(styleSource, "--viewer-grid-minor", "#ffffff12"),
      scaleFg: readCssVar(styleSource, "--viewer-scale-fg", "#f5f7ff"),
      measureLabelBg: readCssVar(styleSource, "--viewer-measure-label-bg", "#101215d8"),
    };
  }

  function readCssVar(styleSource, name, fallback) {
    const value = styleSource.getPropertyValue(name).trim();
    return value || fallback;
  }

  function resolveInitialCell(meta, preferredCell) {
    const cells = Array.isArray(meta.top_cells)
      ? meta.top_cells.map((value) => String(value))
      : [];
    if (preferredCell && cells.includes(preferredCell)) {
      return preferredCell;
    }
    return cellSelect.value || meta.default_cell || cells[0] || "";
  }

  function restorePersistedView() {
    if (!restoredState.view || restoredState.cell !== state.cell) {
      return null;
    }

    const restoredView = cloneView(restoredState.view);
    if (!restoredView) {
      return null;
    }

    const scaledView = scaleViewForCanvasResize(
      restoredView,
      state.restoredCanvasCssSize,
      state.canvasCssSize,
    );
    if (scaledView) {
      return scaledView;
    }

    return fitViewToCanvas(restoredView);
  }

  function fitViewToCanvas(view) {
    const targetAspect = getCanvasAspect();
    if (!view || !Number.isFinite(targetAspect) || targetAspect <= 0) {
      return cloneView(view);
    }

    const viewW = view.x1 - view.x0;
    const viewH = view.y1 - view.y0;
    if (viewW <= 0 || viewH <= 0) {
      return cloneView(view);
    }

    const viewAspect = viewW / viewH;
    let nextW = viewW;
    let nextH = viewH;
    if (viewAspect > targetAspect) {
      nextH = viewW / targetAspect;
    } else {
      nextW = viewH * targetAspect;
    }

    return createCenteredView((view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2, nextW, nextH);
  }

  function getCanvasAspect() {
    const rect = canvas.getBoundingClientRect();
    return Math.max(rect.width, 1) / Math.max(rect.height, 1);
  }

  function scaleViewForCanvasResize(view, previousCssSize, nextCssSize) {
    const sourceView = cloneView(view);
    const prev = normalizeCssSize(previousCssSize);
    const next = normalizeCssSize(nextCssSize);
    if (!sourceView || !prev || !next) {
      return null;
    }

    const viewW = sourceView.x1 - sourceView.x0;
    const viewH = sourceView.y1 - sourceView.y0;
    if (viewW <= 0 || viewH <= 0) {
      return null;
    }

    const scaledW = viewW * (next.width / prev.width);
    const scaledH = viewH * (next.height / prev.height);
    return createCenteredView(
      (sourceView.x0 + sourceView.x1) / 2,
      (sourceView.y0 + sourceView.y1) / 2,
      scaledW,
      scaledH,
    );
  }

  function createCenteredView(cx, cy, width, height) {
    if (
      !Number.isFinite(cx) ||
      !Number.isFinite(cy) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return null;
    }

    return {
      x0: cx - width / 2,
      x1: cx + width / 2,
      y0: cy - height / 2,
      y1: cy + height / 2,
    };
  }

  function schedulePersistState(delayMs) {
    if (!vscode?.setState) {
      return;
    }

    if (state.persistTimer !== null) {
      clearTimeout(state.persistTimer);
      state.persistTimer = null;
    }

    state.persistTimer = setTimeout(() => {
      state.persistTimer = null;
      persistStateNow();
    }, Math.max(0, Number(delayMs) || 0));
  }

  function persistStateNow() {
    if (!vscode?.setState) {
      return;
    }

    if (state.persistTimer !== null) {
      clearTimeout(state.persistTimer);
      state.persistTimer = null;
    }

    vscode.setState({
      cell: state.cell,
      view: cloneView(state.view),
      hiddenLayerIds: Array.from(state.hiddenLayers),
      showLabels: state.showLabels,
      labelFontSize: state.labelFontSize,
      backgroundMode: state.backgroundMode,
      canvasCssSize: state.canvasCssSize ? { ...state.canvasCssSize } : null,
      measureEnabled: state.measure.enabled,
      layerFilterText: state.layerFilterText,
    });
  }

  function setStatus(text) {
    if (statusBar) {
      statusBar.textContent = text;
    }
  }

  async function fetchJson(pathname, queryObj) {
    const query = new URLSearchParams(queryObj);
    const url = `${apiBase}${pathname}?${query.toString()}`;
    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  function getCurrentRenderMode() {
    if (state.isDragging || state.wheelActive) {
      return "interactive";
    }
    return "final";
  }

  function selectHigherQualityMode(currentMode, nextMode) {
    if (!currentMode) {
      return nextMode;
    }
    if (currentMode === "final" || nextMode === "final") {
      return "final";
    }
    return "interactive";
  }

  function clampLabelFontSize(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return 13;
    }
    return clamp(Math.round(num), 6, 48);
  }

  function normalizeBackgroundMode(value) {
    return value === "pure-black" || value === "pure-white" ? value : "soft-dark";
  }

  function sanitizePersistedState(raw) {
    const data = raw && typeof raw === "object" ? raw : {};
    return {
      cell: typeof data.cell === "string" ? data.cell : "",
      view: normalizeView(data.view),
      hiddenLayerIds: Array.isArray(data.hiddenLayerIds)
        ? data.hiddenLayerIds.map((value) => String(value))
        : null,
      showLabels: typeof data.showLabels === "boolean" ? data.showLabels : undefined,
      labelFontSize: Number.isFinite(Number(data.labelFontSize))
        ? Number(data.labelFontSize)
        : undefined,
      backgroundMode: normalizeBackgroundMode(data.backgroundMode),
      canvasCssSize: normalizeCssSize(data.canvasCssSize),
      measureEnabled: typeof data.measureEnabled === "boolean" ? data.measureEnabled : undefined,
      layerFilterText: typeof data.layerFilterText === "string"
        ? data.layerFilterText.trim().toLowerCase()
        : "",
    };
  }

  function normalizeView(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const x0 = Number(raw.x0);
    const x1 = Number(raw.x1);
    const y0 = Number(raw.y0);
    const y1 = Number(raw.y1);
    if (
      !Number.isFinite(x0) ||
      !Number.isFinite(x1) ||
      !Number.isFinite(y0) ||
      !Number.isFinite(y1) ||
      x1 <= x0 ||
      y1 <= y0
    ) {
      return null;
    }

    return { x0, x1, y0, y1 };
  }

  function normalizeCssSize(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const width = Math.round(Number(raw.width));
    const height = Math.round(Number(raw.height));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  }

  function cloneView(view) {
    return view ? { ...view } : null;
  }

  function niceStep(value) {
    const safe = Math.max(1e-12, Number(value) || 1e-12);
    const exp = Math.floor(Math.log10(safe));
    const base = 10 ** exp;
    const scaled = safe / base;

    if (scaled <= 1) {
      return 1 * base;
    }
    if (scaled <= 2) {
      return 2 * base;
    }
    if (scaled <= 5) {
      return 5 * base;
    }
    return 10 * base;
  }

  function formatDistanceUm(um) {
    if (!Number.isFinite(um)) {
      return "-";
    }

    if (um >= 1000) {
      return `${(um / 1000).toFixed(3)} mm`;
    }
    if (um >= 1) {
      return `${um.toFixed(3)} um`;
    }
    return `${(um * 1000).toFixed(2)} nm`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
