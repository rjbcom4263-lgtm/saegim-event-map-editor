(() => {
  "use strict";

  const STORAGE_KEY = "saegim_event_map_project_v1";
  const API_KEY_STORAGE = "saegim_google_maps_api_key";
  const MAP_ID_STORAGE = "saegim_google_maps_map_id";
  const DEFAULT_GOOGLE_MAPS_API_KEY = "AIzaSyDQVnzIP2ywrl4_72_W88FKpjm8DPirTH0";
  const HISTORY_LIMIT = 60;

  const TYPE_META = {
    booth: { label: "부스", icon: "▣", color: "#2563eb", width: 3, height: 3, shape: "rect" },
    stage: { label: "무대", icon: "▰", color: "#7c3aed", width: 12, height: 8, shape: "rect" },
    tent: { label: "텐트", icon: "⌂", color: "#059669", width: 5, height: 5, shape: "rect" },
    food: { label: "푸드", icon: "▤", color: "#ea580c", width: 4, height: 3, shape: "rect" },
    toilet: { label: "화장실", icon: "🚻", color: "#0891b2", shape: "point" },
    info: { label: "안내소", icon: "ℹ️", color: "#2563eb", shape: "point" },
    entrance: { label: "출입구", icon: "🚪", color: "#16a34a", shape: "point" },
    path: { label: "통로", icon: "⌁", color: "#111827", shape: "path" },
    curve: { label: "곡선", icon: "⌒", color: "#7c3aed", shape: "curve" },
    zone: { label: "구역", icon: "⬡", color: "#f59e0b", shape: "zone" },
    text: { label: "텍스트", icon: "T", color: "#111827", shape: "text" }
  };

  const HIDE_BUILDING_LABELS = [
    { elementType: "labels", stylers: [{ visibility: "off" }] }
  ];

  const dom = {};
  let state = null;
  let map = null;
  let previewMap = null;
  let selectedId = null;
  let currentTool = "select";
  let overlayRegistry = new Map();
  let previewOverlays = [];
  let gridLines = [];
  let drawing = null;
  let activeCurveEdit = null;
  let saveTimer = null;
  let historyTimer = null;
  let toastTimer = null;
  let history = [];
  let historyIndex = -1;
  let applyingHistory = false;
  let mapsReady = false;
  let mapTypeSatellite = false;
  let LabelOverlay = null;

  function $(id) {
    return document.getElementById(id);
  }

  function cacheDom() {
    [
      "apiGate", "apiKeyInput", "mapIdInput", "connectMapsBtn", "apiGateError", "app", "preview",
      "eventNameInput", "saveStatus", "undoBtn", "redoBtn", "saveBtn", "exportBtn", "importInput",
      "previewBtn", "settingsBtn", "sidebarToggle", "leftPanel", "rightPanel", "toolGrid", "toolHint",
      "layerCount", "layerSearch", "layerList", "placeSearch", "locateBtn", "mapTypeBtn", "labelsToggle", "gridToggle",
      "gridSizeSelect", "map", "drawGuide", "drawGuideTitle", "drawGuideText", "finishDrawBtn", "cancelDrawBtn",
      "toast", "propertiesTab", "eventTab", "emptyProperties", "propertiesForm", "selectedTypeBadge",
      "selectedHeading", "closeSelectionBtn", "propName", "propCode", "propDescription", "propColor",
      "opacityField", "propOpacity", "sizeFields", "propWidth", "propHeight", "pathFields", "propStrokeWidth",
      "propAccessible", "pointFields", "propIcon", "propLat", "propLng", "propVisible", "propLocked",
      "duplicateBtn", "layerUpBtn", "layerDownBtn", "deleteBtn", "eventTitleSetting", "eventDescription",
      "eventNotice", "setDefaultViewBtn", "clearAllBtn", "previewTitle", "exitPreviewBtn", "previewMap",
      "previewSearch", "previewNotice", "previewList", "previewDetail", "closePreviewDetail", "previewDetailType",
      "previewDetailName", "previewDetailCode", "previewDetailDescription", "directionsLink", "settingsDialog",
      "settingsApiKey", "settingsMapId", "resetApiBtn", "applySettingsBtn"
    ].forEach((id) => { dom[id] = $(id); });
  }

  function defaultProject() {
    const center = { lat: 35.09755, lng: 129.01075 };
    return {
      version: 1,
      event: {
        title: "새 행사 지도",
        description: "",
        notice: "",
        center,
        zoom: 19,
        mapTypeId: "roadmap",
        gridOrigin: center,
        gridSize: 5,
        gridVisible: false,
        labelsHidden: false
      },
      elements: []
    };
  }

  function normalizeProject(raw) {
    const fallback = defaultProject();
    if (!raw || typeof raw !== "object") return fallback;
    const event = raw.event || {};
    const center = normalizeLatLng(event.center) || fallback.event.center;
    const elements = Array.isArray(raw.elements)
      ? raw.elements.map(normalizeElement).filter(Boolean)
      : [];
    return {
      version: 1,
      event: {
        title: cleanText(event.title, 120) || fallback.event.title,
        description: cleanText(event.description, 3000),
        notice: cleanText(event.notice, 2000),
        center,
        zoom: clampNumber(event.zoom, 3, 22, fallback.event.zoom),
        mapTypeId: event.mapTypeId === "satellite" ? "satellite" : "roadmap",
        gridOrigin: normalizeLatLng(event.gridOrigin) || center,
        gridSize: [1, 2, 5, 10].includes(Number(event.gridSize)) ? Number(event.gridSize) : 5,
        gridVisible: Boolean(event.gridVisible),
        labelsHidden: Boolean(event.labelsHidden)
      },
      elements
    };
  }

  function normalizeElement(item) {
    if (!item || typeof item !== "object" || !TYPE_META[item.type]) return null;
    const meta = TYPE_META[item.type];
    const base = {
      id: typeof item.id === "string" && item.id ? item.id : makeId(item.type),
      type: item.type,
      name: cleanText(item.name, 120) || meta.label,
      code: cleanText(item.code, 50),
      description: cleanText(item.description, 3000),
      color: isHexColor(item.color) ? item.color : meta.color,
      visible: item.visible !== false,
      locked: Boolean(item.locked)
    };
    if (meta.shape === "rect") {
      const center = normalizeLatLng(item.center);
      if (!center) return null;
      return {
        ...base,
        shape: "rect",
        center,
        width: clampNumber(item.width, 0.5, 200, meta.width),
        height: clampNumber(item.height, 0.5, 200, meta.height),
        opacity: clampNumber(item.opacity, 0.05, 0.9, 0.48)
      };
    }
    if (meta.shape === "point" || meta.shape === "text") {
      const position = normalizeLatLng(item.position || item.center);
      if (!position) return null;
      return {
        ...base,
        shape: meta.shape,
        position,
        icon: cleanText(item.icon, 8) || meta.icon
      };
    }
    if (meta.shape === "path") {
      const points = normalizePoints(item.points);
      if (points.length < 2) return null;
      return {
        ...base,
        shape: "path",
        points,
        strokeWidth: clampNumber(item.strokeWidth, 1, 20, 5),
        accessible: item.accessible !== false
      };
    }
    if (meta.shape === "curve") {
      const points = normalizePoints(item.points).slice(0, 3);
      if (points.length < 3) return null;
      return {
        ...base,
        shape: "curve",
        points,
        strokeWidth: clampNumber(item.strokeWidth, 1, 20, 4)
      };
    }
    if (meta.shape === "zone") {
      const points = normalizePoints(item.points);
      if (points.length < 3) return null;
      return {
        ...base,
        shape: "zone",
        points,
        opacity: clampNumber(item.opacity, 0.05, 0.9, 0.28),
        strokeWidth: clampNumber(item.strokeWidth, 1, 10, 2)
      };
    }
    return null;
  }

  function cleanText(value, maxLength) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  }

  function normalizeLatLng(value) {
    if (!value) return null;
    const lat = Number(typeof value.lat === "function" ? value.lat() : value.lat);
    const lng = Number(typeof value.lng === "function" ? value.lng() : value.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }

  function normalizePoints(points) {
    if (!Array.isArray(points)) return [];
    return points.map(normalizeLatLng).filter(Boolean).slice(0, 1000);
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function isHexColor(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  }

  function makeId(prefix = "item") {
    if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function loadProject() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      state = raw ? normalizeProject(JSON.parse(raw)) : defaultProject();
    } catch (error) {
      console.warn("저장 데이터를 읽지 못했습니다.", error);
      state = defaultProject();
    }
  }

  function projectSnapshot() {
    return JSON.stringify({ version: 1, event: state.event, elements: state.elements });
  }

  function resetHistory() {
    history = [projectSnapshot()];
    historyIndex = 0;
    updateHistoryButtons();
  }

  function scheduleHistoryCommit() {
    if (applyingHistory) return;
    clearTimeout(historyTimer);
    historyTimer = setTimeout(commitHistoryNow, 380);
  }

  function commitHistoryNow() {
    clearTimeout(historyTimer);
    historyTimer = null;
    const snapshot = projectSnapshot();
    if (history[historyIndex] === snapshot) return;
    history = history.slice(0, historyIndex + 1);
    history.push(snapshot);
    if (history.length > HISTORY_LIMIT) history.shift();
    historyIndex = history.length - 1;
    updateHistoryButtons();
  }

  function undo() {
    commitHistoryNow();
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    applyHistorySnapshot(history[historyIndex]);
  }

  function redo() {
    commitHistoryNow();
    if (historyIndex >= history.length - 1) return;
    historyIndex += 1;
    applyHistorySnapshot(history[historyIndex]);
  }

  function applyHistorySnapshot(snapshot) {
    applyingHistory = true;
    try {
      state = normalizeProject(JSON.parse(snapshot));
      selectedId = state.elements.some((item) => item.id === selectedId) ? selectedId : null;
      syncProjectUi();
      renderAll();
      saveProject(true);
      showToast("변경 내용을 복원했습니다.");
    } finally {
      applyingHistory = false;
      updateHistoryButtons();
    }
  }

  function updateHistoryButtons() {
    if (!dom.undoBtn) return;
    dom.undoBtn.disabled = historyIndex <= 0;
    dom.redoBtn.disabled = historyIndex >= history.length - 1;
  }

  function markChanged({ historyCommit = true, renderLayers = true } = {}) {
    dom.saveStatus.textContent = "저장 중…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveProject(false), 260);
    if (historyCommit) scheduleHistoryCommit();
    if (renderLayers) renderLayerList();
  }

  function saveProject(silent = false) {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, projectSnapshot());
      dom.saveStatus.textContent = `저장됨 · ${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
      if (!silent) showToast("브라우저에 저장했습니다.");
    } catch (error) {
      console.error(error);
      dom.saveStatus.textContent = "저장 실패";
      showToast("저장 공간이 부족하거나 브라우저 저장이 차단되었습니다.");
    }
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.classList.add("show");
    toastTimer = setTimeout(() => dom.toast.classList.remove("show"), 1900);
  }

  function boot() {
    cacheDom();
    loadProject();
    bindApiGate();
    const key = DEFAULT_GOOGLE_MAPS_API_KEY;
    localStorage.setItem(API_KEY_STORAGE, key);
    if (!key) {
      dom.apiGate.hidden = false;
      return;
    }
    loadGoogleMaps(key);
  }

  function bindApiGate() {
    dom.connectMapsBtn.addEventListener("click", () => {
      const key = dom.apiKeyInput.value.trim();
      const mapId = dom.mapIdInput.value.trim();
      if (!key) {
        dom.apiGateError.textContent = "API 키를 입력하세요.";
        return;
      }
      localStorage.setItem(API_KEY_STORAGE, key);
      if (mapId) localStorage.setItem(MAP_ID_STORAGE, mapId);
      else localStorage.removeItem(MAP_ID_STORAGE);
      dom.apiGateError.textContent = "";
      dom.connectMapsBtn.disabled = true;
      dom.connectMapsBtn.textContent = "연결 중…";
      loadGoogleMaps(key);
    });
  }

  function loadGoogleMaps(key) {
    if (window.google?.maps) {
      initApplication();
      return;
    }
    window.gm_authFailure = () => {
      dom.apiGate.hidden = false;
      dom.app.hidden = true;
      dom.apiGateError.textContent = "API 키 인증에 실패했습니다. 키, 결제 계정, 도메인 제한을 확인하세요.";
      dom.connectMapsBtn.disabled = false;
      dom.connectMapsBtn.textContent = "Google Maps 연결";
    };
    window.__saegimMapsReady = initApplication;
    const script = document.createElement("script");
    const params = new URLSearchParams({
      key,
      callback: "__saegimMapsReady",
      libraries: "geometry,places,marker",
      v: "weekly",
      language: "ko",
      region: "KR",
      loading: "async"
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      dom.apiGate.hidden = false;
      dom.apiGateError.textContent = "Google Maps 스크립트를 불러오지 못했습니다. 인터넷 연결과 API 키를 확인하세요.";
      dom.connectMapsBtn.disabled = false;
      dom.connectMapsBtn.textContent = "Google Maps 연결";
    };
    document.head.appendChild(script);
  }

  function initApplication() {
    if (mapsReady) return;
    mapsReady = true;
    initializeLabelOverlayClass();
    dom.apiGate.hidden = true;
    dom.app.hidden = false;
    initMap();
    bindUi();
    syncProjectUi();
    resetHistory();
    renderAll();
  }

  function initMap() {
    map = new google.maps.Map(dom.map, {
      center: state.event.center,
      zoom: state.event.zoom,
      mapTypeId: state.event.mapTypeId,
      disableDefaultUI: true,
      zoomControl: true,
      fullscreenControl: true,
      gestureHandling: "greedy",
      clickableIcons: false,
      keyboardShortcuts: false
    });
    mapTypeSatellite = state.event.mapTypeId === "satellite";
    updateMapTypeButton();

    map.addListener("click", (event) => handleMapClick(event.latLng));
    map.addListener("mousemove", (event) => {
      if (!activeCurveEdit || !event.latLng) return;
      updateCurveControl(activeCurveEdit.item, activeCurveEdit.shape, activeCurveEdit.label, 1, event.latLng);
    });
    map.addListener("mouseup", () => finishCurveEdit());
    map.addListener("idle", () => {
      if (state.event.gridVisible) renderGrid();
    });

    initPlaceSearch();
    updateBaseLabels();
  }

  function initPlaceSearch() {
    const PlaceAutocompleteElement = google.maps.places?.PlaceAutocompleteElement;
    if (PlaceAutocompleteElement) {
      const widget = new PlaceAutocompleteElement({ includedRegionCodes: ["kr"] });
      widget.placeholder = "행사장 또는 주소 검색";
      widget.className = "place-autocomplete-element";
      dom.placeSearch.replaceWith(widget);
      dom.placeSearch = widget;
      widget.addEventListener("gmp-select", async ({ placePrediction }) => {
        try {
          const place = placePrediction.toPlace();
          await place.fetchFields({ fields: ["displayName", "formattedAddress", "location", "viewport"] });
          if (!place.location) {
            showToast("검색 결과의 위치를 찾지 못했습니다.");
            return;
          }
          if (place.viewport) map.fitBounds(place.viewport);
          else {
            map.setCenter(place.location);
            map.setZoom(19);
          }
        } catch (error) {
          console.error(error);
          showToast("장소 검색 결과를 불러오지 못했습니다.");
        }
      });
      map.addListener("idle", () => {
        const bounds = map.getBounds();
        if (bounds) widget.locationBias = bounds;
      });
      return;
    }

    // 구형 Places 프로젝트를 위한 호환 경로입니다.
    const autocomplete = new google.maps.places.Autocomplete(dom.placeSearch, {
      fields: ["geometry", "name", "formatted_address"],
      componentRestrictions: { country: "kr" }
    });
    autocomplete.bindTo("bounds", map);
    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (!place.geometry?.location) {
        showToast("검색 결과의 위치를 찾지 못했습니다.");
        return;
      }
      if (place.geometry.viewport) map.fitBounds(place.geometry.viewport);
      else {
        map.setCenter(place.geometry.location);
        map.setZoom(19);
      }
    });
  }

  function bindUi() {
    dom.toolGrid.addEventListener("click", (event) => {
      const button = event.target.closest("[data-tool]");
      if (button) setTool(button.dataset.tool);
    });
    dom.finishDrawBtn.addEventListener("click", finishDrawing);
    dom.cancelDrawBtn.addEventListener("click", cancelDrawing);
    dom.undoBtn.addEventListener("click", undo);
    dom.redoBtn.addEventListener("click", redo);
    dom.saveBtn.addEventListener("click", () => { commitHistoryNow(); saveProject(); });
    dom.exportBtn.addEventListener("click", exportJson);
    dom.importInput.addEventListener("change", importJson);
    dom.previewBtn.addEventListener("click", enterPreview);
    dom.exitPreviewBtn.addEventListener("click", exitPreview);
    dom.settingsBtn.addEventListener("click", openSettings);
    dom.sidebarToggle.addEventListener("click", () => dom.leftPanel.classList.toggle("open"));
    dom.locateBtn.addEventListener("click", locateUser);
    dom.mapTypeBtn.addEventListener("click", toggleMapType);
    dom.labelsToggle.addEventListener("change", toggleBaseLabels);
    dom.gridToggle.addEventListener("change", toggleGrid);
    dom.gridSizeSelect.addEventListener("change", changeGridSize);
    dom.layerSearch.addEventListener("input", renderLayerList);
    dom.eventNameInput.addEventListener("input", () => updateEventTitle(dom.eventNameInput.value));

    document.querySelectorAll(".right-tab").forEach((button) => {
      button.addEventListener("click", () => switchRightTab(button.dataset.tab));
    });

    dom.closeSelectionBtn.addEventListener("click", () => selectElement(null));
    bindPropertyInputs();
    dom.duplicateBtn.addEventListener("click", duplicateSelected);
    dom.deleteBtn.addEventListener("click", deleteSelected);
    dom.layerUpBtn.addEventListener("click", () => moveLayer(1));
    dom.layerDownBtn.addEventListener("click", () => moveLayer(-1));

    dom.eventTitleSetting.addEventListener("input", () => updateEventTitle(dom.eventTitleSetting.value));
    dom.eventDescription.addEventListener("input", () => {
      state.event.description = dom.eventDescription.value.slice(0, 3000);
      markChanged();
    });
    dom.eventNotice.addEventListener("input", () => {
      state.event.notice = dom.eventNotice.value.slice(0, 2000);
      markChanged();
    });
    dom.setDefaultViewBtn.addEventListener("click", saveDefaultView);
    dom.clearAllBtn.addEventListener("click", clearAllElements);

    dom.previewSearch.addEventListener("input", renderPreviewList);
    dom.closePreviewDetail.addEventListener("click", closePreviewDetail);

    dom.resetApiBtn.addEventListener("click", () => {
      localStorage.removeItem(API_KEY_STORAGE);
      localStorage.removeItem(MAP_ID_STORAGE);
      location.reload();
    });
    dom.applySettingsBtn.addEventListener("click", () => {
      const key = dom.settingsApiKey.value.trim();
      const mapId = dom.settingsMapId.value.trim();
      if (!key) {
        showToast("API 키를 입력하세요.");
        return;
      }
      localStorage.setItem(API_KEY_STORAGE, key);
      if (mapId) localStorage.setItem(MAP_ID_STORAGE, mapId);
      else localStorage.removeItem(MAP_ID_STORAGE);
      location.reload();
    });

    document.addEventListener("keydown", handleKeyboard);
  }

  function bindPropertyInputs() {
    const bindText = (node, key, max, visual = false) => {
      node.addEventListener("input", () => {
        const item = getSelected();
        if (!item) return;
        item[key] = node.value.slice(0, max);
        if (key === "name") {
          dom.selectedHeading.textContent = item.name || TYPE_META[item.type].label;
          updateOverlayLabel(item);
        }
        if (visual) updateOverlayStyle(item);
        markChanged();
      });
    };
    bindText(dom.propName, "name", 120);
    bindText(dom.propCode, "code", 50);
    bindText(dom.propDescription, "description", 3000);

    dom.propColor.addEventListener("input", () => {
      const item = getSelected();
      if (!item) return;
      item.color = dom.propColor.value;
      updateOverlayStyle(item);
      markChanged();
    });
    dom.propOpacity.addEventListener("input", () => {
      const item = getSelected();
      if (!item) return;
      item.opacity = Number(dom.propOpacity.value);
      updateOverlayStyle(item);
      markChanged();
    });
    dom.propWidth.addEventListener("change", updateRectSizeFromForm);
    dom.propHeight.addEventListener("change", updateRectSizeFromForm);
    dom.propStrokeWidth.addEventListener("change", () => {
      const item = getSelected();
      if (!item) return;
      item.strokeWidth = clampNumber(dom.propStrokeWidth.value, 1, 20, 5);
      dom.propStrokeWidth.value = item.strokeWidth;
      updateOverlayStyle(item);
      markChanged();
    });
    dom.propAccessible.addEventListener("change", () => {
      const item = getSelected();
      if (!item) return;
      item.accessible = dom.propAccessible.checked;
      markChanged();
    });
    dom.propIcon.addEventListener("change", () => {
      const item = getSelected();
      if (!item) return;
      item.icon = dom.propIcon.value;
      renderAll();
      markChanged();
    });
    dom.propLat.addEventListener("change", updatePositionFromForm);
    dom.propLng.addEventListener("change", updatePositionFromForm);
    dom.propVisible.addEventListener("change", () => {
      const item = getSelected();
      if (!item) return;
      item.visible = dom.propVisible.checked;
      renderAll();
      markChanged();
    });
    dom.propLocked.addEventListener("change", () => {
      const item = getSelected();
      if (!item) return;
      item.locked = dom.propLocked.checked;
      renderAll();
      markChanged();
    });
  }

  function syncProjectUi() {
    dom.eventNameInput.value = state.event.title;
    dom.eventTitleSetting.value = state.event.title;
    dom.eventDescription.value = state.event.description;
    dom.eventNotice.value = state.event.notice;
    dom.gridToggle.checked = state.event.gridVisible;
    dom.labelsToggle.checked = state.event.labelsHidden;
    dom.gridSizeSelect.value = String(state.event.gridSize);
    mapTypeSatellite = state.event.mapTypeId === "satellite";
    updateMapTypeButton();
    updateBaseLabels();
  }

  function switchRightTab(tab) {
    document.querySelectorAll(".right-tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
    dom.propertiesTab.hidden = tab !== "properties";
    dom.eventTab.hidden = tab !== "event";
    if (tab === "event") {
      dom.rightPanel.classList.add("open");
    }
  }

  function setTool(tool) {
    if (!TYPE_META[tool] && tool !== "select") return;
    if (drawing) cancelDrawing();
    currentTool = tool;
    document.querySelectorAll(".tool").forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
    const hints = {
      select: "시설물을 클릭해 선택하거나 지도를 이동하세요.",
      booth: "지도에서 부스를 배치할 위치를 클릭하세요.",
      stage: "지도에서 무대를 배치할 위치를 클릭하세요.",
      tent: "지도에서 텐트를 배치할 위치를 클릭하세요.",
      food: "지도에서 푸드 부스를 배치할 위치를 클릭하세요.",
      toilet: "지도에서 화장실 위치를 클릭하세요.",
      info: "지도에서 안내소 위치를 클릭하세요.",
      entrance: "지도에서 출입구 위치를 클릭하세요.",
      path: "지도에서 통로의 점을 순서대로 클릭한 후 완료하세요.",
      curve: "시작점과 끝점을 클릭한 뒤, 곡선 위를 드래그해 휘게 만드세요.",
      zone: "지도에서 구역의 꼭짓점을 순서대로 클릭한 후 완료하세요.",
      text: "텍스트를 배치할 위치를 클릭하세요."
    };
    dom.toolHint.textContent = hints[tool] || "";
    map.setOptions({ draggableCursor: tool === "select" ? null : "crosshair" });
    if (tool === "path" || tool === "curve" || tool === "zone") beginDrawing(tool);
  }

  function handleMapClick(latLng) {
    if (!latLng) return;
    let position = normalizeLatLng(latLng);
    if (state.event.gridVisible) position = snapPosition(position);

    if (currentTool === "select") {
      selectElement(null);
      return;
    }
    if (currentTool === "path" || currentTool === "curve" || currentTool === "zone") {
      addDrawingPoint(position);
      return;
    }
    const meta = TYPE_META[currentTool];
    if (!meta) return;
    const count = state.elements.filter((item) => item.type === currentTool).length + 1;
    let item;
    if (meta.shape === "rect") {
      item = {
        id: makeId(currentTool), type: currentTool, shape: "rect", name: `${meta.label} ${count}`, code: "",
        description: "", color: meta.color, visible: true, locked: false, center: position,
        width: meta.width, height: meta.height, opacity: 0.48
      };
    } else if (meta.shape === "point") {
      item = {
        id: makeId(currentTool), type: currentTool, shape: "point", name: `${meta.label} ${count}`, code: "",
        description: "", color: meta.color, visible: true, locked: false, position, icon: meta.icon
      };
    } else if (meta.shape === "text") {
      item = {
        id: makeId(currentTool), type: currentTool, shape: "text", name: "안내 문구", code: "",
        description: "", color: meta.color, visible: true, locked: false, position, icon: "T"
      };
    }
    if (!item) return;
    state.elements.push(item);
    selectedId = item.id;
    renderAll();
    markChanged();
    setTool("select");
    dom.rightPanel.classList.add("open");
    showToast(`${meta.label}을(를) 추가했습니다.`);
  }

  function beginDrawing(type) {
    drawing = { type, points: [], tempOverlay: null };
    map.setOptions({ disableDoubleClickZoom: true, draggableCursor: "crosshair" });
    dom.drawGuide.hidden = false;
    dom.drawGuideTitle.textContent = type === "path" ? "통로 그리기" : type === "curve" ? "곡선 그리기" : "구역 그리기";
    dom.drawGuideText.textContent = type === "path" ? "지도를 클릭해 2개 이상의 점을 추가하세요." : type === "curve" ? "시작점과 끝점을 클릭하세요. 완성 후 곡선 위를 드래그해 휘게 만들 수 있습니다." : "지도를 클릭해 3개 이상의 꼭짓점을 추가하세요.";
  }

  function addDrawingPoint(position) {
    if (!drawing) return;
    drawing.points.push(position);
    renderTemporaryDrawing();
    if (drawing.type === "curve" && drawing.points.length === 2) {
      finishDrawing();
      return;
    }
    dom.drawGuideText.textContent = `${drawing.points.length}개 점 추가됨 · Enter 또는 완료 버튼`;
  }

  function renderTemporaryDrawing() {
    if (!drawing) return;
    if (drawing.tempOverlay) drawing.tempOverlay.setMap(null);
    if (drawing.type === "path" || drawing.type === "curve") {
      drawing.tempOverlay = new google.maps.Polyline({
        map,
        path: drawing.type === "curve" ? quadraticBezierPoints(drawing.points) : drawing.points,
        strokeColor: TYPE_META[drawing.type].color,
        strokeOpacity: 0.9,
        strokeWeight: 5,
        clickable: false,
        zIndex: 9999
      });
    } else {
      drawing.tempOverlay = new google.maps.Polygon({
        map,
        paths: drawing.points,
        strokeColor: TYPE_META.zone.color,
        strokeOpacity: 1,
        strokeWeight: 2,
        fillColor: TYPE_META.zone.color,
        fillOpacity: 0.25,
        clickable: false,
        zIndex: 9999
      });
    }
  }

  function finishDrawing() {
    if (!drawing) return;
    const min = drawing.type === "path" || drawing.type === "curve" ? 2 : 3;
    if (drawing.points.length < min) {
      showToast(`${min}개 이상의 점이 필요합니다.`);
      return;
    }
    const type = drawing.type;
    const count = state.elements.filter((item) => item.type === type).length + 1;
    const meta = TYPE_META[type];
    const item = type === "path"
      ? {
          id: makeId(type), type, shape: "path", name: `${meta.label} ${count}`, code: "", description: "",
          color: meta.color, visible: true, locked: false, points: drawing.points.slice(), strokeWidth: 5, accessible: true
        }
      : type === "curve"
        ? {
            id: makeId(type), type, shape: "curve", name: `${meta.label} ${count}`, code: "", description: "",
            color: meta.color, visible: true, locked: false, points: [drawing.points[0], curveControlPoint(drawing.points[0], drawing.points[1]), drawing.points[1]], strokeWidth: 4
          }
      : {
          id: makeId(type), type, shape: "zone", name: `${meta.label} ${count}`, code: "", description: "",
          color: meta.color, visible: true, locked: false, points: drawing.points.slice(), strokeWidth: 2, opacity: 0.28
        };
    if (drawing.tempOverlay) drawing.tempOverlay.setMap(null);
    drawing = null;
    dom.drawGuide.hidden = true;
    map.setOptions({ disableDoubleClickZoom: false });
    state.elements.push(item);
    selectedId = item.id;
    setTool("select");
    renderAll();
    markChanged();
    dom.rightPanel.classList.add("open");
    showToast(`${meta.label}을(를) 추가했습니다.`);
  }

  function cancelDrawing() {
    if (!drawing) return;
    if (drawing.tempOverlay) drawing.tempOverlay.setMap(null);
    drawing = null;
    dom.drawGuide.hidden = true;
    if (map) map.setOptions({ disableDoubleClickZoom: false, draggableCursor: null });
  }

  function renderAll() {
    clearOverlays();
    state.elements.forEach((item, index) => {
      if (!item.visible) return;
      if (item.shape === "rect") createRectOverlay(item, index);
      else if (item.shape === "point" || item.shape === "text") createMarkerOverlay(item, index);
      else if (item.shape === "path") createPathOverlay(item, index);
      else if (item.shape === "curve") createCurveOverlay(item, index);
      else if (item.shape === "zone") createZoneOverlay(item, index);
    });
    renderLayerList();
    renderProperties();
    if (state.event.gridVisible) renderGrid();
  }

  function clearOverlays() {
    overlayRegistry.forEach((entry) => {
      if (entry.shape?.setMap) entry.shape.setMap(null);
      if (entry.marker?.setMap) entry.marker.setMap(null);
      if (entry.label?.setMap) entry.label.setMap(null);
      entry.controls?.forEach((control) => control.setMap(null));
    });
    overlayRegistry.clear();
  }

  function initializeLabelOverlayClass() {
    if (LabelOverlay) return;
    LabelOverlay = class extends google.maps.OverlayView {
      constructor(position, text, onClick) {
        super();
        this.position = normalizeLatLng(position);
        this.text = text;
        this.onClick = onClick;
        this.div = null;
        this.selected = false;
      }
      onAdd() {
        this.div = document.createElement("div");
        this.div.className = "map-label";
        this.div.textContent = this.text;
        this.div.addEventListener("click", (event) => {
          event.stopPropagation();
          this.onClick?.(event);
        });
        this.getPanes().overlayMouseTarget.appendChild(this.div);
      }
      draw() {
        if (!this.div || !this.position) return;
        const point = this.getProjection().fromLatLngToDivPixel(new google.maps.LatLng(this.position));
        if (!point) return;
        this.div.style.left = `${point.x}px`;
        this.div.style.top = `${point.y}px`;
        this.div.classList.toggle("selected", this.selected);
      }
      onRemove() {
        this.div?.remove();
        this.div = null;
      }
      setPosition(position) { this.position = normalizeLatLng(position); this.draw(); }
      setText(text) { this.text = text; if (this.div) this.div.textContent = text; }
      setSelected(selected) { this.selected = selected; if (this.div) this.div.classList.toggle("selected", selected); }
    };
  }

  function createRectOverlay(item, index) {
    const bounds = boundsFromCenter(item.center, item.width, item.height);
    const selected = item.id === selectedId;
    const shape = new google.maps.Rectangle({
      map,
      bounds,
      strokeColor: selected ? "#1d4ed8" : item.color,
      strokeOpacity: 1,
      strokeWeight: selected ? 3 : 2,
      fillColor: item.color,
      fillOpacity: item.opacity,
      editable: selected && !item.locked,
      draggable: selected && !item.locked,
      clickable: true,
      zIndex: 100 + index
    });
    const label = new LabelOverlay(item.center, displayName(item), () => selectElement(item.id));
    label.selected = selected;
    label.setMap(map);
    shape.addListener("click", (event) => {
      event.domEvent?.stopPropagation?.();
      selectElement(item.id);
    });
    shape.addListener("bounds_changed", () => {
      if (!overlayRegistry.has(item.id)) return;
      const newBounds = shape.getBounds();
      if (!newBounds) return;
      const ne = newBounds.getNorthEast();
      const sw = newBounds.getSouthWest();
      const center = newBounds.getCenter();
      item.center = normalizeLatLng(center);
      item.width = roundMeters(google.maps.geometry.spherical.computeDistanceBetween(
        new google.maps.LatLng(center.lat(), sw.lng()),
        new google.maps.LatLng(center.lat(), ne.lng())
      ));
      item.height = roundMeters(google.maps.geometry.spherical.computeDistanceBetween(
        new google.maps.LatLng(sw.lat(), center.lng()),
        new google.maps.LatLng(ne.lat(), center.lng())
      ));
      label.setPosition(center);
      refreshGeometryFields(item);
      markChanged({ renderLayers: false });
    });
    overlayRegistry.set(item.id, { shape, label });
  }

  function createMarkerOverlay(item, index) {
    const selected = item.id === selectedId;
    const marker = new google.maps.Marker({
      map,
      position: item.position,
      title: displayName(item),
      draggable: selected && !item.locked,
      icon: createMarkerIcon(item, selected),
      label: item.shape === "text" ? undefined : {
        text: item.icon || TYPE_META[item.type].icon,
        color: "#ffffff",
        fontWeight: "700",
        fontSize: "12px"
      },
      zIndex: 500 + index
    });
    const label = new LabelOverlay(item.position, displayName(item), () => selectElement(item.id));
    label.selected = selected;
    label.setMap(map);
    marker.addListener("click", () => selectElement(item.id));
    marker.addListener("dragend", (event) => {
      const position = normalizeLatLng(event.latLng);
      if (!position) return;
      item.position = state.event.gridVisible ? snapPosition(position) : position;
      marker.setPosition(item.position);
      label.setPosition(item.position);
      refreshGeometryFields(item);
      markChanged({ renderLayers: false });
    });
    overlayRegistry.set(item.id, { marker, label });
  }

  function createMarkerIcon(item, selected) {
    if (item.shape === "text") {
      return {
        path: google.maps.SymbolPath.CIRCLE,
        fillOpacity: 0,
        strokeOpacity: 0,
        scale: 10
      };
    }
    return {
      path: google.maps.SymbolPath.CIRCLE,
      fillColor: item.color,
      fillOpacity: 1,
      strokeColor: selected ? "#1d4ed8" : "#ffffff",
      strokeOpacity: 1,
      strokeWeight: selected ? 4 : 2,
      scale: selected ? 14 : 12
    };
  }

  function createPointMarkerContent(item, selected) {
    const root = document.createElement("div");
    root.className = `marker-content${selected ? " selected" : ""}`;
    const icon = document.createElement("div");
    icon.className = "marker-icon";
    icon.style.background = item.color;
    icon.textContent = item.icon || TYPE_META[item.type].icon;
    const label = document.createElement("div");
    label.className = "marker-label";
    label.textContent = displayName(item);
    root.append(icon, label);
    return root;
  }

  function createTextMarkerContent(item, selected) {
    const root = document.createElement("div");
    root.className = `text-marker${selected ? " selected" : ""}`;
    root.style.color = item.color;
    root.textContent = item.name || "텍스트";
    return root;
  }

  function createPathOverlay(item, index) {
    const selected = item.id === selectedId;
    const shape = new google.maps.Polyline({
      map,
      path: item.points,
      strokeColor: selected ? "#1d4ed8" : item.color,
      strokeOpacity: 0.95,
      strokeWeight: item.strokeWidth + (selected ? 2 : 0),
      editable: selected && !item.locked,
      draggable: selected && !item.locked,
      clickable: true,
      zIndex: 200 + index
    });
    const labelPosition = item.points[Math.floor(item.points.length / 2)];
    const label = new LabelOverlay(labelPosition, displayName(item), () => selectElement(item.id));
    label.selected = selected;
    label.setMap(map);
    shape.addListener("click", (event) => {
      event.domEvent?.stopPropagation?.();
      selectElement(item.id);
    });
    attachPathMutationListeners(shape.getPath(), () => {
      item.points = mvcPathToArray(shape.getPath());
      label.setPosition(item.points[Math.floor(item.points.length / 2)]);
      markChanged({ renderLayers: false });
    });
    shape.addListener("dragend", () => {
      item.points = mvcPathToArray(shape.getPath());
      label.setPosition(item.points[Math.floor(item.points.length / 2)]);
      markChanged({ renderLayers: false });
    });
    overlayRegistry.set(item.id, { shape, label });
  }

  function createCurveOverlay(item, index) {
    const selected = item.id === selectedId;
    const shape = new google.maps.Polyline({
      map,
      path: quadraticBezierPoints(item.points),
      strokeColor: selected ? "#1d4ed8" : item.color,
      strokeOpacity: 0.95,
      strokeWeight: item.strokeWidth + (selected ? 2 : 0),
      clickable: true,
      zIndex: 200 + index
    });
    const label = new LabelOverlay(quadraticBezierPoints(item.points, 2)[1], displayName(item), () => selectElement(item.id));
    label.selected = selected;
    label.setMap(map);
    shape.addListener("click", (event) => {
      event.domEvent?.stopPropagation?.();
      selectElement(item.id);
    });
    if (selected && !item.locked) {
      shape.addListener("mousedown", (event) => startCurveEdit(item, shape, label, event));
      shape.addListener("mouseup", () => finishCurveEdit());
    }
    overlayRegistry.set(item.id, { shape, label });
  }

  function startCurveEdit(item, shape, label, event) {
    event.domEvent?.preventDefault?.();
    activeCurveEdit = { item, shape, label };
    map.setOptions({ draggable: false, draggableCursor: "grabbing" });
  }

  function finishCurveEdit() {
    if (!activeCurveEdit) return;
    activeCurveEdit = null;
    map.setOptions({ draggable: true, draggableCursor: currentTool === "select" ? null : "crosshair" });
    markChanged({ renderLayers: false });
  }

  function updateCurveControl(item, shape, label, pointIndex, latLng) {
    const position = normalizeLatLng(latLng);
    if (!position) return;
    item.points[pointIndex] = state.event.gridVisible ? snapPosition(position) : position;
    const curvePath = quadraticBezierPoints(item.points);
    shape.setPath(curvePath);
    label.setPosition(quadraticBezierPoints(item.points, 2)[1]);
  }

  function curveControlPoint(start, end) {
    return {
      lat: (start.lat + end.lat) / 2,
      lng: (start.lng + end.lng) / 2
    };
  }

  function quadraticBezierPoints(points, segments = 36) {
    if (points.length < 3) return points.slice();
    const [start, control, end] = points;
    const curve = [];
    for (let step = 0; step <= segments; step += 1) {
      const t = step / segments;
      const reverse = 1 - t;
      curve.push({
        lat: reverse * reverse * start.lat + 2 * reverse * t * control.lat + t * t * end.lat,
        lng: reverse * reverse * start.lng + 2 * reverse * t * control.lng + t * t * end.lng
      });
    }
    return curve;
  }

  function createZoneOverlay(item, index) {
    const selected = item.id === selectedId;
    const shape = new google.maps.Polygon({
      map,
      paths: item.points,
      strokeColor: selected ? "#1d4ed8" : item.color,
      strokeOpacity: 1,
      strokeWeight: item.strokeWidth + (selected ? 1 : 0),
      fillColor: item.color,
      fillOpacity: item.opacity,
      editable: selected && !item.locked,
      draggable: selected && !item.locked,
      clickable: true,
      zIndex: 50 + index
    });
    const label = new LabelOverlay(centroid(item.points), displayName(item), () => selectElement(item.id));
    label.selected = selected;
    label.setMap(map);
    shape.addListener("click", (event) => {
      event.domEvent?.stopPropagation?.();
      selectElement(item.id);
    });
    attachPathMutationListeners(shape.getPath(), () => {
      item.points = mvcPathToArray(shape.getPath());
      label.setPosition(centroid(item.points));
      markChanged({ renderLayers: false });
    });
    shape.addListener("dragend", () => {
      item.points = mvcPathToArray(shape.getPath());
      label.setPosition(centroid(item.points));
      markChanged({ renderLayers: false });
    });
    overlayRegistry.set(item.id, { shape, label });
  }

  function attachPathMutationListeners(path, callback) {
    path.addListener("insert_at", callback);
    path.addListener("remove_at", callback);
    path.addListener("set_at", callback);
  }

  function mvcPathToArray(path) {
    return path.getArray().map(normalizeLatLng).filter(Boolean);
  }

  function boundsFromCenter(center, widthMeters, heightMeters) {
    const north = google.maps.geometry.spherical.computeOffset(center, heightMeters / 2, 0);
    const south = google.maps.geometry.spherical.computeOffset(center, heightMeters / 2, 180);
    const ne = google.maps.geometry.spherical.computeOffset(north, widthMeters / 2, 90);
    const sw = google.maps.geometry.spherical.computeOffset(south, widthMeters / 2, 270);
    return new google.maps.LatLngBounds(sw, ne);
  }

  function centroid(points) {
    if (!points.length) return state.event.center;
    const sum = points.reduce((acc, point) => ({ lat: acc.lat + point.lat, lng: acc.lng + point.lng }), { lat: 0, lng: 0 });
    return { lat: sum.lat / points.length, lng: sum.lng / points.length };
  }

  function displayName(item) {
    return item.code ? `${item.code} · ${item.name}` : item.name;
  }

  function roundMeters(value) {
    return Math.max(0.5, Math.round(value * 10) / 10);
  }

  function getSelected() {
    return state.elements.find((item) => item.id === selectedId) || null;
  }

  function selectElement(id, pan = false) {
    if (drawing) return;
    selectedId = id && state.elements.some((item) => item.id === id) ? id : null;
    renderAll();
    if (selectedId) {
      switchRightTab("properties");
      dom.rightPanel.classList.add("open");
      if (pan) panToElement(getSelected());
    }
  }

  function renderProperties() {
    const item = getSelected();
    dom.emptyProperties.hidden = Boolean(item);
    dom.propertiesForm.hidden = !item;
    if (!item) return;
    const meta = TYPE_META[item.type];
    dom.selectedTypeBadge.textContent = meta.label;
    dom.selectedHeading.textContent = item.name || meta.label;
    dom.propName.value = item.name || "";
    dom.propCode.value = item.code || "";
    dom.propDescription.value = item.description || "";
    dom.propColor.value = item.color;
    dom.propVisible.checked = item.visible;
    dom.propLocked.checked = item.locked;

    dom.sizeFields.hidden = item.shape !== "rect";
    dom.pathFields.hidden = item.shape !== "path" && item.shape !== "curve" && item.shape !== "zone";
    dom.pointFields.hidden = item.shape !== "point";
    dom.opacityField.hidden = item.shape !== "rect" && item.shape !== "zone";

    if (item.shape === "rect") {
      dom.propWidth.value = item.width;
      dom.propHeight.value = item.height;
      dom.propOpacity.value = item.opacity;
    }
    if (item.shape === "path" || item.shape === "curve" || item.shape === "zone") {
      dom.propStrokeWidth.value = item.strokeWidth;
      dom.propAccessible.parentElement.hidden = item.shape !== "path";
      dom.propAccessible.checked = Boolean(item.accessible);
      if (item.shape === "zone") dom.propOpacity.value = item.opacity;
    }
    if (item.shape === "point") dom.propIcon.value = optionExists(dom.propIcon, item.icon) ? item.icon : "📍";
    refreshGeometryFields(item);
  }

  function optionExists(select, value) {
    return Array.from(select.options).some((option) => option.value === value);
  }

  function refreshGeometryFields(item) {
    if (!item || getSelected()?.id !== item.id) return;
    const position = elementPosition(item);
    dom.propLat.value = position.lat.toFixed(6);
    dom.propLng.value = position.lng.toFixed(6);
    if (item.shape === "rect") {
      dom.propWidth.value = item.width;
      dom.propHeight.value = item.height;
    }
  }

  function elementPosition(item) {
    if (item.shape === "rect") return item.center;
    if (item.shape === "point" || item.shape === "text") return item.position;
    if (item.shape === "path") return item.points[Math.floor(item.points.length / 2)];
    if (item.shape === "curve") return quadraticBezierPoints(item.points, 2)[1];
    return centroid(item.points);
  }

  function updateRectSizeFromForm() {
    const item = getSelected();
    if (!item || item.shape !== "rect") return;
    item.width = clampNumber(dom.propWidth.value, 0.5, 200, item.width);
    item.height = clampNumber(dom.propHeight.value, 0.5, 200, item.height);
    renderAll();
    markChanged();
  }

  function updatePositionFromForm() {
    const item = getSelected();
    if (!item) return;
    const position = normalizeLatLng({ lat: dom.propLat.value, lng: dom.propLng.value });
    if (!position) {
      showToast("올바른 위도와 경도를 입력하세요.");
      refreshGeometryFields(item);
      return;
    }
    if (item.shape === "rect") item.center = position;
    else if (item.shape === "point" || item.shape === "text") item.position = position;
    else {
      const current = elementPosition(item);
      const deltaLat = position.lat - current.lat;
      const deltaLng = position.lng - current.lng;
      item.points = item.points.map((point) => ({ lat: point.lat + deltaLat, lng: point.lng + deltaLng }));
    }
    renderAll();
    markChanged();
  }

  function updateOverlayLabel(item) {
    const entry = overlayRegistry.get(item.id);
    if (entry?.label) entry.label.setText(displayName(item));
  }

  function updateOverlayStyle(item) {
    const entry = overlayRegistry.get(item.id);
    if (!entry) return;
    const selected = item.id === selectedId;
    if (item.shape === "rect") entry.shape.setOptions({ fillColor: item.color, fillOpacity: item.opacity, strokeColor: selected ? "#1d4ed8" : item.color });
    else if (item.shape === "path") entry.shape.setOptions({ strokeColor: selected ? "#1d4ed8" : item.color, strokeWeight: item.strokeWidth + (selected ? 2 : 0) });
    else if (item.shape === "curve") entry.shape.setOptions({ strokeColor: selected ? "#1d4ed8" : item.color, strokeWeight: item.strokeWidth + (selected ? 2 : 0) });
    else if (item.shape === "zone") entry.shape.setOptions({ fillColor: item.color, fillOpacity: item.opacity, strokeColor: selected ? "#1d4ed8" : item.color, strokeWeight: item.strokeWidth + (selected ? 1 : 0) });
    else if (entry.marker) entry.marker.setIcon(createMarkerIcon(item, selected));
    else renderAll();
  }

  function renderLayerList() {
    const query = dom.layerSearch.value.trim().toLowerCase();
    const indexed = state.elements.map((item, index) => ({ item, index })).reverse();
    const filtered = indexed.filter(({ item }) => `${item.name} ${item.code} ${TYPE_META[item.type].label}`.toLowerCase().includes(query));
    dom.layerCount.textContent = String(state.elements.length);
    dom.layerList.innerHTML = "";
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "empty-layers";
      empty.textContent = state.elements.length ? "검색 결과가 없습니다." : "아직 배치된 시설물이 없습니다.\n위 도구를 선택한 뒤 지도를 클릭하세요.";
      dom.layerList.appendChild(empty);
      return;
    }
    filtered.forEach(({ item }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `layer-item${item.id === selectedId ? " active" : ""}${item.visible ? "" : " hidden-layer"}`;
      button.innerHTML = `
        <span class="layer-icon" style="color:${escapeHtml(item.color)}">${escapeHtml(TYPE_META[item.type].icon)}</span>
        <span class="layer-meta"><span class="layer-name">${escapeHtml(item.name)}</span><span class="layer-code">${escapeHtml(item.code || TYPE_META[item.type].label)}</span></span>
        <span class="layer-flags">${item.locked ? "🔒" : ""}${item.visible ? "" : " ◌"}</span>`;
      button.addEventListener("click", () => selectElement(item.id, true));
      dom.layerList.appendChild(button);
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  function panToElement(item) {
    if (!item) return;
    if (item.shape === "rect") {
      map.fitBounds(boundsFromCenter(item.center, Math.max(item.width, 8), Math.max(item.height, 8)), 100);
      if (map.getZoom() > 20) map.setZoom(20);
    } else if (item.shape === "point" || item.shape === "text") {
      map.panTo(item.position);
      if (map.getZoom() < 19) map.setZoom(19);
    } else {
      const bounds = new google.maps.LatLngBounds();
      item.points.forEach((point) => bounds.extend(point));
      map.fitBounds(bounds, 100);
    }
  }

  function duplicateSelected() {
    const item = getSelected();
    if (!item) return;
    const copy = JSON.parse(JSON.stringify(item));
    copy.id = makeId(item.type);
    copy.name = `${item.name} 복사`;
    if (copy.shape === "rect") copy.center = offsetPosition(copy.center, 3, 135);
    else if (copy.shape === "point" || copy.shape === "text") copy.position = offsetPosition(copy.position, 3, 135);
    else copy.points = copy.points.map((point) => offsetPosition(point, 3, 135));
    state.elements.push(copy);
    selectedId = copy.id;
    renderAll();
    markChanged();
    showToast("선택 항목을 복제했습니다.");
  }

  function deleteSelected() {
    const item = getSelected();
    if (!item) return;
    if (!confirm(`“${item.name}”을(를) 삭제할까요?`)) return;
    state.elements = state.elements.filter((element) => element.id !== item.id);
    selectedId = null;
    renderAll();
    markChanged();
    showToast("삭제했습니다.");
  }

  function moveLayer(direction) {
    const index = state.elements.findIndex((item) => item.id === selectedId);
    if (index < 0) return;
    const target = index + direction;
    if (target < 0 || target >= state.elements.length) return;
    [state.elements[index], state.elements[target]] = [state.elements[target], state.elements[index]];
    renderAll();
    markChanged();
  }

  function updateEventTitle(value) {
    state.event.title = value.slice(0, 120) || "새 행사 지도";
    if (dom.eventNameInput.value !== state.event.title) dom.eventNameInput.value = state.event.title;
    if (dom.eventTitleSetting.value !== state.event.title) dom.eventTitleSetting.value = state.event.title;
    markChanged({ renderLayers: false });
  }

  function saveDefaultView() {
    state.event.center = normalizeLatLng(map.getCenter()) || state.event.center;
    state.event.zoom = map.getZoom() || state.event.zoom;
    state.event.mapTypeId = mapTypeSatellite ? "satellite" : "roadmap";
    state.event.gridOrigin = state.event.center;
    markChanged({ renderLayers: false });
    showToast("현재 화면을 기본 위치로 저장했습니다.");
  }

  function clearAllElements() {
    if (!state.elements.length) return;
    if (!confirm("모든 시설물, 통로, 구역을 삭제할까요? 이 작업은 실행 취소할 수 있습니다.")) return;
    state.elements = [];
    selectedId = null;
    renderAll();
    markChanged();
  }

  function exportJson() {
    commitHistoryNow();
    saveProject(true);
    const data = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), event: state.event, elements: state.elements }, null, 2);
    const blob = new Blob([data], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename(state.event.title)}_행사지도.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast("JSON 파일을 내보냈습니다.");
  }

  async function importJson(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const imported = normalizeProject(parsed);
      if (!confirm(`“${imported.event.title}” 지도를 불러오면 현재 편집 내용이 교체됩니다. 계속할까요?`)) return;
      state = imported;
      selectedId = null;
      map.setCenter(state.event.center);
      map.setZoom(state.event.zoom);
      map.setMapTypeId(state.event.mapTypeId);
      syncProjectUi();
      renderAll();
      saveProject(true);
      resetHistory();
      showToast("지도 데이터를 불러왔습니다.");
    } catch (error) {
      console.error(error);
      showToast("올바른 행사 지도 JSON 파일이 아닙니다.");
    }
  }

  function safeFilename(value) {
    return (value || "새김_행사지도").replace(/[\\/:*?"<>|]/g, "_").trim();
  }

  function locateUser() {
    if (!navigator.geolocation) {
      showToast("이 브라우저는 위치 기능을 지원하지 않습니다.");
      return;
    }
    dom.locateBtn.disabled = true;
    dom.locateBtn.textContent = "위치 확인 중…";
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const current = { lat: position.coords.latitude, lng: position.coords.longitude };
        map.panTo(current);
        map.setZoom(Math.max(map.getZoom() || 18, 19));
        new google.maps.Marker({
          map,
          position: current,
          title: "현재 위치",
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            fillColor: "#2563eb",
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 3,
            scale: 10
          },
          zIndex: 99999
        });
        dom.locateBtn.disabled = false;
        dom.locateBtn.textContent = "현재 위치";
      },
      (error) => {
        console.warn(error);
        showToast("현재 위치를 확인하지 못했습니다. 브라우저 위치 권한을 확인하세요.");
        dom.locateBtn.disabled = false;
        dom.locateBtn.textContent = "현재 위치";
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
    );
  }

  function createCurrentLocationContent() {
    const node = document.createElement("div");
    node.style.cssText = "width:20px;height:20px;border-radius:50%;background:#2563eb;border:4px solid white;box-shadow:0 0 0 5px rgba(37,99,235,.25),0 3px 12px rgba(0,0,0,.3)";
    return node;
  }

  function toggleMapType() {
    mapTypeSatellite = !mapTypeSatellite;
    state.event.mapTypeId = mapTypeSatellite ? "satellite" : "roadmap";
    updateBaseLabels();
    updateMapTypeButton();
    markChanged({ renderLayers: false });
  }

  function updateMapTypeButton() {
    if (dom.mapTypeBtn) dom.mapTypeBtn.textContent = mapTypeSatellite ? "일반 지도" : "위성 보기";
  }

  function toggleBaseLabels() {
    state.event.labelsHidden = dom.labelsToggle.checked;
    updateBaseLabels();
    markChanged({ renderLayers: false });
  }

  function updateBaseLabels() {
    if (!map) return;
    map.setOptions({ styles: state.event.labelsHidden ? HIDE_BUILDING_LABELS : [] });
    map.setMapTypeId(mapTypeSatellite ? "satellite" : "roadmap");
  }

  function toggleGrid() {
    state.event.gridVisible = dom.gridToggle.checked;
    if (state.event.gridVisible) renderGrid();
    else clearGrid();
    markChanged({ renderLayers: false });
  }

  function changeGridSize() {
    state.event.gridSize = Number(dom.gridSizeSelect.value);
    if (state.event.gridVisible) renderGrid();
    markChanged({ renderLayers: false });
  }

  function renderGrid() {
    clearGrid();
    if (!map || !state.event.gridVisible || map.getZoom() < 17) return;
    const origin = state.event.gridOrigin || state.event.center;
    const center = normalizeLatLng(map.getCenter());
    const grid = state.event.gridSize;
    const local = toLocalMeters(origin, center);
    const centerE = Math.round(local.east / grid) * grid;
    const centerN = Math.round(local.north / grid) * grid;
    const count = 18;
    const extent = grid * count;
    for (let i = -count; i <= count; i += 1) {
      const e = centerE + i * grid;
      const n = centerN + i * grid;
      gridLines.push(new google.maps.Polyline({
        map,
        path: [fromLocalMeters(origin, e, centerN - extent), fromLocalMeters(origin, e, centerN + extent)],
        strokeColor: i % 5 === 0 ? "#1d4ed8" : "#64748b",
        strokeOpacity: i % 5 === 0 ? 0.32 : 0.16,
        strokeWeight: i % 5 === 0 ? 1.2 : 0.7,
        clickable: false,
        zIndex: 1
      }));
      gridLines.push(new google.maps.Polyline({
        map,
        path: [fromLocalMeters(origin, centerE - extent, n), fromLocalMeters(origin, centerE + extent, n)],
        strokeColor: i % 5 === 0 ? "#1d4ed8" : "#64748b",
        strokeOpacity: i % 5 === 0 ? 0.32 : 0.16,
        strokeWeight: i % 5 === 0 ? 1.2 : 0.7,
        clickable: false,
        zIndex: 1
      }));
    }
  }

  function clearGrid() {
    gridLines.forEach((line) => line.setMap(null));
    gridLines = [];
  }

  function snapPosition(position) {
    const origin = state.event.gridOrigin || state.event.center;
    const local = toLocalMeters(origin, position);
    const grid = state.event.gridSize;
    return fromLocalMeters(origin, Math.round(local.east / grid) * grid, Math.round(local.north / grid) * grid);
  }

  function toLocalMeters(origin, position) {
    const northPoint = { lat: position.lat, lng: origin.lng };
    let north = google.maps.geometry.spherical.computeDistanceBetween(origin, northPoint);
    let east = google.maps.geometry.spherical.computeDistanceBetween(northPoint, position);
    if (position.lat < origin.lat) north *= -1;
    if (position.lng < origin.lng) east *= -1;
    return { east, north };
  }

  function fromLocalMeters(origin, east, north) {
    let point = google.maps.geometry.spherical.computeOffset(origin, Math.abs(north), north >= 0 ? 0 : 180);
    point = google.maps.geometry.spherical.computeOffset(point, Math.abs(east), east >= 0 ? 90 : 270);
    return normalizeLatLng(point);
  }

  function offsetPosition(position, meters, heading) {
    return normalizeLatLng(google.maps.geometry.spherical.computeOffset(position, meters, heading));
  }

  function openSettings() {
    dom.settingsApiKey.value = localStorage.getItem(API_KEY_STORAGE) || "";
    dom.settingsMapId.value = localStorage.getItem(MAP_ID_STORAGE) || "";
    dom.settingsDialog.showModal();
  }

  function handleKeyboard(event) {
    const target = event.target;
    const editingText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      commitHistoryNow();
      saveProject();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d" && !editingText) {
      event.preventDefault();
      duplicateSelected();
      return;
    }
    if (event.key === "Escape") {
      if (drawing) {
        cancelDrawing();
        setTool("select");
      } else selectElement(null);
      return;
    }
    if (event.key === "Enter" && drawing && !editingText) {
      event.preventDefault();
      finishDrawing();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !editingText && selectedId) {
      event.preventDefault();
      deleteSelected();
    }
  }

  function enterPreview() {
    commitHistoryNow();
    saveProject(true);
    dom.app.hidden = true;
    dom.preview.hidden = false;
    dom.previewTitle.textContent = state.event.title;
    dom.previewNotice.textContent = state.event.notice || "지도에서 시설물을 선택하면 상세 정보와 길찾기를 확인할 수 있습니다.";
    if (!previewMap) {
      previewMap = new google.maps.Map(dom.previewMap, {
        center: state.event.center,
        zoom: state.event.zoom,
        mapId: localStorage.getItem(MAP_ID_STORAGE) || "DEMO_MAP_ID",
        mapTypeId: state.event.mapTypeId,
        disableDefaultUI: true,
        zoomControl: true,
        fullscreenControl: true,
        gestureHandling: "greedy",
        clickableIcons: false
      });
      previewMap.addListener("click", closePreviewDetail);
    } else {
      previewMap.setCenter(state.event.center);
      previewMap.setZoom(state.event.zoom);
      previewMap.setMapTypeId(state.event.mapTypeId);
    }
    setTimeout(() => {
      google.maps.event.trigger(previewMap, "resize");
      renderPreviewMap();
      renderPreviewList();
    }, 30);
  }

  function exitPreview() {
    closePreviewDetail();
    dom.preview.hidden = true;
    dom.app.hidden = false;
    setTimeout(() => google.maps.event.trigger(map, "resize"), 30);
  }

  function clearPreviewOverlays() {
    previewOverlays.forEach((overlay) => {
      if (overlay?.setMap) overlay.setMap(null);
      else if (overlay) overlay.map = null;
    });
    previewOverlays = [];
  }

  function renderPreviewMap() {
    clearPreviewOverlays();
    state.elements.filter((item) => item.visible).forEach((item, index) => {
      if (item.shape === "rect") {
        const shape = new google.maps.Rectangle({
          map: previewMap,
          bounds: boundsFromCenter(item.center, item.width, item.height),
          strokeColor: item.color,
          strokeOpacity: 1,
          strokeWeight: 2,
          fillColor: item.color,
          fillOpacity: item.opacity,
          clickable: true,
          zIndex: 100 + index
        });
        shape.addListener("click", () => showPreviewDetail(item));
        const label = new LabelOverlay(item.center, displayName(item), () => showPreviewDetail(item));
        label.setMap(previewMap);
        previewOverlays.push(shape, label);
      } else if (item.shape === "point" || item.shape === "text") {
        const content = item.shape === "text" ? createTextMarkerContent(item, false) : createPointMarkerContent(item, false);
        const marker = new google.maps.marker.AdvancedMarkerElement({ map: previewMap, position: item.position, content, title: displayName(item), zIndex: 500 + index });
        marker.addListener("click", () => showPreviewDetail(item));
        previewOverlays.push(marker);
      } else if (item.shape === "path" || item.shape === "curve") {
        const path = item.shape === "curve" ? quadraticBezierPoints(item.points) : item.points;
        const shape = new google.maps.Polyline({ map: previewMap, path, strokeColor: item.color, strokeOpacity: 0.95, strokeWeight: item.strokeWidth, clickable: true, zIndex: 200 + index });
        shape.addListener("click", () => showPreviewDetail(item));
        previewOverlays.push(shape);
      } else if (item.shape === "zone") {
        const shape = new google.maps.Polygon({ map: previewMap, paths: item.points, strokeColor: item.color, strokeOpacity: 1, strokeWeight: item.strokeWidth, fillColor: item.color, fillOpacity: item.opacity, clickable: true, zIndex: 50 + index });
        shape.addListener("click", () => showPreviewDetail(item));
        const label = new LabelOverlay(centroid(item.points), displayName(item), () => showPreviewDetail(item));
        label.setMap(previewMap);
        previewOverlays.push(shape, label);
      }
    });
  }

  function renderPreviewList() {
    const query = dom.previewSearch.value.trim().toLowerCase();
    const items = state.elements.filter((item) => item.visible && `${item.name} ${item.code} ${TYPE_META[item.type].label}`.toLowerCase().includes(query));
    dom.previewList.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-layers";
      empty.textContent = "검색 결과가 없습니다.";
      dom.previewList.appendChild(empty);
      return;
    }
    items.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "preview-item";
      button.innerHTML = `<strong>${escapeHtml(TYPE_META[item.type].icon)} ${escapeHtml(item.name)}</strong><span>${escapeHtml(item.code || TYPE_META[item.type].label)}</span>`;
      button.addEventListener("click", () => {
        panPreviewToElement(item);
        showPreviewDetail(item);
      });
      dom.previewList.appendChild(button);
    });
  }

  function panPreviewToElement(item) {
    const position = elementPosition(item);
    previewMap.panTo(position);
    if (item.shape === "rect" || item.shape === "point" || item.shape === "text") previewMap.setZoom(Math.max(previewMap.getZoom() || 18, 19));
    else {
      const bounds = new google.maps.LatLngBounds();
      item.points.forEach((point) => bounds.extend(point));
      previewMap.fitBounds(bounds, 100);
    }
  }

  function showPreviewDetail(item) {
    const meta = TYPE_META[item.type];
    const position = elementPosition(item);
    dom.previewDetailType.textContent = meta.label;
    dom.previewDetailName.textContent = item.name;
    dom.previewDetailCode.textContent = item.code || "";
    dom.previewDetailDescription.textContent = item.description || "등록된 상세 설명이 없습니다.";
    dom.directionsLink.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${position.lat},${position.lng}`)}&travelmode=walking`;
    dom.previewDetail.hidden = false;
  }

  function closePreviewDetail() {
    dom.previewDetail.hidden = true;
  }

  boot();
})();
