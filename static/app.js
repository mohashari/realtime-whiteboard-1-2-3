/**
 * RustBoard — Realtime Collaborative Whiteboard
 * Modern, zero-dependency HTML5 Canvas + WebSocket Client
 */

(function () {
  'use strict';

  // --- Utility Functions ---
  function generateId() {
    return 'elem_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
  }

  function randomColor() {
    const palette = [
      '#ef4444', '#f97316', '#eab308', '#10b981',
      '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'
    ];
    return palette[Math.floor(Math.random() * palette.length)];
  }

  function getQueryParam(key, defaultVal) {
    const params = new URLSearchParams(window.location.search);
    return params.get(key) || defaultVal;
  }

  function setQueryParams(params) {
    const url = new URL(window.location);
    Object.keys(params).forEach(k => {
      if (params[k]) url.searchParams.set(k, params[k]);
      else url.searchParams.delete(k);
    });
    window.history.replaceState({}, '', url);
  }

  // --- Application State ---
  const state = {
    roomId: getQueryParam('room', 'main'),
    userId: 'user_' + Math.random().toString(36).substr(2, 6),
    userName: getQueryParam('name', 'User-' + Math.floor(100 + Math.random() * 900)),
    userColor: randomColor(),
    
    // Tools: 'pen', 'highlighter', 'line', 'arrow', 'rectangle', 'circle', 'text', 'eraser', 'pan'
    currentTool: 'pen',
    strokeColor: '#1e293b',
    strokeWidth: 4,
    fillMode: 'none', // 'none', 'semi', 'solid'

    // Viewport transform
    zoom: 1.0,
    panX: 0,
    panY: 0,
    isPanning: false,
    panStartX: 0,
    panStartY: 0,
    spacePressed: false,

    // Whiteboard Elements
    elements: [], // Synchronized array of elements
    historyCount: 0,

    // Live interactions
    isDrawing: false,
    currentDrawing: null, // Temporary in-progress element
    collaborators: new Map(), // peer_id -> { name, color, cursor: {x, y} }

    // WebSocket
    ws: null,
    isConnected: false,
    reconnectTimer: null,
    lastCursorSend: 0
  };

  // --- DOM Elements ---
  const canvas = document.getElementById('whiteboard');
  const ctx = canvas.getContext('2d');
  const canvasContainer = document.getElementById('canvasContainer');
  const cursorsOverlay = document.getElementById('cursorsOverlay');
  const inlineTextInput = document.getElementById('inlineTextInput');

  // Header Elements
  const currentRoomNameEl = document.getElementById('currentRoomName');
  const btnCopyRoom = document.getElementById('btnCopyRoom');
  const roomBadge = document.getElementById('roomBadge');
  const btnUndo = document.getElementById('btnUndo');
  const btnRedo = document.getElementById('btnRedo');
  const btnClear = document.getElementById('btnClear');
  const btnExportMenu = document.getElementById('btnExportMenu');
  const exportDropdown = document.getElementById('exportDropdown');
  const btnExportPng = document.getElementById('btnExportPng');
  const btnExportSvg = document.getElementById('btnExportSvg');
  const btnExportJson = document.getElementById('btnExportJson');
  const btnImportJson = document.getElementById('btnImportJson');
  const jsonFileInput = document.getElementById('jsonFileInput');
  const collaboratorAvatars = document.getElementById('collaboratorAvatars');
  const collaboratorCount = document.getElementById('collaboratorCount');
  const connectionStatus = document.getElementById('connectionStatus');
  const statusText = document.getElementById('statusText');
  const btnHelp = document.getElementById('btnHelp');

  // Viewport Elements
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnResetView = document.getElementById('btnResetView');
  const zoomLevelEl = document.getElementById('zoomLevel');
  const coordsIndicator = document.getElementById('coordsIndicator');

  // Tool Dock & Properties
  const toolBtns = document.querySelectorAll('.tool-btn');
  const colorSwatches = document.querySelectorAll('.color-swatch');
  const customColorPicker = document.getElementById('customColorPicker');
  const sizeBtns = document.querySelectorAll('.size-btn');
  const fillBtns = document.querySelectorAll('.fill-btn');
  const propertiesBar = document.getElementById('propertiesBar');
  const fillGroup = document.getElementById('fillGroup');
  const fillSeparator = document.getElementById('fillSeparator');

  // Modals
  const roomModal = document.getElementById('roomModal');
  const roomInput = document.getElementById('roomInput');
  const usernameInput = document.getElementById('usernameInput');
  const btnCloseRoomModal = document.getElementById('btnCloseRoomModal');
  const btnCancelRoomModal = document.getElementById('btnCancelRoomModal');
  const btnConfirmRoomSwitch = document.getElementById('btnConfirmRoomSwitch');

  const clearModal = document.getElementById('clearModal');
  const btnCloseClearModal = document.getElementById('btnCloseClearModal');
  const btnCancelClear = document.getElementById('btnCancelClear');
  const btnConfirmClear = document.getElementById('btnConfirmClear');

  const helpModal = document.getElementById('helpModal');
  const btnCloseHelpModal = document.getElementById('btnCloseHelpModal');
  const btnCloseHelp = document.getElementById('btnCloseHelp');
  const toastContainer = document.getElementById('toastContainer');

  // --- Toast Notifications ---
  function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // --- Coordinate Transformations ---
  function screenToCanvas(screenX, screenY) {
    return {
      x: (screenX - state.panX) / state.zoom,
      y: (screenY - state.panY) / state.zoom
    };
  }

  function canvasToScreen(canvasX, canvasY) {
    return {
      x: canvasX * state.zoom + state.panX,
      y: canvasY * state.zoom + state.panY
    };
  }

  // --- Canvas Sizing & High-DPI Support ---
  function resizeCanvas() {
    const rect = canvasContainer.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);
    render();
  }

  window.addEventListener('resize', resizeCanvas);

  // --- Color & Hex Helpers ---
  function hexToRgba(hex, alpha) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // --- Rendering Loop ---
  function render() {
    const width = canvasContainer.clientWidth;
    const height = canvasContainer.clientHeight;

    ctx.save();
    ctx.clearRect(0, 0, width, height);

    // Apply viewport transform
    ctx.translate(state.panX, state.panY);
    ctx.scale(state.zoom, state.zoom);

    // Render synchronized elements
    for (const elem of state.elements) {
      drawElement(ctx, elem);
    }

    // Render local live drawing preview
    if (state.currentDrawing) {
      drawElement(ctx, state.currentDrawing);
    }

    ctx.restore();

    // Render collaborator cursor tags
    renderRemoteCursors();
  }

  function drawElement(context, elem) {
    if (!elem || !elem.element_type) return;
    const type = elem.element_type;

    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';

    switch (type.type) {
      case 'stroke': {
        const points = type.points;
        if (!points || points.length === 0) break;

        context.strokeStyle = type.is_highlighter
          ? hexToRgba(type.color, 0.35)
          : type.color;
        context.lineWidth = type.width;

        context.beginPath();
        context.moveTo(points[0].x, points[0].y);

        if (points.length === 1) {
          context.arc(points[0].x, points[0].y, type.width / 2, 0, Math.PI * 2);
          context.fillStyle = context.strokeStyle;
          context.fill();
        } else if (points.length === 2) {
          context.lineTo(points[1].x, points[1].y);
          context.stroke();
        } else {
          // Quadratic Bézier curve smoothing
          for (let i = 1; i < points.length - 1; i++) {
            const xc = (points[i].x + points[i + 1].x) / 2;
            const yc = (points[i].y + points[i + 1].y) / 2;
            context.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
          }
          context.lineTo(points[points.length - 1].x, points[points.length - 1].y);
          context.stroke();
        }
        break;
      }

      case 'line': {
        context.strokeStyle = type.stroke_color;
        context.lineWidth = type.stroke_width;
        context.beginPath();
        context.moveTo(type.start.x, type.start.y);
        context.lineTo(type.end.x, type.end.y);
        context.stroke();
        break;
      }

      case 'arrow': {
        context.strokeStyle = type.stroke_color;
        context.fillStyle = type.stroke_color;
        context.lineWidth = type.stroke_width;

        const start = type.start;
        const end = type.end;
        const headLength = Math.max(12, type.stroke_width * 3.5);
        const angle = Math.atan2(end.y - start.y, end.x - start.x);

        // Draw main line
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();

        // Draw arrow head
        context.beginPath();
        context.moveTo(end.x, end.y);
        context.lineTo(
          end.x - headLength * Math.cos(angle - Math.PI / 6),
          end.y - headLength * Math.sin(angle - Math.PI / 6)
        );
        context.lineTo(
          end.x - headLength * Math.cos(angle + Math.PI / 6),
          end.y - headLength * Math.sin(angle + Math.PI / 6)
        );
        context.closePath();
        context.fill();
        break;
      }

      case 'rectangle': {
        context.strokeStyle = type.stroke_color;
        context.lineWidth = type.stroke_width;

        if (type.fill_color) {
          context.fillStyle = type.fill_color;
          context.fillRect(type.x, type.y, type.width, type.height);
        }
        context.strokeRect(type.x, type.y, type.width, type.height);
        break;
      }

      case 'circle': {
        context.strokeStyle = type.stroke_color;
        context.lineWidth = type.stroke_width;

        context.beginPath();
        context.ellipse(type.cx, type.cy, Math.abs(type.rx), Math.abs(type.ry), 0, 0, Math.PI * 2);
        if (type.fill_color) {
          context.fillStyle = type.fill_color;
          context.fill();
        }
        context.stroke();
        break;
      }

      case 'text': {
        context.font = `${type.font_size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        context.fillStyle = type.color;
        context.textBaseline = 'top';
        context.fillText(type.text, type.x, type.y);
        break;
      }
    }

    context.restore();
  }

  // --- Render Collaborative Cursors ---
  function renderRemoteCursors() {
    cursorsOverlay.innerHTML = '';
    state.collaborators.forEach((user, id) => {
      if (!user.cursor || id === state.userId) return;

      const screenPos = canvasToScreen(user.cursor.x, user.cursor.y);
      if (
        screenPos.x < -50 ||
        screenPos.x > canvasContainer.clientWidth + 50 ||
        screenPos.y < -50 ||
        screenPos.y > canvasContainer.clientHeight + 50
      ) {
        return; // Cull out-of-screen cursors
      }

      const cursorEl = document.createElement('div');
      cursorEl.className = 'remote-cursor';
      cursorEl.style.transform = `translate(${screenPos.x}px, ${screenPos.y}px)`;

      cursorEl.innerHTML = `
        <svg class="cursor-icon" viewBox="0 0 24 24" fill="${user.color || '#3b82f6'}">
          <path d="M4 0l16 12-7 1.5-3.5 8.5-2.5-1 3.5-8L4 0z" stroke="#ffffff" stroke-width="1.5"/>
        </svg>
        <span class="cursor-tag" style="background-color: ${user.color || '#3b82f6'}">${user.name || 'Anonymous'}</span>
      `;
      cursorsOverlay.appendChild(cursorEl);
    });
  }

  // --- WebSocket Connection ---
  function connectWebSocket() {
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/${encodeURIComponent(state.roomId)}`;

    updateConnectionStatus('connecting');

    try {
      const ws = new WebSocket(wsUrl);
      state.ws = ws;

      ws.onopen = () => {
        updateConnectionStatus('connected');
        showToast(`Connected to room "${state.roomId}"`);

        // Send Join message
        sendWsMessage({
          type: 'Join',
          user_id: state.userId,
          user_name: state.userName,
          user_color: state.userColor
        });
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleServerMessage(msg);
        } catch (e) {
          console.error('Failed to parse WS message:', e);
        }
      };

      ws.onclose = () => {
        updateConnectionStatus('disconnected');
        scheduleReconnect();
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        updateConnectionStatus('disconnected');
      };
    } catch (e) {
      console.error('WebSocket connection failed:', e);
      updateConnectionStatus('disconnected');
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connectWebSocket();
    }, 3000);
  }

  function sendWsMessage(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    }
  }

  function updateConnectionStatus(status) {
    connectionStatus.className = 'connection-status ' + status;
    if (status === 'connected') {
      statusText.textContent = 'Connected';
    } else if (status === 'connecting') {
      statusText.textContent = 'Connecting...';
    } else {
      statusText.textContent = 'Disconnected';
    }
  }

  // --- Handle Incoming Server Messages ---
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'Init': {
        state.userId = msg.your_id;
        state.elements = msg.elements || [];
        state.collaborators.clear();
        (msg.users || []).forEach(u => {
          state.collaborators.set(u.id, u);
        });
        updateCollaboratorsUI();
        updateUndoRedoButtons();
        render();
        break;
      }

      case 'ElementAdded': {
        // Prevent duplicate if already added locally
        const exists = state.elements.some(e => e.id === msg.element.id);
        if (!exists) {
          state.elements.push(msg.element);
          updateUndoRedoButtons();
          render();
        }
        break;
      }

      case 'ElementUpdated': {
        const idx = state.elements.findIndex(e => e.id === msg.element.id);
        if (idx !== -1) {
          state.elements[idx] = msg.element;
          render();
        }
        break;
      }

      case 'ElementDeleted': {
        state.elements = state.elements.filter(e => e.id !== msg.id);
        updateUndoRedoButtons();
        render();
        break;
      }

      case 'BoardCleared': {
        state.elements = [];
        updateUndoRedoButtons();
        render();
        showToast('Whiteboard was cleared');
        break;
      }

      case 'UserJoined': {
        state.collaborators.set(msg.user.id, msg.user);
        updateCollaboratorsUI();
        if (msg.user.id !== state.userId) {
          showToast(`${msg.user.name} joined`);
        }
        break;
      }

      case 'UserLeft': {
        const u = state.collaborators.get(msg.user_id);
        if (u) {
          showToast(`${u.name} left`);
          state.collaborators.delete(msg.user_id);
          updateCollaboratorsUI();
          renderRemoteCursors();
        }
        break;
      }

      case 'CursorMoved': {
        if (msg.user_id !== state.userId) {
          let user = state.collaborators.get(msg.user_id);
          if (user) {
            user.cursor = { x: msg.x, y: msg.y };
            renderRemoteCursors();
          }
        }
        break;
      }

      case 'Pong':
        break;

      case 'Error': {
        showToast('Error: ' + msg.message);
        break;
      }
    }
  }

  function updateCollaboratorsUI() {
    collaboratorAvatars.innerHTML = '';
    const users = Array.from(state.collaborators.values());
    collaboratorCount.textContent = `${users.length} online`;

    users.slice(0, 4).forEach(u => {
      const chip = document.createElement('div');
      chip.className = 'avatar-chip';
      chip.style.backgroundColor = u.color || '#3b82f6';
      chip.textContent = (u.name || 'U').charAt(0).toUpperCase();
      chip.title = u.name;
      collaboratorAvatars.appendChild(chip);
    });

    if (users.length > 4) {
      const extra = document.createElement('div');
      extra.className = 'avatar-chip';
      extra.style.backgroundColor = '#64748b';
      extra.textContent = `+${users.length - 4}`;
      collaboratorAvatars.appendChild(extra);
    }
  }

  function updateUndoRedoButtons() {
    btnUndo.disabled = state.elements.length === 0;
    // Redo is maintained on server or client stack
    btnRedo.disabled = false;
  }

  // --- Broadcast Cursor Position (throttled) ---
  function sendCursorPosition(canvasPos) {
    const now = Date.now();
    if (now - state.lastCursorSend > 40) { // ~25 updates/sec max
      state.lastCursorSend = now;
      sendWsMessage({
        type: 'CursorMove',
        x: canvasPos.x,
        y: canvasPos.y
      });
    }
  }

  // --- Element Hit Testing (for Eraser) ---
  function distanceToSegment(p, a, b) {
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
  }

  function hitTestElement(elem, pos, tolerance = 10) {
    const t = elem.element_type;
    switch (t.type) {
      case 'stroke': {
        const pts = t.points;
        const r = (t.width / 2) + tolerance;
        for (let i = 0; i < pts.length - 1; i++) {
          if (distanceToSegment(pos, pts[i], pts[i + 1]) <= r) return true;
        }
        if (pts.length === 1 && Math.hypot(pos.x - pts[0].x, pos.y - pts[0].y) <= r) return true;
        return false;
      }
      case 'line':
      case 'arrow': {
        const r = (t.stroke_width / 2) + tolerance;
        return distanceToSegment(pos, t.start, t.end) <= r;
      }
      case 'rectangle': {
        const minX = Math.min(t.x, t.x + t.width) - tolerance;
        const maxX = Math.max(t.x, t.x + t.width) + tolerance;
        const minY = Math.min(t.y, t.y + t.height) - tolerance;
        const maxY = Math.max(t.y, t.y + t.height) + tolerance;
        return pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY;
      }
      case 'circle': {
        const dx = (pos.x - t.cx) / (Math.abs(t.rx) + tolerance);
        const dy = (pos.y - t.cy) / (Math.abs(t.ry) + tolerance);
        return (dx * dx + dy * dy) <= 1.0;
      }
      case 'text': {
        const pad = tolerance;
        const width = (t.text.length * t.font_size * 0.6) + pad;
        const height = t.font_size + pad;
        return pos.x >= t.x - pad && pos.x <= t.x + width && pos.y >= t.y - pad && pos.y <= t.y + height;
      }
      default:
        return false;
    }
  }

  function eraseAt(pos) {
    for (let i = state.elements.length - 1; i >= 0; i--) {
      const elem = state.elements[i];
      if (hitTestElement(elem, pos)) {
        // Delete element
        state.elements.splice(i, 1);
        sendWsMessage({ type: 'DeleteElement', id: elem.id });
        render();
        break;
      }
    }
  }

  // --- Pointer & Touch Events Handling ---
  let startPos = null;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const canvasPos = screenToCanvas(screenX, screenY);

    if (state.spacePressed || state.currentTool === 'pan' || e.button === 1) {
      // Pan mode
      state.isPanning = true;
      state.panStartX = e.clientX - state.panX;
      state.panStartY = e.clientY - state.panY;
      canvasContainer.classList.add('panning-active');
      return;
    }

    if (e.button !== 0) return; // Only primary button

    if (state.currentTool === 'eraser') {
      state.isDrawing = true;
      eraseAt(canvasPos);
      return;
    }

    if (state.currentTool === 'text') {
      finishInlineText();
      startInlineText(screenX, screenY, canvasPos);
      return;
    }

    state.isDrawing = true;
    startPos = canvasPos;

    // Initialize temporary drawing element
    const id = generateId();
    let fillColor = null;
    if (state.fillMode === 'solid') fillColor = state.strokeColor;
    else if (state.fillMode === 'semi') fillColor = hexToRgba(state.strokeColor, 0.25);

    switch (state.currentTool) {
      case 'pen':
      case 'highlighter': {
        state.currentDrawing = {
          id: id,
          created_by: state.userId,
          created_at: Date.now(),
          z_index: state.elements.length,
          element_type: {
            type: 'stroke',
            points: [{ x: canvasPos.x, y: canvasPos.y }],
            color: state.strokeColor,
            width: state.strokeWidth,
            is_highlighter: state.currentTool === 'highlighter'
          }
        };
        break;
      }
      case 'line': {
        state.currentDrawing = {
          id: id,
          created_by: state.userId,
          created_at: Date.now(),
          z_index: state.elements.length,
          element_type: {
            type: 'line',
            start: { x: canvasPos.x, y: canvasPos.y },
            end: { x: canvasPos.x, y: canvasPos.y },
            stroke_color: state.strokeColor,
            stroke_width: state.strokeWidth
          }
        };
        break;
      }
      case 'arrow': {
        state.currentDrawing = {
          id: id,
          created_by: state.userId,
          created_at: Date.now(),
          z_index: state.elements.length,
          element_type: {
            type: 'arrow',
            start: { x: canvasPos.x, y: canvasPos.y },
            end: { x: canvasPos.x, y: canvasPos.y },
            stroke_color: state.strokeColor,
            stroke_width: state.strokeWidth
          }
        };
        break;
      }
      case 'rectangle': {
        state.currentDrawing = {
          id: id,
          created_by: state.userId,
          created_at: Date.now(),
          z_index: state.elements.length,
          element_type: {
            type: 'rectangle',
            x: canvasPos.x,
            y: canvasPos.y,
            width: 0,
            height: 0,
            stroke_color: state.strokeColor,
            stroke_width: state.strokeWidth,
            fill_color: fillColor
          }
        };
        break;
      }
      case 'circle': {
        state.currentDrawing = {
          id: id,
          created_by: state.userId,
          created_at: Date.now(),
          z_index: state.elements.length,
          element_type: {
            type: 'circle',
            cx: canvasPos.x,
            cy: canvasPos.y,
            rx: 0,
            ry: 0,
            stroke_color: state.strokeColor,
            stroke_width: state.strokeWidth,
            fill_color: fillColor
          }
        };
        break;
      }
    }

    render();
  });

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const canvasPos = screenToCanvas(screenX, screenY);

    // Update bottom coordinates readout
    coordsIndicator.textContent = `X: ${Math.round(canvasPos.x)}, Y: ${Math.round(canvasPos.y)}`;

    // Broadcast cursor position to collaborators
    sendCursorPosition(canvasPos);

    if (state.isPanning) {
      state.panX = e.clientX - state.panStartX;
      state.panY = e.clientY - state.panStartY;
      render();
      return;
    }

    if (!state.isDrawing) return;

    if (state.currentTool === 'eraser') {
      eraseAt(canvasPos);
      return;
    }

    if (!state.currentDrawing) return;

    const t = state.currentDrawing.element_type;
    switch (t.type) {
      case 'stroke': {
        t.points.push({ x: canvasPos.x, y: canvasPos.y });
        break;
      }
      case 'line':
      case 'arrow': {
        t.end = { x: canvasPos.x, y: canvasPos.y };
        break;
      }
      case 'rectangle': {
        t.x = Math.min(startPos.x, canvasPos.x);
        t.y = Math.min(startPos.y, canvasPos.y);
        t.width = Math.abs(canvasPos.x - startPos.x);
        t.height = Math.abs(canvasPos.y - startPos.y);
        break;
      }
      case 'circle': {
        t.cx = (startPos.x + canvasPos.x) / 2;
        t.cy = (startPos.y + canvasPos.y) / 2;
        t.rx = Math.abs(canvasPos.x - startPos.x) / 2;
        t.ry = Math.abs(canvasPos.y - startPos.y) / 2;
        break;
      }
    }

    render();
  });

  function endDrawing(e) {
    if (state.isPanning) {
      state.isPanning = false;
      canvasContainer.classList.remove('panning-active');
      return;
    }

    if (!state.isDrawing) return;
    state.isDrawing = false;

    if (state.currentDrawing) {
      const finalElement = state.currentDrawing;
      state.currentDrawing = null;

      // Filter out accidental clicks/empty elements
      const t = finalElement.element_type;
      let isValid = true;
      if (t.type === 'stroke' && t.points.length <= 1) isValid = true; // dot is valid
      if (t.type === 'rectangle' && t.width < 2 && t.height < 2) isValid = false;
      if (t.type === 'circle' && t.rx < 2 && t.ry < 2) isValid = false;
      if ((t.type === 'line' || t.type === 'arrow') && Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y) < 2) isValid = false;

      if (isValid) {
        state.elements.push(finalElement);
        sendWsMessage({
          type: 'AddElement',
          element: finalElement
        });
        updateUndoRedoButtons();
      }
      render();
    }
  }

  canvas.addEventListener('pointerup', endDrawing);
  canvas.addEventListener('pointercancel', endDrawing);

  // --- Wheel Zoom & Pan ---
  canvasContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvasContainer.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (e.ctrlKey || e.metaKey) {
      // Zoom centered at mouse cursor
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      setZoom(state.zoom * zoomFactor, mouseX, mouseY);
    } else {
      // Pan
      state.panX -= e.deltaX;
      state.panY -= e.deltaY;
      render();
    }
  }, { passive: false });

  function setZoom(newZoom, centerX = canvasContainer.clientWidth / 2, centerY = canvasContainer.clientHeight / 2) {
    newZoom = Math.max(0.1, Math.min(5.0, newZoom));
    const factor = newZoom / state.zoom;
    state.panX = centerX - (centerX - state.panX) * factor;
    state.panY = centerY - (centerY - state.panY) * factor;
    state.zoom = newZoom;
    zoomLevelEl.textContent = `${Math.round(state.zoom * 100)}%`;
    render();
  }

  // --- Inline Text Input ---
  let activeTextPos = null;

  function startInlineText(screenX, screenY, canvasPos) {
    activeTextPos = canvasPos;
    inlineTextInput.style.display = 'block';
    inlineTextInput.style.left = screenX + 'px';
    inlineTextInput.style.top = screenY + 'px';
    inlineTextInput.style.fontSize = (20 * state.zoom) + 'px';
    inlineTextInput.style.color = state.strokeColor;
    inlineTextInput.value = '';
    setTimeout(() => inlineTextInput.focus(), 10);
  }

  function finishInlineText() {
    if (inlineTextInput.style.display === 'none' || !activeTextPos) return;
    const text = inlineTextInput.value.trim();
    if (text) {
      const elem = {
        id: generateId(),
        created_by: state.userId,
        created_at: Date.now(),
        z_index: state.elements.length,
        element_type: {
          type: 'text',
          x: activeTextPos.x,
          y: activeTextPos.y,
          text: text,
          font_size: 20,
          color: state.strokeColor
        }
      };
      state.elements.push(elem);
      sendWsMessage({ type: 'AddElement', element: elem });
      updateUndoRedoButtons();
      render();
    }
    inlineTextInput.style.display = 'none';
    inlineTextInput.value = '';
    activeTextPos = null;
  }

  inlineTextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      finishInlineText();
    } else if (e.key === 'Escape') {
      inlineTextInput.style.display = 'none';
      activeTextPos = null;
    }
  });

  inlineTextInput.addEventListener('blur', finishInlineText);

  // --- Keyboard Shortcuts & Pan Gestures ---
  window.addEventListener('keydown', (e) => {
    // If typing inside an input or modal, do not intercept
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

    if (e.code === 'Space' && !state.spacePressed) {
      state.spacePressed = true;
      canvasContainer.classList.add('panning');
      e.preventDefault();
    }

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) sendWsMessage({ type: 'Redo' });
        else sendWsMessage({ type: 'Undo' });
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        sendWsMessage({ type: 'Redo' });
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        exportAsPng();
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'p':
      case '1':
        setTool('pen');
        break;
      case 'h':
      case '2':
        setTool('highlighter');
        break;
      case 'l':
      case '3':
        setTool('line');
        break;
      case 'a':
      case '4':
        setTool('arrow');
        break;
      case 'r':
      case '5':
        setTool('rectangle');
        break;
      case 'c':
      case '6':
        setTool('circle');
        break;
      case 't':
      case '7':
        setTool('text');
        break;
      case 'e':
      case '8':
        setTool('eraser');
        break;
      case '+':
      case '=':
        setZoom(state.zoom * 1.15);
        break;
      case '-':
      case '_':
        setZoom(state.zoom / 1.15);
        break;
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      state.spacePressed = false;
      canvasContainer.classList.remove('panning');
    }
  });

  // --- UI Controls Event Listeners ---
  function setTool(toolName) {
    state.currentTool = toolName;
    toolBtns.forEach(b => {
      b.classList.toggle('active', b.dataset.tool === toolName);
    });

    const isShape = ['rectangle', 'circle'].includes(toolName);
    fillGroup.style.display = isShape ? 'flex' : 'none';
    fillSeparator.style.display = isShape ? 'block' : 'none';

    if (toolName === 'pan') {
      canvasContainer.classList.add('panning');
    } else {
      canvasContainer.classList.remove('panning');
    }
  }

  toolBtns.forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  colorSwatches.forEach(swatch => {
    swatch.addEventListener('click', () => {
      colorSwatches.forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      state.strokeColor = swatch.dataset.color;
      customColorPicker.value = state.strokeColor;
    });
  });

  customColorPicker.addEventListener('input', (e) => {
    state.strokeColor = e.target.value;
    colorSwatches.forEach(s => s.classList.remove('active'));
  });

  sizeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      sizeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.strokeWidth = parseInt(btn.dataset.size, 10);
    });
  });

  fillBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      fillBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.fillMode = btn.dataset.fill;
    });
  });

  // Action Buttons
  btnUndo.addEventListener('click', () => sendWsMessage({ type: 'Undo' }));
  btnRedo.addEventListener('click', () => sendWsMessage({ type: 'Redo' }));
  btnClear.addEventListener('click', () => clearModal.style.display = 'flex');

  btnZoomIn.addEventListener('click', () => setZoom(state.zoom * 1.2));
  btnZoomOut.addEventListener('click', () => setZoom(state.zoom / 1.2));
  btnResetView.addEventListener('click', () => {
    state.zoom = 1.0;
    state.panX = 0;
    state.panY = 0;
    zoomLevelEl.textContent = '100%';
    render();
  });

  // --- Clear Confirmation ---
  btnCancelClear.addEventListener('click', () => clearModal.style.display = 'none');
  btnCloseClearModal.addEventListener('click', () => clearModal.style.display = 'none');
  btnConfirmClear.addEventListener('click', () => {
    clearModal.style.display = 'none';
    sendWsMessage({ type: 'Clear' });
  });

  // --- Help Modal ---
  btnHelp.addEventListener('click', () => helpModal.style.display = 'flex');
  btnCloseHelp.addEventListener('click', () => helpModal.style.display = 'none');
  btnCloseHelpModal.addEventListener('click', () => helpModal.style.display = 'none');

  // --- Room Switcher Modal ---
  roomBadge.addEventListener('click', () => {
    roomInput.value = state.roomId;
    usernameInput.value = state.userName;
    roomModal.style.display = 'flex';
  });

  btnCancelRoomModal.addEventListener('click', () => roomModal.style.display = 'none');
  btnCloseRoomModal.addEventListener('click', () => roomModal.style.display = 'none');
  btnConfirmRoomSwitch.addEventListener('click', () => {
    const newRoom = roomInput.value.trim();
    const newName = usernameInput.value.trim();
    if (newRoom) {
      state.roomId = newRoom;
      currentRoomNameEl.textContent = newRoom;
      if (newName) state.userName = newName;
      setQueryParams({ room: state.roomId, name: state.userName });
      roomModal.style.display = 'none';
      connectWebSocket();
    }
  });

  // Copy Room Link
  btnCopyRoom.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(window.location.href).then(() => {
      showToast('Room link copied to clipboard!');
    }).catch(() => {
      showToast('Copied: ' + window.location.href);
    });
  });

  // --- Export Features ---
  btnExportMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    exportDropdown.parentElement.classList.toggle('show');
  });

  window.addEventListener('click', () => {
    exportDropdown.parentElement.classList.remove('show');
  });

  // 1. Export as PNG
  function exportAsPng() {
    if (state.elements.length === 0) {
      showToast('Canvas is empty!');
      return;
    }

    // Calculate bounding box of all elements
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    state.elements.forEach(elem => {
      const t = elem.element_type;
      switch (t.type) {
        case 'stroke':
          t.points.forEach(p => {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
          });
          break;
        case 'line':
        case 'arrow':
          minX = Math.min(minX, t.start.x, t.end.x);
          minY = Math.min(minY, t.start.y, t.end.y);
          maxX = Math.max(maxX, t.start.x, t.end.x);
          maxY = Math.max(maxY, t.start.y, t.end.y);
          break;
        case 'rectangle':
          minX = Math.min(minX, t.x);
          minY = Math.min(minY, t.y);
          maxX = Math.max(maxX, t.x + t.width);
          maxY = Math.max(maxY, t.y + t.height);
          break;
        case 'circle':
          minX = Math.min(minX, t.cx - Math.abs(t.rx));
          minY = Math.min(minY, t.cy - Math.abs(t.ry));
          maxX = Math.max(maxX, t.cx + Math.abs(t.rx));
          maxY = Math.max(maxY, t.cy + Math.abs(t.ry));
          break;
        case 'text':
          minX = Math.min(minX, t.x);
          minY = Math.min(minY, t.y);
          maxX = Math.max(maxX, t.x + (t.text.length * t.font_size * 0.6));
          maxY = Math.max(maxY, t.y + t.font_size * 1.5);
          break;
      }
    });

    const padding = 40;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    const outWidth = Math.max(200, maxX - minX);
    const outHeight = Math.max(200, maxY - minY);

    const offscreen = document.createElement('canvas');
    offscreen.width = outWidth * 2; // 2x resolution
    offscreen.height = outHeight * 2;
    const offCtx = offscreen.getContext('2d');
    offCtx.scale(2, 2);

    // Solid white background
    offCtx.fillStyle = '#ffffff';
    offCtx.fillRect(0, 0, outWidth, outHeight);

    // Shift to bounding box
    offCtx.translate(-minX, -minY);

    state.elements.forEach(elem => drawElement(offCtx, elem));

    const link = document.createElement('a');
    link.download = `rustboard-${state.roomId}-${Date.now()}.png`;
    link.href = offscreen.toDataURL('image/png');
    link.click();
    showToast('Exported PNG');
  }

  btnExportPng.addEventListener('click', exportAsPng);

  // 2. Export as SVG
  function exportAsSvg() {
    if (state.elements.length === 0) {
      showToast('Canvas is empty!');
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.elements.forEach(elem => {
      const t = elem.element_type;
      if (t.type === 'stroke') {
        t.points.forEach(p => {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        });
      } else if (t.type === 'line' || t.type === 'arrow') {
        minX = Math.min(minX, t.start.x, t.end.x); minY = Math.min(minY, t.start.y, t.end.y);
        maxX = Math.max(maxX, t.start.x, t.end.x); maxY = Math.max(maxY, t.start.y, t.end.y);
      } else if (t.type === 'rectangle') {
        minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
        maxX = Math.max(maxX, t.x + t.width); maxY = Math.max(maxY, t.y + t.height);
      } else if (t.type === 'circle') {
        minX = Math.min(minX, t.cx - Math.abs(t.rx)); minY = Math.min(minY, t.cy - Math.abs(t.ry));
        maxX = Math.max(maxX, t.cx + Math.abs(t.rx)); maxY = Math.max(maxY, t.cy + Math.abs(t.ry));
      } else if (t.type === 'text') {
        minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
        maxX = Math.max(maxX, t.x + t.text.length * t.font_size * 0.6); maxY = Math.max(maxY, t.y + t.font_size);
      }
    });

    const pad = 30;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const w = Math.max(100, maxX - minX);
    const h = Math.max(100, maxY - minY);

    let svg = `<?xml version="1.0" standalone="no"?>\n<svg width="${w}" height="${h}" viewBox="${minX} ${minY} ${w} ${h}" xmlns="http://www.w3.org/2000/svg">\n`;
    svg += `  <rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#ffffff"/>\n`;

    state.elements.forEach(elem => {
      const t = elem.element_type;
      switch (t.type) {
        case 'stroke': {
          if (!t.points || t.points.length === 0) break;
          const d = t.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
          const opacity = t.is_highlighter ? '0.35' : '1.0';
          svg += `  <path d="${d}" fill="none" stroke="${t.color}" stroke-width="${t.width}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>\n`;
          break;
        }
        case 'line': {
          svg += `  <line x1="${t.start.x}" y1="${t.start.y}" x2="${t.end.x}" y2="${t.end.y}" stroke="${t.stroke_color}" stroke-width="${t.stroke_width}" stroke-linecap="round"/>\n`;
          break;
        }
        case 'arrow': {
          const start = t.start, end = t.end;
          const headLength = Math.max(12, t.stroke_width * 3.5);
          const angle = Math.atan2(end.y - start.y, end.x - start.x);
          const x1 = end.x - headLength * Math.cos(angle - Math.PI / 6);
          const y1 = end.y - headLength * Math.sin(angle - Math.PI / 6);
          const x2 = end.x - headLength * Math.cos(angle + Math.PI / 6);
          const y2 = end.y - headLength * Math.sin(angle + Math.PI / 6);

          svg += `  <line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="${t.stroke_color}" stroke-width="${t.stroke_width}" stroke-linecap="round"/>\n`;
          svg += `  <polygon points="${end.x},${end.y} ${x1},${y1} ${x2},${y2}" fill="${t.stroke_color}"/>\n`;
          break;
        }
        case 'rectangle': {
          const fill = t.fill_color ? t.fill_color : 'none';
          svg += `  <rect x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}" fill="${fill}" stroke="${t.stroke_color}" stroke-width="${t.stroke_width}"/>\n`;
          break;
        }
        case 'circle': {
          const fill = t.fill_color ? t.fill_color : 'none';
          svg += `  <ellipse cx="${t.cx}" cy="${t.cy}" rx="${Math.abs(t.rx)}" ry="${Math.abs(t.ry)}" fill="${fill}" stroke="${t.stroke_color}" stroke-width="${t.stroke_width}"/>\n`;
          break;
        }
        case 'text': {
          svg += `  <text x="${t.x}" y="${t.y + t.font_size}" font-family="sans-serif" font-size="${t.font_size}" fill="${t.color}">${escapeXml(t.text)}</text>\n`;
          break;
        }
      }
    });

    svg += '</svg>';

    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const link = document.createElement('a');
    link.download = `rustboard-${state.roomId}-${Date.now()}.svg`;
    link.href = URL.createObjectURL(blob);
    link.click();
    showToast('Exported SVG');
  }

  function escapeXml(unsafe) {
    return unsafe.replace(/[<>&'"]/g, c => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
      }
    });
  }

  btnExportSvg.addEventListener('click', exportAsSvg);

  // 3. Export as JSON snapshot
  btnExportJson.addEventListener('click', () => {
    const data = {
      version: '1.0',
      roomId: state.roomId,
      exportedAt: new Date().toISOString(),
      elements: state.elements
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.download = `rustboard-${state.roomId}-${Date.now()}.json`;
    link.href = URL.createObjectURL(blob);
    link.click();
    showToast('Saved JSON Snapshot');
  });

  // 4. Import JSON snapshot
  btnImportJson.addEventListener('click', () => jsonFileInput.click());

  jsonFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target.result);
        const importedElements = json.elements || (Array.isArray(json) ? json : null);
        if (Array.isArray(importedElements)) {
          // Import via REST API or bulk add
          fetch(`/api/rooms/${encodeURIComponent(state.roomId)}/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(importedElements)
          }).then(res => {
            if (res.ok) {
              showToast(`Imported ${importedElements.length} elements`);
            } else {
              showToast('Import request failed');
            }
          }).catch(err => {
            console.error('Import error:', err);
            // Fallback: send as WS additions
            importedElements.forEach(elem => {
              sendWsMessage({ type: 'AddElement', element: elem });
            });
            showToast(`Imported ${importedElements.length} elements`);
          });
        } else {
          showToast('Invalid JSON whiteboard format');
        }
      } catch (err) {
        showToast('Failed to parse JSON file');
      }
      jsonFileInput.value = '';
    };
    reader.readAsText(file);
  });

  // --- Keepalive Ping ---
  setInterval(() => {
    sendWsMessage({ type: 'Ping' });
  }, 25000);

  // --- Initialize ---
  currentRoomNameEl.textContent = state.roomId;
  resizeCanvas();
  connectWebSocket();
})();
