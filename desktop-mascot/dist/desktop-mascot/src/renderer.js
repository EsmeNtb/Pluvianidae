"use strict";
(() => {
  // src/renderer.ts
  var MASCOT_STATE_CLASS_PREFIX = "mascot-state-";
  var MASCOT_VISUAL_STATES = [
    "idle",
    "thinking",
    "working",
    "success",
    "warning",
    "error",
    "sleeping"
  ];
  function mapEventToVisualState(event) {
    switch (event.type) {
      case "idle":
        return "idle";
      case "indexing":
        return "working";
      case "success":
        return "success";
      case "warning":
        return "warning";
      case "error":
        return "error";
      // design.md no distingue un estado visual propio para 'seed' entre los
      // 7 de la tabla "Estados visuales y animaciones"; se trata junto a
      // 'success' para el propósito del mapeo de animación (ver doc
      // comment de este módulo).
      case "seed":
        return "success";
      // Requirement 5.7: opacidad reducida "antes de completar la
      // ocultación" — la ocultación real de la ventana la maneja main.ts.
      case "hide":
        return "sleeping";
      // No hay un estado visual "show" explícito en design.md: al volver a
      // mostrarse, la mascota retoma idle por defecto.
      case "show":
        return "idle";
      default:
        return "idle";
    }
  }
  function applyVisualState(root, state) {
    for (const visualState of MASCOT_VISUAL_STATES) {
      root.classList.remove(MASCOT_STATE_CLASS_PREFIX + visualState);
    }
    root.classList.add(MASCOT_STATE_CLASS_PREFIX + state);
  }
  var BUBBLE_AUTO_HIDE_MS = 4e3;
  var BUBBLE_VISIBLE_CLASS = "mascot-bubble-visible";
  function extractBubbleText(event) {
    switch (event.type) {
      case "success":
      case "warning":
      case "error":
        return event.message;
      case "indexing":
        return event.file;
      case "idle":
      case "seed":
      case "hide":
      case "show":
      default:
        return void 0;
    }
  }
  var bubbleHideTimer;
  function showBubble(bubbleElement, text, autoHideMs = BUBBLE_AUTO_HIDE_MS) {
    if (bubbleHideTimer !== void 0) {
      clearTimeout(bubbleHideTimer);
      bubbleHideTimer = void 0;
    }
    bubbleElement.textContent = text;
    bubbleElement.title = text;
    bubbleElement.classList.add(BUBBLE_VISIBLE_CLASS);
    bubbleHideTimer = setTimeout(() => {
      bubbleHideTimer = void 0;
      bubbleElement.classList.remove(BUBBLE_VISIBLE_CLASS);
      bubbleElement.textContent = "";
      bubbleElement.title = "";
    }, autoHideMs);
  }
  function initMascotRenderer() {
    if (typeof window === "undefined" || !window.pluvianidae) {
      return;
    }
    const root = document.getElementById("mascot-root");
    if (!root) {
      return;
    }
    const bubble = document.getElementById("mascot-bubble");
    window.pluvianidae.onMascotEvent((event) => {
      const visualState = mapEventToVisualState(event);
      applyVisualState(root, visualState);
      if (!bubble) {
        return;
      }
      const bubbleText = extractBubbleText(event);
      if (bubbleText !== void 0) {
        showBubble(bubble, bubbleText, BUBBLE_AUTO_HIDE_MS);
      }
    });
  }
  initMascotRenderer();
})();
