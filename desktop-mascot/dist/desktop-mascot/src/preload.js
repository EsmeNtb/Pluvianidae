"use strict";

// src/preload.ts
var import_electron = require("electron");

// ../shared/mascot-events.ts
var MASCOT_EVENT_TYPES = [
  "idle",
  "indexing",
  "success",
  "warning",
  "error",
  "seed",
  "hide",
  "show"
];
var MASCOT_EVENT_MAX_TEXT_LENGTH = 2e3;
function isMascotEvent(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value;
  if (typeof record.type !== "string" || !MASCOT_EVENT_TYPES.includes(record.type)) {
    return false;
  }
  switch (record.type) {
    case "idle":
    case "hide":
    case "show":
      return Object.keys(record).length === 1;
    case "indexing": {
      const allowedKeys = /* @__PURE__ */ new Set(["type", "file", "progress"]);
      if (!Object.keys(record).every((key) => allowedKeys.has(key))) {
        return false;
      }
      if (record.file !== void 0 && !isValidText(record.file)) {
        return false;
      }
      if (record.progress !== void 0 && !isValidProgress(record.progress)) {
        return false;
      }
      return true;
    }
    case "success":
    case "warning":
    case "error":
      return Object.keys(record).length === 2 && isValidText(record.message);
    case "seed":
      return Object.keys(record).length === 2 && isValidSeedAmount(record.amount);
    default:
      return false;
  }
}
function isValidText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MASCOT_EVENT_MAX_TEXT_LENGTH;
}
function isValidProgress(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function isValidSeedAmount(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1e3;
}

// ../shared/mascot-actions.ts
var MASCOT_ACTION_TYPES = [
  "analyze-repository",
  "precommit-review",
  "show-seed-basket",
  "mute-messages",
  "hide-mascot",
  "close-mascot"
];
function isMascotAction(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value;
  return typeof record.action === "string" && MASCOT_ACTION_TYPES.includes(record.action) && Object.keys(record).length === 1;
}

// src/ipc-channels.ts
var MASCOT_EVENT_CHANNEL = "pluvianidae:mascot-event";
var MASCOT_ACTION_CHANNEL = "pluvianidae:mascot-action";

// src/preload.ts
var pluvianidaeMascotApi = {
  onMascotEvent(callback) {
    import_electron.ipcRenderer.on(MASCOT_EVENT_CHANNEL, (_ipcEvent, data) => {
      if (!isMascotEvent(data)) {
        return;
      }
      callback(data);
    });
  },
  sendAction(action) {
    if (!isMascotAction(action)) {
      return;
    }
    import_electron.ipcRenderer.send(MASCOT_ACTION_CHANNEL, action);
  }
};
import_electron.contextBridge.exposeInMainWorld("pluvianidae", pluvianidaeMascotApi);
